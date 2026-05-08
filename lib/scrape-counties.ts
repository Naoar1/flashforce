/**
 * Per-county PDF/HTML row parsers for FlashForce.
 *
 * Each county's enforcement-list PDF has a slightly different column layout.
 * To keep the orchestrator (`scripts/scrape-tech.ts`) simple, each parser
 * here returns a uniform shape `RawRow` that may or may not have lat/lng;
 * the orchestrator decides whether to geocode or skip rows missing coords.
 */
import type { EnforcementPoint } from "./types";
import { isPureSpeedingPhrase } from "./pdf";
import { parseNTPCRows } from "./pdf";
export { parseNTPCRows };

export interface RawRow {
  district: string;
  address: string;
  violation?: string;
  direction?: string;
  speedLimit?: number;
  /** if present, no geocoding needed */
  lat?: number;
  lng?: number;
  raw: string;
}

const DIST_RE = /([一-鿿]{1,5}(?:區|市|鄉|鎮))/;

/* ============= 臺中 ============= */

/**
 * 臺中 固定式 PDF columns (in order):
 *   編號 行政區 設置地點 取締項目 座標緯度 座標經度 拍攝方向 速限 管轄單位 備註
 *
 * Each data row begins with `<n> <district>`; address may wrap to next line.
 * Coordinate is two decimal numbers separated by spaces.
 */
export function parseTaichungFixed(text: string): RawRow[] {
  return parseTaichungLike(text, /固定式|執行科技執法|執行固定式/);
}

/**
 * 臺中 tech PDF columns: 編號 行政區 科技執法種類 取締項目 設置地點 座標緯度 座標經度 拍攝方向 速限 管轄單位
 *
 * The 設置地點 (address) sits BETWEEN the violation column and the coords —
 * different from the 固定式 PDF where address is right after district. Here
 * the address typically begins with the district name again (e.g. "西區臺灣大道與忠明南路口"),
 * so we detect the LAST <district>-prefixed substring before the coords.
 */
export function parseTaichungTech(text: string): RawRow[] {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const merged: string[] = [];
  let buf = "";
  for (const line of lines) {
    if (
      /^(?:臺中市|執行|編號|設備|--\s*\d+\s+of|第\s*\d+\s*頁|科技執法種類|取締項目|管轄單位|拍攝方向)/.test(
        line,
      )
    ) {
      if (buf) merged.push(buf);
      buf = "";
      continue;
    }
    if (/^\d+\s+/.test(line)) {
      if (buf) merged.push(buf);
      buf = line;
    } else if (buf) {
      buf += " " + line;
    }
  }
  if (buf) merged.push(buf);

  const out: RawRow[] = [];
  for (const line of merged) {
    const coordMatch = line.match(
      /(2[0-9]\.\d{3,7})\s+(1[12][0-9]\.\d{3,7})/,
    );
    if (!coordMatch) continue;
    const lat = Number.parseFloat(coordMatch[1]);
    const lng = Number.parseFloat(coordMatch[2]);
    const cutoff = coordMatch.index ?? 0;
    const head = line.slice(0, cutoff).trim();
    const tail = line.slice(cutoff + coordMatch[0].length).trim();

    // district = first XX區/市/鄉/鎮 token after the leading number
    const dm = head.match(/^\d+\s+([一-鿿]{1,5}(?:區|市|鄉|鎮))(?:\s|$)/);
    if (!dm) continue;
    const district = dm[1];

    // address = LAST run of <district>-prefixed text in head (before coord)
    // pattern: address starts at the last occurrence where district name
    // appears flanked by spaces; everything between that and end of head is address.
    const lastIdx = head.lastIndexOf(district);
    let address = "";
    let violation = "";
    if (lastIdx > dm[0].length) {
      address = head.slice(lastIdx).trim();
      violation = head.slice(dm[0].length, lastIdx).trim();
    } else {
      // fallback: no second occurrence of district → take last 30 chars as address guess
      address = head.slice(dm[0].length).trim();
      violation = "";
    }

    const dirMatch = tail.match(
      /(雙向|多向|東往西|西往東|南往北|北往南|東向西|西向東|南向北|北向南|[東西南北]+向?[東西南北]?)/,
    );
    const limitMatch = tail.match(/\b([3-9]\d|1[0-2]\d)\b/);

    out.push({
      district,
      address,
      violation: violation.replace(/\s+/g, "") || undefined,
      direction: dirMatch?.[0],
      speedLimit: limitMatch ? Number.parseInt(limitMatch[1], 10) : undefined,
      lat,
      lng,
      raw: line,
    });
  }
  return out;
}

