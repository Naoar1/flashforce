"use client";

import { useEffect, useRef, useState } from "react";
import type {
  Map as LeafletMap,
  Marker as LeafletMarker,
  MarkerClusterGroup as MCG,
} from "leaflet";
import { ICON_FOR } from "./icons";
import type { DataBundle, EnforcementPoint } from "../lib/types";

const TAIWAN_CENTER: [number, number] = [23.7, 121.0];
const KIND_LABEL: Record<EnforcementPoint["kind"], string> = {
  fixed: "固定測速",
  tech: "科技執法",
  mobile: "機動測速",
};

function formatTime(iso: string | null, full = true): string {
  if (!iso) return "未提供";
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return new Intl.DateTimeFormat("zh-TW", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      ...(full ? { hour: "2-digit", minute: "2-digit", hour12: false } : {}),
      timeZone: "Asia/Taipei",
    }).format(d);
  } catch {
    return iso;
  }
}

function popupHtml(p: EnforcementPoint): string {
  const escape = (s: string) =>
    s.replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
    );
  const rows: string[] = [];
  rows.push(
    `<div style="font-weight:700;font-size:14px;color:#0f1218;margin-bottom:6px">${escape(KIND_LABEL[p.kind])}${p.speedLimit ? ` · 速限 ${p.speedLimit}` : ""}</div>`,
  );
  rows.push(
    `<div style="font-size:13px;color:#3a424d;margin-bottom:4px">${escape(p.city)} ${escape(p.district)}</div>`,
  );
  rows.push(
    `<div style="font-size:13px;color:#0f1218;margin-bottom:6px">${escape(p.address)}</div>`,
  );
  if (p.direction)
    rows.push(
      `<div style="font-size:12px;color:#7d8693">方向：${escape(p.direction)}</div>`,
    );
  if (p.enforcementType)
    rows.push(
      `<div style="font-size:12px;color:#7d8693">類型：${escape(p.enforcementType)}</div>`,
    );
  if (p.authority)
    rows.push(
      `<div style="font-size:12px;color:#7d8693">${escape(p.authority)}${p.branch ? ` · ${escape(p.branch)}` : ""}</div>`,
    );
  const mapsURL = `https://www.google.com/maps/search/?api=1&query=${p.lat},${p.lng}`;
  const streetViewURL = `https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=${p.lat},${p.lng}`;
  rows.push(
    `<div style="margin-top:8px;display:flex;gap:8px;flex-wrap:wrap">
      <a href="${mapsURL}" target="_blank" rel="noopener" style="font-size:12px;color:#1284e8;text-decoration:underline">在 Google Maps 開啟位置</a>
      <a href="${streetViewURL}" target="_blank" rel="noopener" style="font-size:12px;color:#1284e8;text-decoration:underline">街景</a>
    </div>`,
  );
  return rows.join("");
}

