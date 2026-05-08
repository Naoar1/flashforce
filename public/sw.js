/* FlashForce service worker — minimal offline-first shell + data cache. */
const CACHE_NAME = "flashforce-v1";
const PRECACHE = ["/", "/data/data.json", "/manifest.json", "/icon.svg"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((c) => c.addAll(PRECACHE)).catch(() => {}),
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)),
      );
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  // OSM tiles — cache opportunistically (stale-while-revalidate)
  if (url.hostname.endsWith("tile.openstreetmap.org")) {
    event.respondWith(swr(req));
    return;
  }
  // Same-origin app shell + data
  if (url.origin === self.location.origin) {
    event.respondWith(networkFirst(req));
  }
});

async function networkFirst(req) {
  const cache = await caches.open(CACHE_NAME);
  try {
    const fresh = await fetch(req);
    if (fresh.ok) cache.put(req, fresh.clone());
    return fresh;
  } catch {
    const cached = await cache.match(req);
    if (cached) return cached;
    return new Response("offline", { status: 503 });
  }
}

async function swr(req) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(req);
  const fetchPromise = fetch(req)
    .then((res) => {
      if (res.ok) cache.put(req, res.clone());
      return res;
    })
    .catch(() => cached);
  return cached || fetchPromise;
}
