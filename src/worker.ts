/**
 * FlashForce Cloudflare Worker — /api/ask handler + static asset passthrough.
 *
 * Pipeline:
 *
 *   off-topic hard-cut (food / politics / weather / etc.) → instant refuse,
 *     no LLM call. Keyword list is server-side and cheap.
 *
 *   canonicalize(text) → CN digits → Arabic + 臺 → 台, applied only to
 *     numerals that immediately follow a road prefix (國/國道/台/臺/縣道).
 *     The data file mixes formats heavily (94% of 國道 rows use Chinese
 *     numerals like 國道一號, and 臺一線 / 台一線 both occur). Canonicalising
 *     both the query and each point's blob makes substring grep symmetric.
 *
 *   tokenize → overlap 2-8 char windows over Chinese chunks, with intent
 *     phrases (科技執法 / 區間測速 / 闖紅燈 …) phrase-stripped so their
 *     character fragments don't pollute scoring, and generic suffix nouns
 *     (大學 / 國小 / 國中 / 高中 / 高職) dropped.
 *
 *   alias dict (~50 entries, road-colloquials + place-colloquials) →
 *     adds roadCodes / substrs / cityHints when the user's term differs
 *     from the canonical form in data.json.
 *
 *   pool filter: intent → roadCode (canonical match) → cityHint (only
 *     applied when it leaves a non-empty subset).
 *
 *   score: substring matches in canonical blob, weighted by term length.
 *
 *   specificity gate: pure-grep mode (no roadCode / aliasSubstr / intent)
 *     drops the answer if the user's longest typed token (len ≥ 3) appears
 *     in zero scored points — kills off-topic substring coincidence like
 *     義大利 → 義大二路.
 *
 *   top-30 → llama-3.3-70b. Prompt forbids fabricating fields or asserting
 *     road equivalences, and is given an explicit list of user-typed terms
 *     that did NOT appear in any cited point so the model can flag the gap.
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

// ===== canonicalization =====
// Chinese → Arabic numerals, applied ONLY immediately after road prefixes
// (國/國道/台/縣道) so we don't break place names like 三民路, 五分埔, 九份.
// 臺 → 台 is unconditional (the two glyphs are interchangeable in TW road
// signage and the data carries both).
const CN_DIGIT: Record<string, string> = {
  "零": "0", "一": "1", "二": "2", "兩": "2", "三": "3", "四": "4",
  "五": "5", "六": "6", "七": "7", "八": "8", "九": "9",
};

function cnNumToArabic(num: string): string {
  if (num === "十") return "10";
  if (num.length === 1 && CN_DIGIT[num] !== undefined) return CN_DIGIT[num];
  if (num.length === 2 && num[0] === "十" && CN_DIGIT[num[1]] !== undefined) {
    return "1" + CN_DIGIT[num[1]];
  }
  if (num.length === 2 && num[1] === "十" && CN_DIGIT[num[0]] !== undefined) {
    return CN_DIGIT[num[0]] + "0";
  }
  if (
    num.length === 3 &&
    num[1] === "十" &&
    CN_DIGIT[num[0]] !== undefined &&
    CN_DIGIT[num[2]] !== undefined
  ) {
    return CN_DIGIT[num[0]] + CN_DIGIT[num[2]];
  }
  return num;
}

function canonicalize(text: string): string {
  return text
    .replace(/臺/g, "台")
    .replace(
      /(國道?|台|縣道)([零一二兩三四五六七八九十]+)/g,
      (_, prefix, num) => prefix + cnNumToArabic(num),
    );
}

// ===== Alias dictionary =====
// Only entries where user's spelling differs from canonical data form.
// All road / substr targets verified to have >= 1 row in data.json after
// canonicalization.
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

  // 省道 colloquials (with city hints where the road spans far)
  "北宜": { roads: ["台9"], cities: ["新北市", "宜蘭縣"] },
  "北宜公路": { roads: ["台9"], cities: ["新北市", "宜蘭縣"] },
  "蘇花": { roads: ["台9"], cities: ["宜蘭縣", "花蓮縣"] },
  "蘇花公路": { roads: ["台9"], cities: ["宜蘭縣", "花蓮縣"] },
  "蘇花改": { roads: ["台9"], cities: ["宜蘭縣", "花蓮縣"] },
  "南迴": { roads: ["台9", "台26"], cities: ["屏東縣", "台東縣"] },
  "南迴公路": { roads: ["台9", "台26"], cities: ["屏東縣", "台東縣"] },
  "北橫": { roads: ["台7"], cities: ["桃園市", "宜蘭縣", "新北市"] },
  "北橫公路": { roads: ["台7"], cities: ["桃園市", "宜蘭縣", "新北市"] },
  "中橫": { roads: ["台8"], cities: ["台中市", "南投縣", "花蓮縣"] },
  "中橫公路": { roads: ["台8"], cities: ["台中市", "南投縣", "花蓮縣"] },
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

  // 都會快速 (canonical name uses 水源/建國/環河/信義快速)
  "水快": { substrs: ["水源"], cities: ["台北市", "新北市"] },
  "水源快": { substrs: ["水源"], cities: ["台北市", "新北市"] },
  "水源快速": { substrs: ["水源"], cities: ["台北市", "新北市"] },
  "水源快速道路": { substrs: ["水源"], cities: ["台北市", "新北市"] },
  "建快": { substrs: ["建國"], cities: ["台北市", "新北市"] },
  "環快": { substrs: ["環河"], cities: ["台北市", "新北市"] },
  "信義快": { substrs: ["信義快速"], cities: ["台北市"] },

  // 地點俗稱
  "汐科": { substrs: ["汐止"], cities: ["新北市"] },
  "淡江": { substrs: ["淡水"], cities: ["新北市"] },
  "陽明山": { substrs: ["仰德", "陽明山"], cities: ["台北市"] },
  "內科": { substrs: ["內湖"], cities: ["台北市"] },
  "中科": { substrs: ["西屯", "大雅"], cities: ["台中市"] },
  "南科": { substrs: ["善化", "新市"], cities: ["台南市"] },
  "竹科": { substrs: ["竹北", "東區"], cities: ["新竹縣", "新竹市"] },
};

// City names recognised inside the query (strict admin filter when present).
const CITY_NAMES = [
  "台北市", "新北市", "基隆市", "桃園市", "新竹市", "新竹縣",
  "苗栗縣", "台中市", "彰化縣", "南投縣", "雲林縣",
  "嘉義市", "嘉義縣", "台南市", "高雄市", "屏東縣",
  "宜蘭縣", "花蓮縣", "台東縣", "澎湖縣", "金門縣", "連江縣",
];
// Short county names without 縣/市 suffix — used to split run-on landmark
// chunks like "苗栗後龍" into ["苗栗", "後龍"] for cleaner missing-term hints.
const COUNTY_SHORT = [
  "台北", "新北", "基隆", "桃園", "新竹", "苗栗", "台中",
  "彰化", "南投", "雲林", "嘉義", "台南", "高雄", "屏東",
  "宜蘭", "花蓮", "台東", "澎湖", "金門", "連江",
];

// Common single-char Mandarin particles/pronouns/connectives — stripped when
// computing the "core landmark" of a query so windowed grammar artifacts
// don't masquerade as user-typed landmarks.
const PARTICLES = new Set(
  "我你妳他她它的了是也在有沒嗎呢吧啊喔哦得那這還想要去來玩看找問能會可嘛喲對於及與和從到經過往沿並既或而但則因為所以".split(""),
);

// ===== off-topic gate =====
// Hard cut before LLM. Anything matching one of these returns a fixed
// refusal — no point retrieval, no AI call.
const OFF_TOPIC_KEYWORDS = [
  "食譜", "料理", "菜單", "美食", "餐廳", "怎麼煮", "怎麼做",
  "總統", "政治", "選舉", "議員", "立委", "政黨", "市長", "縣長",
  "新聞", "八卦", "娛樂", "明星", "電影", "音樂", "歌曲", "歌詞",
  "天氣", "氣象", "下雨", "颱風", "溫度", "幾度",
  "股票", "股市", "加密", "比特幣", "匯率", "美金",
  "笑話", "故事", "小說", "遊戲", "動漫",
  "翻譯", "英文怎麼", "中文怎麼",
];

function isOffTopic(q: string): boolean {
  return OFF_TOPIC_KEYWORDS.some((k) => q.includes(k));
}

// ===== data cache (with canonicalised blob per point) =====
interface CanonicalPoint {
  p: EnforcementPoint;
  blob: string; // canonical lowercase blob for substring matching
  city: string; // canonical city for strict admin matching
  district: string; // canonical district for strict admin matching
}

let cachedBundle: DataBundle | null = null;
let cachedCanonical: CanonicalPoint[] | null = null;

async function getCanonical(env: Env, request: Request): Promise<CanonicalPoint[]> {
  if (cachedCanonical) return cachedCanonical;
  if (!cachedBundle) {
    const url = new URL("/data/data.json", request.url);
    const res = await env.ASSETS.fetch(new Request(url.toString()));
    if (!res.ok) throw new Error(`failed to load data.json: HTTP ${res.status}`);
    cachedBundle = (await res.json()) as DataBundle;
  }
  cachedCanonical = cachedBundle.points.map((p) => ({
    p,
    blob: canonicalize(
      `${p.city} ${p.district} ${p.address} ${p.enforcementType ?? ""}`,
    ),
    city: canonicalize(p.city),
    district: canonicalize(p.district ?? ""),
  }));
  return cachedCanonical;
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
const STRIP_PHRASES = [
  "科技執法", "區間測速", "區間", "闖紅燈", "違規(臨時)停車",
  "違規停車", "違停", "未禮讓", "禮讓行人", "不停讓",
  "跨越雙白", "跨越雙黃", "機動測速", "固定測速",
  "測速照相", "測速", "拍照", "照相", "罰單", "取締",
];

// Generic road-feature substrings — stripped from cleaned query before
// chunking. Sorted longest-first so 交流道 (3) wins over 交流 (2); otherwise
// "汐止交流道附近" gets cut to "汐止 道附近" instead of "汐止 附近".
const FEATURE_FRAGMENTS = [
  "高速公路", "快速道路",
  "交流道", "高速", "高架", "快速", "道路",
  "路段", "路口", "巷口", "大橋", "小橋", "平面",
  "交流", "流道", "匝道", "隧道",
];

const NOISE = new Set([
  "什麼", "幾處", "幾個", "幾段", "幾條", "哪裡", "哪邊", "哪些", "如何",
  "怎樣", "怎麼", "多少", "哪一", "哪個", "有沒", "沒有", "速限", "限速",
  "最低", "最高", "最快", "最慢", "範圍", "附近", "周遭", "周邊", "資料",
  "點位", "請問", "告訴", "告知", "可以", "幫我", "給我", "查一", "查查",
  "現在", "目前", "到底", "公路", "道路", "今天", "今日", "謝謝", "感謝",
  "大學", "國中", "國小", "高中", "高職",
  "總共", "位置", "路線", "路徑", "沿途", "沿線", "之間", "之中", "中間",
  "處於", "屬於", "包含", "包括", "出發", "經過", "通過",
  "全台", "全國", "各地", "各縣市", "全部", "整個",
]);

const ROAD_CODE_RE = /^(?:台\d{1,3}(?:[甲乙丙丁])?|國道\d{1,2}|縣道\d{1,3})$/;

function tokenize(q: string): string[] {
  // q is already canonical here (臺→台, CN digits→Arabic after road prefix)
  let cleaned = q
    .replace(/國(?:道)?\s*\d{1,2}(?:號)?/g, " ")
    .replace(/台\s*\d{1,3}(?:甲|乙|丙|丁)?(?:線|號)?/g, " ")
    .replace(/縣道\s*\d{1,3}/g, " ");
  for (const phrase of STRIP_PHRASES) {
    if (cleaned.includes(phrase)) cleaned = cleaned.split(phrase).join(" ");
  }
  // Preserve alias-key phrases that appear in the query *before* stripping
  // feature fragments, so compound landmarks like 雪山隧道 / 蔣渭水高速公路
  // survive into the token set.
  const preserved = new Set<string>();
  for (const key of Object.keys(ALIASES)) {
    if (cleaned.includes(key)) preserved.add(key);
  }
  // Strip generic feature substrings so accidental windows like 交流道附 /
  // 流道附近 don't grep-match unrelated 國道X交流道附近 entries.
  for (const f of FEATURE_FRAGMENTS) {
    if (cleaned.includes(f)) cleaned = cleaned.split(f).join(" ");
  }
  const tokens = new Set<string>(preserved);
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
  districtHints: string[];
  speedLimit: number | null;
  kmHints: number[];
  grepTerms: string[];
  userTokens: string[]; // tokens straight from the user (no alias substitution)
  aliasHit: boolean; // user typed something matched by ALIASES
}

function parseQuery(rawQuery: string): ParsedQuery {
  const q = canonicalize(rawQuery);
  const intent = detectIntent(q);

  const codes = new Set<string>();
  for (const m of q.matchAll(/國(?:道)?\s*(\d{1,2})/g)) codes.add(`國道${m[1]}`);
  for (const m of q.matchAll(/台\s*(\d{1,3})\s*([甲乙丙丁])?/g)) {
    codes.add(`台${m[1]}${m[2] ?? ""}`);
  }
  for (const m of q.matchAll(/縣道\s*(\d{1,3})/g)) codes.add(`縣道${m[1]}`);

  const cityHints = new Set<string>();
  // City names typed directly in the query become strict admin filters.
  for (const c of CITY_NAMES) if (q.includes(c)) cityHints.add(c);

  // District-level filter — pattern like 中和區 / 淡水區 / 東區 / 金城鎮.
  // Excludes anything already captured as a city.
  const districtHints = new Set<string>();
  for (const m of q.matchAll(/([一-鿿]{1,3}[區鄉鎮市])/g)) {
    const name = m[1];
    if (CITY_NAMES.includes(name)) continue;
    districtHints.add(name);
  }

  // Speed-limit filter — "速限60" / "限速 60" → strict speedLimit === 60.
  let speedLimit: number | null = null;
  const slMatch = q.match(/(?:速限|限速)\s*(\d{2,3})/);
  if (slMatch) speedLimit = parseInt(slMatch[1], 10);

  // Kilometre hints — "100公里" / "100K" / "100k". Surfaced to the LLM so it
  // can map the user's km to entries' km markers in their address strings.
  const kmHints: number[] = [];
  for (const m of q.matchAll(/(\d{1,3})\s*(?:公里|K|k|km)/g)) {
    kmHints.push(parseInt(m[1], 10));
  }

  const tokens = tokenize(q);
  const userTokens = [...tokens];
  const grepTerms = new Set<string>(userTokens);
  let aliasHit = false;

  for (const t of tokens) {
    const ali = ALIASES[t];
    if (!ali) continue;
    aliasHit = true;
    if (ali.roads) for (const r of ali.roads) codes.add(r);
    if (ali.substrs) for (const s of ali.substrs) grepTerms.add(s);
    if (ali.cities) for (const c of ali.cities) cityHints.add(c);
  }

  for (const t of [...grepTerms]) {
    if (ROAD_CODE_RE.test(t)) grepTerms.delete(t);
  }

  return {
    intent,
    roadCodes: [...codes],
    cityHints: [...cityHints],
    districtHints: [...districtHints],
    speedLimit,
    kmHints,
    grepTerms: [...grepTerms],
    userTokens,
    aliasHit,
  };
}

// Core landmark chunks from a query — everything *after* removing road codes,
// alias keys, intent phrases, NOISE tokens, and single-char particles. Used
// for both (a) the pure-grep specificity gate and (b) computing missing-term
// hints for the LLM prompt.
function extractCoreChunks(rawQuery: string): string[] {
  let cleaned = canonicalize(rawQuery);
  for (const key of Object.keys(ALIASES)) {
    if (cleaned.includes(key)) cleaned = cleaned.split(key).join(" ");
  }
  cleaned = cleaned
    .replace(/國(?:道)?\s*\d{1,2}(?:號)?/g, " ")
    .replace(/台\s*\d{1,3}(?:甲|乙|丙|丁)?(?:線|號)?/g, " ")
    .replace(/縣道\s*\d{1,3}/g, " ");
  for (const p of STRIP_PHRASES) cleaned = cleaned.split(p).join(" ");
  for (const n of NOISE) cleaned = cleaned.split(n).join(" ");
  for (const f of FEATURE_FRAGMENTS) cleaned = cleaned.split(f).join(" ");
  for (const c of CITY_NAMES) cleaned = cleaned.split(c).join(" ");
  // Strip district patterns (X區/X鄉/X鎮/X市)
  cleaned = cleaned.replace(/[一-鿿]{1,3}[區鄉鎮市]/g, " ");
  let stripped = "";
  for (const ch of cleaned) stripped += PARTICLES.has(ch) ? " " : ch;
  const out: string[] = [];
  for (const chunk of stripped.match(/[一-鿿]+/g) ?? []) {
    if (chunk.length < 2) continue;
    // Split at admin-suffix boundaries (區/市/縣/鄉/鎮/村/里) so that
    // concatenated address-like queries decompose into pieces a single
    // address field could plausibly contain.
    let parts = chunk
      .split(/(?<=[區市縣鄉鎮村里])/g)
      .filter((x) => x.length >= 2);
    if (parts.length === 0) parts = [chunk];
    // Further split each piece at short county-name boundaries so that
    // run-on phrases like "苗栗後龍" become ["苗栗", "後龍"].
    const refined: string[] = [];
    for (const piece of parts) {
      let segs = [piece];
      for (const c of COUNTY_SHORT) {
        const next: string[] = [];
        for (const s of segs) {
          if (!s.includes(c)) {
            next.push(s);
            continue;
          }
          const sub = s.split(c);
          for (let i = 0; i < sub.length; i++) {
            if (i > 0) next.push(c);
            if (sub[i]) next.push(sub[i]);
          }
        }
        segs = next;
      }
      for (const s of segs) if (s.length >= 2) refined.push(s);
    }
    out.push(...refined);
  }
  return out;
}

// ===== retrieval =====
interface RetrievalResult {
  points: EnforcementPoint[];
  parsed: ParsedQuery;
  mode: string;
  missingUserTokens: string[];
  totalInPool: number; // pool size after filters, before topN slicing
}

function pickRelevantPoints(
  data: CanonicalPoint[],
  question: string,
  topN = 30,
): RetrievalResult {
  const parsed = parseQuery(question);
  const coreChunks = extractCoreChunks(question);
  let pool = data;

  if (parsed.intent.kindFilter) {
    const kf = parsed.intent.kindFilter;
    pool = pool.filter((x) => kf.includes(x.p.kind));
  }
  if (parsed.intent.enforcementTypeContains) {
    const et = parsed.intent.enforcementTypeContains;
    pool = pool.filter((x) => {
      const t = x.p.enforcementType ?? "";
      return et.some((s) => t.includes(s));
    });
  }
  if (parsed.roadCodes.length > 0) {
    pool = pool.filter((x) =>
      parsed.roadCodes.some((rc) => x.blob.includes(rc)),
    );
  }
  if (parsed.cityHints.length > 0) {
    const filtered = pool.filter((x) => parsed.cityHints.includes(x.city));
    if (filtered.length > 0) pool = filtered;
  }
  if (parsed.districtHints.length > 0) {
    const filtered = pool.filter((x) =>
      parsed.districtHints.includes(x.district),
    );
    if (filtered.length > 0) pool = filtered;
  }
  if (parsed.speedLimit !== null) {
    pool = pool.filter((x) => x.p.speedLimit === parsed.speedLimit);
  }

  const filterActive =
    !!parsed.intent.kindFilter ||
    !!parsed.intent.enforcementTypeContains ||
    parsed.roadCodes.length > 0 ||
    parsed.cityHints.length > 0 ||
    parsed.districtHints.length > 0 ||
    parsed.speedLimit !== null;

  const totalInPool = pool.length;
  const scored: Array<{ p: EnforcementPoint; blob: string; s: number }> = [];
  for (const { p, blob } of pool) {
    let s = 0;
    for (const t of parsed.grepTerms) if (blob.includes(t)) s += t.length;
    for (const rc of parsed.roadCodes) if (blob.includes(rc)) s += rc.length;
    if (s > 0) {
      scored.push({ p, blob, s });
    } else if (filterActive && coreChunks.length === 0) {
      // User narrowed via intent / road / city / alias only — no real
      // landmark in the query (e.g. "闖紅燈在哪裡多", "南橫速限"). Every
      // pool row already satisfies the filter; rank arbitrarily so the
      // LLM gets the full set.
      scored.push({ p, blob, s: 1 });
    }
  }
  scored.sort((a, b) => b.s - a.s);
  let top = scored.slice(0, topN);

  // Specificity gate — pure-grep mode only (no intent / road / alias). The
  // gate compares the query's *core chunks* (post-strip of intent / NOISE /
  // particles / alias keys) against cited blobs. If none of the chunks
  // appears anywhere, we're matching by character coincidence (e.g. 義大
  // in 義大二路 when user actually meant 義大利).
  const pureGrep =
    parsed.roadCodes.length === 0 &&
    !parsed.aliasHit &&
    !parsed.intent.kindFilter &&
    !parsed.intent.enforcementTypeContains &&
    parsed.cityHints.length === 0 &&
    parsed.districtHints.length === 0 &&
    parsed.speedLimit === null;
  let gateTriggered = false;
  if (pureGrep && coreChunks.length > 0) {
    const anyMatch = top.some((x) =>
      coreChunks.some((c) => x.blob.includes(c)),
    );
    if (!anyMatch) {
      top = [];
      gateTriggered = true;
    }
  }

  // Missing-terms hint for the LLM: core chunks not present in any cited
  // point. Limited to 4 entries.
  const missingUserTokens: string[] = [];
  for (const c of coreChunks) {
    if (top.some((x) => x.blob.includes(c))) continue;
    if (missingUserTokens.includes(c)) continue;
    missingUserTokens.push(c);
    if (missingUserTokens.length >= 4) break;
  }

  const modeParts: string[] = [];
  if (parsed.intent.kindFilter) {
    modeParts.push(`kind:${parsed.intent.kindFilter.join(",")}`);
  }
  if (parsed.intent.enforcementTypeContains) {
    modeParts.push(`type:${parsed.intent.enforcementTypeContains.join("/")}`);
  }
  if (parsed.roadCodes.length > 0) {
    modeParts.push(`roads:${parsed.roadCodes.join("|")}`);
  }
  if (parsed.cityHints.length > 0) {
    modeParts.push(`cities:${parsed.cityHints.join("|")}`);
  }
  if (parsed.districtHints.length > 0) {
    modeParts.push(`districts:${parsed.districtHints.join("|")}`);
  }
  if (parsed.speedLimit !== null) {
    modeParts.push(`speed:${parsed.speedLimit}`);
  }
  if (parsed.kmHints.length > 0) {
    modeParts.push(`km:${parsed.kmHints.join(",")}`);
  }
  if (parsed.grepTerms.length > 0) {
    modeParts.push(`grep:${parsed.grepTerms.length}`);
  }
  if (gateTriggered) modeParts.push("gate");
  const mode = modeParts.join(" ") || "empty";

  return {
    points: top.map((x) => x.p),
    parsed,
    mode,
    missingUserTokens,
    totalInPool,
  };
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

const SYSTEM_PROMPT = `你是 FlashForce 的查詢助手。FlashForce 是台灣全台科技執法、測速、機動測速地圖。

任務：依 user 問題 + 「相關點位」清單作答。

絕對規則（違反任一條即視為錯誤回應）：
1. 只能引用清單裡實際出現的 [id]，逐字對應，不可自創。
2. 不要編造速限、方向、子分類、路線、行政區、地點等任何欄位。清單沒寫就不要寫。
3. 不要做出資料中沒有明確顯示的等價聲明（不要說「南迴=國道3」「中山高=國道5」之類）。如果清單裡的點本身有路線編號，就用清單上的；沒有就只引用地址。
4. 「missing-terms」欄位（若有）列出 user 提到、但清單中沒有任何點包含的詞。**遇到時：在回答最前面誠實說「資料庫沒看到 \`X\` 相關的點」**，再列出清單裡實際有的相關點作參考。不要把附近不相干的點冒充成 user 問的位置。
5. 「pool-total」是符合過濾條件的點位總數。**清單只列前 30 個樣本**。若 user 問「總共幾個 / 全部 / 多少」**請使用 pool-total，明確說明「共 N 個，這裡列前 30」**。不要把 30 當總數回答。
6. 「km-hints」是 user 提到的公里數（如「100公里」「100K」）。清單中每個點的地址通常含 \`XXX公里\` 或 \`XX.XK\` 標記，**請只列出與 user km 相近的點**（±5K 內）；其它請過濾掉，或註明「其他段不在你問的範圍」。
7. 多 landmark 路徑題（例如 "從八里經台61到後龍"）：每點地址的 km 標記指出位置，**只列在 user 路徑 km 範圍內的點**。例如八里 ~ 後龍對應 \`台61\` 約 0–110K，143K 的點不在路徑上，要排除或明說。
8. 清單為空（0 點）→ 回答「資料庫沒找到符合條件的點。試試更具體的路線編號（台9線、國道3號…）、行政區（士林區、新竹縣…）或實際路名。」**完全不要列任何 [id]。**

風格：
- 繁體中文。簡短，直接回答，不要重複問題。
- 條列：每個相關點一行，格式 \`- [id] 地點 (子分類)\`，速限/方向若清單有就附。
- 數量明確：使用 pool-total 為總數，提到「列出前 N 個」若樣本不足。

範例 1（直接命中）：
Q: 仰德大道速限
pool-total: 4
list: [fixed-905]…[fixed-906]…[fixed-907]…[fixed-908]
A:
仰德大道有 4 個固定測速：
- [fixed-905] 仰德大道2段29巷 速限 50
- [fixed-906] 仰德大道2段115巷口 速限 50
- [fixed-907] 仰德大道四段75號 速限 40
- [fixed-908] 仰德大道3段陽明山國小前 速限 40

範例 2（user 提了清單沒有的具體地標）：
Q: 中山高八堵段速限
pool-total: 83
list: [tech-39] 國道1號 桃園交流道 … (30 個)
missing-terms: 八堵
A:
資料庫沒看到「八堵」相關的國道1號點位。我能找到的是其他國道1號科技執法（pool 共 83 個，這裡列前 30）：
- [tech-39] 國道1號 桃園交流道南下入口匝道
- [tech-40] 國道1號 桃園交流道南下入口環道
…

範例 3（全台總數題）：
Q: 全台固定測速有幾個
pool-total: 1834
list: [fixed-1] … (30 個樣本)
A:
全台共 1834 個固定測速。以下列出前 30 個樣本：
- …

範例 4（empty）：
Q: 南橫速限
list: （空）
A:
資料庫沒找到符合條件的點。試試更具體的路線編號（台9線、國道3號…）、行政區（士林區、新竹縣…）或實際路名。`;

const OFF_TOPIC_ANSWER =
  "我只能回答台灣科技執法 / 測速 / 機動測速地圖相關的問題。";

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

  // Off-topic short-circuit — bypass everything, no LLM call.
  if (isOffTopic(question)) {
    state.count += 1;
    return new Response(
      JSON.stringify({
        answer: OFF_TOPIC_ANSWER,
        cited: [],
        mode: "off-topic",
        remainingInWindow: MAX_PER_WINDOW - state.count,
      }),
      { headers: { "content-type": "application/json" } },
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

  const data = await getCanonical(env, req);
  const {
    points: relevant,
    mode,
    missingUserTokens,
    totalInPool,
    parsed,
  } = pickRelevantPoints(data, question);

  const headerLines: string[] = [`pool-total: ${totalInPool}`];
  if (missingUserTokens.length > 0) {
    headerLines.push(`missing-terms: ${missingUserTokens.join(", ")}`);
  }
  if (parsed.kmHints.length > 0) {
    headerLines.push(`km-hints: ${parsed.kmHints.join(", ")}`);
  }
  const header = headerLines.join("\n");

  const userPrompt =
    relevant.length === 0
      ? `問題：${question}\n\n${header}\n相關點位：（空）\n\n請依規則回答。`
      : `問題：${question}\n\n${header}\n相關點位（樣本 ${relevant.length} 個，pool 共 ${totalInPool} 個）：\n${relevant
          .map(formatPoint)
          .join("\n")}\n\n請依規則回答。`;

  const aiResp = await env.AI.run("@cf/meta/llama-3.3-70b-instruct-fp8-fast", {
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: userPrompt },
    ],
    max_tokens: 800,
    temperature: 0.15,
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
      missingUserTokens,
      totalInPool,
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
