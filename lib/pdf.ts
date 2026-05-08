/**
 * PDF helpers for FlashForce scrapers.
 *
 * Use case：政府公告頁通常列一連串歷史 PDF（最新的在最上）。
 * scrapers should call `findLatestAttachmentURL()` once per run to discover
 * the most-recent file matching a title regex, then parse its text.
 */
import { safeFetchBuffer, safeFetchText } from "./fetch";

export interface PDFAttachment {
  title: string;
  url: string;
  publishedAt: string | null;
}

/**
 * Fetch an announcement listing page and find attachments matching a title regex.
 * Returns the first match (the page is typically newest-first).
 *
 * Works with the GIP-style government CMS used by NTPC and many other
 * 縣市警察局 sites. Each entry's link looks like `dl-12345-uuid.html`.
 */
export async function findLatestAttachment(
  listingPageUrl: string,
  titleRegex: RegExp,
  baseHost: string,
): Promise<PDFAttachment | null> {
  const html = await safeFetchText(listingPageUrl, "listing");
  // <a href="/dl-XXX-XXX.html">…title…</a>
  // GIP CMS uses both `cp-XXX-NNN-27.html` (announcement page) and
  // `dl-NNN-uuid.html` (file). Match either.
  const re =
    /<a[^>]*href="(\/?(?:cp|dl)-[0-9]+-[a-f0-9-]+(?:-\d+)?(?:\.html)?)"[^>]*>([^<]+)<\/a>/gi;
  const out: PDFAttachment[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const href = m[1];
    const title = m[2].trim();
    if (!titleRegex.test(title)) continue;
    out.push({
      title,
      url: new URL(href, baseHost).href,
      publishedAt: extractRocDate(title),
    });
  }
  return out[0] ?? null;
}

/** "1150430" → "2026-04-30" (ROC + 1911 → AD). */
function extractRocDate(s: string): string | null {
  const m = s.match(/\b(\d{3})(\d{2})(\d{2})\b/);
  if (!m) return null;
  const year = Number(m[1]) + 1911;
  const month = m[2];
  const day = m[3];
  return `${year}-${month}-${day}`;
}

export async function fetchPDFText(url: string): Promise<{
  text: string;
  numpages: number;
}> {
  const buf = await safeFetchBuffer(url, "pdf");
  // pdf-parse 2.x: PDFParse class
  const { PDFParse } = await import("pdf-parse");
  const parser = new PDFParse({ data: buf });
  try {
    const out = await parser.getText();
    const total = (out as { total?: number }).total ?? 0;
    return {
      text: (out as { text?: string }).text ?? "",
      numpages: total,
    };
  } finally {
    await parser.destroy();
  }
}

/**
 * Parse a NTPC-style 設置地點 PDF.
 * Columns: 編號 行政區 設置地址 取締項目 備註
 *
 * Each data line starts with `<n>. <district>...`. We tokenize by leading
 * number; everything after the district up to the violation keywords is
 * the address; remaining tail = violation + optional remarks.
 */
export interface NTPCRow {
  district: string;
  address: string;
  violation: string;
  remarks: string;
  raw: string;
}

/**
 * Phrase test: does this 取締項目 string contain ONLY 超速 (no 闖紅燈 etc.)?
 * Such rows belong to kind="fixed" and should be skipped when emitting tech.
 */
export function isPureSpeedingPhrase(v: string | undefined | null): boolean {
  if (!v) return true;
  const cleaned = v
    .replace(/[超]速[(（][^)）]*[)）]?/g, "")
    .replace(/超速/g, "")
    .replace(/[、,，;；\s/()（）｜|]/g, "")
    .trim();
  return cleaned.length === 0;
}

/**
 * Normalize a Taiwan address for fuzzy matching across CSV / PDF / HTML
 * sources. Removes whitespace, unifies full/half-width digits & punctuation,
 * strips bracket types, and folds 區/市/鄉/鎮 spelling variants.
 */
export function normalizeAddress(s: string): string {
  if (!s) return "";
  return s
    .normalize("NFKC")
    .replace(/[\s　]+/g, "")
    .replace(/[()（）\[\]［］{}『』「」]/g, "")
    .replace(/[、,，;；]/g, "")
    .replace(/[／\/]/g, "/")
    .replace(/-/g, "-")
    .toLowerCase();
}

