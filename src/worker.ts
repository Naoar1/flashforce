/**
 * FlashForce Cloudflare Worker — /api/ask handler + static asset passthrough.
 *
 * Single-layer retrieval, no external APIs:
 *
 *   1. tokenize(q): overlapping 2-8 char windows over Chinese chunks, with
 *      a noise list to drop interrogatives and category keywords already
 *      handled by detectIntent.
 *   2. alias expansion (small hand-picked dict, ~50 entries) — only for
 *      colloquial road/place names that don't appear verbatim in data.json
 *      (南迴 → 台9+台26, 汐科 → 汐止, 水快 → 水源, etc). Verified that every
 *      target term actually has rows in our data.
 *   3. road codes from regex (台N / 國道N / 縣道N) + roads added by alias.
 *   4. pool filter: intent → kind → roadCode → cityHint (each step strict).
 *   5. score remaining points by substring matches of every grep term,
 *      weighted by term length; sort desc, take top-30.
 *   6. single llama-3.3-70b call with a hard prompt: no fabrication, no road
 *      equivalence claims, empty list → refuse politely.
 *
 * Coverage trade-off: anything not in data + not in alias dict will fail
 * loudly (LLM refuses) instead of hallucinating. Adding to the dict is the
 * only knob; no Nominatim / Wikipedia / runtime rewrite to debug.
 */
/// <reference types="@cloudflare/workers-types" />

interface Env {
  ASSETS: Fetcher;
  AI: {
    run: (
      model: string,
      input: {
        messages: Array<{ role: string; content: string }>;
        max_tokens?: number;
        temperature?: number;
      },
    ) => Promise<{ response?: string }>;
  };
  TURNSTILE_SITEKEY?: string;
  TURNSTILE_SECRET?: string;
}

interface EnforcementPoint {
  id: string;
  kind: "fixed" | "tech" | "mobile";
  city: string;
  district: string;
  address: string;
  lat: number;
  lng: number;
  speedLimit?: number;
  direction?: string;
  enforcementType?: string;
  authority?: string;
}

interface DataBundle {
  generatedAt: string;
  points: EnforcementPoint[];
}

// ===== Alias dictionary =====
// Only entries where user's spelling DIFFERS from what the address text says.
// Every road/substr target verified to have >=1 row in data.json.
interface Alias {
  roads?: string[];
  substrs?: string[];
  cities?: string[];
}

