/**
 * 科技執法 (tech enforcement) scraper — 全台.
 *
 * 沒有「全國科技執法」單一資料集；由各縣市政府自行公告。本檔以 config-driven
 * 模式串接所有「公開、有經緯度（或可查得座標）、可機器讀」的來源。對於只
 * 有 PDF / 文字地址 / 無公開資料的縣市，於檔尾的 coverage matrix 標記。
 *
 * 為避免與全國固定測速 (kind="fixed", data.gov.tw/dataset/7320) 重複，
 * 各縣市資料若 violation 只是「超速」(沒有闖紅燈/違停/未禮讓 等項目)，
 * 視同已被 fixed 涵蓋，跳過 — 反之則納入 tech。
 */
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { DataBundle, EnforcementPoint } from "../lib/types";
import { safeFetchText } from "../lib/fetch";
import {
  buildCoordIndex,
  fetchPDFText,
  findLatestAttachment,
  isPureSpeedingPhrase,
  lookupCoord,
  parseNTPCRows,
} from "../lib/pdf";
import { flushCache, geocodeAddress, getApiCallsMade } from "../lib/geocode";
import {
  parseTaichungFixed,
  parseTaichungTech,
  parseTaoyuan,
  parseTainan,
  parseKeelungHTML,
  parseHsinchuHTML,
  parseMiaoli,
  parseChiayiCounty,
  type RawRow,
} from "../lib/scrape-counties";

// Per-run cap on Nominatim queries (free, 1 req/sec). Cache fills over
// successive runs; weekly cron will saturate within ~10 runs.
const MAX_GEOCODE_PER_RUN = 250;

async function geocodeIfBudget(
  city: string,
  district: string,
  address: string,
) {
  if (getApiCallsMade() >= MAX_GEOCODE_PER_RUN) return null;
  return geocodeAddress(city, district, address);
}

const ROOT = process.cwd();
const OUT_DIR = join(ROOT, "public", "data");
const OUT_FILE = join(OUT_DIR, "data.json");

// ---------- CSV utils ----------
function parseCSV(text: string): string[][] {
  const rows: string[][] = [];
  let field = "";
  let row: string[] = [];
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') inQuotes = false;
      else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (c !== "\r") field += c;
  }
  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

function inTaiwan(lat: number, lng: number) {
  return lat >= 21 && lat <= 26.5 && lng >= 118 && lng <= 122.5;
}

interface SourceResult {
  label: string;
  sourceUrl: string;
  sourceUpdatedAt: string | null;
  fetchedAt: string;
  points: EnforcementPoint[];
}

// ============ 1. 國道闖紅燈 ============
async function fetchHighwayRedlight(): Promise<SourceResult> {
  const url =
    "https://opdadm.moi.gov.tw/api/v1/no-auth/resource/api/dataset/EF974C67-917B-43DA-A49C-F1480EEEDB23/resource/C1EC920B-69C5-4A59-B965-2C15A5708C66/download";
  const rows = parseCSV(await safeFetchText(url, "國道闖紅燈"));
  const points: EnforcementPoint[] = [];
  for (const r of rows.slice(1)) {
    if (r.length < 5) continue;
    const [, road, location, lng, lat] = r;
    const la = Number.parseFloat(lat);
    const ln = Number.parseFloat(lng);
    if (!Number.isFinite(la) || !Number.isFinite(ln) || !inTaiwan(la, ln))
      continue;
    points.push({
      id: "",
      kind: "tech",
      city: road?.trim() || "國道",
      district: "",
      address: location?.trim() ?? "",
      lat: la,
      lng: ln,
      enforcementType: "闖紅燈",
      authority: "內政部警政署國道公路警察局",
    });
  }
  return {
    label: "國道闖紅燈科技執法 (國道公路警察局)",
    sourceUrl: "https://data.gov.tw/dataset/100856",
    sourceUpdatedAt: null,
    fetchedAt: new Date().toISOString(),
    points,
  };
}

