const API_BASE_URL = "https://api.buscwb.com.br/api";

/* ---------- ESTADO DA APLICAÇÃO ---------- */
let LINHAS = []; // cache local das linhas carregadas da API
let linhaSelecionadaId = null;
let tipoDiaSelecionado = "util"; // util | sabado | domingo
let pontosLinhaAtual = []; // [{ nome, horarios: [{hora, adapt}] }]
let pontoSelecionado = null;
let mapa = null;
let camadaRota = null;
let camadaPontos = null;
let requisicaoMapa = 0;
let debounceBuscaMapa = null;
let requisicaoBuscaMapa = 0;

/* ---------- FAVORITOS (localStorage) ---------- */
const CHAVE_FAVORITOS = "buscwb_favoritos";

function obterFavoritos() {
  const dados = localStorage.getItem(CHAVE_FAVORITOS);
  return dados ? JSON.parse(dados) : [];
}

function salvarFavoritos(lista) {
  localStorage.setItem(CHAVE_FAVORITOS, JSON.stringify(lista));
}

function ehFavorita(idLinha) {
  return obterFavoritos().includes(idLinha);
}

function alternarFavorito(idLinha) {
  let favoritos = obterFavoritos();
  if (favoritos.includes(idLinha)) {
    favoritos = favoritos.filter((id) => id !== idLinha);
  } else {
    favoritos.push(idLinha);
  }
  salvarFavoritos(favoritos);
  renderizarTudo();
}

/* ---------- CHAMADAS À API ---------- */

async function buscarLinhasNaApi(termoBusca = "") {
  const url = new URL(`${API_BASE_URL}/linhas`);
  if (termoBusca) url.searchParams.set("busca", termoBusca);
  const resposta = await fetch(url);
  if (!resposta.ok) throw new Error("Falha ao buscar linhas na API.");
  return resposta.json();
}

async function buscarHorariosNaApi(idLinha, tipoDia) {
  const url = `${API_BASE_URL}/linhas/${idLinha}/horarios?tipoDia=${tipoDia}`;
  const resposta = await fetch(url);
  if (!resposta.ok) throw new Error("Falha ao buscar horários na API.");
  return resposta.json();
}

async function iniciarMapa() {
  const status = document.getElementById("mapa-status");

  if (!window.L) {
    status.textContent = "Não foi possível carregar o mapa.";
    return;
  }

  if (!mapa) {
    mapa = L.map("mapa").setView([-25.4284, -49.2733], 12);
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    }).addTo(mapa);
    camadaRota = L.layerGroup().addTo(mapa);
    camadaPontos = L.layerGroup().addTo(mapa);
    configurarBuscaMapa();
  }

  setTimeout(() => mapa.invalidateSize(), 150);
}

function configurarBuscaMapa() {
  const input = document.getElementById("mapa-busca");
  const sugestoes = document.getElementById("mapa-sugestoes");

  input.addEventListener("input", () => {
    clearTimeout(debounceBuscaMapa);
    const requisicaoAtual = ++requisicaoBuscaMapa;
    const termo = input.value.trim();
    if (!termo) {
      sugestoes.replaceChildren();
      sugestoes.classList.add("oculto");
      return;
    }

    debounceBuscaMapa = setTimeout(async () => {
      try {
        const linhas = await buscarLinhasNaApi(termo);
        if (requisicaoAtual !== requisicaoBuscaMapa) return;
        sugestoes.replaceChildren();

        if (linhas.length === 0) {
          const vazio = document.createElement("div");
          vazio.className = "sugestao-vazia";
          vazio.textContent = "Nenhuma linha encontrada";
          sugestoes.appendChild(vazio);
        } else {
          linhas.slice(0, 8).forEach((linha) => {
            const botao = document.createElement("button");
            botao.type = "button";
            botao.className = "sugestao";
            botao.textContent = `${linha.numero} · ${linha.nome}`;
            botao.addEventListener("click", () => {
              clearTimeout(debounceBuscaMapa);
              requisicaoBuscaMapa += 1;
              input.value = `${linha.numero} · ${linha.nome}`;
              sugestoes.classList.add("oculto");
              selecionarLinhaMapa(linha.id);
            });
            sugestoes.appendChild(botao);
          });
        }
        sugestoes.classList.remove("oculto");
      } catch (erro) {
        if (requisicaoAtual !== requisicaoBuscaMapa) return;
        console.error(erro);
        sugestoes.replaceChildren();
        const vazio = document.createElement("div");
        vazio.className = "sugestao-vazia";
        vazio.textContent = "Não foi possível buscar linhas.";
        sugestoes.appendChild(vazio);
        sugestoes.classList.remove("oculto");
      }
    }, 250);
  });
}

