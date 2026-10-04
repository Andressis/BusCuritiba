const express = require("express");
const { pool } = require("../db");

const router = express.Router();

const TIPOS_DIA_VALIDOS = ["util", "sabado", "domingo"];

/* ---------- DADOS DE DEMONSTRAÇÃO (fallback se o banco falhar) ---------- */

const DEMO_LINHAS = [
  {
    id: "101",
    numero: "101",
    nome: "Linha 101 - Santa Cândida / Centro",
    categoria_servico: "Terminal Santa Cândida → Centro",
    cor: "#12372A",
    somente_cartao: false,
    ponto_principal: "Terminal Santa Cândida",
  },
  {
    id: "203",
    numero: "203",
    nome: "Linha 203 - Pinheirinho / Bairro Alto",
    categoria_servico: "Pinheirinho → Bairro Alto",
    cor: "#F4B942",
    somente_cartao: true,
    ponto_principal: "Pinheirinho",
  },
  {
    id: "250",
    numero: "250",
    nome: "Linha 250 - Ligeirão Norte / Sul",
    categoria_servico: "Terminal Santa Cândida → Pinheirinho",
    cor: "#1E88E5",
    somente_cartao: false,
    ponto_principal: "Terminal Santa Cândida",
  },
];

function demoProximoHorario(minutosAgora) {
  const horarios = ["05:30", "06:15", "06:55", "07:40", "08:20", "09:10"];
  const proximo = horarios.find((hora) => {
    const [hh, mm] = hora.split(":").map(Number);
    return hh * 60 + mm >= minutosAgora;
  });
  return proximo || horarios[0];
}

function demoPontos(tipoDia) {
  const base = {
    util: [
      { nome: "Terminal Santa Cândida", horarios: ["05:30", "06:15", "06:55", "07:40", "08:20"] },
      { nome: "Centro", horarios: ["05:45", "06:30", "07:12", "07:55", "08:45"] },
    ],
    sabado: [
      { nome: "Terminal Santa Cândida", horarios: ["06:10", "07:00", "08:15", "09:25"] },
      { nome: "Centro", horarios: ["06:40", "07:35", "08:50", "10:05"] },
    ],
    domingo: [
      { nome: "Terminal Santa Cândida", horarios: ["07:00", "08:20", "09:45", "11:00"] },
      { nome: "Centro", horarios: ["07:35", "09:00", "10:25", "11:55"] },
    ],
  };

  return (base[tipoDia] || base.util).map((ponto) => ({
    nome: ponto.nome,
    horarios: ponto.horarios.map((hora) => ({ hora, adapt: true })),
  }));
}

/* ---------- HORÁRIO DE CURITIBA ---------- */

function agoraEmCuritiba() {
  const partes = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Sao_Paulo",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(new Date());

  const pega = (tipo) => partes.find((p) => p.type === tipo).value;
  return {
    diaSemana: pega("weekday"),
    minutos: (Number(pega("hour")) % 24) * 60 + Number(pega("minute")),
  };
}

function tipoDiaDeHoje(diaSemana) {
  if (diaSemana === "Sun") return "domingo";
  if (diaSemana === "Sat") return "sabado";
  return "util";s
}

function calcularProximoHorario(horariosOrdenados, minutosAgora) {
  if (horariosOrdenados.length === 0) return "--:--";
  for (const horario of horariosOrdenados) {
    const [hh, mm] = horario.split(":").map(Number);
    if (hh * 60 + mm >= minutosAgora) return horario;
  }
  return horariosOrdenados[0];
}

