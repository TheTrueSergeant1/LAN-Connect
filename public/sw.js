self.addEventListener('install', (e) => {
    console.log('[Service Worker] Install');
});

self.addEventListener('fetch', (e) => {
    // Standard fetch (we aren't caching actively to avoid LAN sync issues)
    e.respondWith(fetch(e.request));
});