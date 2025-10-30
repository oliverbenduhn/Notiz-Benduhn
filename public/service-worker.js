const CACHE_NAME = "notiz-benduhn-static-v1";
const APP_SHELL = [
  "/",
  "/index.html",
  "/style.css?v=3",
  "/app.js",
  "/manifest.json",
  "/icons/icon.svg"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key !== CACHE_NAME)
          .map((staleKey) => caches.delete(staleKey))
      )
    ).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method === "POST") {
    const url = new URL(request.url);
    if (url.pathname === "/share") {
      event.respondWith(
        (async () => {
          let client = null;
          try {
            const formData = await request.formData();
            const extractText = (key) => {
              const value = formData.get(key);
              return typeof value === "string" ? value : "";
            };
            const sharePayload = {
              title: extractText("title"),
              text: extractText("text"),
              url: extractText("url")
            };
            const windowClients = await self.clients.matchAll({
              type: "window",
              includeUncontrolled: true
            });
            client =
              windowClients.find((c) => new URL(c.url).pathname === "/") ||
              (await self.clients.openWindow("/"));
            if (client) {
              client.postMessage({
                type: "share-target",
                payload: sharePayload
              });
            }
          } catch (error) {
            console.error("Share target handling failed:", error);
          }
          if (client && "focus" in client) {
            client.focus();
          }
          return Response.redirect("/", 303);
        })()
      );
      return;
    }
  }

  if (request.method !== "GET" || request.headers.get("accept")?.includes("text/event-stream")) {
    return;
  }

  if (request.url.includes("/socket.io/")) {
    return;
  }

  event.respondWith(
    caches.match(request).then((cachedResponse) => {
      if (cachedResponse) return cachedResponse;
      return fetch(request)
        .then((response) => {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
          return response;
        })
        .catch(() => cachedResponse);
    })
  );
});
