
// CHANGE THIS VERSION NUMBER TO FORCE AN UPDATE
const CACHE_NAME = 'agriq-pro-v6.0'; 

const ASSETS_TO_CACHE = [
    './',
    './index.html',
    './manifest.json',
    './icon-192.png',      // Fixed to match your exact uploaded filename
    './icon-512x512.png'   // Make sure this file actually exists in your repo!
];

// 1. Install & Cache
self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME).then((cache) => {
            return cache.addAll(ASSETS_TO_CACHE);
        })
    );
});

// 2. Activate & Clean Up Old Versions
self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys().then((cacheNames) => {
            return Promise.all(
                cacheNames.map((cacheName) => {
                    if (cacheName !== CACHE_NAME) {
                        return caches.delete(cacheName);
                    }
                })
            );
        })
    );
    self.clients.claim();
});

// 3. Fetch (Network First, Fallback to Cache)
// This ensures users always get the freshest database data if they have internet!
self.addEventListener('fetch', (event) => {
    // Only intercept basic GET requests
    if (event.request.method !== 'GET') return;
    
    event.respondWith(
        fetch(event.request)
            .then((response) => {
                // If the network fetch is successful, return it
                return response;
            })
            .catch(() => {
                // If offline, return the cached version
                return caches.match(event.request);
            })
    );
});

// 4. Listen for the Update Command from the UI
self.addEventListener('message', (event) => {
    if (event.data === 'SKIP_WAITING') {
        self.skipWaiting();
    }
});
