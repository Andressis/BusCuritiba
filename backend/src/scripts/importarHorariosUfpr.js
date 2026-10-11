/* ============================================================
   BUS CWB - importarHorariosUfpr.js
   Importa os horários do espelho da UFPR (dumps diários .json.xz),
   que o servidor consegue acessar (o site da URBS devolve 403).
   Atualiza só a tabela "horarios" das linhas que já existem em "linhas".

   Uso: npm run importar-horarios-ufpr
   ============================================================ */

require("dotenv").config();
const { XzReadableStream } = require("xz-decompress");
const { pool } = require("../db");

const MAPA_TIPO_DIA = { 1: "util", 2: "sabado", 3: "domingo" };

function dataCuritiba(ms) {
  return new Intl.DateTimeFormat("sv-SE", { timeZone: "America/Sao_Paulo" })
    .format(ms)
    .replace(/-/g, "_");
}

async function baixarTabelaLinha() {
  const base = (process.env.URBS_DUMPS_URL || "").replace(/\/+$/, "");
  if (!base) throw new Error("URBS_DUMPS_URL não configurada.");

  const agora = Date.now();
  let ultimoErro;
  for (const data of [dataCuritiba(agora), dataCuritiba(agora - 86400e3)]) {
    const url = `${base}/${data}_tabelaLinha.json.xz`;
    try {
      const resposta = await fetch(url);
      if (!resposta.ok) throw new Error(`HTTP ${resposta.status} em ${url}`);
      const texto = await new Response(new XzReadableStream(resposta.body)).text();
      const dados = JSON.parse(texto);
      if (!Array.isArray(dados)) throw new Error("tabelaLinha não é um array.");
      console.log(`Arquivo usado: ${url} (${dados.length} registros)`);
      return dados;
    } catch (erro) {
      ultimoErro = erro;
    }
  }
  throw new Error(`Falha ao baixar tabelaLinha: ${ultimoErro.message}`);
}

// { COD: { util: { ponto: Set(horarios) }, sabado: {...}, domingo: {...} } }
function agruparPorLinha(registros) {
  const porLinha = new Map();
  for (const r of registros) {
    const tipoDia = MAPA_TIPO_DIA[r.DIA];
    if (!tipoDia || !r.PONTO || !r.HORA) continue;
    const cod = String(r.COD);
    if (!porLinha.has(cod)) porLinha.set(cod, { util: {}, sabado: {}, domingo: {} });
    const pontos = porLinha.get(cod)[tipoDia];
    (pontos[r.PONTO] ??= new Set()).add(r.HORA);
  }
  return porLinha;
}

function escolherPontoPrincipal(dias) {
  let melhor = null, max = 0;
  for (const pontos of Object.values(dias)) {
    for (const [ponto, horas] of Object.entries(pontos)) {
      if (horas.size > max) { max = horas.size; melhor = ponto; }
    }
  }
  return melhor;
}

async function main() {
  const registros = await baixarTabelaLinha();
  const porLinha = agruparPorLinha(registros);

  const [existentes] = await pool.query("SELECT id FROM linhas");
  const idsNoBanco = new Set(existentes.map((l) => String(l.id)));

  let ok = 0, semCadastro = 0, horariosTotal = 0;

  for (const [cod, dias] of porLinha) {
    if (!idsNoBanco.has(cod)) { semCadastro++; console.warn(`Sem cadastro em "linhas": ${cod}`); continue; }

    const tuplas = [];
    for (const [tipoDia, pontos] of Object.entries(dias)) {
      for (const [ponto, horas] of Object.entries(pontos)) {
        for (const hora of [...horas].sort()) tuplas.push([cod, tipoDia, ponto, hora, 1]);
      }
    }

    const conexao = await pool.getConnection();
    try {
      await conexao.beginTransaction();
      await conexao.query("DELETE FROM horarios WHERE linha_id = ?", [cod]);
      if (tuplas.length > 0) {
        await conexao.query(
          "INSERT IGNORE INTO horarios (linha_id, tipo_dia, ponto, horario, adapt) VALUES ?",
          [tuplas]
        );
      }
      await conexao.query("UPDATE linhas SET ponto_principal = ? WHERE id = ?", [
        escolherPontoPrincipal(dias), cod,
      ]);
      await conexao.commit();
      ok++;
      horariosTotal += tuplas.length;
    } catch (erro) {
      await conexao.rollback();
      console.warn(`FALHOU ${cod}: ${erro.message}`);
    } finally {
      conexao.release();
    }
  }

  await pool.query(
    "INSERT INTO importacoes (linhas_total, horarios_total, observacao) VALUES (?, ?, ?)",
    [ok, horariosTotal, `Importação via espelho UFPR. ${semCadastro} linha(s) sem cadastro.`]
  );
  console.log(`Concluído: ${ok} linhas, ${horariosTotal} horários, ${semCadastro} sem cadastro.`);
  await pool.end();
}

main().catch((erro) => {
  console.error("Falha na importação:", erro);
  process.exit(1);
});