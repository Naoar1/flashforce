/**
 * FlashForce Cloudflare Worker — /api/ask handler + static asset passthrough.
 *
 * Architecture (geographic-first, no alias dict, no runtime LLM rewrite):
 *
 *   parse        — extract intent (區間/闖紅燈/...) + road codes (台N/國道N) +
 *                  remaining Chinese geo tokens via regex (no dictionary)
 *   resolve      — for each geo token, query Nominatim (cached) and keep the
 *                  top 1-2 places (each gives name + bbox + center)
 *   score        — filter pool by intent + road code; score each remaining
 *                  point by (bbox-contains, distance-to-center, road-code
 *                  substring); take top-N
 *   answer       — single llama-3.3-70b call grounded on the retrieved points
 *
 * Knowledge source is OSM (via Nominatim). No hand-curated alias map —
 * coverage of "淡水", "淡江", "汐科", "西濱", "北宜公路" etc. comes from OSM's
 * place / alt_name / industrial / school / way tagging. Tokens OSM doesn't
 * resolve simply fail loudly (LLM refuses politely) rather than silently
 * masquerading as the wrong place.
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

// ===== intent detection (kind / enforcementType) =====
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
    return {
      kindFilter: ["tech"],
      enforcementTypeContains: ["不停讓", "未禮讓"],
    };
  }
  if (q.includes("跨越雙白") || q.includes("跨越雙黃")) {
    return { kindFilter: ["tech"], enforcementTypeContains: ["跨越"] };
  }
  if (q.includes("機動")) return { kindFilter: ["mobile"] };
  if (q.includes("固定測速")) return { kindFilter: ["fixed"] };
  return {};
}

// ===== parse query =====
interface ParsedQuery {
  intent: QueryIntent;
  roadCodes: string[]; // "台61", "國道5", etc. — also includes both 台/臺 variants
  geoTokens: string[]; // chunks for Nominatim resolution
}

function parseQuery(q: string): ParsedQuery {
  const intent = detectIntent(q);

  // Road codes
  const codes = new Set<string>();
  // 國道N / 國N
  for (const m of q.matchAll(/國(?:道)?\s*(\d{1,2})/g)) {
    codes.add(`國道${m[1]}號`);
    codes.add(`國道${m[1]}`);
  }
  // 台N / 臺N (+optional 甲乙丙丁)
  for (const m of q.matchAll(/[台臺]\s*(\d{1,3})\s*(甲|乙|丙|丁)?/g)) {
    const suf = m[2] ?? "";
    codes.add(`台${m[1]}${suf}線`);
    codes.add(`臺${m[1]}${suf}線`);
    codes.add(`台${m[1]}${suf}`);
    codes.add(`臺${m[1]}${suf}`);
  }
  // 縣道N
  for (const m of q.matchAll(/縣道\s*(\d{1,3})/g)) {
    codes.add(`縣道${m[1]}`);
  }

  // Geo tokens — strip out road-code spans first so we don't re-tokenize them
  const cleaned = q
    .replace(/國(?:道)?\s*\d{1,2}(?:號)?/g, " ")
    .replace(/[台臺]\s*\d{1,3}(?:甲|乙|丙|丁)?(?:線|號)?/g, " ")
    .replace(/縣道\s*\d{1,3}/g, " ");

  const tokenSet = new Set<string>();
  // Tier 1: suffix-anchored landmarks / admin areas (higher signal)
  const suffixed = cleaned.match(
    /[一-鿿]{2,8}(?:區|市|鄉|鎮|縣|村|里|大道|路|街|巷|橋|快速道路|快速|公路|交流道|隧道|大學|車站|捷運|園區|路口|商圈|夜市|公園|機場)/g,
  );
  suffixed?.forEach((t) => tokenSet.add(t));
  // Tier 2: bare 2-4 char Chinese chunks (for short colloquials like 汐科, 淡江)
  const bare = cleaned.match(/[一-鿿]{2,4}/g);
  bare?.forEach((t) => tokenSet.add(t));

  // Drop pure-interrogative / common noise chunks
  const NOISE = new Set([
    "什麼",
    "幾處",
    "幾個",
    "哪裡",
    "哪邊",
    "哪些",
    "如何",
    "怎樣",
    "怎麼",
    "多少",
    "嗎",
    "呢",
    "嘛",
    "有沒",
    "沒有",
    "速限",
    "限速",
    "最低",
    "最高",
    "最快",
    "最慢",
    "範圍",
    "附近",
    "周遭",
    "周邊",
    "資料",
    "點位",
    "測速",
    "科技",
    "執法",
    "機動",
    "固定",
    "罰單",
    "取締",
    "違規",
    "拍照",
    "照相",
  ]);
  for (const t of [...tokenSet]) {
    if (NOISE.has(t)) tokenSet.delete(t);
  }

  return {
    intent,
    roadCodes: [...codes],
    geoTokens: [...tokenSet],
  };
}

// ===== Nominatim resolver (cached) =====
interface ResolvedPlace {
  query: string;
  name: string;
  bbox: [number, number, number, number] | null; // [south, north, west, east]
  center: { lat: number; lng: number };
  importance: number;
}

const placeCache = new Map<string, ResolvedPlace[]>();
let lastNominatimAt = 0;
const NOMINATIM_RATE_MS = 1100;

async function nominatimRateLimit() {
  const now = Date.now();
  const wait = lastNominatimAt + NOMINATIM_RATE_MS - now;
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastNominatimAt = Date.now();
}

async function resolveToken(token: string): Promise<ResolvedPlace[]> {
  if (placeCache.has(token)) return placeCache.get(token)!;
  if (placeCache.size > 2000) placeCache.clear();

  await nominatimRateLimit();
  try {
    const url = new URL("https://nominatim.openstreetmap.org/search");
    url.searchParams.set("q", token);
    url.searchParams.set("countrycodes", "tw");
    url.searchParams.set("format", "json");
    url.searchParams.set("limit", "2");
    url.searchParams.set("accept-language", "zh-TW");
    const res = await fetch(url.toString(), {
      headers: { "User-Agent": "FlashForce/1.0 (+github.com/Naoar1/flashforce)" },
    });
    if (!res.ok) {
      placeCache.set(token, []);
      return [];
    }
    const data = (await res.json()) as Array<{
      lat: string;
      lon: string;
      display_name: string;
      importance?: number;
      boundingbox?: [string, string, string, string];
    }>;
    const out: ResolvedPlace[] = [];
    for (const r of data) {
      const lat = Number.parseFloat(r.lat);
      const lng = Number.parseFloat(r.lon);
      if (!inTaiwan(lat, lng)) continue;
      let bbox: ResolvedPlace["bbox"] = null;
      if (r.boundingbox) {
        const [s, n, w, e] = r.boundingbox.map((x) => Number.parseFloat(x));
        if ([s, n, w, e].every(Number.isFinite)) bbox = [s, n, w, e];
      }
      out.push({
        query: token,
        name: r.display_name,
        bbox,
        center: { lat, lng },
        importance: r.importance ?? 0,
      });
    }
    placeCache.set(token, out);
    return out;
  } catch {
    placeCache.set(token, []);
    return [];
  }
}

function inTaiwan(lat: number, lng: number): boolean {
  return lat >= 21 && lat <= 26.5 && lng >= 118 && lng <= 122.5;
}

function distMeters(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number },
): number {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const sLat = Math.sin(dLat / 2);
  const sLng = Math.sin(dLng / 2);
  const h =
    sLat * sLat +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * sLng * sLng;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

function isInBBox(
  p: { lat: number; lng: number },
  bbox: [number, number, number, number],
): boolean {
  const [s, n, w, e] = bbox;
  return p.lat >= s && p.lat <= n && p.lng >= w && p.lng <= e;
}

// ===== retrieval =====
interface RetrievalResult {
  points: EnforcementPoint[];
  mode: string;
  parsed: ParsedQuery;
  resolved: ResolvedPlace[];
}

async function pickRelevantPoints(
  bundle: DataBundle,
  question: string,
  topN = 30,
): Promise<RetrievalResult> {
  const parsed = parseQuery(question);
  let pool = bundle.points;

  // Intent filter
  if (parsed.intent.kindFilter) {
    pool = pool.filter((p) => parsed.intent.kindFilter!.includes(p.kind));
  }
  if (parsed.intent.enforcementTypeContains) {
    pool = pool.filter((p) => {
      const et = p.enforcementType ?? "";
      return parsed.intent.enforcementTypeContains!.some((s) => et.includes(s));
    });
  }

  // Road-code filter — if user said "台61" / "國道5", restrict pool to points
  // whose address actually contains that code.
  if (parsed.roadCodes.length > 0) {
    pool = pool.filter((p) => {
      const blob = `${p.city} ${p.district} ${p.address}`;
      return parsed.roadCodes.some((rc) => blob.includes(rc));
    });
  }

  // Resolve geo tokens via Nominatim (sequential due to 1 req/sec policy,
  // but bounded by max attempts; cache hits cost ~0 time)
  const resolved: ResolvedPlace[] = [];
  const MAX_RESOLVE = 6;
  let attempts = 0;
  for (const t of parsed.geoTokens) {
    if (attempts >= MAX_RESOLVE) break;
    attempts++;
    const r = await resolveToken(t);
    resolved.push(...r);
  }

  // If user gave neither road code nor any resolvable place, we have no
  // anchor — bail out so the LLM refuses politely instead of dumping points
  // from somewhere random.
  if (parsed.roadCodes.length === 0 && resolved.length === 0) {
    return { points: [], mode: "no-anchor", parsed, resolved };
  }

  // Score each pool point
  const scored: Array<{ p: EnforcementPoint; s: number }> = [];
  for (const p of pool) {
    let s = 0;
    // road code substring contributes (filter already enforced membership,
    // so this is mostly tie-breaking when multiple codes given)
    const blob = `${p.city} ${p.district} ${p.address}`;
    for (const rc of parsed.roadCodes) if (blob.includes(rc)) s += 4;
    // bbox membership
    for (const r of resolved) {
      if (r.bbox && isInBBox(p, r.bbox)) s += 5;
    }
    // distance to nearest resolved center
    let minDist = Infinity;
    for (const r of resolved) {
      const d = distMeters({ lat: p.lat, lng: p.lng }, r.center);
      if (d < minDist) minDist = d;
    }
    if (minDist < Infinity) {
      s += 5 / (1 + minDist / 2000); // 2 km falloff; ~5 at 0m, ~1.25 at 6km
    }
    // canonical name substring (geographic resolution sometimes returns a
    // friendly name that may appear in our address)
    for (const r of resolved) {
      const lead = r.name.split(",")[0] ?? "";
      if (lead && blob.includes(lead)) s += 2;
    }
    if (s > 0) scored.push({ p, s });
  }
  scored.sort((a, b) => b.s - a.s);
  const top = scored.slice(0, topN).map((x) => x.p);

  return {
    points: top,
    mode: `geo:${resolved.length}+road:${parsed.roadCodes.length}+intent:${
      parsed.intent.kindFilter ? "yes" : "no"
    }`,
    parsed,
    resolved,
  };
}

// ===== prompt construction =====
function formatPoint(p: EnforcementPoint): string {
  const kindZh = { fixed: "固定測速", tech: "科技執法", mobile: "機動測速" }[
    p.kind
  ];
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

你會收到使用者問題 + 一份「相關點位」清單（已經過 intent / 道路代碼 / 地理範圍 篩選），務必依以下規則回答：

1. 用繁體中文，**對話口吻 + 條列**。直接回答問題，不要重複問題。
2. **列出全部相關點位**（不要只挑一個）。每點開頭加 [id]，方便對照地圖。
3. 子分類辨識：固定測速、區間測速、闖紅燈、違停、不停讓 等是不同類別，要說清楚每點屬於哪一類。
4. **絕對不要編造清單裡沒有的欄位**：沒寫速限就不要寫；沒寫方向就不要寫。
5. **絕對不要列出清單以外的點**。每個 [id] 都必須是清單裡實際出現過的。
6. 如果清單看起來不完全符合題意，誠實說「我看到的清單裡沒有 XX 路 / XX 區的點」，可以附帶提示「附近有以下相關的：...」**前提是清單裡確實有相關項**。

特殊狀況：
- 清單為空（總共 0 點）→ 回應「資料庫沒找到符合的點。請給更具體的路名 / 行政區 / 路線編號。」**不要編造任何點。**
- 問題明顯跟交通執法、測速、地點查詢無關（食譜、新聞、政治、閒聊）→ 禮貌拒絕：「我只能回答台灣科技執法 / 測速 / 機動測速地圖相關的問題。」**不要附帶任何清單。**

格式：使用 markdown 條列（每行 \`- [id] ...\`），網頁會把 [id] 變成可點的連結。

範例輸出 1：
Q: 仰德大道有幾個測速點
A: 仰德大道有 4 個固定測速：
- [fixed-905] 仰德大道 2 段 29 巷
- [fixed-906] 仰德大道 2 段 115 巷口
- [fixed-907] 仰德大道四段 75 號格致國中前
- [fixed-908] 仰德大道 3 段陽明山國小前

範例輸出 2：
Q: 西濱新竹段速限多少
A: 西濱（台61線）新竹段有 X 個測速點：
- [fixed-XXX] 香山區台61線 XX 公里 速限 100
- ...

範例輸出 3：
Q: 給我刺客義大利麵食譜
A: 我只能回答台灣科技執法 / 測速 / 機動測速地圖相關的問題。`;

// ===== rate limit (per-IP, 2-hour rolling window) =====
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

// ===== handlers =====
async function handleAsk(req: Request, env: Env): Promise<Response> {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }
  let body: { question?: string; turnstileToken?: string };
  try {
    body = (await req.json()) as {
      question?: string;
      turnstileToken?: string;
    };
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

  // Rate limit
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
  const { points: relevant, mode, parsed, resolved } = await pickRelevantPoints(
    bundle,
    question,
  );

  const debugLine = `[debug] roadCodes=${JSON.stringify(parsed.roadCodes)} geoTokens=${JSON.stringify(parsed.geoTokens)} resolved=${resolved.map((r) => r.name.split(",")[0]).join(" | ")}`;

  const userPrompt =
    relevant.length === 0
      ? `問題：${question}\n\n相關點位：（清單為空，沒有匹配的點）\n\n${debugLine}\n\n請依規則回答。`
      : `問題：${question}\n\n相關點位（共 ${relevant.length} 點，retrieval mode = ${mode}）：\n${relevant.map(formatPoint).join("\n")}\n\n請依規則回答。`;

  const aiResp = await env.AI.run("@cf/meta/llama-3.3-70b-instruct-fp8-fast", {
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: userPrompt },
    ],
    max_tokens: 800,
    temperature: 0.3,
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
        return new Response(
          JSON.stringify({ error: (e as Error).message }),
          { status: 500, headers: { "content-type": "application/json" } },
        );
      }
    }
    return env.ASSETS.fetch(request);
  },
};
