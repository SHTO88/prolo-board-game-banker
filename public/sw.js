// Offline support: always try the network first so an installed app picks up
// new versions straight away, and fall back to the cached copy when offline
// or the network is too slow. Bump CACHE when you deploy so old caches are cleaned up.
const CACHE = 'bgb-v15';
const ASSETS = [
  '/', '/styles.css', '/app.js', '/manifest.webmanifest',
  '/icon.svg', '/icon-192.png', '/apple-touch-icon.png', '/favicon-32.png',
];
// How long to wait for the network before showing the cached copy.
const NETWORK_TIMEOUT_MS = 3000;

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      // cache: 'reload' skips the browser's HTTP cache so the new version is stored, not a stale one.
      .then((c) => c.addAll(ASSETS.map((url) => new Request(url, { cache: 'reload' }))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;

  const key = req.mode === 'navigate' ? '/' : req;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const network = fetch(req, { cache: 'no-cache' }).then((res) => {
      if (res.ok && !res.redirected) cache.put(key, res.clone());
      return res;
    });
    // Keep the fetch alive to refresh the cache even if the timeout wins.
    event.waitUntil(network.catch(() => {}));
    const timeout = new Promise((resolve) => setTimeout(resolve, NETWORK_TIMEOUT_MS));
    try {
      const res = await Promise.race([network, timeout]);
      if (res) return res;
    } catch { /* offline: use the cache below */ }
    const cached = await cache.match(key, { ignoreSearch: true });
    return cached || network;
  })());
});