const ALIASES: Record<string, Alias> = {
  // 國道 nicknames
  "中山高": { roads: ["國道1"] },
  "中山高速公路": { roads: ["國道1"] },
  "一高": { roads: ["國道1"] },
  "二高": { roads: ["國道3"] },
  "福高": { roads: ["國道3"] },
  "福爾摩沙": { roads: ["國道3"] },
  "福爾摩沙高速公路": { roads: ["國道3"] },
  "蔣渭水": { roads: ["國道5"] },
  "蔣渭水高速公路": { roads: ["國道5"] },
  "雪隧": { roads: ["國道5"] },
  "雪山隧道": { roads: ["國道5"] },
  "北宜高": { roads: ["國道5"] },

  // 主要省道 colloquials, with city hints where the road spans far
  "北宜": { roads: ["台9"], cities: ["新北市", "宜蘭縣"] },
  "北宜公路": { roads: ["台9"], cities: ["新北市", "宜蘭縣"] },
  "蘇花": { roads: ["台9"], cities: ["宜蘭縣", "花蓮縣"] },
  "蘇花公路": { roads: ["台9"], cities: ["宜蘭縣", "花蓮縣"] },
  "蘇花改": { roads: ["台9"], cities: ["宜蘭縣", "花蓮縣"] },
  "南迴": { roads: ["台9", "台26"], cities: ["屏東縣", "臺東縣", "台東縣"] },
  "南迴公路": { roads: ["台9", "台26"], cities: ["屏東縣", "臺東縣", "台東縣"] },
  "北橫": { roads: ["台7"], cities: ["桃園市", "宜蘭縣", "新北市"] },
  "北橫公路": { roads: ["台7"], cities: ["桃園市", "宜蘭縣", "新北市"] },
  "中橫": { roads: ["台8"], cities: ["臺中市", "南投縣", "花蓮縣"] },
  "中橫公路": { roads: ["台8"], cities: ["臺中市", "南投縣", "花蓮縣"] },
  "南橫": { roads: ["台20"] },
  "南橫公路": { roads: ["台20"] },
  "阿里山公路": { roads: ["台18"] },
  "玉山公路": { roads: ["台21"] },
  "新中橫": { roads: ["台21"] },
  "西濱": { roads: ["台61"] },
  "西濱快速": { roads: ["台61"] },
  "西濱公路": { roads: ["台61"] },
  "西濱快速公路": { roads: ["台61"] },
  "北濱": { roads: ["台2"], cities: ["新北市", "基隆市", "宜蘭縣"] },
  "北海岸公路": { roads: ["台2"], cities: ["新北市", "基隆市"] },
  "陽金": { roads: ["台2甲"] },
  "陽金公路": { roads: ["台2甲"] },

  // 都會快速 → match by the real road-segment name in addresses; constrain
  // to the relevant city to avoid pulling unrelated 建國/水源/環河 roads.
  "水快": { substrs: ["水源"], cities: ["臺北市", "新北市"] },
  "水源快": { substrs: ["水源"], cities: ["臺北市", "新北市"] },
  "水源快速": { substrs: ["水源"], cities: ["臺北市", "新北市"] },
  "水源快速道路": { substrs: ["水源"], cities: ["臺北市", "新北市"] },
  "建快": { substrs: ["建國"], cities: ["臺北市", "新北市"] },
  "環快": { substrs: ["環河"], cities: ["臺北市", "新北市"] },
  "信義快": { substrs: ["信義快速"], cities: ["臺北市"] },

  // Place colloquials whose canonical name we *do* have in data
  "汐科": { substrs: ["汐止"] },
  "淡江": { substrs: ["淡水"] },
  "陽明山": { substrs: ["仰德", "陽明山"] },
  "內科": { substrs: ["內湖"] },
  "中科": { substrs: ["西屯", "大雅"] },
  "南科": { substrs: ["善化", "新市"] },
  "竹科": { substrs: ["竹北", "東區"] },
};

// ===== module-scope data cache =====
let cachedBundle: DataBundle | null = null;
async function getBundle(env: Env, request: Request): Promise<DataBundle> {
  if (cachedBundle) return cachedBundle;
  const url = new URL("/data/data.json", request.url);
  const res = await env.ASSETS.fetch(new Request(url.toString()));
  if (!res.ok) throw new Error(`failed to load data.json: HTTP ${res.status}`);
  cachedBundle = (await res.json()) as DataBundle;
  return cachedBundle;
}

// ===== intent =====
interface QueryIntent {
  kindFilter?: EnforcementPoint["kind"][];
  enforcementTypeContains?: string[];
}

function detectIntent(q: string): QueryIntent {
  if (q.includes("區間")) {
    return { kindFilter: ["tech"], enforcementTypeContains: ["區間"] };
  }
  if (q.includes("闖紅燈")) {
    return { kindFilter: ["tech"], enforcementTypeContains: ["闖紅燈"] };
  }
  if (q.includes("違停") || q.includes("違規停車")) {
    return {
      kindFilter: ["tech"],
      enforcementTypeContains: ["違停", "違規停車", "違規(臨時)停車"],
    };
  }
  if (q.includes("不停讓") || q.includes("禮讓行人")) {
    return { kindFilter: ["tech"], enforcementTypeContains: ["不停讓", "未禮讓"] };
  }
  if (q.includes("跨越雙白") || q.includes("跨越雙黃")) {
    return { kindFilter: ["tech"], enforcementTypeContains: ["跨越"] };
  }
  if (q.includes("機動")) return { kindFilter: ["mobile"] };
  if (q.includes("固定測速")) return { kindFilter: ["fixed"] };
  if (q.includes("科技執法")) return { kindFilter: ["tech"] };
  return {};
}

