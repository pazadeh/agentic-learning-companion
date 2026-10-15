/* Audio Learning Companion service worker.
 * - HTML document (navigation): network-first, so the latest markup AND response
 *   headers (e.g. CSP) are always used when online; falls back to cached shell offline.
 * - Hashed static assets: cache-first (they're immutable).
 * - API calls: network-first (never cached).
 * - Audio: cache-first so lectures play offline once heard.
 *
 * Bump the cache version when shipping changes so old caches are purged on activate.
 */
const SHELL_CACHE = 'alc-shell-v3';
const AUDIO_CACHE = 'alc-audio-v3';
const SHELL_ASSETS = ['/', '/index.html', '/manifest.json'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then((cache) => cache.addAll(SHELL_ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key !== SHELL_CACHE && key !== AUDIO_CACHE)
            .map((key) => caches.delete(key))
        )
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // API calls: network-first, never cached.
  if (url.pathname.includes('/jobs/') || url.pathname.includes('/audio/refresh')) {
    event.respondWith(fetch(request).catch(() => new Response('', { status: 503 })));
    return;
  }

  // HTML document navigations: network-first so markup + headers stay fresh.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone();
          caches.open(SHELL_CACHE).then((cache) => cache.put('/index.html', copy));
          return response;
        })
        .catch(() => caches.match('/index.html'))
    );
    return;
  }

  // Audio files: cache-first for offline listening.
  if (url.pathname.endsWith('.mp3') || url.hostname.includes('s3')) {
    event.respondWith(
      caches.open(AUDIO_CACHE).then(async (cache) => {
        const cached = await cache.match(request);
        if (cached) return cached;
        const response = await fetch(request);
        if (response.ok) cache.put(request, response.clone());
        return response;
      })
    );
    return;
  }

  // Other static assets (hashed JS/CSS, icons): cache-first, fall back to network.
  event.respondWith(caches.match(request).then((cached) => cached || fetch(request)));
});
