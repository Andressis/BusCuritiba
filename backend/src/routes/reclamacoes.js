const crypto = require("crypto");
const express = require("express");
const { pool } = require("../db");

const router = express.Router();
const TIPOS_VALIDOS = [
  "atraso",
  "lotado",
  "motorista",
  "veiculo_sujo_defeito",
  "acessibilidade",
  "infraestrutura",
  "outro",
];
const cacheResumo = { instante: 0, dados: null };
const TERMOS_MARCADOS = ["porra", "merda", "caralho", "puta", "foda-se"];

function obterIpHash(ip) {
  return crypto
    .createHash("sha256")
    .update(`${ip || "desconhecido"}${process.env.HASH_SALT || ""}`)
    .digest("hex");
}

function textoOpcional(valor, maximo) {
  if (valor === undefined || valor === null || valor === "") return null;
  if (typeof valor !== "string") return undefined;
  const texto = valor.trim();
  return texto.length <= maximo ? texto || null : undefined;
}

router.post("/", async (req, res) => {
  if (typeof req.body.site === "string" && req.body.site.trim()) {
    return res.status(200).json({ mensagem: "Recebemos seu relato." });
  }

  const { tipo } = req.body;
  const descricao =
    typeof req.body.descricao === "string" ? req.body.descricao.trim() : "";
  const nome = textoOpcional(req.body.nome, 60);
  const prefixoBruto = textoOpcional(req.body.prefixo, 20);
  const linhaInformada = req.body.linha_id;
  const paradaNum = textoOpcional(req.body.parada_num, 30);

  if (!TIPOS_VALIDOS.includes(tipo)) {
    return res.status(400).json({ mensagem: "Selecione um tipo de reclamação válido." });
  }
  if (descricao.length < 10 || descricao.length > 500) {
    return res.status(400).json({ mensagem: "A descrição deve ter entre 10 e 500 caracteres." });
  }
  if (nome === undefined) {
    return res.status(400).json({ mensagem: "O nome ou apelido deve ter até 60 caracteres." });
  }
  if (prefixoBruto === undefined || (prefixoBruto && !/^[a-zA-Z0-9]+$/.test(prefixoBruto))) {
    return res.status(400).json({ mensagem: "O prefixo deve conter apenas letras e números, com até 20 caracteres." });
  }
  if (paradaNum === undefined) {
    return res.status(400).json({ mensagem: "O número da parada informado é inválido." });
  }

  const coordenadaValida = (valor, minimo, maximo) =>
    valor === undefined || valor === null || valor === "" ||
    (typeof valor === "number" && Number.isFinite(valor) && valor >= minimo && valor <= maximo);
  if (!coordenadaValida(req.body.lat, -90, 90) || !coordenadaValida(req.body.lng, -180, 180)) {
    return res.status(400).json({ mensagem: "A localização informada é inválida." });
  }
  const lat = typeof req.body.lat === "number" ? req.body.lat : null;
  const lng = typeof req.body.lng === "number" ? req.body.lng : null;
  if ((lat === null) !== (lng === null)) {
    return res.status(400).json({ mensagem: "Informe latitude e longitude juntas." });
  }

  let ocorridoEm = null;
  if (req.body.ocorrido_em !== undefined && req.body.ocorrido_em !== "") {
    const data = new Date(req.body.ocorrido_em);
    if (Number.isNaN(data.getTime()) || data.getTime() > Date.now()) {
      return res.status(400).json({ mensagem: "A data e hora devem ser válidas e não podem estar no futuro." });
    }
    ocorridoEm = data;
  }
  if (linhaInformada !== undefined && linhaInformada !== null && linhaInformada !== "") {
    if (typeof linhaInformada !== "string" || linhaInformada.length > 20) {
      return res.status(400).json({ mensagem: "A linha informada é inválida." });
    }
  }
  const linhaId = linhaInformada || null;
  const prefixo = prefixoBruto ? prefixoBruto.toUpperCase() : null;
  const ipHash = obterIpHash(req.ip);

  try {
    if (linhaId) {
      const [linhas] = await pool.query("SELECT id FROM linhas WHERE id = ?", [linhaId]);
      if (!linhas.length) {
        return res.status(400).json({ mensagem: "A linha selecionada não foi encontrada." });
      }
    }

    const [limites] = await pool.query(
      `SELECT
         SUM(criada_em >= NOW() - INTERVAL 1 HOUR) AS ultima_hora,
         SUM(criada_em >= CURDATE()) AS hoje
       FROM reclamacoes
       WHERE ip_hash = ?
         AND criada_em >= NOW() - INTERVAL 1 DAY`,
      [ipHash]
    );
    if (Number(limites[0].ultima_hora) >= 5 || Number(limites[0].hoje) >= 20) {
      return res.status(429).json({ mensagem: "Limite de envios atingido. Tente novamente mais tarde." });
    }

    let empresa = null;
    let empresasPossiveis = null;
    let servicoVeiculo = null;
    if (prefixo) {
      const [empresasPrefixo] = await pool.query(
        "SELECT empresa FROM prefixo_empresa WHERE letra = ?",
        [prefixo[0]]
      );
      empresa = empresasPrefixo[0]?.empresa || null;
      const servicos = {
        B: "Interbairros",
        E: "Expresso",
        L: "Linha Direta/Ligeirinho",
        T: "Linha Turismo",
      };
      servicoVeiculo = servicos[prefixo[1]] || null;
    }
    if (!empresa && linhaId) {
      const [empresasLinha] = await pool.query(
        "SELECT empresa FROM linha_empresa WHERE linha_id = ? ORDER BY empresa",
        [linhaId]
      );
      empresasPossiveis = empresasLinha.length
        ? empresasLinha.map((item) => item.empresa).join(" | ")
        : null;
    }

    const marcada = TERMOS_MARCADOS.some((termo) =>
      descricao.toLocaleLowerCase("pt-BR").includes(termo)
    );
    const [resultado] = await pool.query(
      `INSERT INTO reclamacoes
       (linha_id, tipo, ocorrido_em, parada_num, lat, lng, prefixo, servico_veiculo,
        descricao, nome, empresa, empresas_possiveis, marcada, ip_hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        linhaId,
        tipo,
        ocorridoEm,
        paradaNum,
        lat,
        lng,
        prefixo,
        servicoVeiculo,
        descricao,
        nome,
        empresa,
        empresasPossiveis,
        marcada ? 1 : 0,
        ipHash,
      ]
    );
    res.status(201).json({ id: resultado.insertId, mensagem: "Recebemos seu relato." });
  } catch (erro) {
    console.error("Erro ao registrar reclamação:", erro);
    res.status(500).json({ mensagem: "Não foi possível registrar sua reclamação agora." });
  }
});

router.get("/resumo", async (req, res) => {
  if (cacheResumo.dados && Date.now() - cacheResumo.instante < 5 * 60 * 1000) {
    return res.json({ resumo: cacheResumo.dados });
  }
  try {
    const [linhas] = await pool.query(
      `SELECT linha_id, tipo, COUNT(*) AS total
       FROM reclamacoes
       WHERE status IN ('aprovada', 'encaminhada')
         AND criada_em >= NOW() - INTERVAL 30 DAY
         AND linha_id IS NOT NULL
       GROUP BY linha_id, tipo`
    );
    const resumo = new Map();
    linhas.forEach((linha) => {
      const id = String(linha.linha_id);
      if (!resumo.has(id)) resumo.set(id, { linha_id: id, total: 0, por_tipo: {} });
      const item = resumo.get(id);
      const total = Number(linha.total);
      item.total += total;
      item.por_tipo[linha.tipo] = total;
    });
    cacheResumo.instante = Date.now();
    cacheResumo.dados = [...resumo.values()];
    res.json({ resumo: cacheResumo.dados });
  } catch (erro) {
    console.error("Erro ao carregar resumo de reclamações:", erro);
    res.status(500).json({ mensagem: "Não foi possível carregar o resumo agora." });
  }
});

module.exports = router;
