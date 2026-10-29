const API_BASE_URL = "https://api.buscwb.com.br/api";

/* ---------- ESTADO DA APLICAÇÃO ---------- */
let LINHAS = []; // cache local das linhas carregadas da API
let LINHAS_CARREGADAS = false;
let linhaSelecionadaId = null;
let tipoDiaSelecionado = "util"; // util | sabado | domingo
let pontosLinhaAtual = []; // [{ nome, horarios: [{hora, adapt}] }]
let mapa = null;
let grupoIda = null;
let grupoVolta = null;
let rendererParadas = null;
let marcadorUsuario = null;
let marcadorParadaSelecionada = null;
let linhaSelecionadaAtual = null;
let pontoMapaSelecionado = null;
let direcaoSelecionada = "ida";
let saidasHorariosMapa = { ida: [], volta: [] };
let nomesPontosHorarioMapa = { ida: "", volta: "" };
let pontosHorarioMapa = { ida: null, volta: null };
let origensRotaPorDirecao = { ida: "", volta: "" };
let paradasMapaPorDirecao = { ida: [], volta: [] };
let linhasBuscaAtuais = [];
let erroHorariosMapa = false;
let requisicaoMapa = 0;
let debounceBuscaMapa = null;
let requisicaoBuscaMapa = 0;
let debounceBuscaParadas = null;
let requisicaoBuscaParadas = 0;
let temporizadorAvisoCache = null;
let temporizadorAvisoErro = null;
let requisicaoHorarios = 0;

/* ---------- LOCALIZAÇÃO (compartilhada) ---------- */
let ultimaPosicao = null;
let idWatch = null;
let localizacaoAtivadaPeloUsuario = false;
let localizacaoNegada = false;
const ouvintesLocalizacao = new Set();
const rejeicoesLocalizacao = new Set();

function mensagemErroLocalizacao(codigo) {
  const mensagens = {
    1: "Permissão de localização negada. Para liberar, toque no ícone de cadeado ao lado do endereço, abra Localização e escolha Permitir.",
    2: "Não foi possível determinar sua localização. Verifique o sinal e tente novamente.",
    3: "A localização demorou mais que 20 segundos. Tente novamente.",
  };
  return mensagens[codigo] || "Não foi possível obter sua localização.";
}

function ativarLocalizacao() {
  if (idWatch !== null) return;
  if (!window.isSecureContext) {
    throw new Error("A localização só funciona em HTTPS.");
  }
  if (!navigator.geolocation) {
    throw new Error("Este aparelho não oferece serviço de localização.");
  }

  localizacaoNegada = false;
  localizacaoAtivadaPeloUsuario = true;
  idWatch = navigator.geolocation.watchPosition(
    (posicao) => {
      const leitura = {
        lat: posicao.coords.latitude,
        lng: posicao.coords.longitude,
        accuracy: posicao.coords.accuracy,
        instante: Date.now(),
      };
      if (
        !Number.isFinite(leitura.lat) ||
        !Number.isFinite(leitura.lng) ||
        !Number.isFinite(leitura.accuracy)
      ) {
        const erro = new Error("O aparelho retornou coordenadas de localização inválidas.");
        rejeicoesLocalizacao.forEach((rejeitar) => rejeitar(erro));
        return;
      }

      if (
        !ultimaPosicao ||
        Date.now() - ultimaPosicao.instante >= 60000 ||
        leitura.accuracy <= ultimaPosicao.accuracy
      ) {
        ultimaPosicao = leitura;
      }
      ouvintesLocalizacao.forEach((ouvinte) => ouvinte(ultimaPosicao));
    },
    (erro) => {
      const falha = new Error(mensagemErroLocalizacao(erro.code));
      rejeicoesLocalizacao.forEach((rejeitar) => rejeitar(falha));
      if (erro.code === 1) {
        if (idWatch !== null) navigator.geolocation.clearWatch(idWatch);
        idWatch = null;
        localizacaoNegada = true;
        atualizarInterfaceLocalizacao("denied");
      }
    },
    { enableHighAccuracy: true, maximumAge: 0, timeout: 20000 }
  );
}

function obterPosicao() {
  if (ultimaPosicao && Date.now() - ultimaPosicao.instante < 60000) {
    return Promise.resolve(ultimaPosicao);
  }
  return new Promise((resolve, reject) => {
    let temporizador;
    const receberPosicao = (posicao) => {
      clearTimeout(temporizador);
      ouvintesLocalizacao.delete(receberPosicao);
      rejeicoesLocalizacao.delete(rejeitar);
      resolve(posicao);
    };
    const rejeitar = (erro) => {
      clearTimeout(temporizador);
      ouvintesLocalizacao.delete(receberPosicao);
      rejeicoesLocalizacao.delete(rejeitar);
      reject(erro);
    };
    ouvintesLocalizacao.add(receberPosicao);
    rejeicoesLocalizacao.add(rejeitar);
    temporizador = setTimeout(
      () => rejeitar(new Error("A localização demorou mais que 20 segundos. Tente novamente.")),
      25000
    );
    try {
      ativarLocalizacao();
    } catch (erro) {
      rejeitar(erro);
    }
  });
}

function aoMudarLocalizacao(fn) {
  ouvintesLocalizacao.add(fn);
  return () => ouvintesLocalizacao.delete(fn);
}

function pararLocalizacao() {
  if (idWatch !== null && navigator.geolocation) {
    navigator.geolocation.clearWatch(idWatch);
  }
  idWatch = null;
  ultimaPosicao = null;
  rejeicoesLocalizacao.forEach((rejeitar) =>
    rejeitar(new Error("A localização foi pausada. Toque para tentar novamente."))
  );
}

async function estadoPermissao() {
  try {
    if (!navigator.permissions?.query) return "desconhecido";
    const permissao = await navigator.permissions.query({ name: "geolocation" });
    return ["granted", "denied", "prompt"].includes(permissao.state)
      ? permissao.state
      : "desconhecido";
  } catch (erro) {
    console.warn("Não foi possível consultar a permissão de localização:", erro);
    return "desconhecido";
  }
}

function atualizarInterfaceLocalizacao(permissao = null) {
  const botao = document.getElementById("btn-localizacao");
  const botaoMapa = document.getElementById("btn-localizacao-mapa");
  const aviso = document.getElementById("localizacao-status");
  if (!botao || !aviso) return;
  if (!window.isSecureContext) {
    botao.classList.add("oculto");
    botaoMapa?.classList.add("oculto");
    aviso.textContent = "A localização só funciona em HTTPS.";
    const statusMapa = document.getElementById("mapa-status");
    if (statusMapa) statusMapa.textContent = "A localização só funciona em HTTPS.";
    return;
  }
  botao.classList.remove("oculto");
  botaoMapa?.classList.remove("oculto");
  if (permissao === "denied") {
    localizacaoNegada = true;
    aviso.textContent = mensagemErroLocalizacao(1);
    botao.textContent = "Ativar localização";
    botao.classList.remove("localizacao-permitida");
    return;
  }
  if (ultimaPosicao && idWatch !== null) {
    aviso.textContent = `Localização ativa (±${formatarDistancia(Math.round(ultimaPosicao.accuracy))})`;
    botao.textContent = "Atualizar paradas próximas";
    botao.classList.add("localizacao-permitida");
    return;
  }
  botao.textContent = "Ativar localização";
  botao.classList.toggle("localizacao-permitida", permissao === "granted");
  aviso.textContent = permissao === "granted"
    ? "Permissão concedida. Toque para usar sua localização."
    : "";
}

aoMudarLocalizacao(() => atualizarInterfaceLocalizacao());

document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    const deveRetomar = localizacaoAtivadaPeloUsuario;
    pararLocalizacao();
    if (deveRetomar) {
      const aviso = document.getElementById("localizacao-status");
      if (aviso) aviso.textContent = "Localização pausada enquanto o app está em segundo plano.";
    }
    return;
  }
  if (localizacaoAtivadaPeloUsuario && !localizacaoNegada) {
    try {
      ativarLocalizacao();
    } catch (erro) {
      atualizarInterfaceLocalizacao();
      console.warn("Não foi possível retomar a localização:", erro);
    }
  }
});

/* ---------- FAVORITOS (localStorage) ---------- */
const CHAVE_FAVORITOS = "buscwb_favoritos";

function obterFavoritos() {
  try {
    const dados = localStorage.getItem(CHAVE_FAVORITOS);
    const favoritos = dados ? JSON.parse(dados) : [];
    return Array.isArray(favoritos) ? favoritos : [];
  } catch (erro) {
    console.error("Não foi possível ler as linhas favoritas:", erro);
    return [];
  }
}

function salvarFavoritos(lista) {
  try {
    localStorage.setItem(CHAVE_FAVORITOS, JSON.stringify(lista));
  } catch (erro) {
    console.error("Não foi possível salvar as linhas favoritas:", erro);
  }
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
  if (favoritos.includes(idLinha)) preCarregarHorarios(idLinha);
  renderizarSugestoesLinhas(linhasBuscaAtuais);
  renderizarTudo();
}

/* ---------- CHAMADAS À API ---------- */
const PREFIXO_CACHE_API = "buscwb_api_cache_v1:";

function obterChaveCacheApi(url) {
  const consulta = new URL(url);
  if (consulta.pathname.endsWith("/mapa/paradas/proximas")) {
    ["lat", "lng"].forEach((coordenada) => {
      const valor = Number(consulta.searchParams.get(coordenada));
      if (Number.isFinite(valor)) consulta.searchParams.set(coordenada, valor.toFixed(3));
    });
  }
  return `${PREFIXO_CACHE_API}${consulta.toString()}`;
}

