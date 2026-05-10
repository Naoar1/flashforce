/**
 * FlashForce Cloudflare Worker — handles /api/ask (NL Q&A) and falls
 * through everything else to static assets (the Next.js out/).
 *
 * Architecture (RAG):
 *   1) expand colloquial abbreviations  (水快 → 水源快速道路)
 *   2) detect intent  (區間 / 闖紅燈 / 機動 / 違停 / 不停讓 / 固定)
 *   3) keyword-rank candidates with intent filter applied
 *   4) if zero hits, geocode landmark via Nominatim → radius search
 *   5) ALWAYS pass top-N to the LLM (no zero-match short-circuit; the LLM
 *      decides whether anything is relevant; this matters for fuzzy queries)
 *   6) Workers AI llama-3.3-70b answers grounded in retrieved set, with
 *      few-shot system prompt enforcing format.
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

// ===== module-scope cache =====
let cachedBundle: DataBundle | null = null;
async function getBundle(env: Env, request: Request): Promise<DataBundle> {
  if (cachedBundle) return cachedBundle;
  const url = new URL("/data/data.json", request.url);
  const res = await env.ASSETS.fetch(new Request(url.toString()));
  if (!res.ok) throw new Error(`failed to load data.json: HTTP ${res.status}`);
  cachedBundle = (await res.json()) as DataBundle;
  return cachedBundle;
}

// ===== abbreviation expansion =====
//
// Taiwanese drivers heavily abbreviate road names. Without expansion, "水快"
// never grep-matches "水源快速道路" in our address fields. This map is
// extensible; add more pairs as user feedback shows misses.
const ABBREV: Record<string, string[]> = {
  水快: ["水源快速道路", "水源快速", "水源路"],
  環快: ["環河快速道路", "環河南路", "環河北路", "環河西路", "環河東路"],
  北快: ["市民大道", "市民高架"],
  南快: ["信義快速道路", "信義路"],
  建快: ["建國高架", "建國北路", "建國南路"],
  // 國/省道暱稱
  國一: ["國道1號", "國道一號"],
  國二: ["國道2號", "國道二號"],
  國三: ["國道3號", "國道三號"],
  國四: ["國道4號", "國道四號"],
  國五: ["國道5號", "國道五號"],
  國六: ["國道6號", "國道六號"],
  國八: ["國道8號", "國道八號"],
  國十: ["國道10號", "國道十號"],
  // 區域
  陽明山: ["陽明山", "士林區", "北投區"],
  天母: ["士林區", "天母"],
  公館: ["中正區", "公館"],
};

function expandQuery(q: string): string {
  let expanded = q;
  for (const [abbr, fulls] of Object.entries(ABBREV)) {
    if (q.includes(abbr)) {
      expanded += " " + fulls.join(" ");
    }
  }
  return expanded;
}

// ===== intent detection =====
//
// When the user mentions a specific subcategory, we filter the candidate pool
// to that subset BEFORE keyword scoring; otherwise a query like "台64 區間限速"
// returns 4 fixed-point speed cameras + 3 真區間 mixed together, confusing the
// model.
interface QueryIntent {
  kindFilter?: EnforcementPoint["kind"][];
  enforcementTypeContains?: string[];
}

function detectIntent(q: string): QueryIntent {
  const intent: QueryIntent = {};
  // subcategory keywords → narrow to tech kind + specific enforcementType
  if (q.includes("區間")) {
    intent.kindFilter = ["tech"];
    intent.enforcementTypeContains = ["區間"];
  } else if (q.includes("闖紅燈")) {
    intent.kindFilter = ["tech"];
    intent.enforcementTypeContains = ["闖紅燈"];
  } else if (q.includes("違停") || q.includes("違規停車")) {
    intent.kindFilter = ["tech"];
    intent.enforcementTypeContains = ["違停", "違規停車", "違規(臨時)停車"];
  } else if (q.includes("不停讓") || q.includes("禮讓行人")) {
    intent.kindFilter = ["tech"];
    intent.enforcementTypeContains = ["不停讓", "未禮讓"];
  } else if (q.includes("跨越雙白") || q.includes("跨越雙黃")) {
    intent.kindFilter = ["tech"];
    intent.enforcementTypeContains = ["跨越"];
  } else if (q.includes("機動")) {
    intent.kindFilter = ["mobile"];
  } else if (q.includes("固定測速")) {
    intent.kindFilter = ["fixed"];
  }
  return intent;
}

// ===== keyword extraction =====
function extractKeywords(q: string): string[] {
  const tokens = new Set<string>();
  const chinese = q.match(
    /[一-鿿]{2,8}(?:路|大道|街|巷|橋|快速|快道|公路|交流道|隧道|區|市|鄉|鎮|縣|快速道路)/g,
  );
  chinese?.forEach((t) => tokens.add(t));
  const routes = q.match(
    /[國省](?:道)?\s*[\d一二三四五六七八九十]+|[台臺]\s*\d+(?:甲|乙|丙|丁)?|[Ff][沿縣]?道?\s*\d+/g,
  );
  routes?.forEach((t) => tokens.add(t.replace(/\s+/g, "")));
  const landmarks = q.match(
    /[一-鿿]{2,10}(?:大樓|公園|大學|國小|國中|高中|捷運|火車站|體育場|醫院|百貨)/g,
  );
  landmarks?.forEach((t) => tokens.add(t));
  // bare 2-4 char chunks as fallback
  const bare = q.match(/[一-鿿]{2,4}/g);
  bare?.slice(0, 8).forEach((t) => tokens.add(t));
  return [...tokens];
}

function scoreRelevance(point: EnforcementPoint, keywords: string[]): number {
  let s = 0;
  const blob =
    `${point.city} ${point.district} ${point.address} ${point.enforcementType ?? ""}`.toLowerCase();
  for (const kw of keywords) {
    if (blob.includes(kw.toLowerCase())) s += kw.length;
  }
  return s;
}

// ===== Haversine distance (meters) =====
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

// ===== landmark geocoding via Nominatim =====
//
// Module-scope LRU-ish cache (max 100). Cleared on each isolate restart.
const geoCache = new Map<string, { lat: number; lng: number } | null>();

async function geocodeLandmark(
  q: string,
): Promise<{ lat: number; lng: number } | null> {
  if (geoCache.has(q)) return geoCache.get(q) ?? null;
  if (geoCache.size > 100) geoCache.clear();
  try {
    const url = new URL("https://nominatim.openstreetmap.org/search");
    url.searchParams.set("q", q);
    url.searchParams.set("countrycodes", "tw");
    url.searchParams.set("format", "json");
    url.searchParams.set("limit", "1");
    url.searchParams.set("accept-language", "zh-TW");
    const res = await fetch(url.toString(), {
      headers: { "User-Agent": "FlashForce/1.0 (+github.com/Naoar1/flashforce)" },
    });
    if (!res.ok) {
      geoCache.set(q, null);
      return null;
    }
    const arr = (await res.json()) as Array<{ lat: string; lon: string }>;
    if (!arr.length) {
      geoCache.set(q, null);
      return null;
    }
    const lat = Number.parseFloat(arr[0].lat);
    const lng = Number.parseFloat(arr[0].lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      geoCache.set(q, null);
      return null;
    }
    const result = { lat, lng };
    geoCache.set(q, result);
    return result;
  } catch {
    geoCache.set(q, null);
    return null;
  }
}

// Pull "可能是地名" tokens out of a query for geocoding fallback.
function extractLandmarks(q: string): string[] {
  const out = new Set<string>();
  const m = q.match(
    /[一-鿿]{2,8}(?:橋|大道|路口|站|捷運|公園|大學|國小|國中|高中|體育場|百貨|車站)/g,
  );
  m?.forEach((t) => out.add(t));
  return [...out];
}

// ===== relevance pipeline =====
async function pickRelevantPoints(
  bundle: DataBundle,
  question: string,
  topN = 30,
): Promise<{ points: EnforcementPoint[]; mode: string }> {
  const intent = detectIntent(question);
  let pool = bundle.points;
  if (intent.kindFilter) {
    pool = pool.filter((p) => intent.kindFilter!.includes(p.kind));
  }
  if (intent.enforcementTypeContains) {
    pool = pool.filter((p) => {
      const et = p.enforcementType ?? "";
      return intent.enforcementTypeContains!.some((s) => et.includes(s));
    });
  }

  const expanded = expandQuery(question);
  const kws = extractKeywords(expanded);

  let scored = pool
    .map((p) => ({ p, s: scoreRelevance(p, kws) }))
    .sort((a, b) => b.s - a.s);

  // If keyword search hit nothing, try geocoding ALL extracted landmarks and
  // union by closest-distance to any of them.
  if (scored.length === 0 || scored[0].s === 0) {
    const landmarks = extractLandmarks(question);
    const coords: Array<{ lat: number; lng: number }> = [];
    for (const lm of landmarks) {
      const c = await geocodeLandmark(lm);
      if (c) coords.push(c);
    }
    if (coords.length > 0) {
      scored = pool
        .map((p) => {
          let minDist = Infinity;
          for (const c of coords) minDist = Math.min(minDist, distMeters(c, p));
          return { p, s: 1 / (1 + minDist / 200) };
        })
        .sort((a, b) => b.s - a.s);
      // only keep points within reasonable distance (3 km)
      scored = scored.filter((x) => x.s > 1 / (1 + 3000 / 200));
      if (scored.length > 0) {
        return {
          points: scored.slice(0, topN).map((x) => x.p),
          mode: `geo:${landmarks.join(",")}`,
        };
      }
    }
    // truly nothing — return empty so the LLM declines politely instead
    // of dumping random points (which used to surface 金門 due to alphabetical
    // index order).
    return { points: [], mode: "empty" };
  }

  return { points: scored.slice(0, topN).map((x) => x.p), mode: "keyword" };
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

你會收到使用者問題 + 一份「相關點位」清單（已經過模糊匹配 / 子類過濾 / 地名範圍篩選），務必依以下規則回答：

1. 用繁體中文，**對話口吻 + 條列**。直接回答問題，不要重複問題。
2. **列出全部相關點位**（不要只挑一個）。每點開頭加 [id]，方便對照地圖。
3. 子分類辨識：固定測速、區間測速、闖紅燈、違停、不停讓 等是不同類別 — 答題時要說清楚每點屬於哪一類，不要籠統說「科技執法」。
4. **絕對不要編造清單裡沒有的欄位**：如果某點清單沒寫速限就不要寫速限；沒寫方向就不要寫方向。誠實回應「速限資訊未提供」。
5. **絕對不要列出清單以外的點**。每個 [id] 都必須是清單裡實際出現過的。
6. 如果清單看起來不完全符合題意，誠實說「我看到的清單裡沒有 XX 路 / XX 區的點」，可以附帶提示「附近有以下相關的：...」**前提是清單裡確實有相關項**。

特殊狀況：
- 清單為空（總共 0 點）→ 回應「資料庫裡沒找到符合的點。可以給更具體的路名 / 行政區 / 路線編號嗎？」**不要編造任何點。**
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
Q: 台64 區間限速多少
A: 台64 線上有 3 段區間測速：
- [tech-19] 東向 21.4K 至 23.2K，速限 70
- [tech-20] 25.2K 至 28.2K（雙向），速限 70
- [tech-29] 西向 1.6K 至 5.4K，速限 80

範例輸出 3：
Q: 給我刺客義大利麵食譜
A: 我只能回答台灣科技執法 / 測速 / 機動測速地圖相關的問題。`;

// ===== rate limit (per-IP, 2-hour rolling window) =====
//
// Module-scope counter — simple but imperfect since CF spawns many isolates;
// a determined attacker hitting different isolates could exceed the cap.
// For a personal-use site this is OK; upgrade to KV / Durable Objects if abuse
// is observed.
interface IPState {
  count: number;
  resetAt: number;
}
const ipState = new Map<string, IPState>();
const TWO_HOURS_MS = 2 * 60 * 60 * 1000;
const MAX_PER_WINDOW = 30;
const TURNSTILE_EVERY = 4; // Q4, Q8, Q12, ... require Turnstile

function getIPState(ip: string): IPState {
  const now = Date.now();
  let s = ipState.get(ip);
  if (!s || now > s.resetAt) {
    s = { count: 0, resetAt: now + TWO_HOURS_MS };
    ipState.set(ip, s);
  }
  // basic memory hygiene: cap map size
  if (ipState.size > 5000) {
    for (const [k, v] of ipState) {
      if (now > v.resetAt) ipState.delete(k);
    }
  }
  return s;
}

async function verifyTurnstile(token: string, env: Env): Promise<boolean> {
  if (!env.TURNSTILE_SECRET) return true; // gracefully open if not configured
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

  // Every TURNSTILE_EVERY-th question: require Turnstile token
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
        {
          status: 401,
          headers: { "content-type": "application/json" },
        },
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
        {
          status: 401,
          headers: { "content-type": "application/json" },
        },
      );
    }
  }

  const bundle = await getBundle(env, req);
  const { points: relevant, mode } = await pickRelevantPoints(bundle, question);

  const userPrompt =
    relevant.length === 0
      ? `問題：${question}\n\n相關點位：（清單為空，沒有匹配的點）\n\n請依規則回答。`
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

  // Increment counter only on success
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