async function selecionarLinhaMapa(id) {
  const status = document.getElementById("mapa-status");
  const legenda = document.getElementById("mapa-legenda");
  const requisicaoAtual = ++requisicaoMapa;
  camadaRota.clearLayers();
  camadaPontos.clearLayers();
  legenda.classList.add("oculto");

  status.textContent = "Carregando trajeto e paradas...";
  try {
    const codigoUrl = encodeURIComponent(id);
    const [respostaShape, respostaPontos] = await Promise.all([
      fetch(`${API_BASE_URL}/mapa/linhas/${codigoUrl}/shape`),
      fetch(`${API_BASE_URL}/mapa/linhas/${codigoUrl}/pontos`),
    ]);
    if (!respostaShape.ok || !respostaPontos.ok) {
      throw new Error("Falha ao buscar trajeto ou paradas da linha.");
    }

    const [dadosShape, dadosPontos] = await Promise.all([
      respostaShape.json(),
      respostaPontos.json(),
    ]);
    if (requisicaoAtual !== requisicaoMapa) return;

    const itinerarios = new Map();
    (dadosPontos.pontos || []).forEach((ponto) => {
      const itinerario = String(ponto.itinerario);
      if (!itinerarios.has(itinerario)) itinerarios.set(itinerario, []);
      itinerarios.get(itinerario).push(ponto);
    });
    const gruposOrdenados = Array.from(itinerarios.entries())
      .sort(([idA], [idB]) => idA.localeCompare(idB, undefined, { numeric: true }))
      .map(([itinerario, pontos]) => ({
        itinerario,
        pontos: pontos.sort((a, b) => Number(a.seq) - Number(b.seq)),
        sentido: String(pontos[0]?.sentido || ""),
      }));
    const sentidoIda = gruposOrdenados[0]?.sentido || "";
    const gruposPorDirecao = { ida: [], volta: [] };
    gruposOrdenados.forEach((grupo) => {
      grupo.direcao = grupo.sentido === sentidoIda ? "ida" : "volta";
      gruposPorDirecao[grupo.direcao].push(grupo);
    });

    const primeiraParadaPorDirecao = {};
    Object.keys(gruposPorDirecao).forEach((direcao) => {
      primeiraParadaPorDirecao[direcao] = gruposPorDirecao[direcao]
        .flatMap((grupo) => grupo.pontos)
        .find((ponto) => Number.isFinite(Number(ponto.lat)) && Number.isFinite(Number(ponto.lng)));
    });
    const distancia = (a, b) =>
      Math.hypot(Number(a[0]) - Number(b.lat), Number(a[1]) - Number(b.lng));
    const trechos = (dadosShape.trechos || []).filter((trecho) => trecho.pontos?.length);
    const direcoesTrechos = trechos.map((trecho) => {
      const primeiroPonto = trecho.pontos[0];
      const paradaIda = primeiraParadaPorDirecao.ida;
      const paradaVolta = primeiraParadaPorDirecao.volta;
      if (!paradaIda) return "volta";
      if (!paradaVolta) return "ida";
      return distancia(primeiroPonto, paradaIda) <= distancia(primeiroPonto, paradaVolta)
        ? "ida"
        : "volta";
    });
    if (trechos.length >= 2 && direcoesTrechos.every((direcao) => direcao === direcoesTrechos[0])) {
      direcoesTrechos.forEach((_, indice) => {
        direcoesTrechos[indice] = indice === 0 ? "ida" : "volta";
      });
    }

    const limites = [];
    const cores = { ida: "#1B8A3C", volta: "#D32F2F" };
    trechos.forEach((trecho, indice) => {
      L.polyline(trecho.pontos, { color: cores[direcoesTrechos[indice]], weight: 4 }).addTo(camadaRota);
      limites.push(...trecho.pontos);
    });

    const paradasExibidas = new Set();
    gruposOrdenados.forEach((grupo) => {
      grupo.pontos.forEach((ponto) => {
        const chaveParada = `${grupo.direcao}:${ponto.num}`;
        if (paradasExibidas.has(chaveParada)) return;
        paradasExibidas.add(chaveParada);

        const popup = document.createElement("div");
        popup.textContent = `${ponto.nome || "Parada"} / ${ponto.tipo || "não informado"} / ${grupo.direcao === "ida" ? "Ida" : "Volta"}: ${ponto.sentido || "não informado"}`;
        L.circleMarker([ponto.lat, ponto.lng], {
          radius: 5,
          fillColor: cores[grupo.direcao],
          color: "#FFFFFF",
          weight: 1.5,
          fillOpacity: 1,
        }).bindPopup(popup).addTo(camadaPontos);
        limites.push([ponto.lat, ponto.lng]);
      });
    });

    document.getElementById("leg-ida").textContent = `→ ${sentidoIda || "sentido não informado"}`;
    const sentidoVolta = gruposPorDirecao.volta[0]?.sentido;
    document.getElementById("leg-volta").textContent = `→ ${sentidoVolta || "sentido não informado"}`;
    legenda.classList.remove("oculto");
    mapa.invalidateSize();
    if (limites.length) mapa.fitBounds(L.latLngBounds(limites), { padding: [20, 20] });
    status.textContent = paradasExibidas.size
      ? `${paradasExibidas.size} paradas encontradas.`
      : "Nenhuma parada encontrada para esta linha.";
  } catch (erro) {
    if (requisicaoAtual !== requisicaoMapa) return;
    console.error(erro);
    status.textContent = "Não foi possível carregar o trajeto e as paradas desta linha.";
  }
}

