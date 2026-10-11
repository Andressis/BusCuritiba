const express = require("express");
const { XzReadableStream } = require("xz-decompress");

const router = express.Router();
const TEMPO_CACHE = 6 * 60 * 60 * 1000;
const cacheArquivos = new Map();
let cacheIndiceParadas = null;

function dataCuritiba(data = new Date()) {
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: "America/Sao_Paulo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  })
    .format(data)
    .replace(/-/g, "_");
}

function dataAnterior(data) {
  const ontem = new Date(`${data.replace(/_/g, "-")}T00:00:00Z`);
  ontem.setUTCDate(ontem.getUTCDate() - 1);
  return ontem.toISOString().slice(0, 10).replace(/-/g, "_");
}

function converterCoordenada(valor) {
  return Number(String(valor).replace(",", "."));
}

async function baixarArquivo(nome) {
  const base = process.env.URBS_DUMPS_URL;
  if (!base) throw new Error("A variável URBS_DUMPS_URL não está configurada.");

  const hoje = dataCuritiba();
  const datas = [hoje, dataAnterior(hoje)];
  let ultimoErro;

  for (const data of datas) {
    try {
      const url = `${base.replace(/\/+$/, "")}/${data}_${nome}.json.xz`;
      const resposta = await fetch(url);
      if (!resposta.ok) {
        ultimoErro = new Error(`URBS respondeu HTTP ${resposta.status} para ${nome} (${data}).`);
        continue;
      }

      const texto = await new Response(new XzReadableStream(resposta.body)).text();
      const dados = JSON.parse(texto);
      if (!Array.isArray(dados)) {
        throw new Error(`O arquivo ${nome} da URBS não contém um array JSON.`);
      }
      return dados;
    } catch (erro) {
      ultimoErro = erro;
    }
  }

  throw new Error(`Não foi possível baixar ${nome} da URBS hoje nem ontem: ${ultimoErro.message}`);
}

async function obterAgrupados(nome) {
  const cache = cacheArquivos.get(nome);
  if (cache && cache.expiraEm > Date.now()) return cache.dados;

  const registros = await baixarArquivo(nome);
  const agrupados = new Map();

  registros.forEach((registro) => {
    const codigo = String(registro.COD);
    if (!agrupados.has(codigo)) agrupados.set(codigo, []);
    agrupados.get(codigo).push(registro);
  });

  if (nome === "shapeLinha") {
    agrupados.forEach((pontos, codigo) => {
      const trechos = {};
      pontos.forEach((ponto) => {
        const shp = String(ponto.SHP);
        if (!trechos[shp]) trechos[shp] = [];
        trechos[shp].push([
          converterCoordenada(ponto.LAT),
          converterCoordenada(ponto.LON),
        ]);
      });
      agrupados.set(codigo, trechos);
    });
  } else {
    agrupados.forEach((pontos) => {
      pontos.sort((a, b) => Number(a.SEQ) - Number(b.SEQ));
    });
  }

  cacheArquivos.set(nome, { dados: agrupados, expiraEm: Date.now() + TEMPO_CACHE });
  return agrupados;
}

async function obterIndiceParadas() {
  if (cacheIndiceParadas && cacheIndiceParadas.expiraEm > Date.now()) {
    return cacheIndiceParadas.dados;
  }

  const linhas = await obterAgrupados("pontosLinha");
  const paradas = new Map();

  linhas.forEach((pontos, cod) => {
    pontos.forEach((ponto) => {
      const num = String(ponto.NUM);
      if (!paradas.has(num)) {
        paradas.set(num, {
          num,
          nome: ponto.NOME,
          tipo: ponto.TIPO,
          lat: converterCoordenada(ponto.LAT),
          lng: converterCoordenada(ponto.LON),
          linhas: [],
        });
      }

      const parada = paradas.get(num);
      if (!parada.linhas.some((linha) => linha.cod === cod)) {
        parada.linhas.push({ cod, sentido: ponto.SENTIDO });
      }
    });
  });

  cacheIndiceParadas = { dados: paradas, expiraEm: Date.now() + TEMPO_CACHE };
  return paradas;
}

function normalizarTexto(texto) {
  return String(texto)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("pt-BR");
}

function calcularDistanciaM(latA, lngA, latB, lngB) {
  const radianos = (graus) => (graus * Math.PI) / 180;
  const diferencaLat = radianos(latB - latA);
  const diferencaLng = radianos(lngB - lngA);
  const haversine =
    Math.sin(diferencaLat / 2) ** 2 +
    Math.cos(radianos(latA)) *
      Math.cos(radianos(latB)) *
      Math.sin(diferencaLng / 2) ** 2;
  return 6371000 * 2 * Math.asin(Math.min(1, Math.sqrt(haversine)));
}