function mostrarAvisoDadosSalvos(exibir) {
  const aviso = document.getElementById("aviso-dados-salvos");
  if (!aviso) return;
  aviso.classList.toggle("oculto", !exibir);
  clearTimeout(temporizadorAvisoCache);
  if (exibir) {
    temporizadorAvisoCache = setTimeout(() => aviso.classList.add("oculto"), 5000);
  }
}

function mostrarErroApi(mensagem) {
  const aviso = document.getElementById("aviso-erro");
  aviso.textContent = mensagem;
  aviso.classList.remove("oculto");
  clearTimeout(temporizadorAvisoErro);
  temporizadorAvisoErro = setTimeout(() => aviso.classList.add("oculto"), 6000);
}

async function buscarJsonApi(url) {
  const chaveCache = obterChaveCacheApi(url);
  try {
    const controlador = new AbortController();
    const temporizador = setTimeout(() => controlador.abort(), 4000);
    let resposta;
    try {
      resposta = await fetch(url, { signal: controlador.signal });
    } finally {
      clearTimeout(temporizador);
    }
    if (!resposta.ok && resposta.status !== 503) {
      throw new Error(`A API respondeu HTTP ${resposta.status}.`);
    }
    if (resposta.status === 503) throw new Error("A API está indisponível.");
    const dados = await resposta.json();
    try {
      localStorage.setItem(chaveCache, JSON.stringify(dados));
    } catch (erro) {
      console.warn("Não foi possível guardar esta resposta para uso offline:", erro);
    }
    mostrarAvisoDadosSalvos(resposta.headers.get("X-Dados-Salvos") === "true");
    return dados;
  } catch (erro) {
    if (erro.message.startsWith("A API respondeu HTTP")) throw erro;
    try {
      const salvo = localStorage.getItem(chaveCache);
      if (salvo) {
        mostrarAvisoDadosSalvos(true);
        return JSON.parse(salvo);
      }
    } catch (erroCache) {
      console.error("Não foi possível ler os dados salvos da API:", erroCache);
    }
    throw new Error(`Não foi possível conectar à API e não há dados salvos para esta consulta. ${erro.message}`);
  }
}

async function buscarLinhasNaApi(termoBusca = "") {
  const url = new URL(`${API_BASE_URL}/linhas`);
  if (termoBusca) url.searchParams.set("busca", termoBusca);
  return buscarJsonApi(url.toString());
}

async function buscarHorariosNaApi(idLinha, tipoDia) {
  const url = `${API_BASE_URL}/linhas/${idLinha}/horarios?tipoDia=${tipoDia}`;
  return buscarJsonApi(url);
}

async function preCarregarHorarios(idLinha) {
  await Promise.all(["util", "sabado", "domingo"].map(async (tipoDia) => {
    try {
      await buscarHorariosNaApi(idLinha, tipoDia);
    } catch (erro) {
      console.warn(`Não foi possível pré-carregar horários (${tipoDia}) da linha ${idLinha}:`, erro);
    }
  }));
}
/* ---------- PREVISÃO DE HORÁRIO NAS PARADAS (estimativa) ---------- */
const VELOCIDADE_PADRAO_KMH = 22;
const VELOCIDADE_RAPIDA_KMH = 28;
const FATOR_CURVA = 1.3;
const FATOR_PICO_TRANSITO = 0.80;
const FATOR_MADRUGADA = 1.15;
const FATOR_FIM_DE_SEMANA = 1.05;
// Faixas do pico em dia útil, com início e fim inclusivos (minutos após meia-noite).
const FAIXAS_PICO_UTIL = [
  { inicio: 6 * 60 + 30, fim: 9 * 60 },
  { inicio: 17 * 60, fim: 19 * 60 + 30 },
];
// A madrugada cruza a meia-noite: 23:00 até antes de 05:00.
const INICIO_MADRUGADA = 23 * 60;
const FIM_MADRUGADA = 5 * 60;
// Categorias que recebem a velocidade rápida; ajustar esta lista conforme necessário.
const CATEGORIAS_VELOCIDADE_RAPIDA = [
  "EXPRESSO",
  "LIGEIRAO",
  "LIGEIRINHO",
  "TRONCAL",
  "DIRETA",
];

function fatorTransito(minutoDoDia, tipoDia) {
  if (
    tipoDia === "util" &&
    FAIXAS_PICO_UTIL.some(
      (faixa) => minutoDoDia >= faixa.inicio && minutoDoDia <= faixa.fim
    )
  ) {
    return FATOR_PICO_TRANSITO;
  }
  if (minutoDoDia >= INICIO_MADRUGADA || minutoDoDia < FIM_MADRUGADA) {
    return FATOR_MADRUGADA;
  }
  if (tipoDia === "sabado" || tipoDia === "domingo") {
    return FATOR_FIM_DE_SEMANA;
  }
  return 1;
}

function velocidadeDaLinha(linha) {
  const categoria = String(linha?.categoria_servico || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase();
  return CATEGORIAS_VELOCIDADE_RAPIDA.some((termo) =>
    categoria.includes(termo)
  )
    ? VELOCIDADE_RAPIDA_KMH
    : VELOCIDADE_PADRAO_KMH;
}

function kmEntre(a, b) {
  const raioTerraKm = 6371;
  const radianos = (graus) => (graus * Math.PI) / 180;
  const latitudeA = radianos(Number(a.lat));
  const latitudeB = radianos(Number(b.lat));
  const diferencaLatitude = latitudeB - latitudeA;
  const diferencaLongitude = radianos(Number(b.lng) - Number(a.lng));
  const haversine =
    Math.sin(diferencaLatitude / 2) ** 2 +
    Math.cos(latitudeA) *
      Math.cos(latitudeB) *
      Math.sin(diferencaLongitude / 2) ** 2;
  return 2 * raioTerraKm * Math.asin(Math.min(1, Math.sqrt(haversine)));
}

function minutosAteAsParadas(pontos, velocidadeKmh = VELOCIDADE_PADRAO_KMH) {
  const minutosPorParada = new Map();
  let distanciaAcumulada = 0;

  pontos.forEach((ponto, indice) => {
    if (indice > 0) {
      const anterior = pontos[indice - 1];
      const coordenadasValidas = [anterior, ponto].every(
        (parada) =>
          parada.lat !== null &&
          parada.lat !== "" &&
          parada.lng !== null &&
          parada.lng !== "" &&
          Number.isFinite(Number(parada.lat)) &&
          Number.isFinite(Number(parada.lng))
      );
      if (coordenadasValidas) {
        distanciaAcumulada += kmEntre(anterior, ponto) * FATOR_CURVA;
      }
    }
    minutosPorParada.set(String(ponto.num), (distanciaAcumulada / velocidadeKmh) * 60);
  });

  return minutosPorParada;
}

function agoraCuritiba() {
  const partes = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Sao_Paulo",
    hour: "2-digit",
    minute: "2-digit",
    weekday: "short",
    hourCycle: "h23",
  }).formatToParts(new Date());
  const valor = (tipo) => partes.find((parte) => parte.type === tipo)?.value;
  const hora = Number(valor("hour"));
  const minuto = Number(valor("minute"));
  const diaSemana = valor("weekday");
  const tipoDia =
    diaSemana === "Sat" ? "sabado" : diaSemana === "Sun" ? "domingo" : "util";

  return { minutos: hora * 60 + minuto, tipoDia };
}

function calcularPrevisoes(saidas, minutosAteParada, agora, tipoDia, qtd = 3) {
  return saidas
    .map((saida) => {
      const correspondencia = /^(\d{2}):(\d{2})$/.exec(saida);
      if (!correspondencia) return null;
      const hora = Number(correspondencia[1]);
      const minuto = Number(correspondencia[2]);
      if (hora > 23 || minuto > 59) return null;
      const saidaMin = hora * 60 + minuto;
      const fator = fatorTransito(saidaMin, tipoDia);
      const deslocamento = minutosAteParada / fator;
      return { minutos: Math.round(saidaMin + deslocamento), fator };
    })
    .filter((previsao) =>
      previsao !== null && previsao.minutos >= agora && previsao.minutos < 1440
    )
    .sort((a, b) => a.minutos - b.minutos)
    .slice(0, qtd);
}

function formatarMinuto(minutos) {
  const hora = String(Math.floor(minutos / 60)).padStart(2, "0");
  const minuto = String(minutos % 60).padStart(2, "0");
  return `${hora}:${minuto}`;
}

function proximasPrevisoes(saidas, minutosAteParada, agora, tipoDia, qtd = 3) {
  return calcularPrevisoes(saidas, minutosAteParada, agora, tipoDia, qtd)
    .map((previsao) => formatarMinuto(previsao.minutos));
}

function avisoFatorTransito(fator) {
  if (fator < 1) return "Pico de trânsito";
  if (fator === FATOR_MADRUGADA) return "Madrugada";
  if (fator === FATOR_FIM_DE_SEMANA) return "Fim de semana";
  return "";
}

function obterFatorPrimeiraPrevisao(saidas, minutosAteParada, agora, tipoDia) {
  const primeiraPrevisao = calcularPrevisoes(
    saidas,
    minutosAteParada,
    agora,
    tipoDia,
    1
  )[0];
  return primeiraPrevisao?.fator ?? 1;
}