// ============ 2. 臺北市 智慧管理 ============
async function fetchTaipeiSmart(): Promise<SourceResult> {
  const url =
    "https://data.taipei/api/dataset/986fa73e-c470-4ebf-9f35-3a1c9d2a8788/resource/4715904f-6ce1-41c2-8a68-3bc5303f3607/download";
  const rows = parseCSV(await safeFetchText(url, "臺北市智慧管理"));
  const points: EnforcementPoint[] = [];
  for (const r of rows.slice(1)) {
    if (r.length < 7) continue;
    const [, name, segment, x, y, , item] = r;
    const ln = Number.parseFloat(x);
    const la = Number.parseFloat(y);
    if (!Number.isFinite(la) || !Number.isFinite(ln) || !inTaiwan(la, ln))
      continue;
    if (isPureSpeedingPhrase(item)) continue;
    points.push({
      id: "",
      kind: "tech",
      city: "臺北市",
      district: "",
      address: segment?.trim() ?? "",
      lat: la,
      lng: ln,
      enforcementType: `${name?.trim()}｜${item?.trim()}`,
      authority: "臺北市政府警察局交通警察大隊",
    });
  }
  return {
    label: "臺北市智慧管理科技執法設備",
    sourceUrl: "https://data.gov.tw/dataset/135957",
    sourceUpdatedAt: "2024-09-11",
    fetchedAt: new Date().toISOString(),
    points,
  };
}

// ============ 3. 高雄市 111 年 ============
async function fetchKaohsiungFixed(): Promise<SourceResult> {
  const url =
    "https://data.kcg.gov.tw/File/directDownload/d300ae36-e3b7-41c1-aa27-39c48a6f8c4b";
  const rows = parseCSV(await safeFetchText(url, "高雄市111年"));
  const points: EnforcementPoint[] = [];
  for (const r of rows.slice(1)) {
    if (r.length < 10) continue;
    const [, , type, location, dir, limit, district, kind, latS, lngS] = r;
    const la = Number.parseFloat(latS);
    const ln = Number.parseFloat(lngS);
    if (!Number.isFinite(la) || !Number.isFinite(ln) || !inTaiwan(la, ln))
      continue;
    if (isPureSpeedingPhrase(kind)) continue;
    const lim = Number.parseInt(limit, 10);
    points.push({
      id: "",
      kind: "tech",
      city: "高雄市",
      district: district?.trim() ?? "",
      address: location?.trim() ?? "",
      lat: la,
      lng: ln,
      direction: dir?.trim() || undefined,
      speedLimit: Number.isFinite(lim) ? lim : undefined,
      enforcementType: `${type?.trim()}｜${kind?.trim()}`,
      authority: "高雄市政府警察局",
    });
  }
  return {
    label: "高雄市 111 年 固定式違規照相設備及科技執法",
    sourceUrl: "https://data.gov.tw/dataset/148455",
    sourceUpdatedAt: "2022-06-01", // 標題：111年第1次公告
    fetchedAt: new Date().toISOString(),
    points,
  };
}

// ============ 4. 高雄市 112 年 租賃式 ============
async function fetchKaohsiungRental(): Promise<SourceResult> {
  const url =
    "https://data.kcg.gov.tw/File/directDownload/541879da-f6e4-4c46-9fed-b0622cd05f2d";
  const rows = parseCSV(await safeFetchText(url, "高雄市112年租賃"));
  const points: EnforcementPoint[] = [];
  for (const r of rows.slice(1)) {
    if (r.length < 5) continue;
    const [, location, dir, item, coords] = r;
    if (!coords) continue;
    const m = coords.trim().match(/(\d{2}\.\d+)\s+(\d{3}\.\d+)/);
    if (!m) continue;
    const la = Number.parseFloat(m[1]);
    const ln = Number.parseFloat(m[2]);
    if (!Number.isFinite(la) || !Number.isFinite(ln) || !inTaiwan(la, ln))
      continue;
    points.push({
      id: "",
      kind: "tech",
      city: "高雄市",
      district: "",
      address: location?.trim() ?? "",
      lat: la,
      lng: ln,
      direction: dir?.trim() || undefined,
      enforcementType: item?.trim() || "闖紅燈",
      authority: "高雄市政府警察局",
    });
  }
  return {
    label: "高雄市 112 年 租賃式闖紅燈科技執法",
    sourceUrl: "https://data.gov.tw/dataset/161879",
    sourceUpdatedAt: "2023-XX",
    fetchedAt: new Date().toISOString(),
    points,
  };
}

