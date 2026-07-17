const CACHE_NAME = "notiz-benduhn-static-v9";
// Query-Strings werden bei der Precache-Liste bewusst weggelassen und beim
// Match ignoriert: sonst passt der Cache-Key nie zur Laufzeit-Request-URL
// (Audit H1).
const APP_SHELL = [
  "/",
  "/index.html",
  "/style.css",
  "/app.js",
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
      event.respondWith(handleShareTarget(request));
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

  // Navigation: Network-First mit Cache-Fallback. Sonst sitzt der User nach
  // einem Deploy auf der alten index.html fest (Audit H2).
  const isNavigation = request.mode === "navigate";

  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      if (isNavigation) {
        try {
          const fresh = await fetch(request);
          cache.put(request, fresh.clone());
          return fresh;
        } catch {
          const cached = await cache.match(request, { ignoreSearch: true });
          if (cached) return cached;
        }
      }

      // Statische Assets: Cache-First, im Hintergrund revalidieren.
      // ignoreSearch deckt Query-Versionierung ab, falls sie später kommt.
      const cached = await cache.match(request, { ignoreSearch: true });
      if (cached) {
        fetch(request).then((res) => cache.put(request, res.clone())).catch(() => {});
        return cached;
      }
      try {
        const fresh = await fetch(request);
        cache.put(request, fresh.clone());
        return fresh;
      } catch (err) {
        return cached ?? Response.error();
      }
    })()
  );
});

async function handleShareTarget(request) {
  let client = null;
  try {
    const formData = await request.formData();
    const extractText = (key) => {
      const value = formData.get(key);
      return typeof value === "string" ? value : "";
    };

    // Bilder hochladen UND die resultierenden URLs an den Client zurückgeben.
    // Vorher haben wir nur "hat Bilder" geschickt -- der Client konnte nichts
    // damit anfangen (Audit K2).
    const imageFiles = formData.getAll("image").filter(
      (v) => v instanceof File && v.size > 0
    );
    const imageUrls = [];
    for (const file of imageFiles) {
      const uploadForm = new FormData();
      uploadForm.append("image", file, file.name);
      const uploadRes = await fetch("/api/images", { method: "POST", body: uploadForm });
      if (uploadRes.ok) {
        const body = await uploadRes.json().catch(() => null);
        if (body && body.url) imageUrls.push(body.url);
      } else {
        console.error("Share upload failed:", uploadRes.status);
      }
    }

    const sharePayload = {
      title: extractText("title"),
      text: extractText("text"),
      url: extractText("url"),
      imageUrls
    };
    const windowClients = await self.clients.matchAll({
      type: "window",
      includeUncontrolled: true
    });
    client =
      windowClients.find((c) => new URL(c.url).pathname === "/") ||
      (await self.clients.openWindow("/"));
    if (client) {
      try {
        client.postMessage({ type: "share-target", payload: sharePayload });
      } catch (msgErr) {
        console.error("Failed to send message to client:", msgErr);
      }
    }
  } catch (error) {
    console.error("Share target handling failed:", error);
  }
  if (client && "focus" in client) {
    client.focus();
  }
  return Response.redirect("/", 303);
}