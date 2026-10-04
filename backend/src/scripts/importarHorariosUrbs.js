/* ============================================================
   BUS CWB - importarHorariosUrbs.js (versão MySQL)

   Importa linhas e horarios diretamente do endpoint publico usado
   pela propria pagina de horarios da URBS (sem GTFS, sem token,
   sem cadastro):

     Lista de linhas:
       {URBS_BASE_URL}/linhas_ativas.json
     Horarios de uma linha:
       {URBS_BASE_URL}/linha_{codigo}_v2.json

   Cada linha tem "simulacoes" (versoes da tabela horaria valida
   por periodo). Usamos apenas as simulacoes com "is_current": true
   e mesclamos os tipos de dia que cada uma traz:
     "1" -> dia util   "2" -> sabado   "3" -> domingo/feriado

   Uso:
     npm run importar-horarios

   Requer que as tabelas ja existam (rode `npm run migrar` antes).
   ============================================================ */

require("dotenv").config();
const { pool } = require("../db");

const URBS_BASE_URL =
  process.env.URBS_BASE_URL ||
  "https://www.urbs.curitiba.pr.gov.br/portal/wp-content/urbs_data/urbs_horarios";

const PAUSA_ENTRE_REQUISICOES_MS = Number(
  process.env.URBS_REQUEST_DELAY_MS || 150
);

const MAPA_TIPO_DIA = { 1: "util", 2: "sabado", 3: "domingo" };

function pausar(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function buscarJson(url) {
  const resposta = await fetch(url);
  if (!resposta.ok) {
    throw new Error(`HTTP ${resposta.status} ao buscar ${url}`);
  }
  return resposta.json();
}

async function buscarLinhasAtivas() {
  const url = `${URBS_BASE_URL}/linhas_ativas.json`;
  console.log(`Buscando lista de linhas: ${url}`);
  const linhas = await buscarJson(url);
  console.log(`${linhas.length} linhas encontradas.`);
  return linhas;
}

function mesclarSimulacoes(dadosLinha) {
  const acumulado = { util: {}, sabado: {}, domingo: {} };

  const simulacoes = dadosLinha.simulacoes || [];
  simulacoes
    .filter((sim) => sim.is_current)
    .forEach((sim) => {
      const dias = sim.dias || {};
      Object.entries(dias).forEach(([codigoTipoDia, pontos]) => {
        const tipoDia = MAPA_TIPO_DIA[codigoTipoDia];
        if (!tipoDia) return;

        Object.entries(pontos).forEach(([nomePonto, horarios]) => {
          if (!acumulado[tipoDia][nomePonto]) {
            acumulado[tipoDia][nomePonto] = new Map();
          }
          const mapaHorarios = acumulado[tipoDia][nomePonto];
          horarios.forEach((h) => {
            mapaHorarios.set(h.hora, Boolean(h.adapt));
          });
        });
      });
    });

  return acumulado;
}

function escolherPontoPrincipal(acumulado) {
  const candidatos = [
    ...Object.entries(acumulado.util),
    ...Object.entries(acumulado.sabado),
    ...Object.entries(acumulado.domingo),
  ];
  if (candidatos.length === 0) return null;

  candidatos.sort((a, b) => b[1].size - a[1].size);
  return candidatos[0][0];
}

async function buscarHorariosDaLinha(codigo) {
  const url = `${URBS_BASE_URL}/linha_${codigo}_v2.json`;
  const resposta = await buscarJson(url);
  if (resposta.status !== "success" || !resposta.data) {
    throw new Error(`Resposta inesperada para a linha ${codigo}`);
  }
  return resposta.data;
}

/* ---------- Grava uma linha e seus horarios no banco ----------
   MySQL não tem "unnest"/array bind como o Postgres: o jeito
   idiomático de inserir muitas linhas de uma vez é montar um
   array de arrays e usar "INSERT ... VALUES ?" (o driver mysql2
   expande isso automaticamente em várias tuplas). ---------- */
async function gravarLinha(infoLista, dadosLinha, acumulado) {
  const pontoPrincipal = escolherPontoPrincipal(acumulado);

  await pool.query(
    `INSERT INTO linhas
       (id, numero, nome, categoria_servico, cor, somente_cartao, pagamento, ponto_principal)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       nome = VALUES(nome),
       categoria_servico = VALUES(categoria_servico),
       cor = VALUES(cor),
       somente_cartao = VALUES(somente_cartao),
       pagamento = VALUES(pagamento),
       ponto_principal = VALUES(ponto_principal)`,
    [
      infoLista.COD,
      infoLista.COD,
      dadosLinha.nome || infoLista.NOME,
      infoLista.CATEGORIA_SERVICO || null,
      infoLista.NOME_COR || null,
      infoLista.SOMENTE_CARTAO === "S" ? 1 : 0,
      dadosLinha.pagamento || null,
      pontoPrincipal,
    ]
  );

  await pool.query("DELETE FROM horarios WHERE linha_id = ?", [
    infoLista.COD,
  ]);

  const linhas = [];
  for (const tipoDia of ["util", "sabado", "domingo"]) {
    for (const [ponto, mapaHorarios] of Object.entries(acumulado[tipoDia])) {
      for (const [horario, adapt] of mapaHorarios.entries()) {
        linhas.push([infoLista.COD, tipoDia, ponto, horario, adapt ? 1 : 0]);
      }
    }
  }

  if (linhas.length > 0) {
    // "INSERT IGNORE" faz o mesmo papel do "ON CONFLICT DO NOTHING":
    // se a mesma tupla (linha_id, tipo_dia, ponto, horario) já existir
    // (chave única definida no schema), a linha extra é ignorada.
    await pool.query(
      "INSERT IGNORE INTO horarios (linha_id, tipo_dia, ponto, horario, adapt) VALUES ?",
      [linhas]
    );
  }

  return linhas.length;
}

async function main() {
  const linhasAtivas = await buscarLinhasAtivas();

  let linhasOk = 0;
  let linhasComErro = 0;
  let horariosTotal = 0;

  for (const infoLista of linhasAtivas) {
    try {
      const dadosLinha = await buscarHorariosDaLinha(infoLista.COD);
      const acumulado = mesclarSimulacoes(dadosLinha);
      const totalHorariosLinha = await gravarLinha(
        infoLista,
        dadosLinha,
        acumulado
      );
      horariosTotal += totalHorariosLinha;
      linhasOk += 1;
      console.log(
        `OK  ${infoLista.COD} - ${infoLista.NOME} (${totalHorariosLinha} horarios)`
      );
    } catch (erro) {
      linhasComErro += 1;
      console.warn(`FALHOU ${infoLista.COD} - ${infoLista.NOME}: ${erro.message}`);
    }

    await pausar(PAUSA_ENTRE_REQUISICOES_MS);
  }

  await pool.query(
    `INSERT INTO importacoes (linhas_total, horarios_total, observacao)
     VALUES (?, ?, ?)`,
    [
      linhasOk,
      horariosTotal,
      `Importação via API pública da URBS. ${linhasComErro} linha(s) com erro.`,
    ]
  );

  console.log(
    `\nConcluído: ${linhasOk} linhas importadas, ${linhasComErro} com erro, ${horariosTotal} horários no total.`
  );
  await pool.end();
}

main().catch((erro) => {
  console.error("Falha na importação:", erro);
  process.exit(1);
});