function parseTaichungLike(text: string, _kindHint: RegExp): RawRow[] {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  // Merge wrapped lines: data rows start with `\d+ <district>`
  const merged: string[] = [];
  let buf = "";
  for (const line of lines) {
    if (
      /^(?:臺中市|執行|編號|設備|--\s*\d+\s+of|第\s*\d+\s*頁)/.test(line) ||
      /^(?:第[一二三四五六七八九十]+分局|管轄單位|拍攝)/.test(line)
    ) {
      if (buf) merged.push(buf);
      buf = "";
      continue;
    }
    if (/^\d+\s+/.test(line)) {
      if (buf) merged.push(buf);
      buf = line;
    } else if (buf) {
      buf += " " + line;
    }
  }
  if (buf) merged.push(buf);

  const out: RawRow[] = [];
  for (const line of merged) {
    // Find first decimal pair (coordinates) — that's the column anchor.
    const coordMatch = line.match(
      /(2[0-9]\.\d{3,7})\s+(1[12][0-9]\.\d{3,7})/,
    );
    if (!coordMatch) continue;
    const lat = Number.parseFloat(coordMatch[1]);
    const lng = Number.parseFloat(coordMatch[2]);
    const cutoff = coordMatch.index ?? 0;

    const head = line.slice(0, cutoff).trim();
    const tail = line.slice(cutoff + coordMatch[0].length).trim();

    // head = "<n> <district> <address> <violation>" — cut violation by tokens
    const dm = head.match(/^\d+\s+([一-鿿]{1,5}(?:區|市|鄉|鎮))\s*(.+)$/);
    if (!dm) continue;
    const district = dm[1];
    const rest = dm[2].trim();

    // violation tokens (loose) = anything containing 闖紅燈/超速/不依/違規/不停讓 etc.
    let violation = "";
    let address = rest;
    const vm = rest.match(
      /(.*?)(?:\s+)((?:闖紅燈|超速|不依|違規|不停讓|跨越|轉彎|變換車道|禁行|停讓行人)[^]*)$/,
    );
    if (vm) {
      address = vm[1].trim();
      violation = vm[2].replace(/\s+/g, "").trim();
    }

    // tail may have direction + speed limit + branch
    const dirMatch = tail.match(
      /(雙向|多向|東往西|西往東|南往北|北往南|東向西|西向東|南向北|北向南|[東西南北]+向?[東西南北]?)/,
    );
    const limitMatch = tail.match(/\b([3-9]\d|1[0-2]\d)\b/);

    out.push({
      district,
      address,
      violation: violation || undefined,
      direction: dirMatch?.[0],
      speedLimit: limitMatch ? Number.parseInt(limitMatch[1], 10) : undefined,
      lat,
      lng,
      raw: line,
    });
  }
  return out;
}

/**
 * 臺中 移動式 PDF columns:
 *   編號 轄區分局 行政區 取締地點 取締行向 速限
 * No coordinates — caller must geocode.
 */
export function parseTaichungMobile(text: string): RawRow[] {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const merged: string[] = [];
  let buf = "";
  for (const line of lines) {
    if (
      /^(?:臺中市|執行|編號|--\s*\d+\s+of|第\s*\d+\s*頁)/.test(line)
    ) {
      if (buf) merged.push(buf);
      buf = "";
      continue;
    }
    if (/^\d+\s+第[一二三四五六七八九十]+分局/.test(line)) {
      if (buf) merged.push(buf);
      buf = line;
    } else if (buf) {
      buf += " " + line;
    }
  }
  if (buf) merged.push(buf);

  const out: RawRow[] = [];
  for (const line of merged) {
    const m = line.match(
      /^\d+\s+第[一二三四五六七八九十]+分局\s*([一-鿿]{1,5}(?:區|市|鄉|鎮))?\s*(.+?)\s+(雙向|東往西|西往東|南往北|北往南|[東西南北]+往?[東西南北]?)\s+([\d/]+)?$/,
    );
    if (!m) continue;
    const district = m[1] || "";
    const address = m[2].trim();
    const direction = m[3];
    const lim = m[4]?.split("/")[0];
    const sl = lim ? Number.parseInt(lim, 10) : undefined;
    out.push({
      district,
      address,
      direction,
      speedLimit: Number.isFinite(sl) ? sl : undefined,
      raw: line,
    });
  }
  return out;
}

