// Kendo Tournament — Service Worker
// Strategy: cache-first for static assets, network-first for navigation.

const CACHE = 'kendo-v1';

// On install: cache the shell
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) =>
      cache.addAll([
        '/kendo-tournament/',
        '/kendo-tournament/index.html',
        '/kendo-tournament/manifest.webmanifest',
        '/kendo-tournament/pwa-icon.svg',
      ])
    )
  );
  self.skipWaiting();
});

// On activate: delete old caches
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Fetch: network-first for same-origin, fallback to cache
self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    fetch(event.request)
      .then((response) => {
        // Cache successful responses for static assets
        if (response.ok) {
          const clone = response.clone();
          caches.open(CACHE).then((cache) => cache.put(event.request, clone));
        }
        return response;
      })
      .catch(() =>
        caches.match(event.request).then(
          (cached) => cached ?? caches.match('/kendo-tournament/index.html')
        )
      )
  );
});
