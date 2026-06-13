const CACHE_NAME = "notiz-benduhn-static-v8";
const APP_SHELL = [
  "/",
  "/index.html",
  "/style.css?v=4",
  "/app.js?v=8",
  "/manifest.json",
  "/icon-192.png",
  "/icon-512.png",
  "/icon.png"
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

  // Share-Target: Bilder + Text von Android
  if (request.method === "POST") {
    const url = new URL(request.url);
    if (url.pathname === "/share-target") {
      event.respondWith(
        (async () => {
          let client = null;
          try {
            const formData = await request.formData();
            const extractText = (key) => {
              const value = formData.get(key);
              return typeof value === "string" ? value : "";
            };

            // Bilddateien hochladen
            const imageFiles = formData.getAll("image").filter(
              (v) => v instanceof File && v.size > 0
            );
            if (imageFiles.length > 0) {
              const uploadForm = new FormData();
              for (const file of imageFiles) {
                uploadForm.append("image", file, file.name);
              }
              const uploadRes = await fetch("/api/images", { method: "POST", body: uploadForm });
              if (!uploadRes.ok) {
                throw new Error(`Image upload failed: ${uploadRes.status}`);
              }
            }

            // Text-Payload an App-Window senden
            const sharePayload = {
              title: extractText("title"),
              text: extractText("text"),
              url: extractText("url"),
              hasImages: imageFiles.length > 0
            };
            const windowClients = await self.clients.matchAll({
              type: "window",
              includeUncontrolled: true
            });
            client =
              windowClients.find((c) => new URL(c.url).pathname === "/") ||
              (await self.clients.openWindow("/"));
            try {
              if (client) {
                client.postMessage({ type: "share-target", payload: sharePayload });
              }
            } catch (msgErr) {
              console.error("Failed to send message to client:", msgErr);
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

  if (
    request.method !== "GET" ||
    request.headers.get("accept")?.includes("text/event-stream")
  ) {
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
