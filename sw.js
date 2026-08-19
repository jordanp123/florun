/*
 * sw.js -- service worker. Makes FloRun work with no network at all, which for
 * a tool used at outfalls and impoundments is the normal case, not the edge.
 *
 * Strategy is cache-first for the app shell. That is the right call here
 * precisely because the app has no remote data: there is nothing to be stale
 * about except the app itself, and updates are handled explicitly below.
 *
 * CACHE must be bumped whenever any precached asset changes -- the version
 * string is the only thing that triggers a refresh, and tests/run.sh checks
 * that it exists and is well formed. Old caches are deleted on activate, so a
 * user never accumulates dead copies.
 */
"use strict";

const CACHE = "florun-v1";

// Relative paths so the same worker serves correctly from a domain root or a
// subpath; "./" covers the start URL itself.
const PRECACHE = [
  "./",
  "index.html",
  "manifest.webmanifest",
  "css/styles.css",
  "js/format.js",
  "js/bucket-chart.js",
  "js/weir-chart.js",
  "js/core.js",
  "js/csv.js",
  "js/pdf.js",
  "js/store.js",
  "js/photos.js",
  "js/geo.js",
  "js/stopwatch.js",
  "js/export.js",
  "js/ui.js",
  "icons/icon.svg",
  "icons/icon-192.png",
  "icons/icon-512.png",
  "icons/apple-touch-icon.png",
];

self.addEventListener("install", function (event) {
  event.waitUntil(
    caches.open(CACHE).then(function (cache) {
      // addAll is atomic: if any asset 404s the whole install fails and the old
      // worker stays in charge, rather than leaving a half-cached app.
      return cache.addAll(PRECACHE);
    }).then(function () {
      return self.skipWaiting();
    })
  );
});

self.addEventListener("activate", function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (key) {
        if (key !== CACHE) return caches.delete(key);
        return null;
      }));
    }).then(function () {
      return self.clients.claim();
    })
  );
});

self.addEventListener("fetch", function (event) {
  const request = event.request;

  // Only GETs are cacheable, and the app is entirely same-origin. Anything
  // else falls through to the network untouched.
  if (request.method !== "GET") return;
  if (new URL(request.url).origin !== self.location.origin) return;

  // Navigations: serve the cached shell so a cold offline launch works even
  // when the URL carries a query string or a deep path.
  if (request.mode === "navigate") {
    event.respondWith(
      caches.match("index.html").then(function (cached) {
        return cached || fetch(request);
      }).catch(function () {
        return caches.match("index.html");
      })
    );
    return;
  }

  event.respondWith(
    caches.match(request).then(function (cached) {
      if (cached) {
        // Refresh in the background so the next launch gets any new bytes,
        // without making this request wait on the network.
        event.waitUntil(revalidate(request));
        return cached;
      }
      return fetch(request).then(function (response) {
        if (response && response.ok) {
          const copy = response.clone();
          event.waitUntil(caches.open(CACHE).then(function (c) { return c.put(request, copy); }));
        }
        return response;
      });
    })
  );
});

function revalidate(request) {
  return fetch(request).then(function (response) {
    if (!response || !response.ok) return null;
    return caches.open(CACHE).then(function (cache) { return cache.put(request, response); });
  }).catch(function () {
    return null;   // offline: the cached copy is already the answer
  });
}
