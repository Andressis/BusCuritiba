const crypto = require("crypto");
const express = require("express");
const { pool } = require("../db");

const router = express.Router();
const LIMITE_TENTATIVAS = new Map();
const STATUS_VALIDOS = ["pendente", "aprovada", "rejeitada", "encaminhada"];
const DURACAO_TOKEN = 2 * 60 * 60 * 1000;
const DURACAO_LIMITE = 60 * 1000;

function obterIpHash(ip) {
  return crypto
    .createHash("sha256")
    .update(`${ip || "desconhecido"}${process.env.HASH_SALT || ""}`)
    .digest("hex");
}

function iguaisEmTempoConstante(a, b) {
  const hashA = crypto.createHash("sha256").update(a).digest();
  const hashB = crypto.createHash("sha256").update(b).digest();
  return crypto.timingSafeEqual(hashA, hashB);
}

function criarToken() {
  const conteudo = Buffer.from(
    JSON.stringify({ exp: Date.now() + DURACAO_TOKEN })
  ).toString("base64url");
  const assinatura = crypto
    .createHmac("sha256", process.env.ADMIN_SEGREDO)
    .update(conteudo)
    .digest("base64url");
  return `${conteudo}.${assinatura}`;
}

function tokenValido(token) {
  const [conteudo, assinatura, extra] = token.split(".");
  if (!conteudo || !assinatura || extra) return false;
  const assinaturaEsperada = crypto
    .createHmac("sha256", process.env.ADMIN_SEGREDO)
    .update(conteudo)
    .digest("base64url");
  if (!iguaisEmTempoConstante(assinatura, assinaturaEsperada)) return false;
  try {
    const dados = JSON.parse(Buffer.from(conteudo, "base64url").toString("utf8"));
    return Number.isFinite(dados.exp) && dados.exp > Date.now();
  } catch {
    return false;
  }
}

router.post("/login", (req, res) => {
  if (!process.env.ADMIN_SENHA || !process.env.ADMIN_SEGREDO) {
    return res.status(503).json({ mensagem: "A administração está indisponível." });
  }
  const hashIp = obterIpHash(req.ip);
  const tentativasAtuais = (LIMITE_TENTATIVAS.get(hashIp) || []).filter(
    (instante) => Date.now() - instante < DURACAO_LIMITE
  );
  if (tentativasAtuais.length >= 5) {
    LIMITE_TENTATIVAS.set(hashIp, tentativasAtuais);
    return res.status(429).json({ mensagem: "Muitas tentativas. Tente novamente em 1 minuto." });
  }
  const senha = typeof req.body.senha === "string" ? req.body.senha : "";
  if (!iguaisEmTempoConstante(senha, process.env.ADMIN_SENHA)) {
    tentativasAtuais.push(Date.now());
    LIMITE_TENTATIVAS.set(hashIp, tentativasAtuais);
    return res.status(401).json({ mensagem: "Senha incorreta." });
  }
  LIMITE_TENTATIVAS.delete(hashIp);
  res.json({ token: criarToken(), validadeMs: DURACAO_TOKEN });
});

router.use((req, res, next) => {
  if (!process.env.ADMIN_SEGREDO) {
    return res.status(503).json({ mensagem: "A administração está indisponível." });
  }
  const autorizacao = req.get("Authorization") || "";
  const correspondencia = autorizacao.match(/^Bearer (.+)$/);
  if (!correspondencia || !tokenValido(correspondencia[1])) {
    return res.status(401).json({ mensagem: "Sessão expirada. Entre novamente." });
  }
  next();
});