export default function MapView({ bundle }: { bundle: DataBundle }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<LeafletMap | null>(null);
  const clusterRef = useRef<MCG | null>(null);
  const meMarkerRef = useRef<LeafletMarker | null>(null);
  const [filter, setFilter] = useState<{
    fixed: boolean;
    tech: boolean;
    mobile: boolean;
  }>({ fixed: true, tech: true, mobile: true });

  useEffect(() => {
    let disposed = false;
    (async () => {
      const L = (await import("leaflet")).default;
      await import("leaflet.markercluster");
      if (disposed || !containerRef.current) return;

      const map = L.map(containerRef.current, {
        center: TAIWAN_CENTER,
        zoom: 8,
        minZoom: 7,
        maxZoom: 18,
        zoomControl: false, // we add our own at bottomleft below
        preferCanvas: true,
      });
      L.control.zoom({ position: "bottomleft" }).addTo(map);
      L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
        attribution:
          '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
        maxZoom: 19,
      }).addTo(map);

      const cluster = (
        L as unknown as { markerClusterGroup: (opts?: object) => MCG }
      ).markerClusterGroup({
        showCoverageOnHover: false,
        spiderfyOnMaxZoom: true,
        maxClusterRadius: 60,
        chunkedLoading: true, // progressive rendering for 2.5k+ markers
        chunkInterval: 50,
        chunkDelay: 20,
        removeOutsideVisibleBounds: true,
        disableClusteringAtZoom: 18, // keep clusters until very-zoomed in
        animate: false, // skip animation overhead during pan/zoom
      });
      cluster.addTo(map);
      mapRef.current = map;
      clusterRef.current = cluster;
      renderMarkers(L, cluster, bundle.points, filter);
    })();
    return () => {
      disposed = true;
      mapRef.current?.remove();
      mapRef.current = null;
      clusterRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    (async () => {
      if (!clusterRef.current) return;
      const L = (await import("leaflet")).default;
      renderMarkers(L, clusterRef.current, bundle.points, filter);
    })();
  }, [filter, bundle.points]);

  async function flyTo(lat: number, lng: number, zoom = 16) {
    if (!mapRef.current) return;
    mapRef.current.flyTo([lat, lng], zoom, { duration: 0.8 });
  }

  async function locateMe() {
    if (!navigator.geolocation) {
      alert("此裝置不支援定位");
      return;
    }
    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        const { latitude, longitude } = pos.coords;
        const L = (await import("leaflet")).default;
        if (meMarkerRef.current) meMarkerRef.current.remove();
        const html = `
          <svg xmlns="http://www.w3.org/2000/svg" width="36" height="36" viewBox="0 0 36 36">
            <circle cx="18" cy="18" r="14" fill="#1284e8" fill-opacity="0.18"/>
            <circle cx="18" cy="18" r="7" fill="#1284e8" stroke="#fff" stroke-width="3"/>
          </svg>`;
        const icon = L.divIcon({
          className: "ff-marker",
          html,
          iconSize: [36, 36],
          iconAnchor: [18, 18],
        });
        meMarkerRef.current = L.marker([latitude, longitude], {
          icon,
          interactive: false,
        }).addTo(mapRef.current!);
        flyTo(latitude, longitude, 15);
      },
      () => alert("無法取得目前位置，請確認瀏覽器權限。"),
      { enableHighAccuracy: true, timeout: 10000 },
    );
  }

  return (
    <div className="relative h-full w-full">
      <div ref={containerRef} className="absolute inset-0" />
      <SearchPanel onPick={(lat, lng) => flyTo(lat, lng, 15)} />
      <FilterPanel filter={filter} setFilter={setFilter} bundle={bundle} />
      <AskPanel onPick={(lat, lng) => flyTo(lat, lng, 16)} />
      <button
        type="button"
        onClick={locateMe}
        className="absolute bottom-32 left-3 z-[1000] flex h-10 w-10 items-center justify-center rounded-md border-2 border-ink-900 bg-white shadow-sketch hover:bg-ink-50"
        aria-label="定位到我的位置"
        title="定位到我的位置"
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          width="22"
          height="22"
          viewBox="0 0 24 24"
          fill="none"
          stroke="#0f1218"
          strokeWidth="2.2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <circle cx="12" cy="12" r="3" />
          <path d="M12 2v3M12 19v3M2 12h3M19 12h3" />
        </svg>
      </button>
      <Footer bundle={bundle} />
    </div>
  );
}

interface IconGeometry {
  size: [number, number];
  anchor: [number, number];
  popup: [number, number];
}
const ICON_GEOM: Record<EnforcementPoint["kind"], IconGeometry> = {
  // viewBox 80x58: 相機底部 ≈ (36, 30)，吊牌掛右下
  fixed: { size: [80, 58], anchor: [36, 30], popup: [4, -28] },
  // viewBox 60x68: 盾形底端 ≈ (30, 42)
  tech: { size: [60, 68], anchor: [30, 42], popup: [0, -38] },
  // viewBox 60x72: 三腳架著地 ≈ (28, 60)
  mobile: { size: [60, 72], anchor: [28, 60], popup: [0, -56] },
};