// ============ 5. 嘉義市 ============
async function fetchChiayiCity(): Promise<SourceResult> {
  const url =
    "https://data.chiayi.gov.tw/opendata/api/getResource?oid=26242d8c-9340-4553-a67f-5084a37552d4&rid=4adcea0f-ee46-4a9f-bb6e-8f4f3a1817bb";
  const rows = parseCSV(await safeFetchText(url, "嘉義市"));
  const points: EnforcementPoint[] = [];
  for (const r of rows.slice(1)) {
    if (r.length < 7) continue;
    const [, location, dir, equipment, limit, lng, lat] = r;
    const la = Number.parseFloat(lat);
    const ln = Number.parseFloat(lng);
    if (!Number.isFinite(la) || !Number.isFinite(ln) || !inTaiwan(la, ln))
      continue;
    if (isPureSpeedingPhrase(equipment)) continue;
    const lim = Number.parseInt(limit, 10);
    points.push({
      id: "",
      kind: "tech",
      city: "嘉義市",
      district: "",
      address: location?.trim() ?? "",
      lat: la,
      lng: ln,
      direction: dir?.trim() || undefined,
      speedLimit: Number.isFinite(lim) ? lim : undefined,
      enforcementType: equipment?.trim() || undefined,
      authority: "嘉義市政府警察局",
    });
  }
  return {
    label: "嘉義市 固定式測速及闖紅燈",
    sourceUrl: "https://data.gov.tw/dataset/52544",
    sourceUpdatedAt: "2026-04",
    fetchedAt: new Date().toISOString(),
    points,
  };
}

// ============ 6+7. 新北市：PDF (latest) + CSV coord lookup ============
//
// 新北市 traffic.police.ntpc.gov.tw 每月公告最新 PDF；同樣的點位另在
// data.ntpc.gov.tw 有「不更新」的歷史 CSV，這些 CSV 雖然標記凍結但
// 仍含經緯度 — 我們把它當成 coord lookup table，配合 PDF 的 live list。

const NTPC_HOST = "https://www.traffic.police.ntpc.gov.tw";
const NTPC_LIST = `${NTPC_HOST}/lp-3313-27.html`;

const NTPC_COORD_CSVS: Array<{ url: string; columns: string[] }> = [
  {
    // 99F3FF6E 固定式 (含闖紅燈/超速 等多用途)
    url: "https://data.ntpc.gov.tw/api/datasets/99f3ff6e-0352-4399-a726-775ab765a1dc/csv/file",
    columns: ["city", "district", "address", "_dept", "_branch", "_vio", "lng", "lat"],
  },
  {
    // BB59A616 違規停車自動偵測
    url: "https://data.ntpc.gov.tw/api/datasets/bb59a616-3572-4e92-9d09-01bf422057a6/csv/file",
    columns: ["_seq", "address", "_item", "lat", "lng"],
  },
  {
    // B34DBD89 路口安全自動偵測
    url: "https://data.ntpc.gov.tw/api/datasets/b34dbd89-85a9-4489-bf6c-065537661638/csv/file",
    columns: ["_seq", "address", "_item", "lat", "lng"],
  },
];

async function buildNTPCCoordIndex() {
  const rows: Array<{
    address: string;
    district?: string;
    lat: number;
    lng: number;
  }> = [];
  for (const src of NTPC_COORD_CSVS) {
    try {
      const csv = parseCSV(await safeFetchText(src.url, "ntpc-csv"));
      for (const r of csv.slice(1)) {
        if (r.length < src.columns.length) continue;
        const obj: Record<string, string> = {};
        src.columns.forEach((c, i) => {
          obj[c] = r[i];
        });
        const la = Number.parseFloat(obj.lat);
        const ln = Number.parseFloat(obj.lng);
        if (!Number.isFinite(la) || !Number.isFinite(ln) || !inTaiwan(la, ln))
          continue;
        rows.push({
          address: obj.address ?? "",
          district: obj.district ?? "",
          lat: la,
          lng: ln,
        });
      }
    } catch (e) {
      console.warn(`  ntpc CSV ${src.url} failed: ${(e as Error).message}`);
    }
  }
  return buildCoordIndex(rows);
}