// ===== tokenize =====
// Phrases stripped from query before chunking — these are intent / category
// keywords already captured by detectIntent, and we must keep their fragments
// (技執, 科技執, 處科技執, 間測, 區間測, etc.) from polluting substring scoring.
const STRIP_PHRASES = [
  "科技執法",
  "區間測速",
  "區間",
  "闖紅燈",
  "違規(臨時)停車",
  "違規停車",
  "違停",
  "未禮讓",
  "禮讓行人",
  "不停讓",
  "跨越雙白",
  "跨越雙黃",
  "機動測速",
  "固定測速",
  "測速照相",
  "測速",
  "拍照",
  "照相",
  "罰單",
  "取締",
];

// Pure question-words / generic suffix nouns. Tokens equal to these are dropped
// so they don't bias scoring. "大學/國中/國小/高中/高職" are common landmark
// suffixes that match many unrelated addresses (大學路 etc.) — drop them so
// the more specific tokens (淡江, 仰德, 中正…) carry the signal.
const NOISE = new Set([
  "什麼", "幾處", "幾個", "幾段", "哪裡", "哪邊", "哪些", "如何", "怎樣",
  "怎麼", "多少", "哪一", "哪個", "有沒", "沒有", "速限", "限速", "最低",
  "最高", "最快", "最慢", "範圍", "附近", "周遭", "周邊", "資料", "點位",
  "請問", "告訴", "告知", "可以", "幫我", "給我", "查一", "查查", "現在",
  "目前", "到底", "公路", "道路", "今天", "今日", "目前",
  "大學", "國中", "國小", "高中", "高職",
]);

const ROAD_CODE_RE = /^(?:[台臺]\d{1,3}(?:[甲乙丙丁])?|國道\d{1,2}|縣道\d{1,3})$/;

function tokenize(q: string): string[] {
  // 1. strip road-code spans (台N / 國道N / 縣道N)
  let cleaned = q
    .replace(/國(?:道)?\s*\d{1,2}(?:號)?/g, " ")
    .replace(/[台臺]\s*\d{1,3}(?:甲|乙|丙|丁)?(?:線|號)?/g, " ")
    .replace(/縣道\s*\d{1,3}/g, " ");
  // 2. strip intent / category phrases as whole units, so their character
  //    fragments never become tokens.
  for (const phrase of STRIP_PHRASES) {
    if (cleaned.includes(phrase)) cleaned = cleaned.split(phrase).join(" ");
  }

  const tokens = new Set<string>();
  const chunks = cleaned.match(/[一-鿿]+/g) ?? [];
  for (const chunk of chunks) {
    const maxLen = Math.min(8, chunk.length);
    for (let len = 2; len <= maxLen; len++) {
      for (let i = 0; i + len <= chunk.length; i++) {
        tokens.add(chunk.slice(i, i + len));
      }
    }
  }
  for (const n of NOISE) tokens.delete(n);
  return [...tokens];
}

// ===== parse =====
interface ParsedQuery {
  intent: QueryIntent;
  roadCodes: string[];
  cityHints: string[];
  grepTerms: string[];
}

function parseQuery(q: string): ParsedQuery {
  const intent = detectIntent(q);

  const codes = new Set<string>();
  for (const m of q.matchAll(/國(?:道)?\s*(\d{1,2})/g)) codes.add(`國道${m[1]}`);
  for (const m of q.matchAll(/[台臺]\s*(\d{1,3})\s*([甲乙丙丁])?/g)) {
    codes.add(`台${m[1]}${m[2] ?? ""}`);
  }
  for (const m of q.matchAll(/縣道\s*(\d{1,3})/g)) codes.add(`縣道${m[1]}`);

  const tokens = tokenize(q);
  const grepTerms = new Set<string>();
  const cityHints = new Set<string>();

  for (const t of tokens) {
    const ali = ALIASES[t];
    if (ali) {
      if (ali.roads) for (const r of ali.roads) codes.add(r);
      if (ali.substrs) for (const s of ali.substrs) grepTerms.add(s);
      if (ali.cities) for (const c of ali.cities) cityHints.add(c);
    }
    if (t.length >= 2 && !ROAD_CODE_RE.test(t)) grepTerms.add(t);
  }

  return {
    intent,
    roadCodes: [...codes],
    cityHints: [...cityHints],
    grepTerms: [...grepTerms],
  };
}