async function iniciarMapa() {
  const status = document.getElementById("mapa-status");

  if (!window.L) {
    status.textContent = "Não foi possível carregar o mapa.";
    return;
  }

  if (!mapa) {
    mapa = L.map("mapa").setView([-25.4284, -49.2733], 12);
    L.tileLayer("https://{s}.tile.openstreetmap.fr/hot/{z}/{x}/{y}.png", {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> · <a href="https://www.openstreetmap.fr/">OpenStreetMap France (HOT)</a>',
    }).addTo(mapa);
    grupoIda = L.layerGroup().addTo(mapa);
    grupoVolta = L.layerGroup().addTo(mapa);
    rendererParadas = L.canvas({ padding: 0.5 });
    configurarBuscaMapa();
    configurarFiltrosLegenda();
  }

  setTimeout(() => mapa.invalidateSize(), 150);
}

function configurarFiltrosLegenda() {
  [["ida", grupoIda], ["volta", grupoVolta]].forEach(([direcao, grupo]) => {
    const botao = document.getElementById(`btn-leg-${direcao}`);
    botao.addEventListener("click", () => {
      const idaVisivel = document.getElementById("btn-leg-ida").getAttribute("aria-pressed") === "true";
      const voltaVisivel = document.getElementById("btn-leg-volta").getAttribute("aria-pressed") === "true";
      const visivel = botao.getAttribute("aria-pressed") === "true";
      if (visivel && (direcao === "ida" ? !voltaVisivel : !idaVisivel)) {
        document.getElementById("mapa-status").textContent = "Nenhum sentido selecionado";
        return;
      }
      botao.setAttribute("aria-pressed", String(!visivel));
      if (visivel) mapa.removeLayer(grupo);
      else grupo.addTo(mapa);
      document.getElementById("mapa-status").textContent = "";
    });
  });
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
      input.setAttribute("aria-expanded", "false");
      return;
    }

    debounceBuscaMapa = setTimeout(async () => {
      try {
        const linhas = await buscarLinhasNaApi(termo);
        if (requisicaoAtual !== requisicaoBuscaMapa) return;
        linhasBuscaAtuais = linhas.slice(0, 8);
        renderizarSugestoesLinhas(linhasBuscaAtuais);
        sugestoes.classList.remove("oculto");
        input.setAttribute("aria-expanded", "true");
      } catch (erro) {
        if (requisicaoAtual !== requisicaoBuscaMapa) return;
        console.error(erro);
        sugestoes.replaceChildren();
        const vazio = document.createElement("div");
        vazio.className = "sugestao-vazia";
        vazio.textContent = "Não foi possível buscar linhas.";
        sugestoes.appendChild(vazio);
        sugestoes.classList.remove("oculto");
        input.setAttribute("aria-expanded", "true");
      }
    }, 250);
  });
}

function renderizarSugestoesLinhas(linhas) {
  const sugestoes = document.getElementById("mapa-sugestoes");
  if (!sugestoes) return;
  sugestoes.replaceChildren();

  if (!linhas.length) {
    const vazio = document.createElement("div");
    vazio.className = "sugestao-vazia";
    vazio.textContent = "Nenhuma linha encontrada";
    sugestoes.appendChild(vazio);
    return;
  }

  linhas.forEach((linha) => {
    const item = document.createElement("div");
    item.className = "sugestao-linha";
    item.setAttribute("role", "group");

    const selecionar = document.createElement("button");
    selecionar.type = "button";
    selecionar.className = "sugestao";
    selecionar.setAttribute("role", "option");
    selecionar.setAttribute("aria-selected", "false");
    selecionar.textContent = `${linha.numero} · ${linha.nome}`;
    selecionar.addEventListener("click", () => {
      clearTimeout(debounceBuscaMapa);
      requisicaoBuscaMapa += 1;
      document.getElementById("mapa-busca").value = `${linha.numero} · ${linha.nome}`;
      sugestoes.classList.add("oculto");
      document.getElementById("mapa-busca").setAttribute("aria-expanded", "false");
      selecionarLinhaMapa(linha.id, linha);
    });

    const favoritada = ehFavorita(linha.id);
    const estrela = document.createElement("button");
    estrela.type = "button";
    estrela.className = `btn-estrela-card${favoritada ? " favoritado" : ""}`;
    estrela.setAttribute("aria-label", `${favoritada ? "Desfavoritar" : "Favoritar"} linha ${linha.numero}`);
    estrela.setAttribute("aria-pressed", String(favoritada));
    estrela.title = `${favoritada ? "Desfavoritar" : "Favoritar"} linha`;
    estrela.innerHTML = SVG_ESTRELA;
    estrela.addEventListener("click", (evento) => {
      evento.stopPropagation();
      alternarFavorito(linha.id);
    });

    item.append(selecionar, estrela);
    sugestoes.appendChild(item);
  });
}