async function fetchNTPCFromPDF(): Promise<SourceResult> {
  const idx = await buildNTPCCoordIndex();
  console.log(`  NTPC coord index: ${idx.size} entries`);

  // discover the latest "公告" page
  const announcement = await findLatestAttachment(
    NTPC_LIST,
    /固定式科學儀器執法設備設置地點.*公告/,
    NTPC_HOST,
  );
  if (!announcement) throw new Error("NTPC: latest announcement not found");
  console.log(`  NTPC announcement: ${announcement.title} (${announcement.publishedAt})`);

  // attachments inside the announcement page
  const fixedPDF = await findLatestAttachment(
    announcement.url,
    /固定式照相取締.*\.pdf/i,
    NTPC_HOST,
  );
  const techPDF = await findLatestAttachment(
    announcement.url,
    /交通科技執法.*\.pdf/i,
    NTPC_HOST,
  );
  const segPDF = await findLatestAttachment(
    announcement.url,
    /區間平均速率.*\.pdf/i,
    NTPC_HOST,
  );

  const all: { row: ReturnType<typeof parseNTPCRows>[0]; src: string }[] = [];
  for (const target of [fixedPDF, techPDF, segPDF]) {
    if (!target) continue;
    const { text } = await fetchPDFText(target.url);
    const rows = parseNTPCRows(text);
    console.log(`    ${target.title}: ${rows.length} rows`);
    rows.forEach((r) => all.push({ row: r, src: target.title }));
  }

  // map to EnforcementPoint, dropping pure-超速 + unmatched-coord rows
  const points: EnforcementPoint[] = [];
  let unmatched = 0;
  for (const { row, src } of all) {
    if (isPureSpeedingPhrase(row.violation)) continue; // belongs to fixed
    const coord = lookupCoord(idx, row.district, row.address);
    if (!coord) {
      unmatched++;
      continue;
    }
    points.push({
      id: "",
      kind: "tech",
      city: "新北市",
      district: row.district,
      address: row.address,
      lat: coord.lat,
      lng: coord.lng,
      enforcementType: row.violation,
      authority: "新北市政府警察局交通警察大隊",
      notes: src.includes("區間")
        ? "區間測速"
        : src.includes("科技")
          ? "科技執法（路口/違停）"
          : undefined,
    });
  }
  console.log(`    NTPC: matched ${points.length}, unmatched ${unmatched}`);
  return {
    label: "新北市 固定式 + 科技執法 + 區間 (PDF latest)",
    sourceUrl: NTPC_LIST,
    sourceUpdatedAt: announcement.publishedAt,
    fetchedAt: new Date().toISOString(),
    points,
  };
}

// ============ 臺中 (fixed + tech) ============
//
// 臺中 PDFs ship with built-in 座標緯度 / 座標經度 columns — no geocoding.

const TAICHUNG_LIST =
  "https://www.police.taichung.gov.tw/traffic/home.jsp?id=55&parentpath=null&mcustomize=multimessages_view.jsp&dataserno=202207040001&t=Download&mserno=201801260055";
const TAICHUNG_HOST = "https://www.police.taichung.gov.tw";

interface TaichungAttachment {
  url: string;
  title: string;
}
async function discoverTaichungPDFs(): Promise<TaichungAttachment[]> {
  const html = await safeFetchText(TAICHUNG_LIST, "taichung-list");
  const out: TaichungAttachment[] = [];
  const re =
    /<a[^>]*href="(\/filedownload\?file=[^"]+&filedisplay=([^"&]+\.pdf)[^"]*)"[^>]*>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    out.push({
      url: new URL(m[1], TAICHUNG_HOST).href,
      title: decodeURIComponent(m[2]),
    });
  }
  return out;
}

async function fetchTaichungFixed(): Promise<SourceResult> {
  const list = await discoverTaichungPDFs();
  const target =
    list.find((a) => /固定式/.test(a.title)) ??
    list.find((a) => /取締地點/.test(a.title));
  if (!target) throw new Error("臺中 fixed PDF not found");
  const { text } = await fetchPDFText(target.url);
  const rows = parseTaichungFixed(text);
  const points: EnforcementPoint[] = [];
  for (const r of rows) {
    if (r.lat == null || r.lng == null) continue;
    if (r.violation && isPureSpeedingPhrase(r.violation)) continue;
    points.push({
      id: "",
      kind: "tech",
      city: "臺中市",
      district: r.district,
      address: r.address,
      lat: r.lat,
      lng: r.lng,
      direction: r.direction,
      speedLimit: r.speedLimit,
      enforcementType: r.violation,
      authority: "臺中市政府警察局交通警察大隊",
    });
  }
  return {
    label: `臺中市 固定式科學儀器執法 (${target.title})`,
    sourceUrl: TAICHUNG_LIST,
    sourceUpdatedAt: extractDateFromTitle(target.title),
    fetchedAt: new Date().toISOString(),
    points,
  };
}

