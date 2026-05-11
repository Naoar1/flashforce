/**
 * Local verifier mirroring src/worker.ts retrieval pipeline against
 * public/data/data.json. Keep both files in sync when editing logic.
 *
 * Each test case carries `expect` describing what must hold for it to
 * pass:
 *   - mode    — substring expected in `mode` (e.g. "roads:國道5")
 *   - hasId   — at least one of these point IDs must appear in top-N
 *   - allCities — every returned point's city must be in this set
 *   - empty   — top-N must be empty (refusal case)
 *   - missing — these tokens must appear in missingUserTokens
 *   - offTopic — query must trigger isOffTopic (no retrieval run)
 *
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

const CN_DIGIT: Record<string, string> = {
  "零": "0", "一": "1", "二": "2", "兩": "2", "三": "3", "四": "4",
  "五": "5", "六": "6", "七": "7", "八": "8", "九": "9",
};

function cnNumToArabic(num: string): string {
  if (num === "十") return "10";
  if (num.length === 1 && CN_DIGIT[num] !== undefined) return CN_DIGIT[num];
  if (num.length === 2 && num[0] === "十" && CN_DIGIT[num[1]] !== undefined)
    return "1" + CN_DIGIT[num[1]];
  if (num.length === 2 && num[1] === "十" && CN_DIGIT[num[0]] !== undefined)
    return CN_DIGIT[num[0]] + "0";
  if (
    num.length === 3 && num[1] === "十" &&
    CN_DIGIT[num[0]] !== undefined && CN_DIGIT[num[2]] !== undefined
  )
    return CN_DIGIT[num[0]] + CN_DIGIT[num[2]];
  return num;
}

function canonicalize(text: string): string {
  return text
    .replace(/臺/g, "台")
    .replace(/(國道?|台|縣道)([零一二兩三四五六七八九十]+)/g, (_, p, n) => p + cnNumToArabic(n));
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
  "水快": { substrs: ["水源"], cities: ["台北市", "新北市"] },
  "水源快": { substrs: ["水源"], cities: ["台北市", "新北市"] },
  "水源快速": { substrs: ["水源"], cities: ["台北市", "新北市"] },
  "水源快速道路": { substrs: ["水源"], cities: ["台北市", "新北市"] },
  "建快": { substrs: ["建國"], cities: ["台北市", "新北市"] },
  "環快": { substrs: ["環河"], cities: ["台北市", "新北市"] },
  "信義快": { substrs: ["信義快速"], cities: ["台北市"] },
  "汐科": { substrs: ["汐止"], cities: ["新北市"] },
  "淡江": { substrs: ["淡水"], cities: ["新北市"] },
  "陽明山": { substrs: ["仰德", "陽明山"], cities: ["台北市"] },
  "內科": { substrs: ["內湖"], cities: ["台北市"] },
  "中科": { substrs: ["西屯", "大雅"], cities: ["台中市"] },
  "南科": { substrs: ["善化", "新市"], cities: ["台南市"] },
  "竹科": { substrs: ["竹北", "東區"], cities: ["新竹縣", "新竹市"] },
};

const CITY_NAMES = [
  "台北市", "新北市", "基隆市", "桃園市", "新竹市", "新竹縣",
  "苗栗縣", "台中市", "彰化縣", "南投縣", "雲林縣",
  "嘉義市", "嘉義縣", "台南市", "高雄市", "屏東縣",
  "宜蘭縣", "花蓮縣", "台東縣", "澎湖縣", "金門縣", "連江縣",
];
const COUNTY_SHORT = [
  "台北", "新北", "基隆", "桃園", "新竹", "苗栗", "台中",
  "彰化", "南投", "雲林", "嘉義", "台南", "高雄", "屏東",
  "宜蘭", "花蓮", "台東", "澎湖", "金門", "連江",
];

const PARTICLES = new Set(
  "我你妳他她它的了是也在有沒嗎呢吧啊喔哦得那這還想要去來玩看找問能會可嘛喲對於及與和從到經過往沿並既或而但則因為所以上下插起把將被讓且若如且各每某該本另就只僅僅但卻才其前後左右走行開騎坐騎跑騎乘搭".split(""),
);

const OFF_TOPIC_KEYWORDS = [
  "食譜", "料理", "菜單", "美食", "餐廳", "怎麼煮", "怎麼做", "想煮", "煮飯",
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

const STRIP_PHRASES = [
  "科技執法", "區間測速", "區間", "闖紅燈", "違規(臨時)停車",
  "違規停車", "違停", "未禮讓", "禮讓行人", "不停讓",
  "跨越雙白", "跨越雙黃", "機動測速", "固定測速",
  "測速照相", "測速", "拍照", "照相", "罰單", "取締",
];

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
    .replace(/台\s*\d{1,3}(?:甲|乙|丙|丁)?(?:線|號)?/g, " ")
    .replace(/縣道\s*\d{1,3}/g, " ");
  for (const phrase of STRIP_PHRASES) {
    if (cleaned.includes(phrase)) cleaned = cleaned.split(phrase).join(" ");
  }
  const preserved = new Set<string>();
  for (const key of Object.keys(ALIASES)) {
    if (cleaned.includes(key)) preserved.add(key);
  }
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

interface ParsedQuery {
  intent: QueryIntent;
  roadCodes: string[];
  cityHints: string[];
  districtHints: string[];
  speedLimit: number | null;
  kmHints: number[];
  grepTerms: string[];
  userTokens: string[];
  aliasHit: boolean;
}

function parseQuery(rawQuery: string): ParsedQuery {
  const q = canonicalize(rawQuery);
  const intent = detectIntent(q);
  const codes = new Set<string>();
  for (const m of q.matchAll(/國(?:道)?\s*(\d{1,2})/g)) codes.add(`國道${m[1]}`);
  for (const m of q.matchAll(/台\s*(\d{1,3})\s*([甲乙丙丁])?/g))
    codes.add(`台${m[1]}${m[2] ?? ""}`);
  for (const m of q.matchAll(/縣道\s*(\d{1,3})/g)) codes.add(`縣道${m[1]}`);
  const cityHints = new Set<string>();
  for (const c of CITY_NAMES) if (q.includes(c)) cityHints.add(c);
  const districtHints = new Set<string>();
  for (const m of q.matchAll(/([一-鿿]{1,3})(區|鄉|鎮|市)/g)) {
    const full = m[1] + m[2];
    if (CITY_NAMES.includes(full)) continue;
    districtHints.add(full);
  }
  for (const m of q.matchAll(/([一-鿿]{2,3})(段|邊|側|頭|口|橋頭)/g)) {
    const stem = m[1];
    if (!districtStems.has(stem)) continue;
    for (const suf of ["區", "鄉", "鎮", "市"]) {
      const candidate = stem + suf;
      if (CITY_NAMES.includes(candidate)) continue;
      districtHints.add(candidate);
    }
  }
  let speedLimit: number | null = null;
  const slMatch = q.match(/(?:速限|限速)\s*(\d{2,3})/);
  if (slMatch) speedLimit = parseInt(slMatch[1], 10);
  const kmHints: number[] = [];
  for (const m of q.matchAll(/(\d{1,3})\s*(?:公里|K|k|km)/g)) kmHints.push(parseInt(m[1], 10));
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
  cleaned = cleaned.replace(/[一-鿿]{1,3}(?:區|鄉|鎮|市|段|邊|側|頭|口|橋頭)/g, " ");
  let stripped = "";
  for (const ch of cleaned) stripped += PARTICLES.has(ch) ? " " : ch;
  const out: string[] = [];
  for (const chunk of stripped.match(/[一-鿿]+/g) ?? []) {
    if (chunk.length < 2) continue;
    let parts = chunk.split(/(?<=[區市縣鄉鎮村里])/g).filter((x) => x.length >= 2);
    if (parts.length === 0) parts = [chunk];
    const refined: string[] = [];
    for (const piece of parts) {
      let segs = [piece];
      for (const c of COUNTY_SHORT) {
        const next: string[] = [];
        for (const s of segs) {
          if (!s.includes(c)) { next.push(s); continue; }
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

interface CanonicalPoint {
  p: EnforcementPoint;
  blob: string;
  city: string;
  district: string;
}

type Bbox = [number, number, number, number];
const BBOX_EXPAND = 0.03;

function bboxContains(b: Bbox, lat: number, lng: number): boolean {
  return lat >= b[0] && lat <= b[1] && lng >= b[2] && lng <= b[3];
}

interface RetrievalResult {
  points: EnforcementPoint[];
  parsed: ParsedQuery;
  mode: string;
  missingUserTokens: string[];
  totalInPool: number;
  scored: Array<{ p: EnforcementPoint; s: number }>;
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
    pool = pool.filter((x) => parsed.roadCodes.some((rc) => x.blob.includes(rc)));
  }
  if (parsed.cityHints.length > 0) {
    const filtered = pool.filter((x) => parsed.cityHints.includes(x.city));
    if (filtered.length > 0) pool = filtered;
  }
  if (parsed.districtHints.length > 0) {
    const exact = pool.filter((x) => parsed.districtHints.includes(x.district));
    if (exact.length > 0) {
      pool = exact;
    } else {
      const bboxes: Bbox[] = [];
      for (const d of parsed.districtHints) {
        const b = districtBbox.get(d);
        if (b) bboxes.push(b);
      }
      if (bboxes.length > 0) {
        const spatial = pool.filter((x) => bboxes.some((b) => bboxContains(b, x.p.lat, x.p.lng)));
        if (spatial.length > 0) pool = spatial;
      }
    }
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
    if (s > 0) scored.push({ p, blob, s });
  }
  if (scored.length === 0 && filterActive && coreChunks.length === 0) {
    for (const { p, blob } of pool) scored.push({ p, blob, s: 1 });
  }
  scored.sort((a, b) => b.s - a.s);
  let top = scored.slice(0, topN);

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
    const anyMatch = top.some((x) => coreChunks.some((c) => x.blob.includes(c)));
    if (!anyMatch) {
      top = [];
      gateTriggered = true;
    }
  }

  const missingUserTokens: string[] = [];
  for (const c of coreChunks) {
    if (top.some((x) => x.blob.includes(c))) continue;
    if (missingUserTokens.includes(c)) continue;
    missingUserTokens.push(c);
    if (missingUserTokens.length >= 4) break;
  }
  if (missingUserTokens.length > 0) top = top.slice(0, 5);

  const modeParts: string[] = [];
  if (parsed.intent.kindFilter) modeParts.push(`kind:${parsed.intent.kindFilter.join(",")}`);
  if (parsed.intent.enforcementTypeContains)
    modeParts.push(`type:${parsed.intent.enforcementTypeContains.join("/")}`);
  if (parsed.roadCodes.length > 0) modeParts.push(`roads:${parsed.roadCodes.join("|")}`);
  if (parsed.cityHints.length > 0) modeParts.push(`cities:${parsed.cityHints.join("|")}`);
  if (parsed.districtHints.length > 0) modeParts.push(`districts:${parsed.districtHints.join("|")}`);
  if (parsed.speedLimit !== null) modeParts.push(`speed:${parsed.speedLimit}`);
  if (parsed.kmHints.length > 0) modeParts.push(`km:${parsed.kmHints.join(",")}`);
  if (parsed.grepTerms.length > 0) modeParts.push(`grep:${parsed.grepTerms.length}`);
  if (gateTriggered) modeParts.push("gate");
  const mode = modeParts.join(" ") || "empty";

  return {
    points: top.map((x) => x.p),
    parsed,
    mode,
    missingUserTokens,
    totalInPool,
    scored: top.map((x) => ({ p: x.p, s: x.s })),
  };
}

// ---- Build canonical data ----
const bundle = JSON.parse(fs.readFileSync("public/data/data.json", "utf-8")) as {
  points: EnforcementPoint[];
};
const data: CanonicalPoint[] = bundle.points.map((p) => ({
  p,
  blob: canonicalize(`${p.city} ${p.district} ${p.address} ${p.enforcementType ?? ""}`),
  city: canonicalize(p.city),
  district: canonicalize(p.district ?? ""),
}));
const districtBbox = new Map<string, Bbox>();
for (const x of data) {
  if (!x.district) continue;
  const b = districtBbox.get(x.district);
  if (!b) districtBbox.set(x.district, [x.p.lat, x.p.lat, x.p.lng, x.p.lng]);
  else {
    b[0] = Math.min(b[0], x.p.lat); b[1] = Math.max(b[1], x.p.lat);
    b[2] = Math.min(b[2], x.p.lng); b[3] = Math.max(b[3], x.p.lng);
  }
}
for (const b of districtBbox.values()) {
  b[0] -= BBOX_EXPAND; b[1] += BBOX_EXPAND;
  b[2] -= BBOX_EXPAND; b[3] += BBOX_EXPAND;
}
const districtStems = new Set<string>();
for (const d of districtBbox.keys()) {
  const m = d.match(/^(.+?)(區|鄉|鎮|市)$/);
  if (m && m[1].length >= 2) districtStems.add(m[1]);
}

// ---- Expectations + assertions ----
interface Expect {
  mode?: string;
  empty?: boolean;
  offTopic?: boolean;
  hasId?: string[];
  allCities?: string[];
  minCount?: number;
  maxCount?: number;
  missing?: string[];
  minTotalPool?: number;
  maxTotalPool?: number;
  allSpeedLimit?: number;
}

interface Case {
  q: string;
  why: string;
  expect: Expect;
}

const CASES: Case[] = [
  // ===== CN-numeral road codes (the bug user found) =====
  { q: "國四有測速嗎", why: "CN numeral → 國道4", expect: { mode: "國道4" } },
  { q: "國一速限", why: "CN numeral → 國道1, data has 77 國道一號", expect: { mode: "國道1", minCount: 10 } },
  { q: "國二有沒有", why: "CN numeral → 國道2", expect: { mode: "國道2", minCount: 1 } },
  { q: "國三有幾個", why: "CN numeral → 國道3", expect: { mode: "國道3", minCount: 10 } },
  { q: "國五區間測速", why: "CN numeral + intent → 國道5 區間", expect: { mode: "國道5" } },
  { q: "國六", why: "CN numeral", expect: { mode: "國道6", minCount: 1 } },
  { q: "國八", why: "CN numeral", expect: { mode: "國道8", minCount: 1 } },
  { q: "國十", why: "CN numeral 十 → 10", expect: { mode: "國道10", minCount: 1 } },
  { q: "國道五號有測速嗎", why: "CN 五號 → 5", expect: { mode: "國道5", minCount: 10 } },
  { q: "國道一號台北段", why: "CN + landmark", expect: { mode: "國道1" } },
  // ===== mixed Arabic / CN forms =====
  { q: "國道5", why: "Arabic 5 must still work", expect: { mode: "國道5", minCount: 10 } },
  { q: "國道3號", why: "Arabic 3號", expect: { mode: "國道3", minCount: 10 } },
  { q: "國5", why: "short Arabic form", expect: { mode: "國道5", minCount: 10 } },
  // ===== 台 / 臺 normalization =====
  { q: "台九線速限", why: "CN 九 → 9", expect: { mode: "台9", minCount: 10 } },
  { q: "臺一線", why: "臺 → 台 + 一 → 1", expect: { mode: "台1" } },
  { q: "台5線", why: "Arabic 5", expect: { mode: "台5", minCount: 1 } },
  { q: "台9線", why: "Arabic 9", expect: { mode: "台9", minCount: 10 } },
  { q: "台64", why: "two-digit Arabic", expect: { mode: "台64", minCount: 3 } },
  { q: "台61", why: "two-digit", expect: { mode: "台61", minCount: 10 } },
  { q: "台2甲線", why: "Arabic + 甲", expect: { mode: "台2甲" } },
  // ===== road colloquials (alias dict) =====
  { q: "南迴速限多少", why: "alias → 台9 + 台26, cities 屏東/台東", expect: { mode: "台9", allCities: ["屏東縣", "台東縣"] } },
  { q: "南迴公路", why: "alias matches multi-char form", expect: { mode: "台9" } },
  { q: "北宜公路區間限速", why: "alias 北宜 + intent 區間, 台9 in 新北/宜蘭", expect: { mode: "type:區間", allCities: ["新北市", "宜蘭縣"] } },
  { q: "蘇花有什麼測速", why: "台9 in 宜蘭/花蓮", expect: { mode: "台9" } },
  { q: "西濱新竹段", why: "台61, prefer 新竹 via grep", expect: { mode: "台61", hasId: ["fixed-108", "fixed-800"] } },
  { q: "中山高八堵", why: "alias 中山高 → 國道1; 八堵 in missing list", expect: { mode: "國道1", missing: ["八堵"] } },
  { q: "雪隧", why: "alias → 國道5 (formerly 0 hits, now 20)", expect: { mode: "國道5", minCount: 10 } },
  { q: "雪山隧道速限", why: "longer alias key", expect: { mode: "國道5", minCount: 10 } },
  { q: "蔣渭水高速公路", why: "long alias", expect: { mode: "國道5", minCount: 5 } },
  { q: "二高有沒有區間", why: "alias 二高 → 國道3 + intent 區間", expect: { mode: "國道3" } },
  // ===== city / district / valid 2-char place tokens =====
  { q: "淡水有什麼測速", why: "淡水 in 19 addresses", expect: { hasId: ["fixed-1124", "fixed-1125"] } },
  { q: "汐止科技執法", why: "kind tech + 汐止 substring", expect: { mode: "kind:tech", allCities: ["新北市"] } },
  { q: "中和區科技執法", why: "tech + 中和", expect: { mode: "kind:tech", allCities: ["新北市"] } },
  { q: "士林區有沒有測速", why: "士林 in 10 addresses", expect: { minCount: 5 } },
  { q: "新竹縣台61", why: "city + road both filter", expect: { mode: "台61", allCities: ["新竹縣"] } },
  { q: "仰德大道", why: "specific landmark, 4 entries", expect: { hasId: ["fixed-905", "fixed-906", "fixed-907", "fixed-908"], minCount: 4 } },
  // ===== place colloquials =====
  { q: "汐科有幾處科技執法", why: "汐科 → 汐止, tech filter", expect: { mode: "kind:tech", allCities: ["新北市"] } },
  { q: "淡江大學測速", why: "淡江 → 淡水", expect: { allCities: ["新北市"] } },
  { q: "陽明山國小前速限", why: "陽明山 alias + landmark; fixed-908 should top", expect: { hasId: ["fixed-908"] } },
  { q: "陽明山測速", why: "alias substrs 仰德 + 陽明山", expect: { hasId: ["fixed-908"] } },
  { q: "建快有沒有測速", why: "建快 → 建國, city 台北/新北", expect: { allCities: ["台北市", "新北市"] } },
  { q: "水快有測速嗎", why: "水快 → 水源, 台北/新北", expect: { allCities: ["台北市", "新北市"] } },
  // ===== intent filtering =====
  { q: "台64區間限速", why: "tech 區間 ∩ 台64", expect: { mode: "type:區間", minCount: 1 } },
  { q: "新北違停科技執法", why: "違停 enforcementType filter", expect: { mode: "type:違停", minCount: 1 } },
  { q: "闖紅燈在哪裡多", why: "闖紅燈 filter; pool large enough to return many", expect: { mode: "type:闖紅燈", minCount: 10 } },
  { q: "機動測速哪邊有", why: "kind mobile (5 total)", expect: { mode: "kind:mobile" } },
  // ===== off-topic =====
  { q: "義大利麵食譜怎麼做", why: "food → off-topic hard cut", expect: { offTopic: true } },
  { q: "美國總統是誰", why: "politics → off-topic", expect: { offTopic: true } },
  { q: "明天台北天氣", why: "weather", expect: { offTopic: true } },
  { q: "比特幣現在多少錢", why: "crypto", expect: { offTopic: true } },
  { q: "講個笑話", why: "entertainment", expect: { offTopic: true } },
  { q: "翻譯這句話", why: "translation request", expect: { offTopic: true } },
  // ===== specificity gate / partial-match cases =====
  { q: "義大利", why: "no off-topic kw, but 義大利 not in any address — gate", expect: { empty: true } },
  { q: "宇宙無敵爆笑神奇路", why: "non-sense landmark, pure grep, no match", expect: { empty: true } },
  // ===== gibberish =====
  { q: "shfjksh", why: "non-Chinese gibberish", expect: { empty: true } },
  { q: "哈囉", why: "greeting", expect: { empty: true } },
  { q: "你好", why: "greeting", expect: { empty: true } },
  { q: "ok", why: "very short", expect: { empty: true } },
  // ===== aliases pointing to 0-data roads (refusal expected) =====
  { q: "南橫速限", why: "data has 臺20 (canonicalised to 台20) → 4 entries 台南", expect: { mode: "roads:台20", minCount: 1, allCities: ["台南市"] } },
  { q: "玉山公路有測速嗎", why: "data has 臺21 → 2 entries 南投", expect: { mode: "roads:台21", minCount: 1, allCities: ["南投縣"] } },
  // ===== polite phrasing prefixes shouldn't break things =====
  { q: "請問國道5號有測速嗎", why: "請問 noise stripped", expect: { mode: "國道5", minCount: 10 } },
  { q: "幫我查台9線", why: "幫我查 noise", expect: { mode: "台9", minCount: 10 } },
  // ===== multi-road queries =====
  { q: "國道3和國道5", why: "two road codes; union", expect: { mode: "國道" } },
  // ===== user-provided multi-landmark route query =====
  {
    q: "我從八里經台61過苗栗後龍 總共有幾個測速 速限最低的位置在哪裡",
    why: "multi-landmark route on 台61: 八里→苗栗→後龍; 台61 pool ~34",
    expect: { mode: "roads:台61", minCount: 5, minTotalPool: 30 },
  },
  // ===== speedLimit filter =====
  { q: "速限50的測速點", why: "should filter pool to speedLimit=50", expect: { mode: "speed:50", allSpeedLimit: 50, minCount: 1 } },
  { q: "速限60有哪些", why: "speedLimit=60 filter", expect: { mode: "speed:60", allSpeedLimit: 60 } },
  { q: "速限100", why: "speedLimit=100 filter", expect: { mode: "speed:100", allSpeedLimit: 100 } },
  // ===== km hints =====
  { q: "台61線100公里附近", why: "km hint 100 + 台61 road", expect: { mode: "km:100" } },
  { q: "台9線80K", why: "km hint 80", expect: { mode: "km:80" } },
  // ===== nationwide / total =====
  { q: "全台固定測速有幾個", why: "intent fixed; pool ~1800+; LLM should answer 1834 via pool-total", expect: { mode: "kind:fixed", minTotalPool: 1800 } },
  { q: "全台科技執法總共幾個", why: "intent tech; pool ~830", expect: { mode: "kind:tech", minTotalPool: 800 } },
  { q: "區間測速全台共幾個", why: "intent 區間; pool ~38", expect: { mode: "type:區間", minTotalPool: 30, maxTotalPool: 50 } },
  // ===== multi-city =====
  { q: "新北市和台北市的科技執法", why: "two cities, intent tech", expect: { mode: "cities:", allCities: ["新北市", "台北市"] } },
  // ===== interchange / bridge / mrt-like landmarks =====
  { q: "汐止交流道附近測速", why: "汐止 substring matches 12 entries; 交流道 may match nothing", expect: { minCount: 1, allCities: ["新北市"] } },
  { q: "華江橋有測速嗎", why: "華江橋 might not be in data; specificity gate decides", expect: {} },
  // ===== typo / unusual phrasing =====
  { q: "台九縣速限", why: "縣 typo for 線; canonicalize 九→9; pool台9", expect: { mode: "roads:台9", minCount: 10 } },
  { q: "台9台9台9", why: "repeated; Set dedup", expect: { mode: "roads:台9", minCount: 10 } },
  // ===== enforcement type variants =====
  { q: "不停讓行人科技執法", why: "intent 不停讓 + tech", expect: { mode: "type:不停讓" } },
  { q: "新北違停取締", why: "違停 intent + 新北city", expect: { mode: "type:違停", allCities: ["新北市"] } },
  // ===== additional edge cases =====
  { q: "全台機動測速", why: "全台 NOISE; mobile kind; pool ~5", expect: { mode: "kind:mobile", minCount: 1 } },
  { q: "蔣渭水高速公路", why: "alias 蔣渭水高速公路 must survive feature-fragment strip", expect: { mode: "roads:國道5", minCount: 5 } },
  { q: "雪山隧道速限", why: "alias 雪山隧道 must survive 隧道 strip", expect: { mode: "roads:國道5", minCount: 10 } },
  { q: "西濱快速公路測速", why: "alias 西濱快速公路 must survive 快速公路 strip", expect: { mode: "roads:台61", minCount: 10 } },
  { q: "高雄市區的科技執法", why: "高雄市 city + tech; 市區 ambiguous shouldn't double-filter", expect: { mode: "kind:tech", allCities: ["高雄市"] } },
  { q: "我家附近有測速嗎", why: "no real landmark; should return empty", expect: { empty: true } },
  { q: "桃園機場有測速嗎", why: "桃園 substring matches, 機場 might not", expect: { minCount: 1 } },
  // Specific bridge in 新竹/苗栗 etc.
  { q: "中正橋附近的科技執法", why: "intent tech + 中正橋 landmark missing-term", expect: { mode: "kind:tech" } },

  // ===== Highway-segment queries (the bug class user just demonstrated) =====
  // These rely on district-bbox spatial fallback for highway entries with empty district field.
  { q: "國三中和段測速位置", why: "國道3 + 中和段 → bbox-filter 中和區 → 2 國道3 entries near km 38-39", expect: { mode: "roads:國道3", maxTotalPool: 10, minCount: 1 } },
  { q: "中山高八堵", why: "alias 中山高 → 國道1; 八堵 in 七堵區 — but 八堵 is landmark, not district. Should at least return 國道1 + 八堵 in missing-terms", expect: { mode: "roads:國道1" } },
  { q: "國一基隆段", why: "國道1 + 基隆段 → bbox-filter for 基隆市 districts", expect: { mode: "roads:國道1" } },
  { q: "國道3木柵段", why: "國道3 + 木柵段 → 木柵區 bbox", expect: { mode: "roads:國道3" } },
  { q: "國道5坪林段", why: "國道5 + 坪林段 → 坪林區 bbox", expect: { mode: "roads:國道5" } },
  { q: "國道3新店段", why: "國道3 + 新店段 → 新店區 bbox", expect: { mode: "roads:國道3" } },

  // ===== Grammar continuations (the 仰德大道上 bug class) =====
  { q: "仰德大道上有什麼測速", why: "上 particle stripped; 仰德大道 → 4 entries; missing-terms should be []", expect: { hasId: ["fixed-905", "fixed-906", "fixed-907", "fixed-908"], minCount: 4 } },
  { q: "走仰德大道下山要小心測速嗎", why: "走/下山 stripped; 仰德大道 entries", expect: { hasId: ["fixed-905"], minCount: 4 } },
  { q: "上仰德大道前的測速點", why: "上/前 stripped", expect: { hasId: ["fixed-905"], minCount: 4 } },
  { q: "插在哪 仰德大道", why: "插 stripped; 仰德大道", expect: { hasId: ["fixed-905"], minCount: 4 } },

  // ===== Landmark missing → cap 5 + missing-terms =====
  { q: "中正橋接水快有科技執法點嗎", why: "中正橋接 missing; sample cap=5; minimal LLM context", expect: { mode: "kind:tech", missing: ["中正橋接"], maxCount: 5 } },
  { q: "華江橋有測速嗎", why: "華江橋 likely missing in data; cap 5", expect: {} },
  { q: "西門町測速", why: "西門町 missing in data; refuse / cap", expect: {} },
  { q: "墾丁有測速嗎", why: "墾丁 has 0 entries; should be empty", expect: { empty: true } },
  { q: "九份附近的測速", why: "九份 has 0 entries; empty", expect: { empty: true } },

  // ===== Place colloquials with various phrasings =====
  { q: "我要去淡水玩有測速嗎", why: "particles strip 我/要/去/玩; 淡水", expect: { minCount: 5 } },
  { q: "今天從汐止上班會經過測速", why: "汐止 in addresses; today/work-context stripped", expect: { minCount: 1, allCities: ["新北市"] } },
  { q: "竹科上下班有測速嗎", why: "alias 竹科 → 竹北/東區", expect: { allCities: ["新竹縣", "新竹市"] } },
  { q: "從南港到內湖要注意測速嗎", why: "南港 + 內湖 substrings; both have entries", expect: { minCount: 1 } },

  // ===== District forms (with/without 區) =====
  { q: "中和區的測速點", why: "explicit 中和區; district filter", expect: { allCities: ["新北市"] } },
  { q: "中和的測速點", why: "中和 substring (no 區/段); not strict but should hit 中和", expect: { minCount: 1 } },
  { q: "中和邊有測速嗎", why: "中和邊 → 中和區 hint", expect: { allCities: ["新北市"] } },
  { q: "板橋有幾個測速", why: "板橋 substring", expect: { minCount: 1 } },

  // ===== Speed limit + road =====
  { q: "台61速限80的點", why: "台61 + speedLimit 80", expect: { mode: "roads:台61 speed:80", allSpeedLimit: 80 } },
  { q: "速限50的科技執法", why: "tech + speedLimit 50; might be 0 if no tech has 50", expect: { mode: "speed:50" } },

  // ===== Total / count queries =====
  { q: "全台共有幾個固定測速", why: "intent fixed → pool 1800+", expect: { mode: "kind:fixed", minTotalPool: 1800 } },
  { q: "所有科技執法總計", why: "intent tech, total query", expect: { mode: "kind:tech", minTotalPool: 800 } },
  { q: "區間測速一共幾個", why: "區間 intent; pool ~30+", expect: { mode: "type:區間", minTotalPool: 30 } },

  // ===== Polite / verbose phrasings =====
  { q: "請問一下汐止那邊有什麼科技執法呢", why: "請問/一下/那邊/呢 stripped; 汐止 + tech", expect: { mode: "kind:tech", allCities: ["新北市"] } },
  { q: "可以告訴我國道3號的測速嗎", why: "可以/告訴我 stripped; 國道3 alias", expect: { mode: "roads:國道3", minCount: 10 } },
  { q: "幫我查一下台9線速限", why: "幫我/查一下 stripped; 台9", expect: { mode: "roads:台9", minCount: 10 } },

  // ===== Direction phrasings (no direction filter; should still list relevant) =====
  { q: "南港到木柵北上方向測速", why: "南港+木柵+方向 'north'; we don't filter direction strictly", expect: { minCount: 1 } },

  // ===== Edge inputs =====
  { q: "?", why: "single punctuation; empty", expect: { empty: true } },
  { q: "...", why: "ellipsis; empty", expect: { empty: true } },
  { q: "速限速限速限", why: "all noise; empty", expect: { empty: true } },
  { q: "測速測速測速", why: "STRIP_PHRASES eliminates; empty", expect: { empty: true } },

  // ===== Off-topic variants =====
  { q: "今晚我想煮義大利麵", why: "煮 / 義大利麵 / 怎麼煮-adjacent; food off-topic", expect: { offTopic: true } },
  { q: "現任美國總統是誰", why: "politics off-topic", expect: { offTopic: true } },
  { q: "明天會下雨嗎", why: "weather off-topic", expect: { offTopic: true } },

  // ===== Highway 國道N + 縣市 combos (multi-stage filter) =====
  { q: "桃園境內國道3號有幾個", why: "國道3 + 桃園 cityHint; bbox fallback to 桃園 districts", expect: { mode: "roads:國道3" } },
  { q: "新北市的國道1號測速", why: "國道1 + 新北市; bbox fallback to 新北 districts", expect: { mode: "roads:國道1" } },

  // ===== Verbatim user-typed queries from production failure session =====
  // These are the three queries the user found broken on commit 44fc9ac;
  // adding them verbatim so they remain green and any regression is caught.
  {
    q: "仰德大道上陽明山測速點插在哪裡",
    why: "alias 陽明山 (substrs 仰德/陽明山, city 台北市) + 仰德大道 token; particles 上/插/在 strip; should return 4+ 仰德大道 entries",
    expect: { allCities: ["台北市"], hasId: ["fixed-908"], minCount: 4, missing: [] },
  },
  {
    q: "中正橋接水快有科技執法點嗎",
    why: "alias 水快 (cities 台北市/新北市) + intent 科技執法; 中正橋接 missing → cap 5",
    expect: { mode: "kind:tech", missing: ["中正橋接"], maxCount: 5, allCities: ["台北市", "新北市"] },
  },
  {
    q: "國三中和段測速位置",
    why: "國道3 + 中和段 → bbox 中和區 → 2 國道3 entries",
    expect: { mode: "roads:國道3", minCount: 1, maxCount: 5 },
  },
];

// ---- Runner ----
let pass = 0;
let fail = 0;
const failures: string[] = [];

for (const c of CASES) {
  let ok = true;
  const reasons: string[] = [];




  if (c.expect.offTopic) {
    if (!isOffTopic(c.q)) {
      ok = false;
      reasons.push("not detected as off-topic");
    }
  } else {
    if (isOffTopic(c.q)) {
      ok = false;
      reasons.push("incorrectly flagged off-topic");
    } else {
      const r = pickRelevantPoints(data, c.q, 30);

      if (c.expect.mode && !r.mode.includes(c.expect.mode)) {
        ok = false;
        reasons.push(`mode lacks "${c.expect.mode}" (got "${r.mode}")`);
      }
      if (c.expect.empty && r.points.length !== 0) {
        ok = false;
        reasons.push(`expected empty but got ${r.points.length} points`);
      }
      if (c.expect.minCount && r.points.length < c.expect.minCount) {
        ok = false;
        reasons.push(`only ${r.points.length} points (need ${c.expect.minCount})`);
      }
      if (c.expect.maxCount !== undefined && r.points.length > c.expect.maxCount) {
        ok = false;
        reasons.push(`${r.points.length} points exceeds maxCount ${c.expect.maxCount}`);
      }
      if (c.expect.hasId) {
        const ids = new Set(r.points.map((p) => p.id));
        const hit = c.expect.hasId.some((id) => ids.has(id));
        if (!hit) {
          ok = false;
          reasons.push(`none of [${c.expect.hasId.join(",")}] present`);
        }
      }
      if (c.expect.allCities) {
        const allowed = new Set(c.expect.allCities);
        const bad = r.points.filter((p) => !allowed.has(canonicalize(p.city)));
        if (bad.length > 0) {
          ok = false;
          reasons.push(
            `cities outside [${c.expect.allCities.join(",")}]: ${[...new Set(bad.map((p) => p.city))].join(",")}`,
          );
        }
      }
      if (c.expect.missing) {
        for (const m of c.expect.missing) {
          if (!r.missingUserTokens.includes(m)) {
            ok = false;
            reasons.push(`missingUserTokens lacks "${m}" (got ${JSON.stringify(r.missingUserTokens)})`);
          }
        }
      }
      if (c.expect.minTotalPool && r.totalInPool < c.expect.minTotalPool) {
        ok = false;
        reasons.push(`totalInPool=${r.totalInPool} < minTotalPool=${c.expect.minTotalPool}`);
      }
      if (c.expect.maxTotalPool && r.totalInPool > c.expect.maxTotalPool) {
        ok = false;
        reasons.push(`totalInPool=${r.totalInPool} > maxTotalPool=${c.expect.maxTotalPool}`);
      }
      if (c.expect.allSpeedLimit !== undefined) {
        const bad = r.points.filter((p) => p.speedLimit !== c.expect.allSpeedLimit);
        if (bad.length > 0) {
          ok = false;
          reasons.push(
            `speedLimit !== ${c.expect.allSpeedLimit} found: ${bad.slice(0, 3).map((p) => p.speedLimit).join(",")}`,
          );
        }
      }
    }
  }

  if (ok) {
    pass++;
    console.log(`✓ ${c.q}  — ${c.why}`);
  } else {
    fail++;
    const line = `✗ ${c.q}  — ${c.why}\n   ${reasons.join("; ")}`;
    console.log(line);
    failures.push(line);
  }
}

console.log("─".repeat(78));
console.log(`${pass}/${pass + fail} passed`);
if (fail > 0) {
  console.log("\nFAILURES:");
  for (const f of failures) console.log(f);
  process.exit(1);
}