router.get("/reclamacoes", async (req, res) => {
  const pagina = Number(req.query.pagina || 1);
  if (!Number.isInteger(pagina) || pagina < 1 || pagina > 100000) {
    return res.status(400).json({ mensagem: "Número de página inválido." });
  }
  const filtros = [];
  const parametros = [];
  if (req.query.status) {
    if (!STATUS_VALIDOS.includes(req.query.status)) {
      return res.status(400).json({ mensagem: "Filtro de status inválido." });
    }
    filtros.push("status = ?");
    parametros.push(req.query.status);
  }
  if (req.query.linha) {
    filtros.push("linha_id = ?");
    parametros.push(String(req.query.linha));
  }
  if (req.query.empresa) {
    filtros.push("(empresa = ? OR empresas_possiveis LIKE ?)");
    parametros.push(String(req.query.empresa), `%${String(req.query.empresa)}%`);
  }
  const where = filtros.length ? `WHERE ${filtros.join(" AND ")}` : "";
  try {
    const [totalRows] = await pool.query(
      `SELECT COUNT(*) AS total FROM reclamacoes ${where}`,
      parametros
    );
    const [reclamacoes] = await pool.query(
      `SELECT id, linha_id, tipo, ocorrido_em, parada_num, lat, lng, prefixo,
              servico_veiculo, descricao, nome, empresa, empresas_possiveis,
              status, marcada, criada_em
       FROM reclamacoes ${where}
       ORDER BY criada_em DESC, id DESC LIMIT 50 OFFSET ?`,
      [...parametros, (pagina - 1) * 50]
    );
    res.json({ reclamacoes, total: Number(totalRows[0].total), pagina, porPagina: 50 });
  } catch (erro) {
    console.error("Erro ao listar reclamações administrativas:", erro);
    res.status(500).json({ mensagem: "Não foi possível carregar as reclamações." });
  }
});

router.patch("/reclamacoes/:id", async (req, res) => {
  if (!STATUS_VALIDOS.includes(req.body.status)) {
    return res.status(400).json({ mensagem: "Status inválido." });
  }
  try {
    const [resultado] = await pool.query(
      "UPDATE reclamacoes SET status = ? WHERE id = ?",
      [req.body.status, req.params.id]
    );
    if (!resultado.affectedRows) {
      return res.status(404).json({ mensagem: "Reclamação não encontrada." });
    }
    res.json({ mensagem: "Status atualizado." });
  } catch (erro) {
    console.error("Erro ao atualizar reclamação:", erro);
    res.status(500).json({ mensagem: "Não foi possível atualizar a reclamação." });
  }
});

router.delete("/reclamacoes/:id", async (req, res) => {
  try {
    const [resultado] = await pool.query(
      "DELETE FROM reclamacoes WHERE id = ?",
      [req.params.id]
    );
    if (!resultado.affectedRows) {
      return res.status(404).json({ mensagem: "Reclamação não encontrada." });
    }
    res.json({ mensagem: "Reclamação excluída." });
  } catch (erro) {
    console.error("Erro ao excluir reclamação:", erro);
    res.status(500).json({ mensagem: "Não foi possível excluir a reclamação." });
  }
});

router.get("/painel", async (req, res) => {
  try {
    const [[linhas], [empresas], [tipos], [recentes]] = await Promise.all([
      pool.query(
        `SELECT linha_id, COUNT(*) AS total,
                SUM(status = 'aprovada') AS aprovadas
         FROM reclamacoes
         WHERE linha_id IS NOT NULL
           AND criada_em >= NOW() - INTERVAL 30 DAY
         GROUP BY linha_id ORDER BY total DESC, linha_id ASC`
      ),
      pool.query(
        `SELECT COALESCE(empresa, 'Indefinida') AS empresa, COUNT(*) AS total
         FROM reclamacoes
         WHERE criada_em >= NOW() - INTERVAL 30 DAY
         GROUP BY empresa ORDER BY total DESC, empresa ASC`
      ),
      pool.query(
        `SELECT tipo, COUNT(*) AS total
         FROM reclamacoes
         WHERE criada_em >= NOW() - INTERVAL 30 DAY
         GROUP BY tipo ORDER BY total DESC, tipo ASC`
      ),
      pool.query(
        `SELECT COUNT(*) AS total FROM reclamacoes
         WHERE criada_em >= NOW() - INTERVAL 30 DAY`
      ),
    ]);
    res.json({
      linhas: linhas.map((item) => ({
        linha_id: item.linha_id,
        total: Number(item.total),
        aprovadas: Number(item.aprovadas),
      })),
      empresas: empresas.map((item) => ({ empresa: item.empresa, total: Number(item.total) })),
      tipos: tipos.map((item) => ({ tipo: item.tipo, total: Number(item.total) })),
      ultimos_30_dias: Number(recentes[0].total),
    });
  } catch (erro) {
    console.error("Erro ao carregar painel administrativo:", erro);
    res.status(500).json({ mensagem: "Não foi possível carregar o painel." });
  }
});

router.get("/empresas", async (req, res) => {
  try {
    const [empresas] = await pool.query(
      "SELECT linha_id, empresa, consorcio FROM linha_empresa ORDER BY linha_id, empresa"
    );
    res.json({ empresas });
  } catch (erro) {
    console.error("Erro ao listar empresas:", erro);
    res.status(500).json({ mensagem: "Não foi possível carregar as empresas." });
  }
});

