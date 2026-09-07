/* Built into sw.js. All app URLs resolve against this registration's scope. */
"use strict";

const SCOPE = new URL(self.registration.scope);
const CACHE_PREFIX = `sepa-terminal:${encodeURIComponent(SCOPE.pathname)}:`;
// One cache per build id: a snapshot cached by an earlier build can never be served
// beside this build's pages, whatever the app-shell digest says.
const BUILD_ID = "af7b2d064958";
const BUILD_PREFIX = `${CACHE_PREFIX}${BUILD_ID}:`;
const CACHE_NAME = BUILD_PREFIX + "ee116e9ad52b-8f8be850c94b";
const APP_SHELL = ["./", "index.html", "site.css", "site.js", "screener.js", "mschart.js", "lists.js", "mylists.js", "portfolio.js", "screenfilters.js", "resources.js", "manifest.webmanifest", "s/index.html", "vendor/lightweight-charts.standalone.production.js", "privacy.html", "offline.html", "404.html", "icons/icon-192.png", "icons/icon-512.png", "icons/maskable-192.png", "icons/maskable-512.png", "icons/apple-touch-icon.png", "icons/feature-graphic.png"];
const SHELL_URLS = new Set(APP_SHELL.map(path => new URL(path, SCOPE).href));
const OFFLINE_URL = new URL("offline.html", SCOPE).href;

self.addEventListener("install", event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    await cache.addAll(APP_SHELL.map(path => new Request(new URL(path, SCOPE), {
      cache: "reload", credentials: "omit", redirect: "error",
    })));
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", event => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names
      .filter(name => name.startsWith(CACHE_PREFIX) &&
        (!name.startsWith(BUILD_PREFIX) || name !== CACHE_NAME))
      .map(name => caches.delete(name)));
    await self.clients.claim();
  })());
});

function cacheKey(url) {
  const key = new URL(url);
  key.search = "";
  // Share cached stock pages across the .html and directory-style public routes.
  const path = key.pathname.slice(SCOPE.pathname.length);
  // The generic technical route: "s/", "s/index.html" and any ?symbol= query are all
  // served by the one precached page.
  if (path === "s" || path === "s/" || path === "s/index.html") {
    return new URL("s/index.html", SCOPE).href;
  }
  const stock = path.match(/^s\/([A-Z0-9][A-Z0-9&._-]*?)(?:\.html|\/(?:index\.html)?)?$/);
  if (stock) return new URL(`s/${stock[1]}.html`, SCOPE).href;
  if (path === "index.html") return SCOPE.href;
  return key.href;
}

async function fetchAndCache(request, cache, key, canCache) {
  const response = await fetch(request);
  // Failed responses and redirects outside this exact public resource must not
  // overwrite a usable snapshot (including redirects to a refresh console).
  const finalUrl = response.url ? new URL(response.url) : null;
  if (canCache && response.ok && response.type !== "opaque" &&
      (!finalUrl || (finalUrl.origin === SCOPE.origin &&
        finalUrl.pathname.startsWith(SCOPE.pathname) && !finalUrl.search && cacheKey(finalUrl) === key))) {
    try { await cache.put(key, response.clone()); } catch { /* Storage can be full or unavailable. */ }
  }
  return response;
}

async function networkFirst(request, key, canCache, navigation) {
  const cache = await caches.open(CACHE_NAME);
  let response;
  try {
    response = await fetchAndCache(request, cache, key, canCache);
    // A real 404 stays a 404; transient server failures can use the last snapshot.
    if (response.status < 500) return response;
  } catch { /* Offline: try the last successful snapshot. */ }
  const saved = await cache.match(key);
  if (saved) return saved;
  if (navigation) return (await cache.match(OFFLINE_URL)) || Response.error();
  return response || Response.error();
}

async function cacheFirst(request, key) {
  const cache = await caches.open(CACHE_NAME);
  return (await cache.match(key)) || fetchAndCache(request, cache, key, true);
}

self.addEventListener("fetch", event => {
  const request = event.request;
  if (request.method !== "GET" || request.headers.has("authorization") || request.headers.has("range")) return;
  const url = new URL(request.url);
  if (url.origin !== SCOPE.origin || !url.pathname.startsWith(SCOPE.pathname)) return;
  const path = url.pathname.slice(SCOPE.pathname.length);
  if (path === "sepa-trigger" || path.startsWith("sepa-trigger/")) return;
  const key = cacheKey(url);
  const navigation = request.mode === "navigate";
  const snapshot = /^data\/(?:[A-Za-z0-9&._-]+\/)*[A-Za-z0-9&._-]+\.json$/.test(path) ||
    /^s\/[A-Z0-9][A-Z0-9&._-]*(?:\.html|\/(?:index\.html)?)?$/.test(path);
  const shell = SHELL_URLS.has(url.origin + url.pathname);
  // Unknown paths can use the offline navigation fallback, but cannot enter the
  // cache. Query-bearing requests never write to storage.
  if (navigation || snapshot) {
    event.respondWith(networkFirst(request, key, !url.search && (snapshot || shell), navigation));
  } else if (shell) {
    // Shell assets are stamped ?v=<build id>. This build's own stamp names exactly the
    // file that was precached, so it is served from the cache; any other stamp belongs to
    // another build's page and must go to the network first, using the cache only when
    // offline. An unstamped request keeps the original cache-first behaviour.
    const stamp = url.searchParams.get("v");
    if (!url.search || stamp === BUILD_ID) event.respondWith(cacheFirst(request, key));
    else event.respondWith(networkFirst(request, key, false, false));
  }
});
