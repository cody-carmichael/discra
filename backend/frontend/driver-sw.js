const CACHE_NAME = "discra-driver-v20260404a";
const PRECACHE_URLS = [
  "driver",
  "assets/driver-mobile.css",
  "assets/common.js",
  "assets/driver.js",
  "assets/driver-manifest.json",
];

self.addEventListener("install", (event) => {
  self.skipWaiting();
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(PRECACHE_URLS)));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") {
    return;
  }

  // Only cache static assets — never cache API calls.  Caching auth
  // session endpoints caused stale responses after logout.
  const url = new URL(event.request.url);
  const path = url.pathname;
  const isStaticAsset =
    path.endsWith(".js") ||
    path.endsWith(".css") ||
    path.endsWith(".png") ||
    path.endsWith(".svg") ||
    path.endsWith(".ico") ||
    path.endsWith(".woff2") ||
    path.endsWith(".json");

  if (!isStaticAsset && event.request.mode !== "navigate") {
    // Let API calls go straight to the network.
    return;
  }

  // Network-first: try fresh content, fall back to cache for offline
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        const clone = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});

// ── Push Notifications ──────────────────────────────────────────────

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (e) {
    data = { title: "Discra", body: event.data ? event.data.text() : "" };
  }

  const title = data.title || "Discra";
  const options = {
    body: data.body || "",
    tag: "order-" + (data.order_id || "general"),
    renotify: true,
    vibrate: [200, 100, 200],
    data: data,
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = self.location.origin + "/ui/driver";

  event.waitUntil(
    clients.matchAll({ type: "window", includeUncontrolled: true }).then((windowClients) => {
      for (const client of windowClients) {
        if (client.url.includes("/driver") && "focus" in client) {
          return client.focus();
        }
      }
      return clients.openWindow(url);
    })
  );
});
