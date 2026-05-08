/**
 * Shared fetch helpers for scrapers.
 * 部分政府站點 (e.g., traffic.police.ntpc.gov.tw) 的 TLS 中繼憑證鏈不完整，
 * Node 嚴格驗證會 ECONNRESET / certificate-chain — 對這些 host 放寬到只看 leaf.
 */
import { fetch as undiciFetch, Agent } from "undici";

const INSECURE_HOSTS = new Set([
  "www.traffic.police.ntpc.gov.tw",
  "traffic.police.ntpc.gov.tw",
  "www.tnpd.gov.tw",
  "www.hlpb.gov.tw",
  "www.klg.gov.tw",
  "www.chpb.gov.tw",
  "www.mpb.gov.tw",
  "www.ilcpb.gov.tw",
  "www.hccp.gov.tw",
  "tra.hccp.gov.tw",
  "traffic2.tyhp.gov.tw",
  "traffic.tycg.gov.tw",
]);

const insecureAgent = new Agent({ connect: { rejectUnauthorized: false } });

export async function safeFetch(url: string): Promise<Response> {
  const u = new URL(url);
  const init: Parameters<typeof undiciFetch>[1] = {
    headers: { "User-Agent": "FlashForce-scraper/0.1 (+github.com)" },
  };
  if (INSECURE_HOSTS.has(u.hostname)) {
    (init as { dispatcher?: unknown }).dispatcher = insecureAgent;
  }
  const res = await undiciFetch(url, init);
  // cast undici Response → global Response for callers
  return res as unknown as Response;
}

export async function safeFetchText(url: string, label: string) {
  const res = await safeFetch(url);
  if (!res.ok) throw new Error(`${label}: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  // strip BOM
  return buf.toString("utf8").replace(/^﻿/, "");
}

export async function safeFetchBuffer(url: string, label: string) {
  const res = await safeFetch(url);
  if (!res.ok) throw new Error(`${label}: HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}