async function fetchTaichungTech(): Promise<SourceResult> {
  const list = await discoverTaichungPDFs();
  const target =
    list.find((a) => /科技執法/.test(a.title) && /取締地點/.test(a.title)) ??
    list.find((a) => /執行科技執法/.test(a.title));
  if (!target) throw new Error("臺中 tech PDF not found");
  const { text } = await fetchPDFText(target.url);
  const rows = parseTaichungTech(text);
  const points: EnforcementPoint[] = [];
  for (const r of rows) {
    if (r.lat == null || r.lng == null) continue;
    points.push({
      id: "",
      kind: "tech",
      city: "臺中市",
      district: r.district,
      address: r.address,
      lat: r.lat,
      lng: r.lng,
      direction: r.direction,
      speedLimit: r.speedLimit,
      enforcementType: r.violation,
      authority: "臺中市政府警察局交通警察大隊",
    });
  }
  return {
    label: `臺中市 科技執法取締地點 (${target.title})`,
    sourceUrl: TAICHUNG_LIST,
    sourceUpdatedAt: extractDateFromTitle(target.title),
    fetchedAt: new Date().toISOString(),
    points,
  };
}

function extractDateFromTitle(title: string): string | null {
  // Look for "115年3月10日" or "1150310"
  const m1 = title.match(/(\d{2,3})年(\d{1,2})月(\d{1,2})日/);
  if (m1) {
    const y = Number(m1[1]) + 1911;
    return `${y}-${m1[2].padStart(2, "0")}-${m1[3].padStart(2, "0")}`;
  }
  const m2 = title.match(/\b(\d{3})(\d{2})(\d{2})\b/);
  if (m2) return `${Number(m2[1]) + 1911}-${m2[2]}-${m2[3]}`;
  return null;
}

// ============ 桃園 (PDF + geocode) ============

const TAOYUAN_LIST = "https://traffic2.tyhp.gov.tw/index-77-0-123";

async function fetchTaoyuan(): Promise<SourceResult> {
  const html = await safeFetchText(TAOYUAN_LIST, "桃園 list");
  const m = html.match(/href="(\/uploads\/files\/tech\/[^"]+\.pdf)"/i);
  if (!m) throw new Error("桃園 PDF not found");
  const pdfUrl = new URL(m[1], "https://traffic2.tyhp.gov.tw").href;
  const { text } = await fetchPDFText(pdfUrl);
  const rows = parseTaoyuan(text);
  return await rowsToTechWithGeocode(rows, "桃園市", "桃園市政府警察局交通警察大隊", {
    label: "桃園市 科技執法設備設置及移動式 (PDF latest)",
    sourceUrl: TAOYUAN_LIST,
  });
}

// ============ 臺南 (PDF + geocode) ============

const TAINAN_PAGE =
  "https://www.tnpd.gov.tw/Article/71d16651-5929-91c8-8a06-039fc3dbee6c";

async function fetchTainan(): Promise<SourceResult> {
  const html = await safeFetchText(TAINAN_PAGE, "臺南 list");
  const m = html.match(/href="(\/upfiles\/files\/[^"]+\.pdf)"/i);
  if (!m) throw new Error("臺南 PDF not found");
  const pdfUrl = new URL(m[1], "https://www.tnpd.gov.tw").href;
  const { text } = await fetchPDFText(pdfUrl);
  const rows = parseTainan(text);
  return await rowsToTechWithGeocode(rows, "臺南市", "臺南市政府警察局交通警察大隊", {
    label: "臺南市 固定式交通違規照相 (PDF latest)",
    sourceUrl: TAINAN_PAGE,
  });
}

// ============ 基隆 (HTML + geocode) ============
const KEELUNG_PAGE = "https://www.klg.gov.tw/cht/index.php?code=list&ids=937";
async function fetchKeelung(): Promise<SourceResult> {
  const html = await safeFetchText(KEELUNG_PAGE, "基隆");
  const rows = parseKeelungHTML(html);
  return rowsToTechWithGeocode(rows, "基隆市", "基隆市政府警察局", {
    label: "基隆市 違規照相之路段 (HTML latest)",
    sourceUrl: KEELUNG_PAGE,
  });
}