function normalizarNomePonto(nome) {
  return String(nome || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("pt-BR")
    .replace(/[^a-z0-9]/g, "");
}

function encontrarPontoHorario(direcao, pontos) {
  const origem = normalizarNomePonto(origensRotaPorDirecao[direcao]);
  const encontrado = origem && pontos.find((ponto) => {
    const nome = normalizarNomePonto(ponto.nome);
    return nome === origem || nome.includes(origem) || origem.includes(nome);
  });
  if (encontrado) return encontrado;
  return pontos[direcao === "ida" ? 0 : 1] || pontos[0] || null;
}

async function selecionarLinhaMapa(idLinha, linhaInformada) {
  const linhaAtual =
    linhaInformada ||
    obterLinhaPorId(idLinha) ||
    LINHAS.find((linha) => String(linha.id) === String(idLinha));
  linhaSelecionadaId = idLinha;
  linhaSelecionadaAtual = linhaAtual || null;
  pontoMapaSelecionado = null;
  erroHorariosMapa = false;
  document.getElementById("horarios-vazio").classList.add("oculto");
  document.getElementById("horarios-conteudo").classList.remove("oculto");
  document.getElementById("horarios-numero-linha").textContent = linhaAtual?.numero || "";
  document.getElementById("lista-proximos-horarios").textContent = "Carregando horários...";
  document.getElementById("lista-horarios-modal").replaceChildren();
  const velocidade = velocidadeDaLinha(linhaAtual);
  const status = document.getElementById("mapa-status");
  const legenda = document.getElementById("mapa-legenda");
  const requisicaoAtual = ++requisicaoMapa;
  const requisicaoHorarioAtual = ++requisicaoHorarios;
  grupoIda.clearLayers();
  grupoVolta.clearLayers();
  paradasMapaPorDirecao = { ida: [], volta: [] };
  saidasHorariosMapa = { ida: [], volta: [] };
  nomesPontosHorarioMapa = { ida: "", volta: "" };
  pontosHorarioMapa = { ida: null, volta: null };
  origensRotaPorDirecao = { ida: "", volta: "" };
  grupoIda.addTo(mapa);
  grupoVolta.addTo(mapa);
  ["ida", "volta"].forEach((direcao) => {
    document.getElementById(`btn-leg-${direcao}`).setAttribute("aria-pressed", "true");
  });
  legenda.classList.add("oculto");

  status.textContent = "Carregando trajeto e paradas...";
  try {
    const codigoUrl = encodeURIComponent(idLinha);
    const [respostaShape, respostaPontos] = await Promise.all([
      buscarJsonApi(`${API_BASE_URL}/mapa/linhas/${codigoUrl}/shape`),
      buscarJsonApi(`${API_BASE_URL}/mapa/linhas/${codigoUrl}/pontos`),
    ]);
    const [dadosShape, dadosPontos] = [respostaShape, respostaPontos];
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
    Object.keys(gruposPorDirecao).forEach((direcao) => {
      origensRotaPorDirecao[direcao] =
        gruposPorDirecao[direcao][0]?.pontos[0]?.nome || "";
    });

    let pontosHorarios = [];
    let falhaHorarios = false;
    try {
      const resultadoHorarios = await buscarHorariosNaApi(idLinha, tipoDiaSelecionado);
      pontosHorarios = Array.isArray(resultadoHorarios.pontos)
        ? resultadoHorarios.pontos
        : [];
    } catch (erro) {
      console.error(erro);
      falhaHorarios = true;
    }
    if (requisicaoAtual !== requisicaoMapa) return;
    if (requisicaoHorarioAtual === requisicaoHorarios) {
      pontosLinhaAtual = pontosHorarios;
      erroHorariosMapa = falhaHorarios;
    } else {
      pontosHorarios = pontosLinhaAtual;
    }

    // O endpoint não expõe o sentido de cada quadro; tenta-se casar o terminal e usa-se a ordem como fallback.
    const obterSaidas = (ponto) =>
      (Array.isArray(ponto?.horarios) ? ponto.horarios : [])
        .map((horario) => horario?.hora)
        .filter((hora) => typeof hora === "string");
    pontosHorarioMapa = {
      ida: encontrarPontoHorario("ida", pontosHorarios),
      volta: encontrarPontoHorario("volta", pontosHorarios),
    };
    const saidasIda = obterSaidas(pontosHorarioMapa.ida);
    const pontoSaidaVolta = pontosHorarioMapa.volta;
    const saidasVolta = obterSaidas(pontoSaidaVolta);
    saidasHorariosMapa = { ida: saidasIda, volta: saidasVolta };
    nomesPontosHorarioMapa = {
      ida: pontosHorarioMapa.ida?.nome || "",
      volta: pontoSaidaVolta?.nome || "",
    };
    const offsets = new Map(
      gruposOrdenados.map((grupo) => [
        grupo.itinerario,
        minutosAteAsParadas(grupo.pontos, velocidade),
      ])
    );

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
      const grupo = direcoesTrechos[indice] === "ida" ? grupoIda : grupoVolta;
      L.polyline(trecho.pontos, { color: cores[direcoesTrechos[indice]], weight: 4 }).addTo(grupo);
      limites.push(...trecho.pontos);
    });

    const paradasExibidas = new Set();
    gruposOrdenados.forEach((grupo) => {
      grupo.pontos.forEach((ponto) => {
        const coordenadasValidas = [ponto.lat, ponto.lng].every(
          (valor) => valor !== null && valor !== "" && Number.isFinite(Number(valor))
        );
        if (!coordenadasValidas) return;
        const chaveParada = `${grupo.direcao}:${ponto.num}`;
        if (paradasExibidas.has(chaveParada)) return;
        paradasExibidas.add(chaveParada);

        const minutosAteParada =
          offsets.get(grupo.itinerario)?.get(String(ponto.num)) ?? 0;
        const marcador = L.circleMarker([ponto.lat, ponto.lng], {
          radius: 5,
          fillColor: cores[grupo.direcao],
          color: "#FFFFFF",
          weight: 1.5,
          fillOpacity: 1,
          renderer: rendererParadas,
        });
        paradasMapaPorDirecao[grupo.direcao].push({
          ponto,
          minutosAteParada,
          marcador,
        });
        marcador.on("click", () =>
          selecionarParadaMapa(ponto, grupo.direcao, minutosAteParada, marcador)
        );
        marcador.bindPopup(() => {
            const popup = document.createElement("div");
            const nome = document.createElement("strong");
            nome.textContent = ponto.nome || "Parada";
            popup.append(nome, document.createElement("br"));
            popup.append(
              document.createTextNode(ponto.tipo || "não informado"),
              document.createElement("br"),
              document.createTextNode(
                `${grupo.direcao === "ida" ? "Ida" : "Volta"}: ${ponto.sentido || "não informado"}`
              ),
              document.createElement("br")
            );
            const momentoAtual = agoraCuritiba();
            const previsoes = proximasPrevisoes(
              saidasHorariosMapa[grupo.direcao],
              minutosAteParada,
              momentoAtual.minutos,
              momentoAtual.tipoDia
            );
            if (previsoes.length) {
              const horarios = document.createElement("strong");
              horarios.textContent = `≈ ${previsoes.join(" · ")}`;
              popup.append(horarios, document.createElement("br"));
              const aviso = document.createElement("small");
              aviso.textContent = "Horário estimado, pode variar";
              const avisoVelocidade = document.createElement("small");
              avisoVelocidade.textContent = ` (~${velocidade} km/h)`;
              popup.append(aviso, avisoVelocidade);
              const fatorPrimeiraPrevisao = obterFatorPrimeiraPrevisao(
                saidasHorariosMapa[grupo.direcao],
                minutosAteParada,
                momentoAtual.minutos,
                momentoAtual.tipoDia
              );
              const avisoTransito = avisoFatorTransito(fatorPrimeiraPrevisao);
              if (avisoTransito) {
                const textoTransito = document.createElement("small");
                textoTransito.textContent = ` · ${avisoTransito}`;
                popup.append(textoTransito);
              }
            } else {
              const vazio = document.createElement("small");
              vazio.textContent = "Sem mais previsões hoje";
              popup.append(vazio);
            }
            return popup;
          })
          .addTo(grupo.direcao === "ida" ? grupoIda : grupoVolta);
        limites.push([ponto.lat, ponto.lng]);
      });
    });

    document.getElementById("leg-ida").textContent = `→ ${sentidoIda || "sentido não informado"}`;
    const sentidoVolta = gruposPorDirecao.volta[0]?.sentido;
    document.getElementById("leg-volta").textContent = `→ ${sentidoVolta || "sentido não informado"}`;
    legenda.classList.remove("oculto");
    mapa.invalidateSize();
    if (limites.length) mapa.fitBounds(L.latLngBounds(limites), { padding: [20, 20] });
    const primeiraParada = paradasMapaPorDirecao.ida[0] || paradasMapaPorDirecao.volta[0];
    if (primeiraParada) {
      const direcaoInicial = paradasMapaPorDirecao.ida.length ? "ida" : "volta";
      direcaoSelecionada = direcaoInicial;
      atualizarControleSentido();
      selecionarParadaMapa(
        primeiraParada.ponto,
        direcaoInicial,
        primeiraParada.minutosAteParada,
        primeiraParada.marcador
      );
    } else {
      atualizarPainelHorarios();
    }
    status.textContent = paradasExibidas.size
      ? `${paradasExibidas.size} paradas encontradas.${erroHorariosMapa ? " Não foi possível carregar os horários." : ""}`
      : "Nenhuma parada encontrada para esta linha.";
  } catch (erro) {
    if (requisicaoAtual !== requisicaoMapa) return;
    console.error(erro);
    status.textContent = "Não foi possível carregar o trajeto e as paradas desta linha.";
    document.getElementById("lista-proximos-horarios").textContent =
      "Não foi possível carregar o trajeto desta linha.";
  }
}

/* ---------- PARADAS, LOCALIZAÇÃO E FAVORITOS ---------- */
const CHAVE_PARADAS_FAVORITAS = "buscwb_paradas_favoritas";

function obterParadasFavoritas() {
  try {
    const dados = localStorage.getItem(CHAVE_PARADAS_FAVORITAS);
    const favoritos = dados ? JSON.parse(dados) : [];
    return Array.isArray(favoritos) ? favoritos.map(String) : [];
  } catch (erro) {
    console.error("Não foi possível ler as paradas favoritas:", erro);
    return [];
  }
}

function salvarParadasFavoritas(favoritos) {
  try {
    localStorage.setItem(CHAVE_PARADAS_FAVORITAS, JSON.stringify(favoritos));
  } catch (erro) {
    console.error("Não foi possível salvar as paradas favoritas:", erro);
  }
}

function ehParadaFavorita(num) {
  return obterParadasFavoritas().includes(String(num));
}

function alternarParadaFavorita(num) {
  const numero = String(num);
  let favoritos = obterParadasFavoritas();
  favoritos = favoritos.includes(numero)
    ? favoritos.filter((favorito) => favorito !== numero)
    : [...favoritos, numero];
  salvarParadasFavoritas(favoritos);
  document.querySelectorAll(".btn-favoritar-parada").forEach((botao) => {
    if (botao.dataset.num !== numero) return;
    const favoritada = favoritos.includes(numero);
    botao.classList.toggle("favoritado", favoritada);
    botao.setAttribute("aria-pressed", String(favoritada));
    botao.setAttribute("aria-label", favoritada ? "Remover parada dos favoritos" : "Favoritar parada");
  });
  renderizarFavoritasParadas("lista-paradas-favoritas-inicio", "msg-paradas-favoritas-inicio");
  renderizarFavoritasParadas("lista-paradas-favoritas-tela", "msg-paradas-favoritas-tela");
}

async function buscarParadasNaApi(caminho) {
  return buscarJsonApi(`${API_BASE_URL}/mapa/paradas${caminho}`);
}

function formatarDistancia(distanciaM) {
  if (distanciaM < 1000) return `${distanciaM} m`;
  return `${(distanciaM / 1000).toLocaleString("pt-BR", { maximumFractionDigits: 1 })} km`;
}

async function abrirLinhaPorCodigo(codigo) {
  let linha = obterLinhaPorId(String(codigo));
  if (!linha) {
    try {
      const linhas = await buscarLinhasNaApi(String(codigo));
      linha = linhas.find((item) => String(item.id) === String(codigo)) || linhas[0];
      if (linha && !obterLinhaPorId(linha.id)) LINHAS.push(linha);
    } catch (erro) {
      console.error(erro);
      mostrarErroApi(`Não foi possível abrir os detalhes da linha. ${erro.message}`);
      return;
    }
  }
  if (linha) {
    irParaTela("tela-mapa");
    await iniciarMapa();
    document.getElementById("mapa-busca").value = `${linha.numero} · ${linha.nome}`;
    await selecionarLinhaMapa(linha.id, linha);
  }
  else mostrarErroApi("A linha desta parada não foi encontrada.");
}

function criarChipLinha(codigo) {
  const botao = document.createElement("button");
  botao.type = "button";
  botao.className = "chip-linha";
  botao.textContent = String(codigo);
  botao.setAttribute("aria-label", `Abrir linha ${codigo}`);
  botao.addEventListener("click", () => abrirLinhaPorCodigo(codigo));
  return botao;
}