function formatarParada(parada) {
  return {
    num: parada.num,
    nome: parada.nome,
    tipo: parada.tipo,
    lat: parada.lat,
    lng: parada.lng,
    linhas: parada.linhas,
  };
}

router.get("/paradas/proximas", async (req, res) => {
  try {
    const lat = Number(req.query.lat);
    const lng = Number(req.query.lng);
    if (
      req.query.lat === undefined ||
      req.query.lat === "" ||
      req.query.lng === undefined ||
      req.query.lng === "" ||
      !Number.isFinite(lat) ||
      !Number.isFinite(lng) ||
      Math.abs(lat) > 90 ||
      Math.abs(lng) > 180
    ) {
      return res.status(400).json({ erro: "Informe latitude e longitude numéricas válidas." });
    }

    const raioInformado = req.query.raio === undefined ? 500 : Number(req.query.raio);
    if (!Number.isFinite(raioInformado) || raioInformado <= 0) {
      return res.status(400).json({ erro: "O raio deve ser um número maior que zero." });
    }
    const raio = Math.min(raioInformado, 2000);
    const indice = await obterIndiceParadas();
    const paradas = Array.from(indice.values())
      .map((parada) => ({
        parada: formatarParada(parada),
        distancia: calcularDistanciaM(lat, lng, parada.lat, parada.lng),
      }))
      .filter((item) => Number.isFinite(item.distancia) && item.distancia <= raio)
      .sort((a, b) => a.distancia - b.distancia)
      .slice(0, 30);

    res.json({
      paradas: paradas.map(({ parada, distancia }) => ({
        ...parada,
        distanciaM: Math.round(distancia),
      })),
    });
  } catch (erro) {
    console.error("Erro ao buscar paradas próximas:", erro);
    res.status(500).json({ erro: `Não foi possível buscar paradas próximas: ${erro.message}` });
  }
});

router.get("/paradas/busca", async (req, res) => {
  try {
    const consulta = typeof req.query.q === "string" ? req.query.q.trim() : "";
    if (consulta.length < 2) {
      return res.status(400).json({ erro: "Informe pelo menos 2 caracteres para buscar paradas." });
    }

    const termoNormalizado = normalizarTexto(consulta);
    const indice = await obterIndiceParadas();
    const paradas = Array.from(indice.values())
      .filter((parada) =>
        normalizarTexto(parada.nome).includes(termoNormalizado) ||
        parada.num.includes(consulta)
      )
      .slice(0, 20)
      .map(formatarParada);

    res.json({ paradas });
  } catch (erro) {
    console.error("Erro ao buscar paradas:", erro);
    res.status(500).json({ erro: `Não foi possível buscar paradas: ${erro.message}` });
  }
});

router.get("/paradas/:num", async (req, res) => {
  try {
    const indice = await obterIndiceParadas();
    const parada = indice.get(String(req.params.num));
    if (!parada) return res.status(404).json({ erro: "Parada não encontrada." });
    res.json(formatarParada(parada));
  } catch (erro) {
    console.error("Erro ao carregar parada:", erro);
    res.status(500).json({ erro: `Não foi possível carregar a parada: ${erro.message}` });
  }
});

router.get("/linhas/:id/shape", async (req, res) => {
  try {
    const linhas = await obterAgrupados("shapeLinha");
    const shapes = linhas.get(req.params.id);
    if (!shapes) return res.status(404).json({ erro: "Linha não encontrada no arquivo de trajetos da URBS." });
    const trechos = Object.entries(shapes).map(([shp, pontos]) => ({ shp, pontos }));
    res.json({ trechos });
  } catch (erro) {
    console.error("Erro ao carregar trajeto da URBS:", erro);
    res.status(500).json({ erro: `Não foi possível carregar o trajeto da linha: ${erro.message}` });
  }
});

router.get("/linhas/:id/pontos", async (req, res) => {
  try {
    const linhas = await obterAgrupados("pontosLinha");
    const registros = linhas.get(req.params.id);
    if (!registros) return res.status(404).json({ erro: "Linha não encontrada no arquivo de paradas da URBS." });

    const pontos = registros.map((ponto) => ({
      nome: ponto.NOME,
      num: ponto.NUM,
      tipo: ponto.TIPO,
      sentido: ponto.SENTIDO,
      seq: ponto.SEQ,
      itinerario: ponto.ITINERARY_ID,
      lat: converterCoordenada(ponto.LAT),
      lng: converterCoordenada(ponto.LON),
    }));
    res.json({ pontos });
  } catch (erro) {
    console.error("Erro ao carregar paradas da URBS:", erro);
    res.status(500).json({ erro: `Não foi possível carregar as paradas da linha: ${erro.message}` });
  }
});

module.exports = router;