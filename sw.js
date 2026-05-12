/* sw.js — service worker that caches forcing-data JSONs as immutable assets.
 *
 * The chunked JSON files under /data/ are content-addressed per dataset
 * release: when the dataset is regenerated the bundle name changes. So we
 * can treat each successful response as forever-fresh. This eliminates the
 * network round-trip on repeat visits and back/forward scrubbing.
 *
 * Scope is the page root; the worker only intercepts requests under /data/
 * that end in .json. Everything else (HTML, CSS, JS, basemap tiles) falls
 * through to the browser's normal cache.
 */
const CACHE_NAME = "hormuz-forcing-v1";
const DATA_PATTERN = /\/data\/.*\.json(?:\?|$)/;

self.addEventListener("install", (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    /* Drop any older cache versions to free disk. */
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  const url = new URL(event.request.url);
  if (!DATA_PATTERN.test(url.pathname)) return;

  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    const cached = await cache.match(event.request, { ignoreSearch: true });
    if (cached) return cached;
    try {
      const fresh = await fetch(event.request);
      if (fresh.ok) {
        /* Clone before caching — Response bodies are single-use streams. */
        cache.put(event.request, fresh.clone()).catch(() => {});
      }
      return fresh;
    } catch (err) {
      /* Offline fallback: if the network failed and we have a cached copy
         from an older variant of the URL, return that rather than erroring. */
      const fallback = await cache.match(event.request, { ignoreSearch: true });
      if (fallback) return fallback;
      throw err;
    }
  })());
});