function criarCardParada(parada, { distanciaM, mostrarMapa = false } = {}) {
  const card = document.createElement("article");
  card.className = "parada-card";
  const info = document.createElement("div");
  info.className = "parada-info";
  const nome = document.createElement("h3");
  nome.textContent = parada.nome || "Parada";
  const detalhe = document.createElement("p");
  detalhe.textContent = [parada.tipo || "Tipo não informado", `Parada ${parada.num}`].join(" · ");
  info.append(nome, detalhe);
  if (Number.isFinite(distanciaM)) {
    const distancia = document.createElement("p");
    distancia.className = "parada-distancia";
    distancia.textContent = formatarDistancia(distanciaM);
    info.appendChild(distancia);
  }
  const chips = document.createElement("div");
  chips.className = "chips-linhas";
  (parada.linhas || []).forEach((linha) => chips.appendChild(criarChipLinha(linha.cod)));
  if (chips.childElementCount) info.appendChild(chips);

  if (mostrarMapa) {
    const botaoMapa = document.createElement("button");
    botaoMapa.type = "button";
    botaoMapa.className = "btn-ver-mapa";
    botaoMapa.textContent = "Ver no mapa";
    botaoMapa.addEventListener("click", () => abrirParadaNoMapa(parada));
    info.appendChild(botaoMapa);
  }

  const acoes = document.createElement("div");
  acoes.className = "parada-acoes";
  const estrela = document.createElement("button");
  estrela.type = "button";
  estrela.className = `btn-favoritar-parada${ehParadaFavorita(parada.num) ? " favoritado" : ""}`;
  estrela.dataset.num = String(parada.num);
  estrela.setAttribute("aria-label", ehParadaFavorita(parada.num) ? "Remover parada dos favoritos" : "Favoritar parada");
  estrela.setAttribute("aria-pressed", String(ehParadaFavorita(parada.num)));
  estrela.innerHTML = SVG_ESTRELA;
  estrela.addEventListener("click", () => alternarParadaFavorita(parada.num));
  acoes.appendChild(estrela);
  card.append(info, acoes);
  return card;
}

async function carregarParadasProximas(localizacao, raio = 500) {
  const container = document.getElementById("lista-paradas-proximas");
  container.replaceChildren();
  if (localizacao.accuracy > 500) {
    const aviso = document.createElement("p");
    aviso.className = "mensagem-vazia";
    aviso.textContent = `Não é possível listar paradas: a localização está muito imprecisa (±${formatarDistancia(Math.round(localizacao.accuracy))}). Ative o GPS/localização precisa do aparelho e tente novamente.`;
    container.appendChild(aviso);
    return;
  }
  if (localizacao.accuracy > 50) {
    const avisoPrecisao = document.createElement("p");
    avisoPrecisao.className = "parada-distancia aviso-localizacao-aproximada";
    avisoPrecisao.textContent = `Localização aproximada (±${formatarDistancia(Math.round(localizacao.accuracy))}); as paradas podem não estar na ordem exata.`;
    container.appendChild(avisoPrecisao);
  }
  const carregando = document.createElement("p");
  carregando.className = "mensagem-vazia";
  carregando.textContent = "Buscando paradas próximas...";
  container.appendChild(carregando);
  try {
    const consulta = new URLSearchParams({
      lat: String(localizacao.lat),
      lng: String(localizacao.lng),
      raio: String(raio),
    });
    const resultado = await buscarParadasNaApi(`/proximas?${consulta}`);
    if (localizacao.accuracy <= 50) container.replaceChildren();
    else container.querySelector(".mensagem-vazia")?.remove();
    if (!resultado.paradas?.length) {
      const aviso = document.createElement("p");
      aviso.className = "mensagem-vazia";
      aviso.textContent = raio < 2000
        ? `Nenhuma parada encontrada em ${formatarDistancia(raio)}.`
        : "Nenhuma parada encontrada em até 2 km da sua localização.";
      container.appendChild(aviso);
      if (raio < 2000) {
        const botao = document.createElement("button");
        botao.type = "button";
        botao.className = "botao-secundario";
        botao.textContent = `Aumentar raio para ${raio === 500 ? "1 km" : "2 km"}`;
        botao.addEventListener("click", () =>
          carregarParadasProximas(localizacao, raio === 500 ? 1000 : 2000)
        );
        container.appendChild(botao);
      }
      return;
    }
    resultado.paradas.slice(0, 10).forEach((parada) =>
      container.appendChild(criarCardParada(parada, {
        distanciaM: parada.distanciaM,
        mostrarMapa: true,
      }))
    );
  } catch (erro) {
    console.error(erro);
    container.replaceChildren();
    const aviso = document.createElement("p");
    aviso.className = "mensagem-vazia";
    aviso.textContent = `Não foi possível carregar as paradas próximas. ${erro.message}`;
    container.appendChild(aviso);
  }
}

async function usarLocalizacaoParaParadas() {
  const container = document.getElementById("lista-paradas-proximas");
  container.replaceChildren();
  const aviso = document.createElement("p");
  aviso.className = "mensagem-vazia";
  aviso.textContent = "Obtendo sua localização...";
  container.appendChild(aviso);
  try {
    ativarLocalizacao();
    const localizacao = await obterPosicao();
    await carregarParadasProximas(localizacao);
  } catch (erro) {
    console.warn("Localização indisponível:", erro);
    aviso.textContent = erro.message;
    if (erro.message.includes("Permissão de localização negada")) {
      atualizarInterfaceLocalizacao("denied");
    }
  }
}

function mostrarLocalizacaoNoMapa(localizacao) {
  if (!mapa) iniciarMapa();
  if (marcadorUsuario) mapa.removeLayer(marcadorUsuario);
  marcadorUsuario = L.circleMarker([localizacao.lat, localizacao.lng], {
    radius: 7,
    color: "#FFFFFF",
    weight: 2,
    fillColor: "#2878D0",
    fillOpacity: 1,
  }).bindPopup(`Você está aqui · precisão aproximada ±${formatarDistancia(Math.round(localizacao.accuracy))}`).addTo(mapa);
  mapa.setView([localizacao.lat, localizacao.lng], 16);
  marcadorUsuario.openPopup();
}

async function centralizarNaMinhaLocalizacao() {
  const status = document.getElementById("mapa-status");
  status.textContent = "Obtendo sua localização...";
  try {
    ativarLocalizacao();
    const localizacao = await obterPosicao();
    mostrarLocalizacaoNoMapa(localizacao);
    status.textContent = "";
  } catch (erro) {
    console.warn("Localização indisponível:", erro);
    status.textContent = erro.message;
    if (erro.message.includes("Permissão de localização negada")) {
      atualizarInterfaceLocalizacao("denied");
    }
  }
}

function abrirParadaNoMapa(parada) {
  irParaTela("tela-mapa");
  setTimeout(() => {
    if (!mapa) return;
    const conteudo = document.createElement("strong");
    conteudo.textContent = String(parada.nome || "Parada");
    if (marcadorParadaSelecionada) mapa.removeLayer(marcadorParadaSelecionada);
    marcadorParadaSelecionada = L.circleMarker([parada.lat, parada.lng], {
      radius: 8,
      color: "#FFFFFF",
      weight: 2,
      fillColor: "#D6B52E",
      fillOpacity: 1,
    }).addTo(mapa);
    marcadorParadaSelecionada.bindPopup(conteudo).openPopup();
    mapa.setView([parada.lat, parada.lng], 17);
    document.getElementById("mapa-status").textContent = `Parada ${parada.num}`;
  }, 180);
}

async function buscarParadasFavoritas() {
  const favoritos = obterParadasFavoritas();
  return Promise.all(favoritos.map(async (num) => {
    try {
      return await buscarParadasNaApi(`/${encodeURIComponent(num)}`);
    } catch (erro) {
      console.error(`Não foi possível carregar a parada favorita ${num}:`, erro);
      return { num, nome: "Parada indisponível", tipo: "", linhas: [] };
    }
  }));
}

async function renderizarFavoritasParadas(idContainer, idMensagem) {
  const container = document.getElementById(idContainer);
  const mensagem = document.getElementById(idMensagem);
  if (!container || !mensagem) return;
  const favoritos = obterParadasFavoritas();
  container.replaceChildren();
  mensagem.classList.toggle("oculto", favoritos.length > 0);
  if (!favoritos.length) return;
  const paradas = await buscarParadasFavoritas();
  if (obterParadasFavoritas().join("|") !== favoritos.join("|")) return;
  paradas.forEach((parada) => container.appendChild(criarCardParada(parada)));
  // TODO: estimar horários exige correlacionar NUM da parada com os pontos de horários da linha.
}

function configurarBuscaParadas() {
  const entrada = document.getElementById("input-busca-paradas");
  const resultados = document.getElementById("resultados-busca-paradas");
  entrada.addEventListener("input", () => {
    clearTimeout(debounceBuscaParadas);
    const requisicaoAtual = ++requisicaoBuscaParadas;
    const consulta = entrada.value.trim();
    resultados.replaceChildren();
    if (consulta.length < 2) return;
    debounceBuscaParadas = setTimeout(async () => {
      try {
        const resposta = await buscarParadasNaApi(`/busca?q=${encodeURIComponent(consulta)}`);
        if (requisicaoAtual !== requisicaoBuscaParadas) return;
        resultados.replaceChildren();
        if (!resposta.paradas?.length) {
          const vazio = document.createElement("p");
          vazio.className = "mensagem-vazia";
          vazio.textContent = "Nenhuma parada encontrada.";
          resultados.appendChild(vazio);
        } else {
          resposta.paradas.forEach((parada) => resultados.appendChild(criarCardParada(parada)));
        }
      } catch (erro) {
        if (requisicaoAtual !== requisicaoBuscaParadas) return;
        console.error(erro);
        const aviso = document.createElement("p");
        aviso.className = "mensagem-vazia";
        aviso.textContent = `Não foi possível buscar paradas. ${erro.message}`;
        resultados.replaceChildren(aviso);
      }
    }, 300);
  });
}

function selecionarAbaBusca(aba) {
  const linhasAtivas = aba === "linhas";
  document.getElementById("aba-linhas").classList.toggle("ativa", linhasAtivas);
  document.getElementById("aba-paradas").classList.toggle("ativa", !linhasAtivas);
  document.getElementById("aba-linhas").setAttribute("aria-selected", String(linhasAtivas));
  document.getElementById("aba-paradas").setAttribute("aria-selected", String(!linhasAtivas));
  document.getElementById("busca-paradas").classList.toggle("oculto", linhasAtivas);
  document.getElementById("secao-favoritos-linhas").classList.toggle("oculto", !linhasAtivas);
  document.getElementById("secao-favoritos-paradas").classList.toggle("oculto", linhasAtivas);
}

