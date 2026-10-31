/**
 * Service worker of the PWA test client: caches the app shell on install and serves it cache-first, so the page loads
 * while the browser is offline. API requests (`/sync`, `/iam`) always go to the network. Test code, not shipped.
 */
const CACHE = 'sync-pwa-shell';
const SHELL = ['./', './index.html', './app.mjs', '../sync-client.mjs', '../idb-store.mjs'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(SHELL))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin || !url.pathname.startsWith('/sync-pwa/')) {
    return;
  }
  event.respondWith(caches.match(event.request, { ignoreSearch: true }).then((hit) => hit ?? fetch(event.request)));
});