/* ---------- FUNÇÕES AUXILIARES ---------- */

function obterLinhaPorId(id) {
  return LINHAS.find((l) => l.id === id);
}

/* ---------- ÍCONE DE ESTRELA (SVG) REUTILIZÁVEL ---------- */
const SVG_ESTRELA = `
  <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
    <polygon points="12,3 14.9,9.3 21.8,10 16.7,14.6 18.2,21.5 12,17.9 5.8,21.5 7.3,14.6 2.2,10 9.1,9.3" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/>
  </svg>
`;

/* ---------- CRIAÇÃO DE ITEM DE LINHA (HTML) ---------- */
function criarCardLinha(linha) {
  const favoritada = ehFavorita(linha.id);
  const nomesTiposDia = {
    util: "Dia útil",
    sabado: "Sábado",
    domingo: "Domingo",
  };
  const proximosHorarios = linha.proximosHorarios?.length
    ? linha.proximosHorarios
    : [
      {
        ponto: linha.pontoProximoHorario || linha.ponto_principal || "Ponto não informado",
        horario: linha.proximoHorario || "--:--",
        tipoDia: linha.tipoDiaProximoHorario,
        tipoDiaAlternativo: linha.tipoDiaAlternativo,
      },
    ];

  const item = document.createElement("div");
  item.className = "item-linha";
  item.dataset.id = linha.id;

  item.innerHTML = `
    <div class="item-linha-info">
      <div class="item-numero">${linha.numero}</div>
      <div class="item-texto">
        <h3>${linha.nome}</h3>
        <span>${linha.categoria_servico || ""}</span>
      </div>
    </div>
    <div class="item-linha-acoes">
      <div class="item-proximo-horario">
        <span class="label">Próximo</span>
        <div class="resumo-pontos">
          ${proximosHorarios
      .map((proximo) => {
        const dia = nomesTiposDia[proximo.tipoDia];
        return `
                <div class="resumo-ponto">
                  <span class="ponto-horario">
                    <span class="ponto-nome">${proximo.ponto}:</span>
                    <strong>${proximo.horario}</strong>
                  </span>
                  ${proximo.tipoDiaAlternativo && dia ? `<span class="dia-horario">(${dia})</span>` : ""}
                </div>
              `;
      })
      .join("")}
        </div>
      </div>
      <button class="btn-estrela-card${favoritada ? " favoritado" : ""}" aria-label="Favoritar linha">
        ${SVG_ESTRELA}
      </button>
    </div>
  `;

  item.addEventListener("click", (evento) => {
    if (evento.target.closest(".btn-estrela-card")) {
      evento.stopPropagation();
      alternarFavorito(linha.id);
      return;
    }
    abrirModalLinha(linha.id);
  });

  return item;
}

