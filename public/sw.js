// Minimal, safe service worker: network-first for everything (so it never serves
// stale HTML), with an offline fallback for navigations and a small cached shell.
const CACHE = 'ss-shell-v1';
const OFFLINE_URL = '/offline.html';
const SHELL = [OFFLINE_URL, '/img/logo.svg'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  event.respondWith(
    fetch(req).catch(() =>
      req.mode === 'navigate' ? caches.match(OFFLINE_URL) : caches.match(req)
    )
  );
});
