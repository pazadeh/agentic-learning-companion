/* Audio Learning Companion service worker.
 * The shell is cached during install so saved lectures can be opened offline.
 * User audio/transcripts are managed explicitly in owner-scoped IndexedDB, never
 * opportunistically under expiring presigned URLs.
 */
const SHELL_CACHE = 'alc-shell-v5';
const SHELL_ASSETS = ['/', '/index.html', '/manifest.json', '/icon-192.png', '/icon-512.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL_CACHE);
      const response = await fetch('/index.html', { cache: 'no-store' });
      const markup = await response.clone().text();
      await cache.put('/index.html', response);
      await cache.put('/', await fetch('/', { cache: 'no-store' }));
      const hashedAssets = [...markup.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map(
        (match) => match[1]
      );
      await cache.addAll([...SHELL_ASSETS.slice(2), ...hashedAssets]);
      await self.skipWaiting();
    })()
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== SHELL_CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);

  // API and presigned S3 requests remain network-only. Explicit offline saves are
  // stored in IndexedDB under the authenticated owner, without credentials in keys.
  if (url.origin !== self.location.origin) return;

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response.ok) {
            const copy = response.clone();
            caches.open(SHELL_CACHE).then((cache) => cache.put('/index.html', copy));
          }
          return response;
        })
        .catch(() => caches.match('/index.html'))
    );
    return;
  }

  event.respondWith(
    caches.open(SHELL_CACHE).then(async (cache) => {
      const cached = await cache.match(request);
      if (cached) return cached;
      const response = await fetch(request);
      if (response.ok) await cache.put(request, response.clone());
      return response;
    })
  );
});