/* ---------- RENDERIZAÇÃO DAS LISTAS ---------- */

function renderizarListaLinhas() {
  const container = document.getElementById("lista-linhas");
  const msgVazio = document.getElementById("msg-sem-resultado");
  container.innerHTML = "";

  if (LINHAS.length === 0) {
    msgVazio.classList.remove("oculto");
  } else {
    msgVazio.classList.add("oculto");
    LINHAS.forEach((linha) => container.appendChild(criarCardLinha(linha)));
  }
}

function renderizarFavoritas() {
  const container = document.getElementById("lista-favoritas");
  const msgSemFavoritas = document.getElementById("msg-sem-favoritas");
  const favoritos = obterFavoritos();

  container.innerHTML = "";

  if (favoritos.length === 0) {
    container.appendChild(msgSemFavoritas);
    msgSemFavoritas.classList.remove("oculto");
    return;
  }

  favoritos.forEach((id) => {
    const linha = obterLinhaPorId(id);
    if (linha) container.appendChild(criarCardLinha(linha));
  });
}

function renderizarTelaFavoritos() {
  const container = document.getElementById("lista-favoritos-tela");
  const msgVazio = document.getElementById("msg-favoritos-vazio");
  const favoritos = obterFavoritos();

  container.innerHTML = "";

  if (favoritos.length === 0) {
    msgVazio.classList.remove("oculto");
    return;
  }

  msgVazio.classList.add("oculto");
  favoritos.forEach((id) => {
    const linha = obterLinhaPorId(id);
    if (linha) container.appendChild(criarCardLinha(linha));
  });
}

async function renderizarTudo() {
  const termo = document.getElementById("input-busca").value;
  try {
    LINHAS = await buscarLinhasNaApi(termo);
  } catch (erro) {
    console.error(erro);
    LINHAS = [];
  }
  renderizarListaLinhas();
  renderizarFavoritas();
  renderizarTelaFavoritos();
}

/* ---------- MODAL DE DETALHES DA LINHA ---------- */

async function abrirModalLinha(idLinha) {
  const linha = obterLinhaPorId(idLinha);
  if (!linha) return;

  linhaSelecionadaId = idLinha;
  tipoDiaSelecionado = "util";
  pontoSelecionado = null;

  document.getElementById("modal-overlay").classList.remove("oculto");
  rolarParaProximo();
  document.getElementById("modal-numero-linha").textContent = linha.numero;
  document.getElementById("modal-titulo-linha").textContent = linha.nome;
  document.getElementById("modal-sentido-texto").textContent =
    linha.categoria_servico || "";

  document.querySelectorAll(".tipo-dia-btn").forEach((btn) => {
    btn.classList.toggle("ativo", btn.dataset.tipo === "util");
  });

  atualizarFavoritoModal();
  await carregarPontosERenderizar();

  document.getElementById("modal-overlay").classList.remove("oculto");
}