/** Build a coord-lookup table keyed by normalized address. */
export interface CoordEntry {
  lat: number;
  lng: number;
  speedLimit?: number;
  direction?: string;
}
export function buildCoordIndex(
  rows: Array<{
    address: string;
    district?: string;
    lat: number;
    lng: number;
    speedLimit?: number;
    direction?: string;
  }>,
): Map<string, CoordEntry> {
  const idx = new Map<string, CoordEntry>();
  for (const r of rows) {
    const k = normalizeAddress(`${r.district ?? ""}${r.address}`);
    if (!k) continue;
    if (!idx.has(k))
      idx.set(k, {
        lat: r.lat,
        lng: r.lng,
        speedLimit: r.speedLimit,
        direction: r.direction,
      });
  }
  return idx;
}

/** Lookup; tries district+address first, then address-only. */
export function lookupCoord(
  idx: Map<string, CoordEntry>,
  district: string,
  address: string,
): CoordEntry | null {
  const k1 = normalizeAddress(district + address);
  if (idx.has(k1)) return idx.get(k1)!;
  const k2 = normalizeAddress(address);
  if (idx.has(k2)) return idx.get(k2)!;
  // partial: any key that contains the address
  for (const [k, v] of idx) {
    if (k.includes(k2) && k2.length >= 8) return v;
  }
  return null;
}

/**
 * Violation phrases — used to find where the address ends and the violation
 * column begins. These cover the most common 取締項目 wording across counties.
 */
const VIOLATION_TOKENS = [
  "闖紅燈",
  "超速",
  "違規\\(臨時\\)停車",
  "違規停車",
  "未禮讓行人",
  "不停讓行人",
  "停讓自行車",
  "違規左轉",
  "違規右轉",
  "違規迴轉",
  "違規行駛",
  "禁行大貨車",
  "禁行機車道",
  "禁行",
  "跨越雙白線",
  "跨越兩車道行駛",
  "區間測速",
  "未戴安全帽",
  "未依標誌標線號誌行駛",
  "未依標誌",
  "未依規定兩段式左轉",
  "未依規定轉彎",
  "未保持路口淨空",
  "路口淨空",
  "行駛人行道",
  "行駛路肩",
  "下台\\d+匝道處違規右轉、迴轉",
  "占用直行車道",
  "佔用直行車道",
  "違規",
];
const VIO_ATOM = `(?:${VIOLATION_TOKENS.join("|")})`;
// allow combined violations separated by 、，,／/
const VIO_RE = new RegExp(`(${VIO_ATOM}(?:\\s*[、，,／/]\\s*${VIO_ATOM})*)`, "g");

const HEADER_RE =
  /^(?:固定式|交通科技|區間平均|移動式|路口安全|違規停車|路段|編號|第\s*\d+\s*頁|--\s*\d+\s+of)/;

/**
 * Parse a NTPC-style 設置地點 PDF — handles both the
 * "編號. 行政區 設置地址" (固定式) and "編號. 行政區+地址" (科技執法)
 * variants, plus address lines that wrap across two PDF lines.
 */
export function parseNTPCRows(text: string): NTPCRow[] {
  // 1) tokenize: every line starting with `<n>.` opens a new row;
  //    subsequent non-row lines are appended as continuation.
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.replace(/ /g, " ").trim())
    .filter(Boolean);
  const merged: string[] = [];
  let buf = "";
  for (const line of lines) {
    if (HEADER_RE.test(line)) {
      if (buf) merged.push(buf);
      buf = "";
      continue;
    }
    if (/^\d+\s*[.。．]/.test(line)) {
      if (buf) merged.push(buf);
      buf = line;
    } else if (buf) {
      buf += " " + line;
    }
  }
  if (buf) merged.push(buf);

  // 2) parse each merged row.
  const out: NTPCRow[] = [];
  for (const line of merged) {
    const m = line.match(/^\d+\s*[.。．]\s*(.+)$/);
    if (!m) continue;
    const body = m[1].replace(/\s+/g, " ").trim();

    // district: 中文 1-5 chars + 區/市/鄉/鎮, optional space after
    const dm = body.match(/^([一-鿿]{1,5}(?:區|市|鄉|鎮))\s*(.+)$/);
    if (!dm) continue;
    const district = dm[1];
    const rest = dm[2].trim();

    // pick the LAST violation match — that marks the boundary
    const viols = [...rest.matchAll(VIO_RE)];
    if (viols.length === 0) continue;
    const last = viols[viols.length - 1];
    const violation = last[0].trim();
    const cutoff = last.index ?? 0;

    const address = rest.slice(0, cutoff).trim();
    const remarks = rest.slice(cutoff + violation.length).trim();
    if (!address || address.length < 3) continue;
    out.push({ district, address, violation, remarks, raw: line });
  }
  return out;
}
