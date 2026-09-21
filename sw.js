// Service worker: red primero, cache como red de emergencia.
// Los PDF no pasan por acá — viven en IndexedDB, que es donde los pone la app.
const VERSION = "v4";   // subir al cambiar el shell (nombre, paleta, iconos)
const CACHE = `pdfsync-${VERSION}`;

const SHELL = [
  "./", "./index.html", "./app.webmanifest", "./config.js",
  "./src/styles.css", "./src/app.js", "./src/supabase.js", "./src/device.js",
  "./src/idb.js", "./src/hash.js", "./src/ui.js", "./src/sync.js",
  "./src/bookmarks.js", "./src/library.js", "./src/reader.js", "./src/pdf.js",
  "./src/covers.js", "./src/sort.js",
  "./vendor/supabase.js", "./vendor/esm/node/buffer.js",
  "./vendor/esm/supabase/supabase-js.bundle.js",
  "./vendor/pdfjs/pdf.js", "./vendor/pdfjs/pdf.worker.js",
  "./icons/icon-192.png", "./icons/icon-512.png",
  "./icons/logo.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE)
      // addAll es todo-o-nada; así un 404 suelto no rompe la instalación.
      .then((cache) => Promise.allSettled(SHELL.map((url) => cache.add(url))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;   // Supabase no se cachea

  event.respondWith(
    fetch(request)
      .then((response) => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put(request, copy));
        }
        return response;
      })
      .catch(async () => {
        const hit = await caches.match(request);
        if (hit) return hit;
        if (request.mode === "navigate") return caches.match("./index.html");
        return new Response("offline", { status: 503, statusText: "offline" });
      }),
  );
});