// ============ 新竹市 (HTML + geocode) ============
const HSINCHU_PAGE = "https://tra.hccp.gov.tw/pages/camera";
async function fetchHsinchuCity(): Promise<SourceResult> {
  const html = await safeFetchText(HSINCHU_PAGE, "新竹市");
  const rows = parseHsinchuHTML(html);
  return rowsToTechWithGeocode(rows, "新竹市", "新竹市政府警察局", {
    label: "新竹市 科學儀器及科技執法取締地點",
    sourceUrl: HSINCHU_PAGE,
  });
}

// ============ 嘉義縣 (PDF with built-in coords) ============
const CHIAYI_COUNTY_PDF =
  "https://www.cypd.gov.tw/upfiles/files/%E5%98%89%E7%BE%A9%E7%B8%A3%E8%AD%A6%E5%AF%9F%E5%B1%80%E5%9B%BA%E5%AE%9A%E5%BC%8F%E7%A7%91%E5%AD%B8%E5%84%80%E5%99%A8%E4%BA%A4%E9%80%9A%E5%9F%B7%E6%B3%95%E8%A8%AD%E5%82%99%E8%A8%AD%E7%BD%AE%E5%9C%B0%E9%BB%9E%E4%B8%80%E8%A6%BD%E8%A1%A8113%E5%B9%B41%E6%9C%88%E5%85%AC%E5%91%8A%E5%9C%B0%E9%BB%9E.pdf";
async function fetchChiayiCounty(): Promise<SourceResult> {
  const { text } = await fetchPDFText(CHIAYI_COUNTY_PDF);
  const rows = parseChiayiCounty(text);
  const points: EnforcementPoint[] = [];
  for (const r of rows) {
    if (r.lat == null || r.lng == null) continue;
    if (r.violation && isPureSpeedingPhrase(r.violation)) continue;
    points.push({
      id: "",
      kind: "tech",
      city: "嘉義縣",
      district: r.district,
      address: r.address,
      lat: r.lat,
      lng: r.lng,
      direction: r.direction,
      speedLimit: r.speedLimit,
      enforcementType: r.violation,
      authority: "嘉義縣警察局",
    });
  }
  return {
    label: "嘉義縣 固定式科學儀器交通執法設備",
    sourceUrl: "https://www.cypd.gov.tw/Tpb/News/Details/d501d372-4195-2632-2787-f0847b97a70d/23/13478",
    sourceUpdatedAt: "2024-01",
    fetchedAt: new Date().toISOString(),
    points,
  };
}

// ============ 彰化 (CSV with coords, data.gov.tw/27969) ============
async function fetchChanghua(): Promise<SourceResult> {
  const url = "https://www.chpb.gov.tw/opendata/2XvPDK8t9UC1v65F7FQ4Kw/csv";
  const csv = parseCSV(await safeFetchText(url, "彰化"));
  const points: EnforcementPoint[] = [];
  // header: 設備編號 設置地點 公路分類 速限 取締項目 拍攝方向 經度 緯度 備註
  for (const r of csv.slice(1)) {
    if (r.length < 8) continue;
    const [, location, , limit, item, dir, lng, lat] = r;
    const la = Number.parseFloat(lat);
    const ln = Number.parseFloat(lng);
    if (!Number.isFinite(la) || !Number.isFinite(ln) || !inTaiwan(la, ln))
      continue;
    if (isPureSpeedingPhrase(item)) continue;
    const lim = Number.parseInt(limit, 10);
    const dm = location?.match(/([一-鿿]{1,5}(?:區|市|鄉|鎮))/);
    points.push({
      id: "",
      kind: "tech",
      city: "彰化縣",
      district: dm?.[1] ?? "",
      address: location?.trim() ?? "",
      lat: la,
      lng: ln,
      direction: dir?.trim() || undefined,
      speedLimit: Number.isFinite(lim) ? lim : undefined,
      enforcementType: item?.trim() || undefined,
      authority: "彰化縣警察局",
    });
  }
  return {
    label: "彰化縣 固定桿式自動取締違規照相",
    sourceUrl: "https://data.gov.tw/dataset/27969",
    sourceUpdatedAt: null,
    fetchedAt: new Date().toISOString(),
    points,
  };
}

