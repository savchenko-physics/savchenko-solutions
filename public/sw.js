// Retired 2026-09-12. This file now exists only to remove itself.
//
// The site used to register a service worker here, first as an offline cache for every
// request and, after that broke /problems (see git history), as an offline fallback for
// navigations only. Either way it controlled every page, and Firefox bypasses its shared
// image cache for any document a service worker controls: every image is loaded and
// decoded again on each navigation. On /messages that meant every avatar went blank and
// came back each time someone switched chats. Measured locally against the real
// views/messages.ejs in Firefox 155 at 60 fps: 33–166 ms of blank avatars on every switch
// with a worker (even one with no fetch handler at all), zero blank frames without.
//
// Browsers that still have the old worker check this URL for updates as they browse. They
// install this version, which clears the old caches and unregisters, and from their next
// navigation no page is controlled. Pages also call unregister() themselves (see
// views/default/main_site_header_head.ejs). Keep this file: a 404 here would leave old
// workers installed forever. Do not add clients.claim() or a fetch listener, and do not
// register a service worker again (tests/service-worker.test.js).

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.map((key) => caches.delete(key)));
    await self.registration.unregister();
  })());
});