/* ============= 桃園 ============= */
//
// 桃園 tech PDF columns: 編號 地點 方向 速限 轄區 功能
// Each row is on one line. No coords — caller geocodes.

export function parseTaoyuan(text: string): RawRow[] {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const out: RawRow[] = [];
  for (const line of lines) {
    if (/^(?:編號|桃園市|--)/.test(line)) continue;
    const m = line.match(
      /^\d+\s+(.+?)\s+(雙向|往[東西南北][方向上下]?|往\S+方向|[東西南北]+往?[東西南北]?|北上|南下|往南|往北|往東|往西|往北上車道)\s+([\dxX]+)\s+(\S+分局)\s+(.+)$/,
    );
    if (!m) continue;
    const address = m[1].trim();
    const direction = m[2];
    const lim = m[3];
    const limitNum = Number.parseInt(lim, 10);
    const _branch = m[4];
    const violation = m[5].replace(/\s+/g, "").trim();
    const dm = address.match(DIST_RE);
    out.push({
      district: dm?.[1] ?? "",
      address,
      violation,
      direction,
      speedLimit: Number.isFinite(limitNum) ? limitNum : undefined,
      raw: line,
    });
  }
  return out;
}

/* ============= 臺南 ============= */
//
// 臺南 fixed PDF columns: 編號 轄區分局 行政區 設置位置 拍攝行向 速限
// No coords; address heavy with 公里 markers ("臺1線290.3公里").

export function parseTainan(text: string): RawRow[] {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const merged: string[] = [];
  let buf = "";
  for (const line of lines) {
    if (
      /^(?:臺南市|編號|--|拍攝|行向)/.test(line) ||
      /^第\s*\d+\s*頁/.test(line)
    ) {
      if (buf) merged.push(buf);
      buf = "";
      continue;
    }
    if (/^\d+\s+\S+分局/.test(line)) {
      if (buf) merged.push(buf);
      buf = line;
    } else if (buf) {
      buf += " " + line;
    }
  }
  if (buf) merged.push(buf);

  const out: RawRow[] = [];
  for (const line of merged) {
    const m = line.match(
      /^\d+\s+\S+分局\s+([一-鿿]{1,5}(?:區|市|鄉|鎮))\s+(.+?)\s+(雙向|東向|西向|南向|北向|[東西南北]+向?)\s+(\d+)/,
    );
    if (!m) continue;
    out.push({
      district: m[1],
      address: m[2].trim(),
      direction: m[3],
      speedLimit: Number.parseInt(m[4], 10),
      raw: line,
    });
  }
  return out;
}

/* ============= 基隆 (HTML) ============= */
//
// 基隆 page is a 大表格 listing 違規照相之路段. Inline HTML table.

