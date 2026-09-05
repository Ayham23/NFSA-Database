const CACHE_NAME = 'nfsa-inspector-v7';
const ASSETS = [
  './index.html',
  './style.css',
  './app.js',
  './icons.js',
  './data.js',
  './manifest.json',
  './logo.png',
  './firebase-config.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Only cache our own files plus the specific CDN hosts we depend on
// (Firebase SDK script + Cairo font). Firestore's own data traffic
// (firestore.googleapis.com, long-polling, etc.) is intentionally left
// untouched so real-time sync and offline queuing behave correctly.
const CACHEABLE_CDN_HOSTS = ['www.gstatic.com', 'fonts.googleapis.com', 'fonts.gstatic.com'];

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return; // let writes/streams pass through untouched

  const url = new URL(event.request.url);
  const isOwnOrigin = url.origin === self.location.origin;
  const isCacheableCDN = CACHEABLE_CDN_HOSTS.includes(url.hostname);

  if (!isOwnOrigin && !isCacheableCDN) return; // e.g. firestore.googleapis.com — pass through

  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;
      return fetch(event.request)
        .then((response) => {
          if (response && response.status === 200) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
          }
          return response;
        })
        .catch(() => cached);
    })
  );
});
