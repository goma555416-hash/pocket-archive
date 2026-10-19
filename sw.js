const CACHE = 'pocket-archive-v2.3.0-images-capture-ai';
const RESOURCES = ['./','./index.html','./styles.css','./theme.css','./app.js','./lib.mjs','./db.mjs','./archive.mjs','./drive.mjs','./backend.mjs','./migration.mjs','./crypto.mjs','./sync.mjs','./cloud.mjs','./image-viewer.mjs','./ai-launch.mjs','./capture-client.mjs','./manifest.webmanifest','./icons/icon.svg','./icons/icon-180.png','./icons/icon-192.png','./icons/icon-512.png'];
self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(RESOURCES)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', event => {
  event.waitUntil(Promise.all([caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))), self.clients.claim()]));
});
self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET' || new URL(event.request.url).origin !== self.location.origin) return;
  if (new URL(event.request.url).pathname.includes('/api/')) return;
  if (event.request.mode === 'navigate') {
    event.respondWith(fetch(event.request).catch(() => caches.match('./index.html')));
    return;
  }
  event.respondWith(caches.match(event.request).then(cached => cached || fetch(event.request).then(response => {
    if (response.ok) caches.open(CACHE).then(cache => cache.put(event.request, response.clone()));
    return response;
  })));
});