/* ---------- GET /api/linhas?busca=203 ---------- */
router.get("/", async (req, res) => {
  res.set("X-Versao", "novo");
  const termo = (req.query.busca || "").trim().toLowerCase();

  try {
    const [linhas] = await pool.query(
      `SELECT id, numero, nome, categoria_servico, cor, somente_cartao, ponto_principal
       FROM linhas ORDER BY numero`
    );

    const linhasFiltradas = termo
      ? linhas.filter(
          (l) =>
            l.numero.toLowerCase().includes(termo) ||
            l.nome.toLowerCase().includes(termo)
        )
      : linhas;

    if (linhasFiltradas.length === 0) {
      return res.json([]);
    }

    const { diaSemana, minutos } = agoraEmCuritiba();
    const tipoDiaHoje = tipoDiaDeHoje(diaSemana);
    const ids = linhasFiltradas.map((l) => l.id);

    // MySQL não tem "DISTINCT ON" como o Postgres; o equivalente é
    // ranquear com ROW_NUMBER() e pegar só a linha rn = 1 de cada grupo.
    const [contagens] = await pool.query(
      `SELECT h.linha_id, h.tipo_dia, h.ponto, COUNT(*) AS quantidade
       FROM horarios h
       WHERE h.linha_id IN (?)
       GROUP BY h.linha_id, h.tipo_dia, h.ponto`,
      [ids]
    );

    const ordemTiposDia = {
      util: ["util", "sabado", "domingo"],
      sabado: ["sabado", "domingo", "util"],
      domingo: ["domingo", "util", "sabado"],
    }[tipoDiaHoje];
    const pontosPorLinha = new Map();

    contagens.forEach((row) => {
      const linhaId = String(row.linha_id);
      if (!pontosPorLinha.has(linhaId)) pontosPorLinha.set(linhaId, []);
      let ponto = pontosPorLinha
        .get(linhaId)
        .find((item) => item.nome === row.ponto);
      if (!ponto) {
        ponto = { nome: row.ponto, quantidades: {} };
        pontosPorLinha.get(linhaId).push(ponto);
      }
      ponto.quantidades[row.tipo_dia] = Number(row.quantidade);
    });

    const escolhasPorLinha = new Map();
    const escolhas = linhasFiltradas.flatMap((linha) => {
      const pontos = (pontosPorLinha.get(String(linha.id)) || [])
        .map((ponto) => ({
          linha,
          ponto: ponto.nome,
          tipoDia: ordemTiposDia.find((tipo) => ponto.quantidades[tipo]),
          quantidade: Object.values(ponto.quantidades).reduce(
            (total, quantidade) => total + quantidade,
            0
          ),
        }))
        .filter((escolha) => escolha.tipoDia)
        .sort(
          (a, b) =>
            Number(b.ponto === linha.ponto_principal) -
              Number(a.ponto === linha.ponto_principal) ||
            b.quantidade - a.quantidade ||
            a.ponto.localeCompare(b.ponto, "pt-BR")
        );

      escolhasPorLinha.set(String(linha.id), pontos);
      return pontos;
    });

    let horariosEscolhidos = [];

    if (escolhas.length > 0) {
      const condicoes = escolhas
        .map(() => "(linha_id = ? AND tipo_dia = ? AND ponto = ?)")
        .join(" OR ");
      const parametros = escolhas.flatMap((escolha) => [
        escolha.linha.id,
        escolha.tipoDia,
        escolha.ponto,
      ]);
      [horariosEscolhidos] = await pool.query(
        `SELECT linha_id, tipo_dia, ponto, horario
         FROM horarios
         WHERE ${condicoes}
         ORDER BY horario ASC`,
        parametros
      );
    }

    const horariosPorEscolha = new Map();
    horariosEscolhidos.forEach((row) => {
      const chave = JSON.stringify([
        String(row.linha_id),
        row.tipo_dia,
        row.ponto,
      ]);
      if (!horariosPorEscolha.has(chave)) horariosPorEscolha.set(chave, []);
      horariosPorEscolha.get(chave).push(row.horario);
    });

    const resultado = linhasFiltradas.map((linha) => {
      const proximosHorarios = (escolhasPorLinha.get(String(linha.id)) || []).map(
        ({ tipoDia, ponto }) => ({
          ponto,
          horario: calcularProximoHorario(
            horariosPorEscolha.get(
              JSON.stringify([String(linha.id), tipoDia, ponto])
            ) || [],
            tipoDia === tipoDiaHoje ? minutos : 0
          ),
          tipoDia,
          tipoDiaAlternativo: tipoDia !== tipoDiaHoje,
        })
      );
      const proximo = proximosHorarios[0];

      return {
        ...linha,
        somente_cartao: Boolean(linha.somente_cartao),
        proximoHorario: proximo?.horario || "--:--",
        pontoProximoHorario: proximo?.ponto || linha.ponto_principal,
        tipoDiaProximoHorario: proximo?.tipoDia || null,
        tipoDiaAlternativo: Boolean(proximo?.tipoDiaAlternativo),
        proximosHorarios,
      };
    });

    res.json(resultado);
  } catch (erro) {
    console.error("Erro ao listar linhas:", erro);

    const { minutos } = agoraEmCuritiba();
    const linhasDemo = DEMO_LINHAS.map((linha) => ({
      ...linha,
      proximoHorario: demoProximoHorario(minutos),
    }));
    const filtradas = termo
      ? linhasDemo.filter(
          (linha) =>
            String(linha.numero).toLowerCase().includes(termo) ||
            linha.nome.toLowerCase().includes(termo)
        )
      : linhasDemo;

    res.json(filtradas);
  }
});

/* ---------- GET /api/linhas/:id/horarios?tipoDia=util ---------- */
router.get("/:id/horarios", async (req, res) => {
  const { id } = req.params;
  const tipoDia = req.query.tipoDia || "util";

  if (!TIPOS_DIA_VALIDOS.includes(tipoDia)) {
    return res.status(400).json({
      erro: `tipoDia inválido. Use um de: ${TIPOS_DIA_VALIDOS.join(", ")}`,
    });
  }

  try {
    const [linhaRows] = await pool.query(
      `SELECT id, numero, nome, categoria_servico, cor, somente_cartao, ponto_principal
       FROM linhas WHERE id = ?`,
      [id]
    );
    if (linhaRows.length === 0) {
      return res.status(404).json({ erro: "Linha não encontrada." });
    }

    const [horarioRows] = await pool.query(
      `SELECT ponto, horario, adapt FROM horarios
       WHERE linha_id = ? AND tipo_dia = ?
       ORDER BY ponto ASC, horario ASC`,
      [id, tipoDia]
    );

    const pontosMap = new Map();
    horarioRows.forEach((row) => {
      if (!pontosMap.has(row.ponto)) pontosMap.set(row.ponto, []);
      pontosMap.get(row.ponto).push({ hora: row.horario, adapt: Boolean(row.adapt) });
    });

    const pontos = [...pontosMap.entries()].map(([nome, horarios]) => ({
      nome,
      horarios,
    }));

    const linha = { ...linhaRows[0], somente_cartao: Boolean(linhaRows[0].somente_cartao) };

    res.json({ linha, tipoDia, pontos });
  } catch (erro) {
    console.error("Erro ao buscar horários:", erro);

    const linha =
      DEMO_LINHAS.find((item) => String(item.id) === String(id)) ||
      DEMO_LINHAS[0];

    res.json({ linha, tipoDia, pontos: demoPontos(tipoDia) });
  }
});

module.exports = router;
