/**
 * FlashForce Cloudflare Worker — handles /api/ask (NL Q&A) and falls
 * through everything else to static assets (the Next.js out/).
 *
 * Stack:
 *   - Workers AI binding `AI` running llama-3.1-8b-instruct (free 10K req/day)
 *   - ASSETS binding fetches the static data.json so the worker bundle stays small
 *   - Module-scope cache: data is fetched once per isolate then reused
 */
/// <reference types="@cloudflare/workers-types" />

interface Env {
  ASSETS: Fetcher;
  AI: {
    run: (
      model: string,
      input: { messages: Array<{ role: string; content: string }>; max_tokens?: number; temperature?: number },
    ) => Promise<{ response?: string }>;
  };
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

// ===== keyword extraction =====
// Common Taiwan road / area tokens we want to recognise so we can grep.
function extractKeywords(q: string): string[] {
  const tokens = new Set<string>();
  // Chinese 1-6 char chunks that look like place names or roads
  const chinese = q.match(
    /[一-鿿]{2,6}(?:路|大道|街|巷|橋|快速|快道|公路|交流道|隧道|區|市|鄉|鎮|縣)/g,
  );
  chinese?.forEach((t) => tokens.add(t));
  // Highway/route codes: 台64, 國道5, 省道, etc.
  const routes = q.match(/[國省](?:道)?\s*\d+|[台臺]\s*\d+|[Ff][沿縣]?道?\s*\d+/g);
  routes?.forEach((t) => tokens.add(t.replace(/\s+/g, "")));
  // Specific landmark tokens
  const landmarks = q.match(/[一-鿿]{2,8}(?:大樓|公園|大學|國小|國中|高中|捷運|火車站)/g);
  landmarks?.forEach((t) => tokens.add(t));
  // Bare 2-4 char chunks as a fallback
  const bare = q.match(/[一-鿿]{2,4}/g);
  bare?.slice(0, 5).forEach((t) => tokens.add(t));
  return [...tokens];
}

// ===== relevance scoring =====
function scoreRelevance(point: EnforcementPoint, keywords: string[]): number {
  let s = 0;
  const blob = `${point.city} ${point.district} ${point.address} ${point.enforcementType ?? ""}`;
  for (const kw of keywords) {
    if (blob.includes(kw)) s += kw.length; // longer keyword → higher signal
  }
  return s;
}

function pickRelevantPoints(
  points: EnforcementPoint[],
  question: string,
  topN = 30,
): EnforcementPoint[] {
  const kws = extractKeywords(question);
  if (kws.length === 0) return [];
  const scored = points
    .map((p) => ({ p, s: scoreRelevance(p, kws) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s)
    .slice(0, topN);
  return scored.map((x) => x.p);
}

// ===== prompt construction =====
function formatPoint(p: EnforcementPoint): string {
  const kindZh = { fixed: "固定測速", tech: "科技執法", mobile: "機動測速" }[p.kind];
  const parts = [
    `[${p.id}]`,
    `(${kindZh}${p.enforcementType ? `／${p.enforcementType}` : ""})`,
    `${p.city}${p.district ? " " + p.district : ""}`,
    p.address,
  ];
  if (p.speedLimit) parts.push(`速限 ${p.speedLimit}`);
  if (p.direction) parts.push(`方向 ${p.direction}`);
  return parts.join(" ");
}

const SYSTEM_PROMPT = `你是 FlashForce 的查詢助手。FlashForce 是台灣全台科技執法、測速、機動測速的地圖服務。

規則：
1. 只能根據下方提供的「相關點位」清單回答，不准編造。
2. 找不到答案就說「資料庫裡沒有找到符合的點」，不要硬猜。
3. 回答用繁體中文，簡短條列即可。每點開頭加上點位 id（例如 [tech-37]）方便對照。
4. 區分清楚 固定測速 / 科技執法 / 機動測速 三類。
5. 如果使用者問速限，列出「該點位速限」即可。
6. 不要長篇大論。`;

// ===== handlers =====
async function handleAsk(req: Request, env: Env): Promise<Response> {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }
  let body: { question?: string };
  try {
    body = (await req.json()) as { question?: string };
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

  const bundle = await getBundle(env, req);
  const relevant = pickRelevantPoints(bundle.points, question);

  if (relevant.length === 0) {
    return new Response(
      JSON.stringify({
        answer: "資料庫裡沒有找到符合這個問題的點。試試更具體的路名 / 行政區 / 路線編號。",
        cited: [],
      }),
      { headers: { "content-type": "application/json" } },
    );
  }

  const userPrompt = `問題：${question}

相關點位（總共 ${relevant.length} 點）：
${relevant.map(formatPoint).join("\n")}

請依規則回答。`;

  const aiResp = await env.AI.run("@cf/meta/llama-3.1-8b-instruct", {
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: userPrompt },
    ],
    max_tokens: 512,
    temperature: 0.2,
  });

  const answer = aiResp.response ?? "（模型沒有回應）";

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
    // fall through to static assets
    return env.ASSETS.fetch(request);
  },
};
