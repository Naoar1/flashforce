import { mkdir, writeFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { DataBundle, EnforcementPoint } from "../lib/types";

const FIXED_CSV =
  "https://opdadm.moi.gov.tw/api/v1/no-auth/resource/api/dataset/EA5E6FCD-B82D-43B7-A5CF-E9893253187E/resource/20A22CBE-D705-4DBE-8851-4C63B4806DE4/download";
const FIXED_LANDING = "https://data.gov.tw/dataset/7320";

const ROOT = process.cwd();
const OUT_DIR = join(ROOT, "public", "data");
const OUT_FILE = join(OUT_DIR, "data.json");

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
      } else if (c === '"') {
        inQuotes = false;
      } else {
        field += c;
      }
    } else {
      if (c === '"') inQuotes = true;
      else if (c === ",") {
        row.push(field);
        field = "";
      } else if (c === "\n") {
        row.push(field);
        rows.push(row);
        row = [];
        field = "";
      } else if (c === "\r") {
        // skip
      } else {
        field += c;
      }
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

function stripBOM(s: string): string {
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

async function fetchFixedCameras(): Promise<{
  points: EnforcementPoint[];
  fetchedAt: string;
}> {
  const res = await fetch(FIXED_CSV, {
    headers: { "User-Agent": "FlashForce-scraper/0.1 (+https://github.com/)" },
  });
  if (!res.ok) throw new Error(`Fixed cameras CSV fetch failed: ${res.status}`);
  const text = stripBOM(await res.text());
  const rows = parseCSV(text);
  // First row: english headers; second row: chinese headers; rest: data
  const dataRows = rows.slice(2).filter((r) => r.length >= 9 && r[5] && r[6]);
  const points: EnforcementPoint[] = [];
  for (const r of dataRows) {
    const [city, district, address, dept, branch, lng, lat, direction, limit] =
      r;
    const lngN = Number.parseFloat(lng);
    const latN = Number.parseFloat(lat);
    if (!Number.isFinite(lngN) || !Number.isFinite(latN)) continue;
    if (latN < 21 || latN > 26.5 || lngN < 118 || lngN > 122.5) continue;
    const limitN = Number.parseInt(limit, 10);
    points.push({
      id: `fixed-${points.length + 1}`,
      kind: "fixed",
      city: city.trim(),
      district: district.trim(),
      address: address.trim(),
      lat: latN,
      lng: lngN,
      speedLimit: Number.isFinite(limitN) ? limitN : undefined,
      direction: direction?.trim() || undefined,
      authority: dept?.trim() || undefined,
      branch: branch?.trim() || undefined,
    });
  }
  return { points, fetchedAt: new Date().toISOString() };
}

async function tryReadSourceUpdatedAt(): Promise<string | null> {
  try {
    const res = await fetch(FIXED_LANDING, {
      headers: { "User-Agent": "FlashForce-scraper/0.1" },
    });
    if (!res.ok) return null;
    const html = await res.text();
    // Look for "詮釋資料更新時間" or "metadata last updated"
    const m = html.match(
      /(?:詮釋資料更新時間|metadata\s*last\s*updated)[^<]{0,40}?(\d{4}[-/]\d{1,2}[-/]\d{1,2})/i,
    );
    return m?.[1] ?? null;
  } catch {
    return null;
  }
}

async function loadExisting(): Promise<DataBundle | null> {
  if (!existsSync(OUT_FILE)) return null;
  try {
    return JSON.parse(await readFile(OUT_FILE, "utf8")) as DataBundle;
  } catch {
    return null;
  }
}

async function main() {
  console.log("[FlashForce scrape] fetching fixed-camera data…");
  const fixed = await fetchFixedCameras();
  const sourceUpdatedAt = await tryReadSourceUpdatedAt();
  console.log(`  fixed cameras: ${fixed.points.length}`);

  const existing = await loadExisting();
  // preserve previously scraped tech / mobile points if present
  const otherPoints = (existing?.points ?? []).filter(
    (p) => p.kind !== "fixed",
  );
  const otherSources = (existing?.sources ?? []).filter(
    (s) => s.kind !== "fixed",
  );

  const bundle: DataBundle = {
    generatedAt: new Date().toISOString(),
    sources: [
      {
        kind: "fixed",
        label: "全國固定式測速執法設置點 (警政署)",
        sourceUrl: FIXED_LANDING,
        sourceUpdatedAt,
        fetchedAt: fixed.fetchedAt,
        license: "政府資料開放授權條款 v1",
        count: fixed.points.length,
      },
      ...otherSources,
    ],
    points: [...fixed.points, ...otherPoints],
  };

  await mkdir(OUT_DIR, { recursive: true });
  await writeFile(OUT_FILE, JSON.stringify(bundle), "utf8");
  console.log(`[FlashForce scrape] wrote ${OUT_FILE}`);
  console.log(`  total points: ${bundle.points.length}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
