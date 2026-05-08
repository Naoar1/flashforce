/**
 * 機動測速 (mobile / portable speed traps) — 全台.
 *
 * 機動測速由各縣市警察局公告，「設置地點」是指該縣市警察通常會在這些
 * 點位實施機動執法。各縣市發布頻率多為週/月。
 *
 * 此 scraper 使用：
 *   - 新北：traffic.police.ntpc.gov.tw 移動式公告 (HTML 表格，1096+ 點)
 *   - 臺中：police.taichung.gov.tw filedownload 「移動式測速照相公告」(PDF)
 *
 * 兩者皆無經緯度 → 走 Nominatim geocoding (1 req/sec)；地址快取至磁碟，
 * GH Actions 後續 run 直接命中。
 *
 * 重要：機動點與既有 fixed/tech 點 *不去重*。同一路口可能同時有固定攝影
 * 與機動巡邏，疊兩個 marker 是預期行為（icon 顏色不同，使用者自行判讀）。
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { DataBundle, EnforcementPoint } from "../lib/types";
import { safeFetchText } from "../lib/fetch";
import { fetchPDFText } from "../lib/pdf";
import { flushCache, geocodeAddress, getApiCallsMade } from "../lib/geocode";
import {
  parseNTPCMobileHTML,
  parseTaichungMobile,
  type RawRow,
} from "../lib/scrape-counties";

const ROOT = process.cwd();
const OUT_DIR = join(ROOT, "public", "data");
const OUT_FILE = join(OUT_DIR, "data.json");

const MAX_GEOCODE_PER_RUN = 250;

interface SourceResult {
  label: string;
  sourceUrl: string;
  sourceUpdatedAt: string | null;
  fetchedAt: string;
  points: EnforcementPoint[];
}

async function geocodeIfBudget(
  city: string,
  district: string,
  address: string,
) {
  if (getApiCallsMade() >= MAX_GEOCODE_PER_RUN) return null;
  return geocodeAddress(city, district, address);
}

async function rowsToMobile(
  rows: RawRow[],
  city: string,
  authority: string,
  meta: { label: string; sourceUrl: string; sourceUpdatedAt: string | null },
): Promise<SourceResult> {
  const points: EnforcementPoint[] = [];
  let unmatched = 0;
  for (const r of rows) {
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
      kind: "mobile",
      city,
      district: r.district,
      address: r.address,
      lat,
      lng,
      direction: r.direction,
      speedLimit: r.speedLimit,
      enforcementType: "機動測速 / 經常出沒點",
      authority,
    });
  }
  console.log(
    `    ${city}: matched ${points.length}, unmatched ${unmatched} (api calls: ${getApiCallsMade()}/${MAX_GEOCODE_PER_RUN})`,
  );
  return {
    label: meta.label,
    sourceUrl: meta.sourceUrl,
    sourceUpdatedAt: meta.sourceUpdatedAt,
    fetchedAt: new Date().toISOString(),
    points,
  };
}

// ============ 新北 移動式 (HTML) ============
//
// The cp-* announcement page has a JS-rendered shell; the matching fp-* page
// contains the actual inline 1096-row table.
const NTPC_MOBILE_PAGE =
  "https://www.traffic.police.ntpc.gov.tw/fp-3313-97704-27.html";

async function fetchNTPCMobile(): Promise<SourceResult> {
  const html = await safeFetchText(NTPC_MOBILE_PAGE, "ntpc-mobile");
  const rows = parseNTPCMobileHTML(html);
  console.log(`    NTPC mobile raw rows: ${rows.length}`);
  return rowsToMobile(rows, "新北市", "新北市政府警察局交通警察大隊", {
    label: "新北市 移動式科學儀器執法設備 (HTML latest)",
    sourceUrl: NTPC_MOBILE_PAGE,
    sourceUpdatedAt: "2025-11-26",
  });
}

// ============ 臺中 移動式 (PDF) ============
const TAICHUNG_LIST =
  "https://www.police.taichung.gov.tw/traffic/home.jsp?id=55&parentpath=null&mcustomize=multimessages_view.jsp&dataserno=202207040001&t=Download&mserno=201801260055";
const TAICHUNG_HOST = "https://www.police.taichung.gov.tw";

async function fetchTaichungMobile(): Promise<SourceResult> {
  const html = await safeFetchText(TAICHUNG_LIST, "taichung-list");
  const re =
    /<a[^>]*href="(\/filedownload\?file=[^"]+&filedisplay=([^"&]+\.pdf)[^"]*)"[^>]*>/gi;
  let m: RegExpExecArray | null;
  let target: { url: string; title: string } | null = null;
  // Several PDFs on the page have 移動式 in the title; we want the data
  // 「取締地點一覽表」, NOT the announcement letter「公告」.
  const candidates: Array<{ url: string; title: string }> = [];
  while ((m = re.exec(html)) !== null) {
    const title = decodeURIComponent(m[2]);
    if (!/移動式/.test(title)) continue;
    candidates.push({ url: new URL(m[1], TAICHUNG_HOST).href, title });
  }
  target =
    candidates.find((c) => /取締地點一覽表/.test(c.title)) ??
    candidates.find((c) => !/公告/.test(c.title)) ??
    candidates[0] ??
    null;
  if (!target) throw new Error("臺中 mobile PDF not found");
  const { text } = await fetchPDFText(target.url);
  const rows = parseTaichungMobile(text);
  console.log(`    臺中 mobile raw rows: ${rows.length}`);
  return rowsToMobile(rows, "臺中市", "臺中市政府警察局交通警察大隊", {
    label: `臺中市 移動式測速照相 (${target.title})`,
    sourceUrl: TAICHUNG_LIST,
    sourceUpdatedAt: extractDateFromTitle(target.title),
  });
}

function extractDateFromTitle(title: string): string | null {
  const m1 = title.match(/(\d{2,3})年(\d{1,2})月(\d{1,2})日/);
  if (m1) {
    const y = Number(m1[1]) + 1911;
    return `${y}-${m1[2].padStart(2, "0")}-${m1[3].padStart(2, "0")}`;
  }
  const m2 = title.match(/\b(\d{3})年/);
  if (m2) return `${Number(m2[1]) + 1911}`;
  return null;
}

const SOURCES: Array<() => Promise<SourceResult>> = [
  fetchNTPCMobile,
  fetchTaichungMobile,
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
  console.log("[FlashForce scrape:mobile] fetching mobile-speed-trap data…");
  const all: EnforcementPoint[] = [];
  const sources: DataBundle["sources"] = [];
  let id = 0;
  for (const fn of SOURCES) {
    try {
      const r = await fn();
      r.points.forEach((p) => all.push({ ...p, id: `mobile-${++id}` }));
      sources.push({
        kind: "mobile",
        label: r.label,
        sourceUrl: r.sourceUrl,
        sourceUpdatedAt: r.sourceUpdatedAt,
        fetchedAt: r.fetchedAt,
        license: "依各機關授權",
        count: r.points.length,
      });
      console.log(`  ✓ ${r.label}: ${r.points.length}`);
    } catch (e) {
      console.warn(`  ✗ ${(e as Error).message}`);
    }
  }
  console.log(`  mobile total: ${all.length}`);

  const existing = await loadExisting();
  if (!existing) {
    console.error("  data.json not found — run `npm run scrape` first.");
    process.exit(1);
  }
  const otherPoints = existing.points.filter((p) => p.kind !== "mobile");
  const otherSources = existing.sources.filter((s) => s.kind !== "mobile");

  const bundle: DataBundle = {
    generatedAt: new Date().toISOString(),
    sources: [...otherSources, ...sources],
    points: [...otherPoints, ...all],
  };

  await mkdir(OUT_DIR, { recursive: true });
  await writeFile(OUT_FILE, JSON.stringify(bundle), "utf8");
  await flushCache();
  console.log(`[FlashForce scrape:mobile] wrote ${OUT_FILE}`);
  console.log(`  total points: ${bundle.points.length}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