function fecharModalLinha() {
  document.getElementById("modal-overlay").classList.add("oculto");
  linhaSelecionadaId = null;
}

function atualizarFavoritoModal() {
  const favoritado = ehFavorita(linhaSelecionadaId);
  const botao = document.getElementById("btn-favoritar-modal");
  const texto = document.getElementById("texto-favoritar-modal");

  botao.classList.toggle("favoritado", favoritado);
  texto.textContent = favoritado ? "Linha favoritada" : "Favoritar linha";
}

// Busca na API os pontos/horários do tipo de dia atual
async function carregarPontosERenderizar() {
  const container = document.getElementById("lista-horarios-modal");
  container.innerHTML = `<p class="mensagem-vazia">Carregando horários...</p>`;

  try {
    const resultado = await buscarHorariosNaApi(
      linhaSelecionadaId,
      tipoDiaSelecionado
    );
    pontosLinhaAtual = resultado.pontos || [];
  } catch (erro) {
    console.error(erro);
    pontosLinhaAtual = [];
  }

  if (pontosLinhaAtual.length === 0) {
    document.getElementById("seletor-ponto-wrapper").classList.add("oculto");
    container.innerHTML = `<p class="mensagem-vazia">Esta linha não opera nesse tipo de dia.</p>`;
    return;
  }

  // Mantém o ponto já selecionado se ele continuar existindo; senão usa o primeiro
  if (!pontosLinhaAtual.some((p) => p.nome === pontoSelecionado)) {
    pontoSelecionado = pontosLinhaAtual[0].nome;
  }

  renderizarSeletorDePontos();
  renderizarHorariosDoPontoSelecionado();
}

function renderizarSeletorDePontos() {
  const wrapper = document.getElementById("seletor-ponto-wrapper");
  const select = document.getElementById("seletor-ponto");
  wrapper.classList.remove("oculto");

  select.innerHTML = pontosLinhaAtual
    .map((p) => `<option value="${p.nome}">${p.nome}</option>`)
    .join("");
  select.value = pontoSelecionado;
}

function agoraEmCuritiba() {
  const partes = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Sao_Paulo",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(new Date());
  const pega = (t) => partes.find((p) => p.type === t).value;
  return {
    diaSemana: pega("weekday"),
    minutos: (Number(pega("hour")) % 24) * 60 + Number(pega("minute")),
  };
}

function tipoDiaDeHoje(diaSemana) {
  if (diaSemana === "Sun") return "domingo";
  if (diaSemana === "Sat") return "sabado";
  return "util";
}

function horaParaMinutos(hora) {
  const [hh, mm] = hora.split(":").map(Number);
  return hh * 60 + mm;
}

function rolarParaProximo() {
  const el = document.querySelector("#lista-horarios-modal .horario-item.proximo");
  if (el) el.scrollIntoView({ block: "center" });
}

function renderizarHorariosDoPontoSelecionado() {
  const container = document.getElementById("lista-horarios-modal");
  container.innerHTML = "";

  const ponto = pontosLinhaAtual.find((p) => p.nome === pontoSelecionado);
  const horarios = ponto ? ponto.horarios : [];

  if (horarios.length === 0) {
    container.innerHTML = `<p class="mensagem-vazia">Nenhum horário encontrado para este ponto.</p>`;
    return;
  }

  // Só marca o "próximo" se o tipo de dia selecionado for o de hoje
  const { diaSemana, minutos } = agoraEmCuritiba();
  const ehHoje = tipoDiaSelecionado === tipoDiaDeHoje(diaSemana);
  const indiceProximo = ehHoje
    ? horarios.findIndex((h) => horaParaMinutos(h.hora) >= minutos)
    : -1;

  horarios.forEach((h, index) => {
    const ehProximo = index === indiceProximo;
    const item = document.createElement("div");
    item.className = "horario-item" + (ehProximo ? " proximo" : "");
    item.innerHTML = `
      <span class="horario-valor">${h.hora}${h.adapt === false ? " ♿︎✕" : ""}</span>
      ${ehProximo ? `<span class="selo-proximo">Próximo</span>` : ""}
    `;
    container.appendChild(item);
  });

  rolarParaProximo();
}

