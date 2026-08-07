// Minimal, safe service worker: an offline fallback for navigations, and nothing else.
//
// It used to intercept EVERY GET on the site and wrap it in `fetch(req).catch(...)`,
// falling back to `caches.match(req)`. That was actively harmful. `caches.match()`
// resolves to `undefined` for anything not in the tiny SHELL cache below — which is
// almost everything — and `event.respondWith(undefined)` throws
// "TypeError: Failed to convert value to 'Response'", which the browser surfaces as a
// hard *network error response*. So any momentary network hiccup on a script or JSON
// request was converted from something the browser would normally retry/report into a
// guaranteed failure with an empty body. On /problems that meant its JSON arrived empty,
// `JSON.parse('')` threw ("unexpected end of data at line 1 column 1") at the top of the
// bundle, and every button and slider on the page silently stopped working — reported
// from several devices and unfixable by a hard refresh, because the service worker sits
// in front of the refresh too.
//
// Now: only navigations are intercepted, purely so an offline visit gets a friendly page,
// and the fallback can never be undefined. Scripts, styles, images and JSON endpoints are
// not intercepted at all — they get normal browser networking, normal error handling and
// normal retry behaviour.
const CACHE = 'ss-shell-v2';
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
  // Everything that is not a navigation is left completely alone.
  if (req.method !== 'GET' || req.mode !== 'navigate') return;

  event.respondWith(
    fetch(req).catch(async () => {
      const cached = await caches.match(OFFLINE_URL);
      // Never resolve to undefined — that is what turned a network blip into a
      // "Failed to convert value to 'Response'" error page.
      return cached || new Response(
        '<!doctype html><meta charset="utf-8"><title>Offline</title>'
        + '<p style="font:16px system-ui;padding:2rem">You appear to be offline. Please try again.</p>',
        { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8' } }
      );
    })
  );
});