// ============ 苗栗 (PDF with built-in coords) ============
const MIAOLI_PDF =
  "https://webws.miaoli.gov.tw/Download.ashx?u=LzAwMS9VcGxvYWQvNDY3L3JlbGZpbGUvMTA4MDAvNjY1OTQyLzc2M2RhNGEyLWU5YTEtNDUxMi04OWRkLTAxNTc2Zjg3MDQyMi5wZGY%3D&n=6Kit572u5Zyw6bue6KGoLnBkZg%3D%3D";
async function fetchMiaoli(): Promise<SourceResult> {
  const { text } = await fetchPDFText(MIAOLI_PDF);
  const rows = parseMiaoli(text);
  const points: EnforcementPoint[] = [];
  for (const r of rows) {
    if (r.lat == null || r.lng == null) continue;
    if (r.violation && isPureSpeedingPhrase(r.violation)) continue;
    points.push({
      id: "",
      kind: "tech",
      city: "苗栗縣",
      district: r.district,
      address: r.address,
      lat: r.lat,
      lng: r.lng,
      direction: r.direction,
      speedLimit: r.speedLimit,
      enforcementType: r.violation,
      authority: "苗栗縣警察局",
    });
  }
  return {
    label: "苗栗縣 固定式闖紅燈、測速及跨越雙黃線照相設備",
    sourceUrl: "https://www.mpb.gov.tw/",
    sourceUpdatedAt: null,
    fetchedAt: new Date().toISOString(),
    points,
  };
}

// ============ 宜蘭 (CSV addresses + geocode) ============
async function fetchYilan(): Promise<SourceResult> {
  const url =
    "https://opendataap2.e-land.gov.tw/./resource/files/2026-04-21/7ee7846049c5beb093fb4b119c4d864f.csv";
  const csv = parseCSV(await safeFetchText(url, "宜蘭"));
  const rows: RawRow[] = [];
  // header rows can be 2-3 lines depending on year publish
  for (const r of csv.slice(2)) {
    if (r.length < 5) continue;
    const [, location, item, dir] = r;
    if (!location?.trim()) continue;
    const dm = location.match(/([一-鿿]{1,5}(?:區|市|鄉|鎮))/);
    rows.push({
      district: dm?.[1] ?? "",
      address: location.replace(/[,，]\s*速限\s*\d+\s*公里?/, "").trim(),
      violation: item?.trim() || undefined,
      direction: dir?.trim() || undefined,
      raw: r.join(","),
    });
  }
  return rowsToTechWithGeocode(rows, "宜蘭縣", "宜蘭縣政府警察局", {
    label: "宜蘭縣 固定式科學儀器執法設備 (CSV+geocode)",
    sourceUrl: "https://data.gov.tw/dataset/128438",
  });
}

// ============ Generic: rows → tech points with on-demand geocoding ============

async function rowsToTechWithGeocode(
  rows: RawRow[],
  city: string,
  authority: string,
  meta: { label: string; sourceUrl: string },
): Promise<SourceResult> {
  const points: EnforcementPoint[] = [];
  let unmatched = 0;
  for (const r of rows) {
    // skip pure-超速 BEFORE geocoding to save Nominatim quota
    if (r.violation && isPureSpeedingPhrase(r.violation)) continue;
    let lat = r.lat;
    let lng = r.lng;
    if (lat == null || lng == null) {
      const gc = await geocodeIfBudget(city, r.district, r.address);
      if (gc) {
        lat = gc.lat;
        lng = gc.lng;
      }
    }
    if (lat == null || lng == null) {
      unmatched++;
      continue;
    }
    points.push({
      id: "",
      kind: "tech",
      city,
      district: r.district,
      address: r.address,
      lat,
      lng,
      direction: r.direction,
      speedLimit: r.speedLimit,
      enforcementType: r.violation,
      authority,
    });
  }
  if (unmatched) console.log(`    ${city}: unmatched ${unmatched} (api calls so far: ${getApiCallsMade()}/${MAX_GEOCODE_PER_RUN})`);
  return {
    label: meta.label,
    sourceUrl: meta.sourceUrl,
    sourceUpdatedAt: null,
    fetchedAt: new Date().toISOString(),
    points,
  };
}

// ============ orchestrator ============
const SOURCES: Array<() => Promise<SourceResult>> = [
  fetchHighwayRedlight,
  fetchTaipeiSmart,
  fetchKaohsiungFixed,
  fetchKaohsiungRental,
  fetchChiayiCity,
  fetchNTPCFromPDF,
  fetchTaichungFixed,
  fetchTaichungTech,
  fetchTaoyuan,
  fetchTainan,
  fetchKeelung,
  fetchHsinchuCity,
  fetchYilan,
  fetchMiaoli,
  fetchChanghua,
  fetchChiayiCounty,
];