router.put("/empresas", async (req, res) => {
  const empresas = req.body.empresas;
  if (!Array.isArray(empresas) || empresas.length > 5000) {
    return res.status(400).json({ mensagem: "Envie uma lista válida de empresas." });
  }
  const linhas = new Map();
  const idsDeclarados = req.body.linha_ids;
  if (idsDeclarados !== undefined && (
    !Array.isArray(idsDeclarados) ||
    idsDeclarados.some((id) => typeof id !== "string" || !id || id.length > 20)
  )) {
    return res.status(400).json({ mensagem: "A lista de linhas a atualizar é inválida." });
  }
  (idsDeclarados || []).forEach((linhaId) => {
    if (!linhas.has(linhaId)) linhas.set(linhaId, []);
  });
  for (const item of empresas) {
    if (
      !item || typeof item.linha_id !== "string" || !item.linha_id ||
      typeof item.empresa !== "string" || !item.empresa.trim() ||
      item.empresa.trim().length > 150 ||
      (item.consorcio != null && (typeof item.consorcio !== "string" || item.consorcio.length > 150))
    ) {
      return res.status(400).json({ mensagem: "Há dados de empresa ou linha inválidos." });
    }
    if (!linhas.has(item.linha_id)) linhas.set(item.linha_id, []);
    const registros = linhas.get(item.linha_id);
    if (registros.some(([empresa]) => empresa === item.empresa.trim())) {
      return res.status(400).json({ mensagem: "Há empresas repetidas para a mesma linha." });
    }
    registros.push([item.empresa.trim(), item.consorcio?.trim() || null]);
  }
  const conexao = await pool.getConnection();
  try {
    await conexao.beginTransaction();
    for (const [linhaId, registros] of linhas) {
      const [existentes] = await conexao.query("SELECT id FROM linhas WHERE id = ?", [linhaId]);
      if (!existentes.length) {
        await conexao.rollback();
        return res.status(400).json({ mensagem: "Uma das linhas informadas não foi encontrada." });
      }
      await conexao.query("DELETE FROM linha_empresa WHERE linha_id = ?", [linhaId]);
      for (const [empresa, consorcio] of registros) {
        await conexao.query(
          "INSERT INTO linha_empresa (linha_id, empresa, consorcio) VALUES (?, ?, ?)",
          [linhaId, empresa, consorcio]
        );
      }
    }
    await conexao.commit();
    res.json({ mensagem: "Empresas atualizadas." });
  } catch (erro) {
    await conexao.rollback();
    console.error("Erro ao gravar empresas:", erro);
    res.status(500).json({ mensagem: "Não foi possível gravar as empresas." });
  } finally {
    conexao.release();
  }
});

router.get("/prefixos", async (req, res) => {
  try {
    const [prefixos] = await pool.query(
      "SELECT letra, empresa FROM prefixo_empresa ORDER BY letra"
    );
    res.json({ prefixos });
  } catch (erro) {
    console.error("Erro ao listar prefixos:", erro);
    res.status(500).json({ mensagem: "Não foi possível carregar os prefixos." });
  }
});

router.put("/prefixos", async (req, res) => {
  const prefixos = req.body.prefixos;
  if (!Array.isArray(prefixos) || prefixos.length > 26) {
    return res.status(400).json({ mensagem: "Envie uma lista válida de prefixos." });
  }
  for (const item of prefixos) {
    if (
      !item || typeof item.letra !== "string" || !/^[A-Z]$/.test(item.letra) ||
      typeof item.empresa !== "string" || !item.empresa.trim() || item.empresa.trim().length > 150
    ) {
      return res.status(400).json({ mensagem: "Há dados de prefixo inválidos." });
    }
  }
  const conexao = await pool.getConnection();
  try {
    await conexao.beginTransaction();
    await conexao.query("DELETE FROM prefixo_empresa");
    for (const item of prefixos) {
      await conexao.query(
        "INSERT INTO prefixo_empresa (letra, empresa) VALUES (?, ?)",
        [item.letra, item.empresa.trim()]
      );
    }
    await conexao.commit();
    res.json({ mensagem: "Prefixos atualizados." });
  } catch (erro) {
    await conexao.rollback();
    console.error("Erro ao gravar prefixos:", erro);
    res.status(500).json({ mensagem: "Não foi possível gravar os prefixos." });
  } finally {
    conexao.release();
  }
});

module.exports = router;
