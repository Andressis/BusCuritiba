const CACHE_NOME = "bus-cwb-cache-v23";
const CACHE_API = "bus-cwb-api-v1";
const CACHE_TILES = "bus-cwb-tiles-v2";
const ARQUIVOS_PARA_CACHE = [
  "./",
  "./index.html",
  "./style.css",
  "./app.js",
  "./manifest.json",
  "./favicon/favicon.ico",
  "./favicon/favicon-16x16.png",
  "./favicon/favicon-32x32.png",
  "./favicon/apple-touch-icon.png",
  "./favicon/android-chrome-192x192.png",
  "./favicon/android-chrome-512x512.png",
  "./assets/onibus-header.jpg",
  "./vendor/leaflet.css",
  "./vendor/leaflet.js",
  "./vendor/images/layers.png",
  "./vendor/images/layers-2x.png",
  "./vendor/images/marker-icon.png",
];
const MAXIMO_TILES = 200;

self.addEventListener("install", (evento) => {
  evento.waitUntil(
    caches.open(CACHE_NOME).then((cache) => cache.addAll(ARQUIVOS_PARA_CACHE))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (evento) => {
  const cachesAtuais = [CACHE_NOME, CACHE_API, CACHE_TILES];
  evento.waitUntil(
    caches.keys().then((nomesCache) =>
      Promise.all(
        nomesCache
          .filter((nome) => !cachesAtuais.includes(nome))
          .map((nome) => caches.delete(nome))
      )
    )
  );
  self.clients.claim();
});

async function buscarApiComTimeout(requisicao) {
  const controlador = new AbortController();
  const temporizador = setTimeout(() => controlador.abort(), 4000);
  try {
    return await fetch(requisicao, { signal: controlador.signal });
  } finally {
    clearTimeout(temporizador);
  }
}

async function responderApi(requisicao) {
  const cache = await caches.open(CACHE_API);
  try {
    const resposta = await buscarApiComTimeout(requisicao);
    if (resposta.ok) await cache.put(requisicao, resposta.clone());
    return resposta;
  } catch (erro) {
    const salva = await cache.match(requisicao);
    if (salva) {
      const cabecalhos = new Headers(salva.headers);
      cabecalhos.set("X-Dados-Salvos", "true");
      return new Response(await salva.blob(), {
        status: salva.status,
        statusText: salva.statusText,
        headers: cabecalhos,
      });
    }
    return new Response(
      JSON.stringify({ erro: "Sem conexão e sem dados salvos para esta consulta." }),
      { status: 503, headers: { "Content-Type": "application/json; charset=utf-8" } }
    );
  }
}

async function limitarCacheTiles(cache) {
  const chaves = await cache.keys();
  const excedentes = chaves.length - MAXIMO_TILES;
  if (excedentes > 0) {
    await Promise.all(chaves.slice(0, excedentes).map((chave) => cache.delete(chave)));
  }
}

function responderTile(requisicao, evento) {
  const atualizar = caches.open(CACHE_TILES).then((cache) =>
    fetch(requisicao).then(async (resposta) => {
      if (resposta.ok || resposta.type === "opaque") {
        await cache.delete(requisicao);
        await cache.put(requisicao, resposta.clone());
        await limitarCacheTiles(cache);
      }
      return resposta;
    })
  );
  evento.waitUntil(atualizar.catch((erro) => console.warn("Falha ao atualizar tile do mapa:", erro)));
  return caches.open(CACHE_TILES).then(async (cache) => {
    const salvo = await cache.match(requisicao);
    return salvo || atualizar;
  });
}

self.addEventListener("fetch", (evento) => {
  const requisicao = evento.request;
  if (requisicao.method !== "GET") return;

  const url = new URL(requisicao.url);
  if (
    url.pathname === "/admin.html" ||
    url.pathname.endsWith("/admin.js") ||
    url.pathname.startsWith("/api/reclamacoes") ||
    url.pathname.startsWith("/api/config") ||
    url.pathname.startsWith("/api/admin")
  ) {
    return;
  }
  if (url.pathname.includes("/api/")) {
    evento.respondWith(responderApi(requisicao));
    return;
  }

  if (url.hostname.endsWith(".tile.openstreetmap.fr")) {
    evento.respondWith(responderTile(requisicao, evento));
    return;
  }

  if (requisicao.mode === "navigate") {
    evento.respondWith(
      fetch(requisicao).catch(async () => {
        const cache = await caches.open(CACHE_NOME);
        return (await cache.match("./index.html")) || Response.error();
      })
    );
    return;
  }

  if (url.origin === self.location.origin) {
    evento.respondWith(
      caches.open(CACHE_NOME).then(async (cache) => {
        const salvo = await cache.match(requisicao, { ignoreSearch: true });
        if (salvo) return salvo;
        const resposta = await fetch(requisicao);
        if (resposta.ok) await cache.put(requisicao, resposta.clone());
        return resposta;
      })
    );
  }
});
