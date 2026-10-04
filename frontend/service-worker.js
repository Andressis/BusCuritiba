const CACHE_NOME = "bus-cwb-cache-v6";

const ARQUIVOS_PARA_CACHE = [
  "./",
  "./index.html",
  "./style.css",
  "./app.js",
  "./manifest.json",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./assets/onibus-header.jpg",
];

self.addEventListener("install", (evento) => {
  evento.waitUntil(
    caches.open(CACHE_NOME).then((cache) => {
      return cache.addAll(ARQUIVOS_PARA_CACHE);
    })
  );
  self.skipWaiting();
});

self.addEventListener("activate", (evento) => {
  evento.waitUntil(
    caches.keys().then((nomesCache) => {
      return Promise.all(
        nomesCache
          .filter((nome) => nome !== CACHE_NOME)
          .map((nome) => caches.delete(nome))
      );
    })
  );
  self.clients.claim();
});

self.addEventListener("fetch", (evento) => {
  evento.respondWith(
    caches.match(evento.request).then((respostaCache) => {
      return respostaCache || fetch(evento.request);
    })
  );
});
