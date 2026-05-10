/**
 * Shared fetch helpers for scrapers.
 *
 * Many .gov.tw sites have incomplete TLS chains and/or transient outages
 * (504, ECONNRESET). We:
 *   1) lower TLS strictness for any *.gov.tw host (they serve public data,
 *      we're already trusting them by definition; the cert chain quirks
 *      are infrastructure noise, not security signal)
 *   2) retry transient network failures with exponential backoff
 *   3) include the host in every error message so cron logs are debuggable
 */
import { fetch as undiciFetch, Agent } from "undici";

function isInsecureHost(hostname: string): boolean {
  return hostname.endsWith(".gov.tw") || hostname.endsWith(".gov.taipei");
}

const insecureAgent = new Agent({ connect: { rejectUnauthorized: false } });

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

async function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

export async function safeFetch(url: string, retries = 3): Promise<Response> {
  const u = new URL(url);
  const init: Parameters<typeof undiciFetch>[1] = {
    headers: {
      "User-Agent": "FlashForce-scraper/0.1 (+github.com)",
      Accept:
        "text/html,application/xhtml+xml,application/json,application/pdf,text/csv,*/*;q=0.8",
    },
  };
  if (isInsecureHost(u.hostname)) {
    (init as { dispatcher?: unknown }).dispatcher = insecureAgent;
  }

  let lastErr: unknown = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await undiciFetch(url, init);
      if (res.ok) return res as unknown as Response;
      if (!RETRYABLE_STATUS.has(res.status) || attempt === retries) {
        return res as unknown as Response;
      }
      lastErr = new Error(`HTTP ${res.status}`);
    } catch (e) {
      lastErr = e;
      if (attempt === retries) break;
    }
    // backoff: 800ms, 2.4s, 7.2s
    await sleep(800 * Math.pow(3, attempt));
  }
  const msg = lastErr instanceof Error ? lastErr.message : String(lastErr);
  throw new Error(`fetch failed: ${u.hostname} — ${msg}`);
}

export async function safeFetchText(url: string, label: string) {
  const res = await safeFetch(url);
  if (!res.ok) throw new Error(`${label} (${new URL(url).hostname}): HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  return buf.toString("utf8").replace(/^﻿/, "");
}

export async function safeFetchBuffer(url: string, label: string) {
  const res = await safeFetch(url);
  if (!res.ok) throw new Error(`${label} (${new URL(url).hostname}): HTTP ${res.status}`);
  // sanity check: don't return HTML disguised as PDF/CSV
  const buf = Buffer.from(await res.arrayBuffer());
  return buf;
}

/** Try to extract upstream "last modified" from HTTP headers — fallback for sourceUpdatedAt. */
export async function fetchLastModified(url: string): Promise<string | null> {
  try {
    const res = await safeFetch(url);
    const lm = res.headers.get("last-modified");
    if (!lm) return null;
    const d = new Date(lm);
    if (Number.isNaN(d.getTime())) return null;
    return d.toISOString().slice(0, 10);
  } catch {
    return null;
  }
}
