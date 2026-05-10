import { mkdir, writeFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { DataBundle, EnforcementPoint } from "../lib/types";
import { safeFetchText, fetchLastModified } from "../lib/fetch";
import { isIntervalAddress } from "../lib/pdf";

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
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

async function fetchFixedCameras(): Promise<{
  fixed: EnforcementPoint[];
  fetchedAt: string;
}> {
  const text = await safeFetchText(FIXED_CSV, "全國固定測速 CSV");
  const rows = parseCSV(text);
  // First row: english headers; second row: chinese headers; rest: data
  const dataRows = rows.slice(2).filter((r) => r.length >= 9 && r[5] && r[6]);
  const fixed: EnforcementPoint[] = [];
  for (const r of dataRows) {
    const [city, district, address, dept, branch, lng, lat, direction, limit] =
      r;
    const lngN = Number.parseFloat(lng);
    const latN = Number.parseFloat(lat);
    if (!Number.isFinite(lngN) || !Number.isFinite(latN)) continue;
    if (latN < 21 || latN > 26.5 || lngN < 118 || lngN > 122.5) continue;
    // skip 區間 patterns — scrape-tech.ts re-emits those as tech kind
    if (isIntervalAddress(address)) continue;
    const limitN = Number.parseInt(limit, 10);
    fixed.push({
      id: `fixed-${fixed.length + 1}`,
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
  return { fixed, fetchedAt: new Date().toISOString() };
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
  const { fixed, fetchedAt } = await fetchFixedCameras();
  const lastMod = await fetchLastModified(FIXED_CSV);
  console.log(`  fixed cameras: ${fixed.length} (intervals → tech in scrape-tech)`);

  const existing = await loadExisting();
  const otherPoints = (existing?.points ?? []).filter((p) => p.kind !== "fixed");
  const otherSources = (existing?.sources ?? []).filter((s) => s.kind !== "fixed");

  const bundle: DataBundle = {
    generatedAt: new Date().toISOString(),
    sources: [
      {
        kind: "fixed",
        label: "全國固定式測速執法設置點 (警政署)",
        sourceUrl: FIXED_LANDING,
        sourceUpdatedAt: lastMod,
        fetchedAt,
        license: "政府資料開放授權條款 v1",
        count: fixed.length,
      },
      ...otherSources,
    ],
    points: [...fixed, ...otherPoints],
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