// ===== retrieval =====
interface RetrievalResult {
  points: EnforcementPoint[];
  parsed: ParsedQuery;
  mode: string;
}

function pickRelevantPoints(
  bundle: DataBundle,
  question: string,
  topN = 30,
): RetrievalResult {
  const parsed = parseQuery(question);
  let pool = bundle.points;

  if (parsed.intent.kindFilter) {
    const kf = parsed.intent.kindFilter;
    pool = pool.filter((p) => kf.includes(p.kind));
  }
  if (parsed.intent.enforcementTypeContains) {
    const et = parsed.intent.enforcementTypeContains;
    pool = pool.filter((p) => {
      const t = p.enforcementType ?? "";
      return et.some((s) => t.includes(s));
    });
  }

  // Road-code strict filter (only when user named a road)
  if (parsed.roadCodes.length > 0) {
    pool = pool.filter((p) => {
      const blob = `${p.city} ${p.district} ${p.address}`;
      return parsed.roadCodes.some((rc) => blob.includes(rc));
    });
  }

  // City-hint strict filter (only when alias supplied one and the filter
  // leaves at least one row — otherwise fall back to road-only).
  if (parsed.cityHints.length > 0) {
    const filtered = pool.filter((p) => parsed.cityHints.includes(p.city));
    if (filtered.length > 0) pool = filtered;
  }

  // Score by substring grep — weighted by term length so longer / more
  // specific tokens beat short generic ones (e.g. "中正橋" beats "中正").
  const scored: Array<{ p: EnforcementPoint; s: number }> = [];
  for (const p of pool) {
    const blob = `${p.city} ${p.district} ${p.address} ${p.enforcementType ?? ""}`;
    let s = 0;
    for (const t of parsed.grepTerms) {
      if (blob.includes(t)) s += t.length;
    }
    for (const rc of parsed.roadCodes) {
      if (blob.includes(rc)) s += rc.length;
    }
    if (s > 0) {
      scored.push({ p, s });
    } else if (
      parsed.roadCodes.length > 0 &&
      parsed.grepTerms.length === 0
    ) {
      // User only gave a road code (e.g. "台64區間限速"). Every row in pool
      // already matches the road; rank arbitrarily.
      scored.push({ p, s: 1 });
    }
  }
  scored.sort((a, b) => b.s - a.s);
  const top = scored.slice(0, topN).map((x) => x.p);

  const modeParts: string[] = [];
  if (parsed.intent.kindFilter) {
    modeParts.push(`kind:${parsed.intent.kindFilter.join(",")}`);
  }
  if (parsed.roadCodes.length > 0) {
    modeParts.push(`roads:${parsed.roadCodes.join("|")}`);
  }
  if (parsed.cityHints.length > 0) {
    modeParts.push(`cities:${parsed.cityHints.join("|")}`);
  }
  if (parsed.grepTerms.length > 0) {
    modeParts.push(`grep:${parsed.grepTerms.length}`);
  }
  const mode = modeParts.join(" ") || "empty";

  return { points: top, parsed, mode };
}

// ===== prompt =====
function formatPoint(p: EnforcementPoint): string {
  const kindZh = { fixed: "固定測速", tech: "科技執法", mobile: "機動測速" }[p.kind];
  const subtype = p.enforcementType ? `／${p.enforcementType}` : "";
  const parts = [
    `[${p.id}]`,
    `(${kindZh}${subtype})`,
    `${p.city}${p.district ? " " + p.district : ""}`,
    p.address,
  ];
  if (p.speedLimit) parts.push(`速限 ${p.speedLimit}`);
  if (p.direction) parts.push(`方向 ${p.direction}`);
  return parts.join(" ");
}