function renderMarkers(
  L: typeof import("leaflet"),
  cluster: MCG,
  points: EnforcementPoint[],
  filter: { fixed: boolean; tech: boolean; mobile: boolean },
) {
  cluster.clearLayers();
  const markers: import("leaflet").Marker[] = [];
  for (const p of points) {
    if (!filter[p.kind]) continue;
    const html =
      p.kind === "fixed"
        ? ICON_FOR.fixed(p.speedLimit)
        : p.kind === "tech"
          ? ICON_FOR.tech()
          : ICON_FOR.mobile();
    const g = ICON_GEOM[p.kind];
    const icon = L.divIcon({
      className: "ff-marker",
      html,
      iconSize: g.size,
      iconAnchor: g.anchor,
      popupAnchor: g.popup,
    });
    const m = L.marker([p.lat, p.lng], { icon });
    m.bindPopup(popupHtml(p), { maxWidth: 280 });
    markers.push(m);
  }
  cluster.addLayers(markers);
}

interface NominatimHit {
  lat: string;
  lon: string;
  display_name: string;
}

function SearchPanel({
  onPick,
}: {
  onPick: (lat: number, lng: number) => void;
}) {
  const [q, setQ] = useState("");
  const [results, setResults] = useState<NominatimHit[]>([]);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);

  async function go(text: string) {
    if (!text.trim()) return;
    setLoading(true);
    try {
      const url = new URL("https://nominatim.openstreetmap.org/search");
      url.searchParams.set("q", text);
      url.searchParams.set("format", "json");
      url.searchParams.set("countrycodes", "tw");
      url.searchParams.set("limit", "5");
      url.searchParams.set("accept-language", "zh-TW");
      const res = await fetch(url.toString());
      if (!res.ok) throw new Error(String(res.status));
      const data = (await res.json()) as NominatimHit[];
      setResults(data);
      setOpen(true);
    } catch {
      setResults([]);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="absolute left-3 top-3 z-[1000] w-72">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          go(q);
        }}
        className="flex items-center gap-2 rounded-2xl border-2 border-ink-900 bg-white/95 px-3 py-2 shadow-sketch backdrop-blur"
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          width="18"
          height="18"
          viewBox="0 0 24 24"
          fill="none"
          stroke="#0f1218"
          strokeWidth="2.2"
          strokeLinecap="round"
        >
          <circle cx="11" cy="11" r="7" />
          <path d="m20 20-3.5-3.5" />
        </svg>
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onFocus={() => results.length && setOpen(true)}
          placeholder="搜尋地點 / 地址 / 路口"
          className="w-full bg-transparent text-sm text-ink-900 outline-none placeholder:text-ink-400"
        />
        {loading && (
          <span className="font-sketch text-xs text-ink-400">…</span>
        )}
      </form>
      {open && results.length > 0 && (
        <ul className="mt-2 overflow-hidden rounded-2xl border-2 border-ink-900 bg-white/95 shadow-sketch">
          {results.map((r, i) => (
            <li
              key={i}
              className="cursor-pointer border-b border-ink-100 px-3 py-2 text-sm text-ink-900 last:border-b-0 hover:bg-ink-50"
              onClick={() => {
                onPick(Number(r.lat), Number(r.lon));
                setOpen(false);
              }}
            >
              {r.display_name}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

interface AskCitation {
  id: string;
  kind: EnforcementPoint["kind"];
  address: string;
  lat: number;
  lng: number;
}

function AskPanel({
  onPick,
}: {
  onPick: (lat: number, lng: number) => void;
}) {
  const [collapsed, setCollapsed] = useState(true);
  const [q, setQ] = useState("");
  const [loading, setLoading] = useState(false);
  const [answer, setAnswer] = useState<string | null>(null);
  const [cited, setCited] = useState<AskCitation[]>([]);
  const [err, setErr] = useState<string | null>(null);

  const HINTS = [
    "仰德大道上陽明山測速點插在哪裡",
    "中正橋接水快有科技執法點嗎",
    "台64區間限速多少",
  ];

  async function ask(text: string) {
    if (!text.trim()) return;
    setLoading(true);
    setErr(null);
    setAnswer(null);
    setCited([]);
    try {
      const res = await fetch("/api/ask", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ question: text }),
      });
      if (!res.ok) {
        setErr(`HTTP ${res.status}`);
      } else {
        const data = (await res.json()) as {
          answer?: string;
          cited?: AskCitation[];
          error?: string;
        };
        if (data.error) setErr(data.error);
        else {
          setAnswer(data.answer ?? "");
          setCited(data.cited ?? []);
        }
      }
    } catch (e) {
      setErr(String((e as Error).message));
    } finally {
      setLoading(false);
    }
  }

  if (collapsed) {
    return (
      <button
        type="button"
        onClick={() => setCollapsed(false)}
        className="absolute right-3 top-56 z-[1000] flex items-center gap-1.5 rounded-full border-2 border-ink-900 bg-white px-3 py-1.5 text-sm font-semibold text-ink-900 shadow-sketch hover:bg-ink-50"
        title="自然語言問問題"
      >
        <span>✨</span>
        <span>問問題</span>
      </button>
    );
  }

  return (
    <div className="absolute right-3 top-56 z-[1000] flex max-h-[60vh] w-80 flex-col overflow-hidden rounded-2xl border-2 border-ink-900 bg-white/95 shadow-sketch backdrop-blur">
      <div className="flex items-center justify-between border-b border-ink-100 px-3 py-2">
        <div className="flex items-center gap-1.5 font-sketch text-lg leading-none text-ink-900">
          <span>✨</span> 問 FlashForce
        </div>
        <button
          type="button"
          onClick={() => setCollapsed(true)}
          className="text-ink-400 hover:text-ink-900"
          aria-label="收起"
        >
          ✕
        </button>
      </div>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          ask(q);
        }}
        className="flex items-center gap-2 px-3 py-2"
      >
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="例如「台64 區間限速多少」"
          maxLength={200}
          className="flex-1 rounded-md border border-ink-200 px-2 py-1 text-sm text-ink-900 outline-none focus:border-ai-500"
        />
        <button
          type="submit"
          disabled={loading || !q.trim()}
          className="rounded-md border-2 border-ink-900 bg-ai-500 px-2 py-1 text-sm font-semibold text-white shadow-sketch disabled:opacity-50"
        >
          {loading ? "…" : "送"}
        </button>
      </form>
      <div className="border-t border-ink-100 px-3 py-2">
        <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-ink-400">
          Try this hint
        </div>
        <div className="flex flex-wrap gap-1.5">
          {HINTS.map((h) => (
            <button
              key={h}
              type="button"
              onClick={() => {
                setQ(h);
                ask(h);
              }}
              className="rounded-full border border-ink-200 px-2 py-0.5 text-[11px] text-ink-600 hover:border-ai-500 hover:text-ai-500"
            >
              {h}
            </button>
          ))}
        </div>
      </div>
      {(loading || answer || err || cited.length > 0) && (
        <div className="flex-1 overflow-auto border-t border-ink-100 px-3 py-2 text-sm">
          {loading && (
            <div className="text-ink-400">查詢中（模型在 Cloudflare 邊端跑，約 2-5 秒）…</div>
          )}
          {err && <div className="text-radar-700">錯誤：{err}</div>}
          {answer && (
            <div className="whitespace-pre-wrap leading-relaxed text-ink-900">
              {answer}
            </div>
          )}
          {cited.length > 0 && (
            <div className="mt-2 border-t border-ink-100 pt-2">
              <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-ink-400">
                引用點位 ({cited.length})
              </div>
              <ul className="space-y-0.5 text-[11px]">
                {cited.slice(0, 12).map((c) => (
                  <li
                    key={c.id}
                    onClick={() => onPick(c.lat, c.lng)}
                    className="cursor-pointer rounded px-1 hover:bg-ink-50"
                  >
                    <span className="text-ink-400">[{c.id}]</span>{" "}
                    <span className="text-ink-900">{c.address}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function FilterPanel({
  filter,
  setFilter,
  bundle,
}: {
  filter: { fixed: boolean; tech: boolean; mobile: boolean };
  setFilter: React.Dispatch<
    React.SetStateAction<{ fixed: boolean; tech: boolean; mobile: boolean }>
  >;
  bundle: DataBundle;
}) {
  const counts = {
    fixed: bundle.points.filter((p) => p.kind === "fixed").length,
    tech: bundle.points.filter((p) => p.kind === "tech").length,
    mobile: bundle.points.filter((p) => p.kind === "mobile").length,
  };
  const Item = ({
    k,
    color,
    label,
  }: {
    k: "fixed" | "tech" | "mobile";
    color: string;
    label: string;
  }) => (
    <label className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1 hover:bg-ink-50">
      <input
        type="checkbox"
        checked={filter[k]}
        onChange={(e) =>
          setFilter((f) => ({ ...f, [k]: e.target.checked }))
        }
        className="h-4 w-4 accent-radar-500"
      />
      <span
        className="inline-block h-3 w-3 rounded-full border-2 border-ink-900"
        style={{ background: color }}
      />
      <span className="text-sm text-ink-900">{label}</span>
      <span className="ml-auto text-xs text-ink-400">{counts[k]}</span>
    </label>
  );
  return (
    <div className="absolute right-3 top-3 z-[1000] w-56 rounded-2xl border-2 border-ink-900 bg-white/95 p-3 shadow-sketch backdrop-blur">
      <div className="mb-2 font-sketch text-2xl leading-none text-ink-900">
        FlashForce
      </div>
      <div className="mb-2 text-xs text-ink-400">
        全台科技執法・測速地圖
      </div>
      <div className="space-y-0.5">
        <Item k="fixed" color="#ff7a59" label="固定測速" />
        <Item k="tech" color="#3aa9ff" label="科技執法" />
        <Item k="mobile" color="#ffc043" label="機動測速" />
      </div>
    </div>
  );
}

function Footer({ bundle }: { bundle: DataBundle }) {
  const [open, setOpen] = useState(false);
  const totals = {
    fixed: bundle.points.filter((p) => p.kind === "fixed").length,
    tech: bundle.points.filter((p) => p.kind === "tech").length,
    mobile: bundle.points.filter((p) => p.kind === "mobile").length,
  };
  // hide 0-count, group by kind, sort within group by count desc
  const grouped: Record<EnforcementPoint["kind"], DataBundle["sources"]> = {
    fixed: [],
    tech: [],
    mobile: [],
  };
  for (const s of bundle.sources) {
    if (s.count === 0) continue;
    grouped[s.kind].push(s);
  }
  for (const k of Object.keys(grouped) as EnforcementPoint["kind"][]) {
    grouped[k].sort((a, b) => b.count - a.count);
  }
  const totalSources =
    grouped.fixed.length + grouped.tech.length + grouped.mobile.length;
  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-0 z-[1000] flex justify-center px-3 pb-3">
      <div className="pointer-events-auto max-w-3xl rounded-xl border-2 border-ink-900 bg-white/95 px-3 py-2 text-[11px] leading-snug text-ink-600 shadow-sketch backdrop-blur">
        <div className="flex flex-wrap items-baseline gap-x-3">
          <span>
            <span className="font-semibold text-ink-900">最近爬蟲完成：</span>
            {formatTime(bundle.generatedAt)} (台灣時間)
          </span>
          <span className="text-ink-400">
            固定 {totals.fixed} · 科技 {totals.tech} · 機動 {totals.mobile}
          </span>
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            className="ml-auto text-ai-500 underline-offset-2 hover:underline"
          >
            {open ? "收起資料來源" : `展開 ${totalSources} 個來源`}
          </button>
        </div>
        {open && (
          <div className="mt-1 max-h-48 overflow-auto">
            {(["fixed", "tech", "mobile"] as const).map((k) =>
              grouped[k].length === 0 ? null : (
                <div key={k} className="mt-1">
                  <div className="text-[10px] font-semibold uppercase tracking-wide text-ink-400">
                    {KIND_LABEL[k]}（{grouped[k].length} 個源）
                  </div>
                  <ul className="space-y-0.5">
                    {grouped[k].map((s) => (
                      <li key={s.label}>
                        <a
                          href={s.sourceUrl}
                          target="_blank"
                          rel="noopener"
                          className="text-ai-500 hover:underline"
                        >
                          {s.label}
                        </a>
                        （{s.count} 筆，來源更新{" "}
                        {formatTime(s.sourceUpdatedAt, false)}）
                      </li>
                    ))}
                  </ul>
                </div>
              ),
            )}
          </div>
        )}
        <div className="mt-1 text-ink-400">
          ⚠ 資料僅供參考，實際取締請依現場標示與員警指揮為準。地點搜尋使用 Nominatim/OpenStreetMap。
        </div>
      </div>
    </div>
  );
}
