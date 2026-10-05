// Service worker: guarda la app para que abra al instante y se pueda instalar.
// Solo cachea los archivos de la app y la librería de voz; nunca la conversación ni el pase.
const CACHE = "jarvis-v8";
const APP = ["./", "index.html", "privacidad.html", "condiciones.html", "app.js", "manifest.webmanifest", "icon-192.png", "icon-512.png", "icon-maskable-512.png",
             "https://cdn.jsdelivr.net/npm/livekit-client@2.22.3/dist/livekit-client.umd.min.js"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(APP)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

// Primero la red (para recibir actualizaciones); si no hay internet, la copia guardada.
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  const nuestro = url.origin === location.origin || url.href === APP[APP.length - 1];
  if (e.request.method !== "GET" || !nuestro) return;
  e.respondWith(
    fetch(e.request).then((resp) => {
      if (resp.ok) { const copia = resp.clone(); caches.open(CACHE).then((c) => c.put(e.request, copia)); }
      return resp;
    }).catch(() => caches.match(e.request, {ignoreSearch: true}))
  );
});