const SYSTEM_PROMPT = `你是 FlashForce 的查詢助手。FlashForce 是台灣全台科技執法、測速、機動測速的地圖服務。

任務：依使用者問題 + 「相關點位」清單回答。

絕對規則（違反任一條都是錯誤回應）：
1. 只能引用清單裡實際出現的 [id]。每個 [id] 必須能在清單裡逐字找到，不可自創。
2. 不要編造速限、方向、路線編號、行政區、地點名稱等任何欄位。清單沒寫就不要寫。
3. 不要做出資料中沒有明確顯示的等價聲明（例如：不要說「南迴公路 = 國道3號」、「北宜公路 = 國道5號」、「西濱 = 國道1」之類的對應）。如果清單裡的點本身有路線編號，就用清單上寫的；沒有就只引用地址。
4. 清單為空（0 點）時：回應「資料庫沒找到符合條件的點。可以試著用更具體的路線編號（台9線、國道3號…）、行政區（士林區、新竹縣…）或實際路名。」**完全不要列任何 [id]，也不要附帶任何補充說明。**
5. 問題與台灣科技執法 / 測速 / 機動測速 / 地圖點位查詢無關（食譜、政治、新聞、閒聊、其他國家、純打招呼）→ 直接回應「我只能回答台灣科技執法 / 測速 / 機動測速地圖相關的問題。」**完全不要列任何 [id]。**

風格：
- 繁體中文，對話口吻、簡潔。直接回答，不要重複問題。
- 條列形式：每個相關點一行，格式 \`- [id] 地點 (類別 — 子分類)\`，速限/方向若清單有就附上。
- 子分類（固定測速、區間測速、闖紅燈、違停、不停讓、跨越雙白實線…）標清楚。
- 若清單看起來只部分符合題意（例如使用者問「淡水」但清單裡只有「新北市 淡水區」的某類點），如實說明範圍。

回應範例：
Q: 仰德大道有幾個測速
A: 仰德大道有 4 個固定測速：
- [fixed-905] 仰德大道2段29巷 (固定測速) 速限 50
- [fixed-906] 仰德大道2段115巷口 (固定測速) 速限 50
- [fixed-907] 仰德大道四段75號 (固定測速) 速限 40
- [fixed-908] 仰德大道3段陽明山國小前 (固定測速) 速限 40

Q: 義大利麵食譜
A: 我只能回答台灣科技執法 / 測速 / 機動測速地圖相關的問題。

Q: 南橫速限多少 （清單為空）
A: 資料庫沒找到符合條件的點。可以試著用更具體的路線編號（台9線、國道3號…）、行政區（士林區、新竹縣…）或實際路名。`;

// ===== rate limit =====
interface IPState {
  count: number;
  resetAt: number;
}
const ipState = new Map<string, IPState>();
const TWO_HOURS_MS = 2 * 60 * 60 * 1000;
const MAX_PER_WINDOW = 30;
const TURNSTILE_EVERY = 4;

function getIPState(ip: string): IPState {
  const now = Date.now();
  let s = ipState.get(ip);
  if (!s || now > s.resetAt) {
    s = { count: 0, resetAt: now + TWO_HOURS_MS };
    ipState.set(ip, s);
  }
  if (ipState.size > 5000) {
    for (const [k, v] of ipState) if (now > v.resetAt) ipState.delete(k);
  }
  return s;
}

async function verifyTurnstile(token: string, env: Env): Promise<boolean> {
  if (!env.TURNSTILE_SECRET) return true;
  try {
    const res = await fetch(
      "https://challenges.cloudflare.com/turnstile/v0/siteverify",
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          secret: env.TURNSTILE_SECRET,
          response: token,
        }).toString(),
      },
    );
    if (!res.ok) return false;
    const data = (await res.json()) as { success: boolean };
    return data.success === true;
  } catch {
    return false;
  }
}

