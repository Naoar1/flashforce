/**
 * Mental-trace verifier for src/worker.ts retrieval pipeline.
 * Mirrors the logic in worker.ts; keep both files in sync when editing.
 * Run: npx tsx scripts/test-retrieval.ts
 */
import fs from "node:fs";

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
}

interface Alias {
  roads?: string[];
  substrs?: string[];
  cities?: string[];
}

const ALIASES: Record<string, Alias> = {
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
  "水快": { substrs: ["水源"], cities: ["臺北市", "新北市"] },
  "水源快": { substrs: ["水源"], cities: ["臺北市", "新北市"] },
  "水源快速": { substrs: ["水源"], cities: ["臺北市", "新北市"] },
  "水源快速道路": { substrs: ["水源"], cities: ["臺北市", "新北市"] },
  "建快": { substrs: ["建國"], cities: ["臺北市", "新北市"] },
  "環快": { substrs: ["環河"], cities: ["臺北市", "新北市"] },
  "信義快": { substrs: ["信義快速"], cities: ["臺北市"] },
  "汐科": { substrs: ["汐止"] },
  "淡江": { substrs: ["淡水"] },
  "陽明山": { substrs: ["仰德", "陽明山"] },
  "內科": { substrs: ["內湖"] },
  "中科": { substrs: ["西屯", "大雅"] },
  "南科": { substrs: ["善化", "新市"] },
  "竹科": { substrs: ["竹北", "東區"] },
};

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

const NOISE = new Set([
  "什麼", "幾處", "幾個", "幾段", "哪裡", "哪邊", "哪些", "如何", "怎樣",
  "怎麼", "多少", "哪一", "哪個", "有沒", "沒有", "速限", "限速", "最低",
  "最高", "最快", "最慢", "範圍", "附近", "周遭", "周邊", "資料", "點位",
  "請問", "告訴", "告知", "可以", "幫我", "給我", "查一", "查查", "現在",
  "目前", "到底", "公路", "道路", "今天", "今日",
  "大學", "國中", "國小", "高中", "高職",
]);

const ROAD_CODE_RE = /^(?:[台臺]\d{1,3}(?:[甲乙丙丁])?|國道\d{1,2}|縣道\d{1,3})$/;

interface QueryIntent {
  kindFilter?: EnforcementPoint["kind"][];
  enforcementTypeContains?: string[];
}

function detectIntent(q: string): QueryIntent {
  if (q.includes("區間")) return { kindFilter: ["tech"], enforcementTypeContains: ["區間"] };
  if (q.includes("闖紅燈")) return { kindFilter: ["tech"], enforcementTypeContains: ["闖紅燈"] };
  if (q.includes("違停") || q.includes("違規停車"))
    return { kindFilter: ["tech"], enforcementTypeContains: ["違停", "違規停車", "違規(臨時)停車"] };
  if (q.includes("不停讓") || q.includes("禮讓行人"))
    return { kindFilter: ["tech"], enforcementTypeContains: ["不停讓", "未禮讓"] };
  if (q.includes("跨越雙白") || q.includes("跨越雙黃"))
    return { kindFilter: ["tech"], enforcementTypeContains: ["跨越"] };
  if (q.includes("機動")) return { kindFilter: ["mobile"] };
  if (q.includes("固定測速")) return { kindFilter: ["fixed"] };
  if (q.includes("科技執法")) return { kindFilter: ["tech"] };
  return {};
}

function tokenize(q: string): string[] {
  let cleaned = q
    .replace(/國(?:道)?\s*\d{1,2}(?:號)?/g, " ")
    .replace(/[台臺]\s*\d{1,3}(?:甲|乙|丙|丁)?(?:線|號)?/g, " ")
    .replace(/縣道\s*\d{1,3}/g, " ");
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
  for (const m of q.matchAll(/[台臺]\s*(\d{1,3})\s*([甲乙丙丁])?/g))
    codes.add(`台${m[1]}${m[2] ?? ""}`);
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
  return { intent, roadCodes: [...codes], cityHints: [...cityHints], grepTerms: [...grepTerms] };
}