async function loadExisting(): Promise<DataBundle | null> {
  if (!existsSync(OUT_FILE)) return null;
  try {
    return JSON.parse(await readFile(OUT_FILE, "utf8")) as DataBundle;
  } catch {
    return null;
  }
}

async function main() {
  console.log("[FlashForce scrape:tech] fetching 全台 tech-enforcement…");
  const all: EnforcementPoint[] = [];
  const sources: DataBundle["sources"] = [];
  let id = 0;
  for (const fn of SOURCES) {
    try {
      const r = await fn();
      r.points.forEach((p) => all.push({ ...p, id: `tech-${++id}` }));
      sources.push({
        kind: "tech",
        label: r.label,
        sourceUrl: r.sourceUrl,
        sourceUpdatedAt: r.sourceUpdatedAt,
        fetchedAt: r.fetchedAt,
        license: "政府資料開放授權條款 v1",
        count: r.points.length,
      });
      console.log(`  ✓ ${r.label}: ${r.points.length}`);
    } catch (e) {
      console.warn(`  ✗ ${(e as Error).message}`);
    }
  }
  console.log(`  tech total: ${all.length}`);

  const existing = await loadExisting();
  if (!existing) {
    console.error("  data.json not found — run `npm run scrape` first.");
    process.exit(1);
  }
  const otherPoints = existing.points.filter((p) => p.kind !== "tech");
  const otherSources = existing.sources.filter((s) => s.kind !== "tech");

  const bundle: DataBundle = {
    generatedAt: new Date().toISOString(),
    sources: [...otherSources, ...sources],
    points: [...otherPoints, ...all],
  };

  await mkdir(OUT_DIR, { recursive: true });
  await writeFile(OUT_FILE, JSON.stringify(bundle), "utf8");
  await flushCache();
  console.log(`[FlashForce scrape:tech] wrote ${OUT_FILE}`);
  console.log(`  total points: ${bundle.points.length}`);
  console.log(`  Nominatim API calls: ${getApiCallsMade()}/${MAX_GEOCODE_PER_RUN}`);
}

// ===== coverage matrix (22 縣市) =====
//
// 已串 ✓ ／ 待擴展 ⚠ ／ 暫缺 ✗ ／ 僅 PDF/HTML 📄
//
// 6 都
//   臺北市 ✓ data.taipei (35+ 點)
//   新北市 ✓ NTPC PDF latest (1150430+) → CSV 座標查找
//   桃園市 📄 traffic2.tyhp.gov.tw/index-77 + traffic.tycg.gov.tw 各有 PDF
//   臺中市 📄 police.taichung.gov.tw/traffic 「固定式及移動式」清單頁
//   臺南市 📄 tnpd.gov.tw/Article/71d16651-... + 多份 PDF
//   高雄市 ✓ data.gov.tw 多份 dataset
//
// 3 省轄市
//   基隆市 📄 klg.gov.tw/cht/index.php?code=list&ids=937 (HTML 列表)
//   新竹市 📄 tra.hccp.gov.tw/pages/camera (HTML 表格)
//   嘉義市 ✓ data.gov.tw/52544 (11 點)
//
// 13 縣
//   宜蘭縣 ⚠ data.gov.tw/128438 (CSV 無經緯度，需 geocoding)
//   新竹縣 📄 hccp.gov.tw 警政公告
//   苗栗縣 📄 mpb.gov.tw 113 年 PDF 一覽
//   彰化縣 📄 chpb.gov.tw/FileList/C004200 (PDF 列表)
//   南投縣 ⚠ data.gov.tw/38357 (與 7320 重複)
//   雲林縣 📄 ylcpb.gov.tw 警政公告
//   嘉義縣 ✗
//   屏東縣 ⚠ data.gov.tw/144578 (與 7320 重複)
//   臺東縣 ✗
//   花蓮縣 📄 hlpb.gov.tw/iframcontent_edit.php?menu=1775&typeid=2763
//   澎湖縣 ✗
//   金門縣 (固定已在 7320，無獨立科技執法 dataset)
//   連江縣 ✗

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