/* ---------- FUNÇÕES AUXILIARES ---------- */

function obterLinhaPorId(id) {
  return LINHAS.find((l) => String(l.id) === String(id));
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
      <button class="btn-estrela-card${favoritada ? " favoritado" : ""}"
        aria-label="${favoritada ? "Desfavoritar" : "Favoritar"} linha ${linha.numero}"
        aria-pressed="${favoritada}">
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
    irParaTela("tela-mapa");
    iniciarMapa().then(() => selecionarLinhaMapa(linha.id, linha));
  });

  return item;
}

function renderizarTelaFavoritos() {
  const container = document.getElementById("lista-favoritos-tela");
  const msgVazio = document.getElementById("msg-favoritos-vazio");
  const favoritos = obterFavoritos();

  container.innerHTML = "";

  if (favoritos.length === 0) {
    msgVazio.textContent =
      "Você ainda não favoritou nenhuma linha. Use a estrela em um resultado da busca para adicioná-la aqui.";
    msgVazio.classList.remove("oculto");
    return;
  }

  const linhas = favoritos.map(obterLinhaPorId).filter(Boolean);
  linhas.forEach((linha) => container.appendChild(criarCardLinha(linha)));
  if (linhas.length === 0) {
    msgVazio.textContent = "Não foi possível carregar suas linhas favoritas.";
    msgVazio.classList.remove("oculto");
  } else if (linhas.length < favoritos.length) {
    const aviso = document.createElement("p");
    aviso.className = "mensagem-vazia";
    aviso.textContent = "Não foi possível carregar uma ou mais linhas favoritas.";
    container.appendChild(aviso);
    msgVazio.classList.add("oculto");
  } else {
    msgVazio.classList.add("oculto");
  }
}

async function renderizarTudo() {
  let erroBusca = null;
  try {
    if (!LINHAS_CARREGADAS) {
      LINHAS = await buscarLinhasNaApi();
      LINHAS_CARREGADAS = true;
    }
  } catch (erro) {
    console.error(erro);
    if (!LINHAS_CARREGADAS) LINHAS = [];
    erroBusca = erro;
  }
  renderizarTelaFavoritos();
  renderizarFavoritasParadas("lista-paradas-favoritas-tela", "msg-paradas-favoritas-tela");
  if (erroBusca) {
    document.getElementById("msg-favoritos-vazio").textContent =
      `Não foi possível carregar as linhas favoritas. ${erroBusca.message}`;
  }
}

async function carregarPontosERenderizar() {
  const container = document.getElementById("lista-proximos-horarios");
  if (!linhaSelecionadaId) {
    atualizarPainelHorarios();
    return;
  }
  container.textContent = "Carregando horários...";
  const requisicaoAtual = requisicaoMapa;
  const requisicaoHorarioAtual = ++requisicaoHorarios;
  try {
    const resultado = await buscarHorariosNaApi(
      linhaSelecionadaId,
      tipoDiaSelecionado
    );
    if (
      requisicaoAtual !== requisicaoMapa ||
      requisicaoHorarioAtual !== requisicaoHorarios
    ) return;
    pontosLinhaAtual = resultado.pontos || [];
    erroHorariosMapa = false;
  } catch (erro) {
    if (
      requisicaoAtual !== requisicaoMapa ||
      requisicaoHorarioAtual !== requisicaoHorarios
    ) return;
    console.error(erro);
    pontosLinhaAtual = [];
    erroHorariosMapa = true;
    mostrarErroApi(`Não foi possível carregar os horários. ${erro.message}`);
  }
  const saidas = (ponto) =>
    (Array.isArray(ponto?.horarios) ? ponto.horarios : [])
      .map((horario) => horario?.hora)
      .filter((hora) => typeof hora === "string");
  pontosHorarioMapa = {
    ida: encontrarPontoHorario("ida", pontosLinhaAtual),
    volta: encontrarPontoHorario("volta", pontosLinhaAtual),
  };
  const pontoIda = pontosHorarioMapa.ida;
  const pontoVolta = pontosHorarioMapa.volta;
  saidasHorariosMapa = {
    ida: saidas(pontoIda),
    volta: saidas(pontoVolta),
  };
  nomesPontosHorarioMapa = {
    ida: pontoIda?.nome || "",
    volta: pontoVolta?.nome || "",
  };
  renderizarHorariosDoPontoSelecionado();
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
  const correspondencia = /^(\d{1,2}):(\d{2})$/.exec(String(hora));
  if (!correspondencia) return NaN;
  const horas = Number(correspondencia[1]);
  const minutos = Number(correspondencia[2]);
  return horas <= 47 && minutos <= 59 ? horas * 60 + minutos : NaN;
}

function formatarHoraCircular(minutos) {
  const horario = ((minutos % 1440) + 1440) % 1440;
  return formatarMinuto(horario);
}

function selecionarParadaMapa(ponto, direcao, minutosAteParada, marcador) {
  if (pontoMapaSelecionado?.marcador) {
    pontoMapaSelecionado.marcador.setStyle({
      radius: 5,
      color: "#FFFFFF",
      weight: 1.5,
    });
  }
  pontoMapaSelecionado = { ponto, direcao, minutosAteParada, marcador };
  direcaoSelecionada = direcao;
  if (marcador) marcador.setStyle({ radius: 8, color: "#D6E94B", weight: 3 });
  atualizarControleSentido();
  atualizarPainelHorarios();
}

function atualizarControleSentido() {
  document.querySelectorAll(".sentido-btn").forEach((botao) => {
    const ativo = botao.dataset.sentido === direcaoSelecionada;
    botao.classList.toggle("ativo", ativo);
    botao.setAttribute("aria-pressed", String(ativo));
  });
}

function selecionarSentido(direcao) {
  direcaoSelecionada = direcao;
  const paradas = paradasMapaPorDirecao[direcao];
  if (paradas.length) {
    const paradaAtual = paradas.find((item) =>
      String(item.ponto.num) === String(pontoMapaSelecionado?.ponto.num)
    ) || paradas[0];
    selecionarParadaMapa(
      paradaAtual.ponto,
      direcao,
      paradaAtual.minutosAteParada,
      paradaAtual.marcador
    );
  } else {
    atualizarControleSentido();
    renderizarHorariosDoPontoSelecionado();
  }
}

function atualizarPainelHorarios() {
  if (!linhaSelecionadaId) {
    document.getElementById("horarios-vazio").classList.remove("oculto");
    document.getElementById("horarios-conteudo").classList.add("oculto");
    return;
  }

  document.getElementById("horarios-vazio").classList.add("oculto");
  document.getElementById("horarios-conteudo").classList.remove("oculto");
  const pontoNome = pontoMapaSelecionado?.ponto?.nome || "";
  document.getElementById("nome-ponto-selecionado").textContent = pontoNome
    ? `Parada ${pontoMapaSelecionado.ponto.num || ""} · ${pontoNome}`
    : "Selecione uma parada no mapa";
  renderizarHorariosDoPontoSelecionado();
}

function renderizarHorariosDoPontoSelecionado() {
  const proximos = document.getElementById("lista-proximos-horarios");
  const grade = document.getElementById("lista-horarios-modal");
  const observacao = document.getElementById("horarios-estimativa");
  proximos.replaceChildren();
  grade.replaceChildren();

  const saidas = saidasHorariosMapa[direcaoSelecionada] || [];
  const deslocamento = pontoMapaSelecionado?.direcao === direcaoSelecionada
    ? pontoMapaSelecionado.minutosAteParada
    : 0;
  document.getElementById("horarios-numero-linha").textContent =
    linhaSelecionadaAtual?.numero || "";
  const terminal = nomesPontosHorarioMapa[direcaoSelecionada];
  const paradas = paradasMapaPorDirecao[direcaoSelecionada];
  const origem = terminal ? `Saídas de ${terminal}` : "Horários do sentido selecionado";
  observacao.textContent = pontoMapaSelecionado
    ? `${origem}; chegada estimada na parada.`
    : origem;

  if (erroHorariosMapa) {
    proximos.textContent = "Não foi possível carregar os horários. Tente novamente.";
    return;
  }
  if (!paradas.length) {
    proximos.textContent = "Não há paradas cadastradas neste sentido.";
    return;
  }
  if (!saidas.length) {
    proximos.textContent = "Não há horários cadastrados para este ponto neste tipo de dia.";
    return;
  }

  const { diaSemana, minutos: agora } = agoraEmCuritiba();
  const ehHoje = tipoDiaSelecionado === tipoDiaDeHoje(diaSemana);
  const horarios = saidas
    .map((hora, indice) => {
      const saida = horaParaMinutos(hora);
      if (!Number.isFinite(saida)) return null;
      const chegada = saida + Math.round(deslocamento / fatorTransito(saida, tipoDiaSelecionado));
      return {
        hora,
        indice,
        chegada,
        chegadaSeguinte: ehHoje && chegada < agora
          ? chegada + Math.ceil((agora - chegada) / 1440) * 1440
          : chegada,
        adapt: pontosHorarioMapa[direcaoSelecionada]
          ?.horarios?.find((item) => item.hora === hora)?.adapt,
      };
    })
    .filter(Boolean);

  if (!horarios.length) {
    proximos.textContent = "Nenhum horário válido encontrado.";
    return;
  }

  const ordenar = (a, b) => a.chegadaSeguinte - b.chegadaSeguinte || a.indice - b.indice;
  const proximosDoDia = [...horarios].sort(ordenar).slice(0, 8);
  proximosDoDia.forEach((item, indice) => {
    const chip = document.createElement("div");
    chip.className = `horario-chip horario-proximo${indice === 0 ? " proximo" : ""}`;
    const hora = document.createElement("strong");
    hora.textContent = `${formatarHoraCircular(item.chegadaSeguinte)}${item.adapt === false ? " ♿︎✕" : ""}`;
    chip.appendChild(hora);
    if (indice === 0 && ehHoje) {
      const minutosRestantes = Math.max(0, item.chegadaSeguinte - agora);
      const detalhe = document.createElement("span");
      detalhe.className = "selo-proximo";
      detalhe.textContent = minutosRestantes === 0 ? "agora" : `em ${minutosRestantes} min`;
      chip.appendChild(detalhe);
    } else if (indice === 0) {
      const detalhe = document.createElement("span");
      detalhe.className = "selo-proximo";
      detalhe.textContent = "primeiro horário";
      chip.appendChild(detalhe);
    }
    proximos.appendChild(chip);
  });

  const gradeOrdenada = ehHoje
    ? [...horarios].sort((a, b) => a.chegada - b.chegada || a.indice - b.indice)
    : [...horarios].sort((a, b) => a.chegada - b.chegada || a.indice - b.indice);
  const proximoIndex = ehHoje
    ? gradeOrdenada.findIndex((item) => item.indice === proximosDoDia[0].indice)
    : 0;
  gradeOrdenada.forEach((item, indice) => {
    const chip = document.createElement("span");
    const passado = ehHoje && indice !== proximoIndex && item.chegada < agora && item.chegada < 1440;
    chip.className = `horario-chip${passado ? " passado" : ""}${indice === proximoIndex ? " proximo" : ""}`;
    chip.textContent = `${formatarHoraCircular(item.chegada)}${item.adapt === false ? " ♿︎✕" : ""}`;
    if (indice === proximoIndex) {
      chip.setAttribute("aria-label", `${chip.textContent}, próximo horário`);
      chip.title = "Próximo horário";
    }
    grade.appendChild(chip);
  });
}