function pickRelevantPoints(points: EnforcementPoint[], q: string, topN = 30) {
  const parsed = parseQuery(q);
  let pool = points;
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
  if (parsed.roadCodes.length > 0) {
    pool = pool.filter((p) => {
      const blob = `${p.city} ${p.district} ${p.address}`;
      return parsed.roadCodes.some((rc) => blob.includes(rc));
    });
  }
  if (parsed.cityHints.length > 0) {
    const filtered = pool.filter((p) => parsed.cityHints.includes(p.city));
    if (filtered.length > 0) pool = filtered;
  }
  const scored: Array<{ p: EnforcementPoint; s: number }> = [];
  for (const p of pool) {
    const blob = `${p.city} ${p.district} ${p.address} ${p.enforcementType ?? ""}`;
    let s = 0;
    for (const t of parsed.grepTerms) if (blob.includes(t)) s += t.length;
    for (const rc of parsed.roadCodes) if (blob.includes(rc)) s += rc.length;
    if (s > 0) scored.push({ p, s });
    else if (parsed.roadCodes.length > 0 && parsed.grepTerms.length === 0)
      scored.push({ p, s: 1 });
  }
  scored.sort((a, b) => b.s - a.s);
  return { parsed, scored: scored.slice(0, topN) };
}

const bundle = JSON.parse(
  fs.readFileSync("public/data/data.json", "utf-8"),
) as { points: EnforcementPoint[] };

const TESTS = [
  { q: "南迴速限多少", expect: "台9南段+台26 in 屏東/台東" },
  { q: "南迴公路有測速嗎", expect: "same as 南迴" },
  { q: "北宜公路區間限速最低", expect: "tech 區間 on 台9, 新北/宜蘭" },
  { q: "蘇花有什麼測速", expect: "台9, 宜蘭/花蓮" },
  { q: "西濱新竹段速限多少", expect: "台61, prefer 新竹" },
  { q: "台64區間限速", expect: "tech 區間 ∩ 台64" },
  { q: "國道5號有區間測速嗎", expect: "tech 區間 ∩ 國道5 — likely empty" },
  { q: "汐科有幾處科技執法", expect: "tech ∩ substr(汐止)" },
  { q: "淡水有什麼測速點", expect: "新北市 淡水區 entries" },
  { q: "淡江大學附近測速", expect: "新北市 淡水區 (via 淡江→淡水)" },
  { q: "陽明山測速", expect: "仰德大道 + 陽明山 entries" },
  { q: "陽明山國小前的速限", expect: "fixed-908 should top" },
  { q: "中和區有哪些科技執法", expect: "tech ∩ 中和區" },
  { q: "仰德大道有幾個測速", expect: "4 仰德大道 entries" },
  { q: "中正橋接水快有科技執法點嗎", expect: "tech entries with 中正橋 + 水源" },
  { q: "建快有沒有測速", expect: "建國 entries in 臺北/新北 only" },
  { q: "雪隧速限", expect: "國道5 (0 entries → empty)" },
  { q: "新竹台61哪幾段", expect: "台61 ∩ 新竹" },
  { q: "中和台64區間", expect: "tech 區間 ∩ 台64 ∩ 中和" },
  { q: "義大利麵食譜", expect: "EMPTY-ish (trust LLM refuse)" },
  { q: "美國總統是誰", expect: "EMPTY-ish (trust LLM refuse)" },
  { q: "shfjksh", expect: "EMPTY" },
  { q: "哈囉", expect: "EMPTY" },
  { q: "你好", expect: "EMPTY" },
  { q: "中山高 八堵 速限", expect: "國道1 entries (small)" },
];

for (const t of TESTS) {
  const { parsed, scored } = pickRelevantPoints(bundle.points, t.q, 10);
  console.log("─".repeat(78));
  console.log(`Q: ${t.q}`);
  console.log(`expect: ${t.expect}`);
  console.log(
    `  roads=${JSON.stringify(parsed.roadCodes)} cities=${JSON.stringify(
      parsed.cityHints,
    )} intent=${JSON.stringify(parsed.intent)}`,
  );
  console.log(
    `  grep(${parsed.grepTerms.length}): ${parsed.grepTerms.slice(0, 12).join("|")}${parsed.grepTerms.length > 12 ? "..." : ""}`,
  );
  console.log(`  → ${scored.length} points`);
  for (const { p, s } of scored.slice(0, 5)) {
    console.log(
      `    [${s.toString().padStart(2)}] [${p.id}] ${p.kind} ${p.city} ${p.district} ${p.address.slice(0, 50)}`,
    );
  }
}