// ===== handler =====
async function handleAsk(req: Request, env: Env): Promise<Response> {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }
  let body: { question?: string; turnstileToken?: string };
  try {
    body = (await req.json()) as { question?: string; turnstileToken?: string };
  } catch {
    return new Response(JSON.stringify({ error: "invalid JSON" }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  }
  const question = (body.question ?? "").trim();
  if (!question || question.length > 200) {
    return new Response(
      JSON.stringify({ error: "question must be 1-200 chars" }),
      { status: 400, headers: { "content-type": "application/json" } },
    );
  }

  const ip = req.headers.get("CF-Connecting-IP") ?? "0.0.0.0";
  const state = getIPState(ip);
  const turnstileEnabled = !!env.TURNSTILE_SECRET && !!env.TURNSTILE_SITEKEY;

  if (state.count >= MAX_PER_WINDOW) {
    const retryAfterSec = Math.ceil((state.resetAt - Date.now()) / 1000);
    return new Response(
      JSON.stringify({
        error: "rate-limited",
        message: `2 小時內已問過 ${MAX_PER_WINDOW} 次，請等 ${Math.ceil(retryAfterSec / 60)} 分鐘後再試。`,
        retryAfterSec,
      }),
      {
        status: 429,
        headers: {
          "content-type": "application/json",
          "Retry-After": String(retryAfterSec),
        },
      },
    );
  }

  const isChallengeRequest =
    turnstileEnabled && (state.count + 1) % TURNSTILE_EVERY === 0;
  if (isChallengeRequest) {
    if (!body.turnstileToken) {
      return new Response(
        JSON.stringify({
          requireTurnstile: true,
          sitekey: env.TURNSTILE_SITEKEY,
          message: "請完成驗證後重新送出。",
        }),
        { status: 401, headers: { "content-type": "application/json" } },
      );
    }
    const ok = await verifyTurnstile(body.turnstileToken, env);
    if (!ok) {
      return new Response(
        JSON.stringify({
          error: "Turnstile verification failed",
          requireTurnstile: true,
          sitekey: env.TURNSTILE_SITEKEY,
        }),
        { status: 401, headers: { "content-type": "application/json" } },
      );
    }
  }

  const bundle = await getBundle(env, req);
  const { points: relevant, parsed, mode } = pickRelevantPoints(bundle, question);

  const userPrompt =
    relevant.length === 0
      ? `問題：${question}\n\n相關點位：（清單為空，沒有匹配的點）\n\n[debug] mode=${mode}\n\n請依規則回答。`
      : `問題：${question}\n\n相關點位（共 ${relevant.length} 點）：\n${relevant.map(formatPoint).join("\n")}\n\n[debug] mode=${mode}\n\n請依規則回答。`;

  const aiResp = await env.AI.run("@cf/meta/llama-3.3-70b-instruct-fp8-fast", {
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: userPrompt },
    ],
    max_tokens: 800,
    temperature: 0.2,
  });

  const answer = aiResp.response ?? "（模型沒有回應）";
  state.count += 1;

  return new Response(
    JSON.stringify({
      answer,
      cited: relevant.map((p) => ({
        id: p.id,
        kind: p.kind,
        address: p.address,
        lat: p.lat,
        lng: p.lng,
      })),
      mode,
      parsed: {
        roadCodes: parsed.roadCodes,
        cityHints: parsed.cityHints,
        grepTerms: parsed.grepTerms,
      },
      remainingInWindow: MAX_PER_WINDOW - state.count,
    }),
    { headers: { "content-type": "application/json" } },
  );
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/api/ask") {
      try {
        return await handleAsk(request, env);
      } catch (e) {
        return new Response(JSON.stringify({ error: (e as Error).message }), {
          status: 500,
          headers: { "content-type": "application/json" },
        });
      }
    }
    return env.ASSETS.fetch(request);
  },
};