/* ---------- NAVEGAÇÃO ENTRE TELAS ---------- */

function irParaTela(idTela) {
  document.querySelectorAll(".tela").forEach((tela) => {
    tela.classList.toggle("ativa", tela.id === idTela);
  });
  if (idTela === "tela-mapa") {
    iniciarMapa();
    setTimeout(() => mapa?.invalidateSize(), 100);
  } else {
    renderizarTudo();
  }
}

function aplicarTema(tema) {
  const escuro = tema === "escuro";
  document.documentElement.dataset.tema = escuro ? "escuro" : "claro";
  document.getElementById("meta-theme-color").setAttribute("content", escuro ? "#08251B" : "#12372A");
  const botao = document.getElementById("btn-tema");
  botao.setAttribute("aria-label", escuro ? "Ativar tema claro" : "Ativar tema escuro");
  botao.title = escuro ? "Ativar modo claro" : "Ativar modo escuro";
  botao.innerHTML = escuro
    ? '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M4.93 4.93l1.42 1.42m11.3 11.3 1.42 1.42M2 12h2m16 0h2M4.93 19.07l1.42-1.42m11.3-11.3 1.42-1.42"/></svg>'
    : '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20.5 15.5A8.5 8.5 0 0 1 8.5 3.5 8.5 8.5 0 1 0 20.5 15.5Z"/></svg>';
}

function atualizarEstadoConexao() {
  const offline = !navigator.onLine;
  document.getElementById("aviso-offline").classList.toggle("oculto", !offline);
}

/* ---------- RECLAMAÇÕES ---------- */
let localizacaoReclamacao = null;
let emailUrbsReclamacao = "";
let textoReclamacaoEmail = "";
let temporizadorBuscaLinhaReclamacao = null;
let requisicaoBuscaLinhaReclamacao = 0;

function definirDataReclamacaoAgora() {
  const agora = new Date();
  agora.setMinutes(agora.getMinutes() - agora.getTimezoneOffset());
  document.getElementById("reclamacao-data").value = agora.toISOString().slice(0, 16);
}

function abrirModalReclamacao(idLinha = null) {
  const formulario = document.getElementById("form-reclamacao");
  formulario.reset();
  localizacaoReclamacao = null;
  textoReclamacaoEmail = "";
  emailUrbsReclamacao = "";
  document.getElementById("reclamacao-mensagem").textContent = "";
  document.getElementById("reclamacao-localizacao-status").textContent = "";
  document.getElementById("reclamacao-copia-status").textContent = "";
  document.getElementById("reclamacao-confirmacao").classList.add("oculto");
  document.getElementById("reclamacao-formulario").classList.remove("oculto");
  document.getElementById("reclamacao-rodape").classList.remove("oculto");
  document.getElementById("btn-enviar-urbs").classList.add("oculto");
  document.getElementById("reclamacao-sugestoes").classList.add("oculto");
  document.getElementById("reclamacao-linha-id").value = "";
  if (idLinha !== null && idLinha !== undefined) {
    const linha = obterLinhaPorId(String(idLinha)) ||
      LINHAS.find((item) => String(item.id) === String(idLinha));
    document.getElementById("reclamacao-linha-id").value = String(idLinha);
    document.getElementById("reclamacao-linha").value = linha
      ? `${linha.numero} - ${linha.nome}`
      : String(idLinha);
  }
  definirDataReclamacaoAgora();
  atualizarContadorDescricao();
  document.getElementById("modal-reclamacao").classList.remove("oculto");
}

function fecharModalReclamacao() {
  document.getElementById("modal-reclamacao").classList.add("oculto");
}

function atualizarContadorDescricao() {
  const descricao = document.getElementById("reclamacao-descricao").value;
  document.getElementById("reclamacao-contador").textContent = `${descricao.length}/500`;
}

function formatarDataReclamacao(valor) {
  if (!valor) return "Não informada";
  const data = new Date(valor);
  return Number.isNaN(data.getTime()) ? "Não informada" : data.toLocaleString("pt-BR");
}

function criarTextoReclamacaoEmail() {
  const campoLinha = document.getElementById("reclamacao-linha");
  const linha = campoLinha.value.trim() || "Não informada";
  const opcoesTipo = document.getElementById("reclamacao-tipo");
  const tipo = opcoesTipo.options[opcoesTipo.selectedIndex].text;
  const data = formatarDataReclamacao(document.getElementById("reclamacao-data").value);
  const parada = document.getElementById("reclamacao-parada").value.trim();
  const local = parada
    ? `Parada ${parada}`
    : localizacaoReclamacao
      ? `Coordenadas: ${localizacaoReclamacao.lat}, ${localizacaoReclamacao.lng}\nMapa: https://maps.google.com/?q=${localizacaoReclamacao.lat},${localizacaoReclamacao.lng}`
      : "Não informado";
  const prefixo = document.getElementById("reclamacao-prefixo").value.trim() || "Não informado";
  const descricao = document.getElementById("reclamacao-descricao").value.trim();
  const completo = [
    `Linha: ${linha}`,
    `Tipo: ${tipo}`,
    `Data e hora: ${data}`,
    `Local: ${local}`,
    `Veículo/prefixo: ${prefixo}`,
    "",
    "Descrição:",
    descricao,
  ].join("\n");
  const caracteres = Array.from(completo);
  return caracteres.length > 1500 ? `${caracteres.slice(0, 1497).join("")}...` : completo;
}

async function enviarReclamacao(evento) {
  evento.preventDefault();
  const botao = document.getElementById("btn-enviar-reclamacao");
  const mensagem = document.getElementById("reclamacao-mensagem");
  const dataCampo = document.getElementById("reclamacao-data").value;
  const corpo = {
    tipo: document.getElementById("reclamacao-tipo").value,
    ocorrido_em: dataCampo ? new Date(dataCampo).toISOString() : undefined,
    linha_id: document.getElementById("reclamacao-linha-id").value || undefined,
    parada_num: document.getElementById("reclamacao-parada").value.trim() || undefined,
    prefixo: document.getElementById("reclamacao-prefixo").value.trim() || undefined,
    descricao: document.getElementById("reclamacao-descricao").value.trim(),
    nome: document.getElementById("reclamacao-nome").value.trim() || undefined,
    site: document.getElementById("reclamacao-site").value,
  };
  if (localizacaoReclamacao) {
    corpo.lat = localizacaoReclamacao.lat;
    corpo.lng = localizacaoReclamacao.lng;
  }
  botao.disabled = true;
  mensagem.textContent = "";
  try {
    const resposta = await fetch(`${API_BASE_URL}/reclamacoes`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(corpo),
    });
    const dados = await resposta.json().catch(() => ({}));
    if (resposta.status === 400) {
      mensagem.textContent = dados.mensagem || "Confira os dados e tente novamente.";
      return;
    }
    if (resposta.status === 429) {
      mensagem.textContent = "Você atingiu o limite de envios. Tente novamente mais tarde.";
      return;
    }
    if (!resposta.ok) {
      mensagem.textContent = "Não foi possível enviar o relato agora. Tente novamente.";
      return;
    }
    textoReclamacaoEmail = criarTextoReclamacaoEmail();
    document.getElementById("reclamacao-formulario").classList.add("oculto");
    document.getElementById("reclamacao-rodape").classList.add("oculto");
    document.getElementById("reclamacao-confirmacao").classList.remove("oculto");
    try {
      const configuracao = await fetch(`${API_BASE_URL}/config`);
      if (configuracao.ok) {
        const dadosConfig = await configuracao.json();
        emailUrbsReclamacao = typeof dadosConfig.emailUrbs === "string"
          ? dadosConfig.emailUrbs
          : "";
      }
    } catch (erroConfig) {
      console.warn("Não foi possível obter o endereço da URBS:", erroConfig);
    }
    document.getElementById("btn-enviar-urbs").classList.toggle(
      "oculto",
      !emailUrbsReclamacao
    );
  } catch (erro) {
    console.error("Falha ao enviar reclamação:", erro);
    mensagem.textContent = "Não foi possível conectar para enviar. Verifique sua conexão e tente novamente.";
  } finally {
    botao.disabled = false;
  }
}

