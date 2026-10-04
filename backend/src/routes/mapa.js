const express = require("express");
const { XzReadableStream } = require("xz-decompress");

const router = express.Router();
const TEMPO_CACHE = 6 * 60 * 60 * 1000;
const cacheArquivos = new Map();

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