/* ---------- NAVEGAÇÃO ENTRE TELAS ---------- */

function irParaTela(idTela) {
  document.querySelectorAll(".tela").forEach((tela) => {
    tela.classList.toggle("ativa", tela.id === idTela);
  });
  document.querySelectorAll(".nav-item").forEach((item) => {
    item.classList.toggle("ativo", item.dataset.tela === idTela);
  });
  renderizarTudo();
  if (idTela === "tela-mapa") iniciarMapa();
}

/* ---------- EVENTOS ---------- */

document.addEventListener("DOMContentLoaded", () => {
  renderizarTudo();

  const inputBusca = document.getElementById("input-busca");
  let debounceBusca = null;
  inputBusca.addEventListener("input", () => {
    clearTimeout(debounceBusca);
    debounceBusca = setTimeout(() => renderizarTudo(), 300);
  });

  document.getElementById("btn-buscar").addEventListener("click", () => {
    renderizarTudo();
    inputBusca.blur();
  });

  document
    .getElementById("btn-fechar-modal")
    .addEventListener("click", fecharModalLinha);

  document.getElementById("modal-overlay").addEventListener("click", (e) => {
    if (e.target.id === "modal-overlay") fecharModalLinha();
  });

  document
    .getElementById("btn-favoritar-modal")
    .addEventListener("click", () => {
      if (linhaSelecionadaId) alternarFavorito(linhaSelecionadaId);
      atualizarFavoritoModal();
    });

  document.querySelectorAll(".tipo-dia-btn").forEach((botao) => {
    botao.addEventListener("click", () => {
      tipoDiaSelecionado = botao.dataset.tipo;
      document
        .querySelectorAll(".tipo-dia-btn")
        .forEach((b) => b.classList.remove("ativo"));
      botao.classList.add("ativo");
      carregarPontosERenderizar();
    });
  });

  // Seletor de ponto/terminal (adicionado ao HTML dentro do modal)
  document
    .getElementById("seletor-ponto")
    .addEventListener("change", (evento) => {
      pontoSelecionado = evento.target.value;
      renderizarHorariosDoPontoSelecionado();
    });

  document.querySelectorAll(".nav-item").forEach((item) => {
    item.addEventListener("click", () => irParaTela(item.dataset.tela));
  });

  const botaoInstalar = document.getElementById("btn-instalar-app");
  const ehIOS = /iphone|ipad|ipod/i.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  let promptInstalacao = null;

  if (ehIOS && !navigator.standalone) {
    botaoInstalar.classList.remove("oculto");
  }

  window.addEventListener("beforeinstallprompt", (evento) => {
    evento.preventDefault();
    promptInstalacao = evento;
    botaoInstalar.classList.remove("oculto");
  });

  botaoInstalar.addEventListener("click", async () => {
    if (!promptInstalacao) {
      alert("No Safari, toque em Compartilhar e depois em Adicionar à Tela de Início.");
      return;
    }

    promptInstalacao.prompt();
    await promptInstalacao.userChoice;
    promptInstalacao = null;
    botaoInstalar.classList.add("oculto");
  });

  window.addEventListener("appinstalled", () => {
    promptInstalacao = null;
    botaoInstalar.classList.add("oculto");
  });

  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => {
      navigator.serviceWorker
        .register("service-worker.js")
        .then(() => console.log("Service Worker registrado com sucesso."))
        .catch((erro) =>
          console.log("Erro ao registrar Service Worker:", erro)
        );
    });
  }
});