function configurarBuscaLinhaReclamacao() {
  const entrada = document.getElementById("reclamacao-linha");
  const sugestoes = document.getElementById("reclamacao-sugestoes");
  entrada.addEventListener("input", () => {
    document.getElementById("reclamacao-linha-id").value = "";
    clearTimeout(temporizadorBuscaLinhaReclamacao);
    const requisicao = ++requisicaoBuscaLinhaReclamacao;
    const termo = entrada.value.trim();
    sugestoes.replaceChildren();
    if (termo.length < 2) {
      sugestoes.classList.add("oculto");
      return;
    }
    temporizadorBuscaLinhaReclamacao = setTimeout(async () => {
      try {
        const linhas = await buscarLinhasNaApi(termo);
        if (requisicao !== requisicaoBuscaLinhaReclamacao) return;
        sugestoes.replaceChildren();
        linhas.slice(0, 8).forEach((linha) => {
          const botao = document.createElement("button");
          botao.type = "button";
          botao.className = "reclamacao-sugestao";
          botao.textContent = `${linha.numero} - ${linha.nome}`;
          botao.addEventListener("click", () => {
            entrada.value = `${linha.numero} - ${linha.nome}`;
            document.getElementById("reclamacao-linha-id").value = String(linha.id);
            sugestoes.classList.add("oculto");
          });
          sugestoes.appendChild(botao);
        });
        if (!linhas.length) {
          const vazio = document.createElement("p");
          vazio.className = "reclamacao-dica";
          vazio.textContent = "Nenhuma linha encontrada.";
          sugestoes.appendChild(vazio);
        }
        sugestoes.classList.remove("oculto");
      } catch (erro) {
        if (requisicao !== requisicaoBuscaLinhaReclamacao) return;
        console.warn("Não foi possível buscar linhas para a reclamação:", erro);
        sugestoes.replaceChildren();
        const aviso = document.createElement("p");
        aviso.className = "reclamacao-dica";
        aviso.textContent = "Não foi possível buscar linhas agora.";
        sugestoes.appendChild(aviso);
        sugestoes.classList.remove("oculto");
      }
    }, 250);
  });
}

async function usarLocalizacaoNaReclamacao() {
  const status = document.getElementById("reclamacao-localizacao-status");
  status.textContent = "Obtendo sua localização...";
  try {
    ativarLocalizacao();
    const posicao = await obterPosicao();
    localizacaoReclamacao = { lat: posicao.lat, lng: posicao.lng };
    status.textContent = "Localização adicionada ao relato.";
  } catch (erro) {
    status.textContent = erro.message;
  }
}

/* ---------- EVENTOS ---------- */

document.addEventListener("DOMContentLoaded", () => {
  aplicarTema(document.documentElement.dataset.tema || "claro");
  tipoDiaSelecionado = tipoDiaDeHoje(agoraEmCuritiba().diaSemana);
  document.querySelectorAll(".painel-horarios .tipo-dia-btn").forEach((botao) => {
    const ativo = botao.dataset.tipo === tipoDiaSelecionado;
    botao.classList.toggle("ativo", ativo);
    botao.setAttribute("aria-pressed", String(ativo));
  });
  renderizarTudo();
  iniciarMapa();
  configurarBuscaParadas();
  atualizarEstadoConexao();
  window.addEventListener("online", atualizarEstadoConexao);
  window.addEventListener("offline", atualizarEstadoConexao);

  document.getElementById("btn-tema").addEventListener("click", () => {
    const proximoTema = document.documentElement.dataset.tema === "escuro" ? "claro" : "escuro";
    try {
      localStorage.setItem("buscwb_tema", proximoTema);
    } catch (erro) {
      console.error("Não foi possível salvar a preferência de tema:", erro);
    }
    aplicarTema(proximoTema);
  });
  document.getElementById("btn-favoritos").addEventListener("click", () => irParaTela("tela-favoritos"));
  document.getElementById("btn-fechar-favoritos").addEventListener("click", () => irParaTela("tela-mapa"));
  document.getElementById("btn-reclamar").addEventListener("click", () => abrirModalReclamacao());
  document.getElementById("btn-fechar-reclamacao").addEventListener("click", fecharModalReclamacao);
  document.getElementById("modal-reclamacao").addEventListener("click", (evento) => {
    if (evento.target.id === "modal-reclamacao") fecharModalReclamacao();
  });
  document.getElementById("form-reclamacao").addEventListener("submit", enviarReclamacao);
  document.getElementById("reclamacao-descricao").addEventListener("input", atualizarContadorDescricao);
  document.getElementById("btn-localizacao-reclamacao").addEventListener("click", usarLocalizacaoNaReclamacao);
  configurarBuscaLinhaReclamacao();
  document.getElementById("btn-enviar-urbs").addEventListener("click", () => {
    if (!emailUrbsReclamacao) return;
    const idLinha = document.getElementById("reclamacao-linha-id").value;
    const linhaSelecionada = idLinha && (
      obterLinhaPorId(idLinha) ||
      LINHAS.find((item) => String(item.id) === String(idLinha))
    );
    const linha = linhaSelecionada
      ? linhaSelecionada.numero
      : document.getElementById("reclamacao-linha").value.trim() || "sem linha";
    const campoTipo = document.getElementById("reclamacao-tipo");
    const tipo = campoTipo.options[campoTipo.selectedIndex].text;
    const assunto = `Reclamação - Linha ${linha} - ${tipo}`;
    const email = encodeURIComponent(emailUrbsReclamacao).replace(/%40/gi, "@");
    window.location.href = `mailto:${email}?subject=${encodeURIComponent(assunto)}&body=${encodeURIComponent(textoReclamacaoEmail)}`;
  });
  document.getElementById("btn-copiar-reclamacao").addEventListener("click", async () => {
    const status = document.getElementById("reclamacao-copia-status");
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(textoReclamacaoEmail);
      } else {
        const campo = document.createElement("textarea");
        campo.value = textoReclamacaoEmail;
        campo.style.position = "fixed";
        campo.style.opacity = "0";
        document.body.appendChild(campo);
        campo.select();
        const copiado = document.execCommand("copy");
        campo.remove();
        if (!copiado) throw new Error("Não foi possível copiar.");
      }
      status.textContent = "Texto copiado.";
    } catch (erro) {
      status.textContent = "Não foi possível copiar o texto neste aparelho.";
    }
  });

  document.getElementById("aba-linhas").addEventListener("click", () => selecionarAbaBusca("linhas"));
  document.getElementById("aba-paradas").addEventListener("click", () => selecionarAbaBusca("paradas"));
  document.getElementById("btn-localizacao").addEventListener("click", usarLocalizacaoParaParadas);
  document.getElementById("btn-localizacao-mapa").addEventListener("click", centralizarNaMinhaLocalizacao);
  if (!window.isSecureContext) {
    atualizarInterfaceLocalizacao();
  } else {
    estadoPermissao().then((permissao) => atualizarInterfaceLocalizacao(permissao));
  }

  const inputBusca = document.getElementById("mapa-busca");
  inputBusca.addEventListener("keydown", (evento) => {
    if (evento.key === "Enter") {
      evento.preventDefault();
      inputBusca.dispatchEvent(new Event("input", { bubbles: true }));
    }
  });

  document.getElementById("btn-buscar").addEventListener("click", () => {
    inputBusca.dispatchEvent(new Event("input", { bubbles: true }));
    inputBusca.blur();
  });

  document.querySelectorAll(".painel-horarios .tipo-dia-btn[data-tipo]").forEach((botao) => {
    botao.addEventListener("click", () => {
      tipoDiaSelecionado = botao.dataset.tipo;
      document.querySelectorAll(".painel-horarios .tipo-dia-btn[data-tipo]").forEach((b) => {
        const ativo = b === botao;
        b.classList.toggle("ativo", ativo);
        b.setAttribute("aria-pressed", String(ativo));
      });
      carregarPontosERenderizar();
    });
  });

  document.querySelectorAll(".sentido-btn").forEach((botao) => {
    botao.addEventListener("click", () => selecionarSentido(botao.dataset.sentido));
  });

  document.querySelectorAll(".nav-item").forEach((item) => {
    item.addEventListener("click", () => irParaTela(item.dataset.tela));
  });

  const botaoInstalar = document.getElementById("btn-instalar-app");
  const dicaIOS = document.getElementById("dica-ios");
  const ehIOS = /iphone|ipad|ipod/i.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  let promptInstalacao = null;

  if (ehIOS && !navigator.standalone) {
    dicaIOS.classList.remove("oculto");
    botaoInstalar.classList.add("oculto");
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
    dicaIOS.classList.add("oculto");
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
