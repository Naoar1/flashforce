/**
 * Nominatim (OpenStreetMap) geocoder — disk-cached, rate-limited.
 *
 * Usage policy: Nominatim allows 1 req/sec, must identify via User-Agent /
 * email. We obey both, plus cache every successful lookup to JSON on disk so
 * GH Actions only spends quota on truly-new addresses.
 */
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { safeFetch } from "./fetch";

const CACHE_FILE = join(
  process.cwd(),
  "public",
  "data",
  ".geocode-cache.json",
);

const NOMINATIM_BASE = "https://nominatim.openstreetmap.org/search";
const RATE_LIMIT_MS = 1100; // a hair over 1 req/sec

interface CacheRow {
  lat: number | null;
  lng: number | null;
  ts: string;
}
type Cache = Record<string, CacheRow>;

let cache: Cache | null = null;
let lastReqAt = 0;
let apiCallsMade = 0;

export function getApiCallsMade() {
  return apiCallsMade;
}
export function resetApiCallsCounter() {
  apiCallsMade = 0;
}

async function loadCache(): Promise<Cache> {
  if (cache) return cache;
  if (existsSync(CACHE_FILE)) {
    try {
      cache = JSON.parse(await readFile(CACHE_FILE, "utf8")) as Cache;
      return cache;
    } catch {
      /* fall through */
    }
  }
  cache = {};
  return cache;
}

export async function flushCache() {
  if (!cache) return;
  await mkdir(dirname(CACHE_FILE), { recursive: true });
  await writeFile(CACHE_FILE, JSON.stringify(cache), "utf8");
}

export interface GeocodeResult {
  lat: number;
  lng: number;
}

function inTaiwan(lat: number, lng: number) {
  return lat >= 21 && lat <= 26.5 && lng >= 118 && lng <= 122.5;
}

async function rateLimit() {
  const now = Date.now();
  const wait = lastReqAt + RATE_LIMIT_MS - now;
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastReqAt = Date.now();
}

/**
 * Resolve a Taiwan address to lat/lng. Returns null if unresolvable.
 * Looks up cache first; on miss, queries Nominatim with TW country filter.
 */
export async function geocode(query: string): Promise<GeocodeResult | null> {
  if (!query || query.length < 4) return null;
  const c = await loadCache();
  const key = query.trim();
  if (key in c) {
    const r = c[key];
    return r.lat != null && r.lng != null ? { lat: r.lat, lng: r.lng } : null;
  }
  await rateLimit();
  apiCallsMade++;
  const url = new URL(NOMINATIM_BASE);
  url.searchParams.set("q", key);
  url.searchParams.set("format", "json");
  url.searchParams.set("countrycodes", "tw");
  url.searchParams.set("limit", "1");
  url.searchParams.set("accept-language", "zh-TW");
  let res: Response;
  try {
    res = await safeFetch(url.toString());
  } catch {
    return null;
  }
  if (!res.ok) {
    c[key] = { lat: null, lng: null, ts: new Date().toISOString() };
    return null;
  }
  const arr = (await res.json()) as Array<{ lat: string; lon: string }>;
  if (!arr.length) {
    c[key] = { lat: null, lng: null, ts: new Date().toISOString() };
    return null;
  }
  const lat = Number.parseFloat(arr[0].lat);
  const lng = Number.parseFloat(arr[0].lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || !inTaiwan(lat, lng)) {
    c[key] = { lat: null, lng: null, ts: new Date().toISOString() };
    return null;
  }
  c[key] = { lat, lng, ts: new Date().toISOString() };
  return { lat, lng };
}

/**
 * Strip Taiwanese address noise that confuses Nominatim's free-form search:
 * directional suffixes ("往XX方向", "雙向", "北上"), parenthetical 速限/說明,
 * 燈桿編號, 公里-mile markers turned into building-style if possible.
 */
export function cleanAddress(s: string): string {
  return s
    // parenthesized direction / 速限 / 燈桿 markers
    .replace(/[（(](?:雙向|北上|南下|東向西?|西向東?|南向北?|北向南?|往[^)）]*|速限[^)）]*|[^)）]*燈桿[^)）]*)[）)]/g, "")
    // trailing "往XXX方向" / "往XXX" — any chars allowed
    .replace(/\s+往\S{1,20}方向?$/g, "")
    .replace(/\s+往[東西南北上下]+(?:方向?)?$/g, "")
    // standalone trailing direction tokens
    .replace(/\s+(雙向|北上|南下|東向|西向|南向|北向|東向西|西向東|南向北|北向南)$/g, "")
    // mid-string direction in brackets-less form: "XXX 雙向 段落"
    .replace(/[燈桿桿號]\s*\d+\s*號?旁?/g, "")
    // lingering pole numbers
    .replace(/\s{2,}/g, " ")
    .trim();
}

/**
 * Try a sequence of query forms (city + district + address, district + address,
 * cleaned forms, address alone) until one resolves. First success wins; failures
 * are cached.
 */
export async function geocodeAddress(
  city: string,
  district: string,
  address: string,
): Promise<GeocodeResult | null> {
  const cleaned = cleanAddress(address);
  const tries = [
    `${city}${district}${cleaned}`,
    `${district}${cleaned}`,
    `${city}${cleaned}`,
    cleaned,
    `${city}${district}${address}`,
    address,
  ].filter((s, i, a) => s.length >= 4 && a.indexOf(s) === i);
  for (const q of tries) {
    const r = await geocode(q);
    if (r) return r;
  }
  return null;
}

/** Haversine — meters between two WGS84 points. */
export function distanceMeters(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number },
): number {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const sLat = Math.sin(dLat / 2);
  const sLng = Math.sin(dLng / 2);
  const h =
    sLat * sLat +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * sLng * sLng;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}