export function parseKeelungHTML(html: string): RawRow[] {
  // Crude: extract table cells, group every 4-5 contiguous as a row.
  const cells = [...html.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((m) =>
    m[1]
      .replace(/<[^>]+>/g, "")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .trim(),
  );
  const out: RawRow[] = [];
  for (let i = 0; i + 3 < cells.length; ) {
    // try to find rows starting with a serial number
    if (/^\d+$/.test(cells[i])) {
      const seq = cells[i];
      const location = cells[i + 1] ?? "";
      const direction = cells[i + 2] ?? "";
      const violation = cells[i + 3] ?? "";
      i += 4;
      if (!location) continue;
      const dm = location.match(/(中正區|信義區|仁愛區|中山區|安樂區|暖暖區|七堵區)/);
      out.push({
        district: dm?.[1] ?? "",
        address: location,
        direction,
        violation: isPureSpeedingPhrase(violation) ? "超速" : violation,
        raw: `${seq} ${location} ${direction} ${violation}`,
      });
    } else {
      i++;
    }
  }
  return out;
}

/* ============= 新竹市 (HTML) ============= */
//
// 新竹市 page (tra.hccp.gov.tw/pages/camera) is a single-page HTML with
// inline table of 編號 / 地址 / 速限 / 取締項目.

export function parseHsinchuHTML(html: string): RawRow[] {
  const cells = [...html.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((m) =>
    m[1]
      .replace(/<[^>]+>/g, "")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .trim(),
  );
  const out: RawRow[] = [];
  for (let i = 0; i + 3 < cells.length; ) {
    if (/^\d+$/.test(cells[i])) {
      const seq = cells[i];
      const address = cells[i + 1] ?? "";
      const limit = cells[i + 2] ?? "";
      const violation = cells[i + 3] ?? "";
      i += 4;
      if (!address) continue;
      const dm = address.match(/(東區|北區|香山區)/);
      const lim = Number.parseInt(limit.replace(/\D/g, ""), 10);
      out.push({
        district: dm?.[1] ?? "",
        address,
        speedLimit: Number.isFinite(lim) ? lim : undefined,
        violation: violation || undefined,
        raw: `${seq} ${address} ${limit} ${violation}`,
      });
    } else {
      i++;
    }
  }
  return out;
}

/* ============= 苗栗 (PDF with coords) ============= */
//
// 苗栗 PDF columns: 編號 設置地點 設備型式 取締項目 拍攝方向 速限 經緯度
// 經緯度 format: "<lng> , <lat>". Address can wrap to next line.

export function parseMiaoli(text: string): RawRow[] {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const merged: string[] = [];
  let buf = "";
  for (const line of lines) {
    if (
      /^(?:苗栗縣|編號|設備型式|取締項目|拍攝|方向|速限|經緯度)/.test(line)
    ) {
      if (buf) merged.push(buf);
      buf = "";
      continue;
    }
    if (/^\d+\s+/.test(line)) {
      if (buf) merged.push(buf);
      buf = line;
    } else if (buf) {
      buf += " " + line;
    }
  }
  if (buf) merged.push(buf);

  const out: RawRow[] = [];
  for (const line of merged) {
    // coords: "<lng> , <lat>"
    const cm = line.match(
      /(1[12][0-9]\.\d{3,7})\s*[,，]\s*(2[0-9]\.\d{3,7})/,
    );
    if (!cm) continue;
    const lng = Number.parseFloat(cm[1]);
    const lat = Number.parseFloat(cm[2]);
    const cutoff = cm.index ?? 0;
    const head = line.slice(0, cutoff).trim();
    // <n> <address...> <type> <violation> <direction> <limit>
    const m = head.match(
      /^\d+\s+(.+?)\s+(雙向|多向|東西雙向|南北雙向|東向西|西向東|南向北|北向南|[東西南北]+(?:向?[東西南北])?)\s+(\d+)\s*$/,
    );
    if (!m) continue;
    const beforeDir = m[1];
    const direction = m[2];
    const speedLimit = Number.parseInt(m[3], 10);
    // beforeDir = "<address> <type> <violation>" — split: violation is one of: 測速/闖紅燈/雙黃線
    const vm = beforeDir.match(
      /^(.+?)\s*((?:闖紅燈|測速|雙黃線|跨越雙黃線)(?:\s*[、，,]\s*(?:闖紅燈|測速|雙黃線))*)\s*$/,
    );
    let address = beforeDir;
    let violation = "";
    if (vm) {
      address = vm[1].trim();
      violation = vm[2].trim();
    }
    const dm = address.match(DIST_RE);
    out.push({
      district: dm?.[1] ?? "",
      address: address.replace(/\s+/g, " ").trim(),
      violation: violation || undefined,
      direction,
      speedLimit: Number.isFinite(speedLimit) ? speedLimit : undefined,
      lat,
      lng,
      raw: line,
    });
  }
  return out;
}

/* ============= 嘉義縣 (PDF with coords on next line) ============= */
//
// 嘉義縣 PDF columns: 編號 設置地點 轄區分局 拍攝方向 速限 經緯度 取締項目
// 經緯度 is two decimals on the SAME line as the row header but the lng / lat
// often wrap onto the next line; we extract via regex anchored to "1XX.X..."
// (lng) followed by "2X.X..." (lat).

export function parseChiayiCounty(text: string): RawRow[] {
  // Pre-process: normalize whitespace and tabs
  const cleaned = text
    .replace(/\t+/g, " ")
    .replace(/[  ]+/g, " ");
  const lines = cleaned.split(/\r?\n/);
  const merged: string[] = [];
  let buf = "";
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (/^(?:編號|設置地點|轄區|拍攝|速限|經緯度|取締項目|嘉義縣|--)/.test(trimmed))
      continue;
    if (/^\d+\s+/.test(trimmed)) {
      if (buf) merged.push(buf);
      buf = trimmed;
    } else if (buf) {
      buf += " " + trimmed;
    }
  }
  if (buf) merged.push(buf);

  const out: RawRow[] = [];
  for (const line of merged) {
    // coords typically: "23.466447 120.254673" or "23.466447\n120.254673"
    const cm = line.match(/(2[0-9]\.\d{3,7})\s+(1[12][0-9]\.\d{3,7})/);
    if (!cm) continue;
    const lat = Number.parseFloat(cm[1]);
    const lng = Number.parseFloat(cm[2]);
    const cutoff = cm.index ?? 0;
    const head = line.slice(0, cutoff).trim();
    const tail = line.slice(cutoff + cm[0].length).trim();
    // head pattern: "<n> <address> <branch>分局 <direction> <limit>"
    const m = head.match(
      /^\d+\s+(.+?)\s+(\S+分局)\s+(雙向|東向|西向|南向|北向|東向西|西向東|南向北|北向南|[東西南北]+向?[東西南北]?)\s+(\d+)\s*$/,
    );
    if (!m) continue;
    const address = m[1].trim();
    const direction = m[3];
    const speedLimit = Number.parseInt(m[4], 10);
    const violation = tail
      .replace(/[\s、,，]+/g, " ")
      .trim();
    const dm = address.match(DIST_RE);
    out.push({
      district: dm?.[1] ?? "",
      address,
      violation: violation || undefined,
      direction,
      speedLimit: Number.isFinite(speedLimit) ? speedLimit : undefined,
      lat,
      lng,
      raw: line,
    });
  }
  return out;
}

/* ============= NTPC mobile (HTML inline table) ============= */
//
// 移動式科學儀器執法設備設置地點1141126 — 1096 rows, columns: 地區別 + 地點

export function parseNTPCMobileHTML(html: string): RawRow[] {
  const cells = [...html.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((m) =>
    m[1]
      .replace(/<[^>]+>/g, "")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .trim(),
  );
  const out: RawRow[] = [];
  for (let i = 0; i + 1 < cells.length; i += 2) {
    const district = cells[i];
    const location = cells[i + 1];
    if (!district || !location) continue;
    if (district === "地區別" || district.length > 6) continue;
    if (!/[區市鄉鎮]$/.test(district)) continue;
    out.push({
      district,
      address: location,
      raw: `${district} ${location}`,
    });
  }
  return out;
}

/* ============= row → EnforcementPoint helpers ============= */

export function rowsToPoints(
  rows: RawRow[],
  fixed: {
    kind: EnforcementPoint["kind"];
    city: string;
    authority: string;
    enforcementTypePrefix?: string;
  },
): EnforcementPoint[] {
  const out: EnforcementPoint[] = [];
  for (const r of rows) {
    if (r.lat == null || r.lng == null) continue;
    if (
      fixed.kind === "tech" &&
      r.violation &&
      isPureSpeedingPhrase(r.violation)
    )
      continue;
    out.push({
      id: "",
      kind: fixed.kind,
      city: fixed.city,
      district: r.district,
      address: r.address,
      lat: r.lat,
      lng: r.lng,
      direction: r.direction,
      speedLimit: r.speedLimit,
      enforcementType: fixed.enforcementTypePrefix
        ? `${fixed.enforcementTypePrefix}｜${r.violation ?? ""}`.replace(/\｜$/, "")
        : r.violation,
      authority: fixed.authority,
    });
  }
  return out;
}
