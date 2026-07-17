const CACHE_NAME = 'awb-tracker-v3';
const urlsToCache = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './helpers.js',
  './ml-engine.js',
  './awb_model_seed.json',
  './manifest.json',
  './icon-192x192.png',
  './icon-512x512.png',
  './New-AWB.png'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(urlsToCache))
  );
  // Activate immediately — don't wait for old SW to release
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key)))
    )
  );
  // Claim all clients immediately so new SW controls pages
  self.clients.claim();
});

self.addEventListener('fetch', event => {
  // Network-first for HTML/JS — always try fresh, fallback to cache
  const url = new URL(event.request.url);
  if (url.pathname.match(/\.(html|js|css)$/) || url.pathname === '/' || url.pathname.endsWith('/')) {
    event.respondWith(
      fetch(event.request)
        .then(response => {
          const cloned = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, cloned));
          return response;
        })
        .catch(() => caches.match(event.request))
    );
  } else {
    // Cache-first for static assets (images, fonts, etc.)
    event.respondWith(
      caches.match(event.request).then(response => response || fetch(event.request))
    );
  }
});