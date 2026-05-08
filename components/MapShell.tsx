"use client";

import { useEffect, useState } from "react";
import MapView from "./Map";
import type { DataBundle } from "../lib/types";

const EMPTY: DataBundle = {
  generatedAt: new Date(0).toISOString(),
  sources: [],
  points: [],
};

export default function MapShell() {
  const [bundle, setBundle] = useState<DataBundle | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/data/data.json", { cache: "no-cache" })
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((b: DataBundle) => {
        if (!cancelled) setBundle(b);
      })
      .catch((e) => {
        if (!cancelled) setError(String(e?.message ?? e));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (error)
    return (
      <div className="flex h-full items-center justify-center text-ink-600">
        <div className="rounded-xl border-2 border-ink-900 bg-white px-4 py-3 shadow-sketch">
          資料載入失敗：{error}
        </div>
      </div>
    );

  if (!bundle)
    return (
      <div className="flex h-full items-center justify-center text-ink-400">
        <div className="font-sketch text-3xl text-ink-900">
          FlashForce
          <div className="mt-1 text-base text-ink-400">資料載入中…</div>
        </div>
      </div>
    );

  return <MapView bundle={bundle.points.length ? bundle : EMPTY} />;
}
