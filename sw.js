const CACHE_NAME = 'agriq-v2.6';
const ASSETS = [
  '/',
  '/index.html',
  '/style.css' // Add your CSS/JS files here
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS))
  );
});

self.addEventListener('fetch', (e) => {
  e.respondWith(
    caches.match(e.request).then((res) => res || fetch(e.request))
  );
});
