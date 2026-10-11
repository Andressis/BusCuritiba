const API_BASE_URL = "https://api.buscwb.com.br/api";

/* ---------- ESTADO DA APLICAÇÃO ---------- */
let LINHAS = []; // cache local das linhas carregadas da API
let LINHAS_EXIBIDAS = [];
let LINHAS_CARREGADAS = false;
let linhaSelecionadaId = null;
let tipoDiaSelecionado = "util"; // util | sabado | domingo
let pontosLinhaAtual = []; // [{ nome, horarios: [{hora, adapt}] }]
let pontoSelecionado = null;
let mapa = null;
let grupoIda = null;
let grupoVolta = null;
let marcadorUsuario = null;
let marcadorParadaSelecionada = null;
let ultimaLocalizacao = null;
let requisicaoMapa = 0;
let debounceBuscaMapa = null;
let requisicaoBuscaMapa = 0;
let debounceBuscaParadas = null;
let requisicaoBuscaParadas = 0;
let temporizadorAvisoCache = null;
let temporizadorAvisoErro = null;

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
              selecionarLinhaMapa(linha.id, linha);
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

async function selecionarLinhaMapa(idLinha, linhaInformada) {
  const linhaAtual =
    linhaInformada ||
    obterLinhaPorId(idLinha) ||
    LINHAS.find((linha) => String(linha.id) === String(idLinha));
  const velocidade = velocidadeDaLinha(linhaAtual);
  const status = document.getElementById("mapa-status");
  const legenda = document.getElementById("mapa-legenda");
  const requisicaoAtual = ++requisicaoMapa;
  grupoIda.clearLayers();
  grupoVolta.clearLayers();
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

    const { minutos: agora, tipoDia } = agoraCuritiba();
    let pontosHorarios = [];
    let erroHorarios = false;
    try {
      const resultadoHorarios = await buscarHorariosNaApi(idLinha, tipoDia);
      pontosHorarios = Array.isArray(resultadoHorarios.pontos)
        ? resultadoHorarios.pontos
        : [];
    } catch (erro) {
      console.error(erro);
      erroHorarios = true;
    }
    if (requisicaoAtual !== requisicaoMapa) return;

    // SUPOSIÇÃO: 1º ponto = saída da ida, 2º = saída da volta; é um palpite a validar.
    const obterSaidas = (ponto) =>
      (Array.isArray(ponto?.horarios) ? ponto.horarios : [])
        .map((horario) => horario?.hora)
        .filter((hora) => typeof hora === "string");
    const saidasIda = obterSaidas(pontosHorarios[0]);
    const pontoSaidaVolta = pontosHorarios[1] || pontosHorarios[0];
    const saidasVolta = obterSaidas(pontoSaidaVolta);
    const saidasPorDirecao = { ida: saidasIda, volta: saidasVolta };
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
        const chaveParada = `${grupo.direcao}:${ponto.num}`;
        if (paradasExibidas.has(chaveParada)) return;
        paradasExibidas.add(chaveParada);

        L.circleMarker([ponto.lat, ponto.lng], {
          radius: 5,
          fillColor: cores[grupo.direcao],
          color: "#FFFFFF",
          weight: 1.5,
          fillOpacity: 1,
        })
          .bindPopup(() => {
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
            const minutosAteParada =
              offsets.get(grupo.itinerario)?.get(String(ponto.num)) ?? 0;
            const previsoes = proximasPrevisoes(
              saidasPorDirecao[grupo.direcao],
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
                saidasPorDirecao[grupo.direcao],
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
    status.textContent = paradasExibidas.size
      ? `${paradasExibidas.size} paradas encontradas.${erroHorarios ? " Não foi possível carregar os horários." : ""}`
      : "Nenhuma parada encontrada para esta linha.";
  } catch (erro) {
    if (requisicaoAtual !== requisicaoMapa) return;
    console.error(erro);
    status.textContent = "Não foi possível carregar o trajeto e as paradas desta linha.";
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
  if (linha) abrirModalLinha(linha.id);
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

function obterLocalizacaoUsuario() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(new Error("Este aparelho não oferece serviço de localização."));
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (posicao) => {
        ultimaLocalizacao = {
          lat: posicao.coords.latitude,
          lng: posicao.coords.longitude,
          accuracy: posicao.coords.accuracy,
        };
        if (
          !Number.isFinite(ultimaLocalizacao.lat) ||
          !Number.isFinite(ultimaLocalizacao.lng) ||
          !Number.isFinite(ultimaLocalizacao.accuracy)
        ) {
          reject(new Error("O aparelho retornou coordenadas de localização inválidas."));
          return;
        }
        resolve(ultimaLocalizacao);
      },
      (erro) => {
        const mensagens = {
          1: "Permissão de localização negada. Autorize o acesso nas configurações do navegador.",
          2: "Não foi possível determinar sua localização. Verifique o sinal e tente novamente.",
          3: "A localização demorou mais que 10 segundos. Tente novamente.",
        };
        reject(new Error(mensagens[erro.code] || "Não foi possível obter sua localização."));
      },
      { enableHighAccuracy: true, maximumAge: 0, timeout: 10000 }
    );
  });
}

async function carregarParadasProximas(localizacao, raio = 500) {
  const container = document.getElementById("lista-paradas-proximas");
  container.replaceChildren();
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
    container.replaceChildren();
    const precisao = document.createElement("p");
    precisao.className = "parada-distancia";
    precisao.textContent = `Precisão aproximada da localização: ±${formatarDistancia(Math.round(localizacao.accuracy))}.`;
    container.appendChild(precisao);
    if (!resultado.paradas?.length) {
      const aviso = document.createElement("p");
      aviso.className = "mensagem-vazia";
      aviso.textContent = localizacao.accuracy > 100
        ? `Nenhuma parada encontrada em ${formatarDistancia(raio)}. A localização recebida tem precisão limitada; ative a localização precisa/GPS do aparelho e tente novamente.`
        : raio < 2000
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
    const localizacao = await obterLocalizacaoUsuario();
    await carregarParadasProximas(localizacao);
  } catch (erro) {
    console.warn("Localização indisponível:", erro);
    aviso.textContent = erro.message;
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
    const localizacao = await obterLocalizacaoUsuario();
    mostrarLocalizacaoNoMapa(localizacao);
    status.textContent = "";
  } catch (erro) {
    console.warn("Localização indisponível:", erro);
    status.textContent = erro.message;
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
  document.getElementById("busca-linhas-container").classList.toggle("oculto", !linhasAtivas);
  document.getElementById("busca-paradas").classList.toggle("oculto", linhasAtivas);
  document.getElementById("secao-linhas-favoritas").classList.toggle("oculto", !linhasAtivas);
  document.getElementById("secao-resultados-linhas").classList.toggle("oculto", !linhasAtivas);
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

  if (LINHAS_EXIBIDAS.length === 0) {
    msgVazio.classList.remove("oculto");
  } else {
    msgVazio.classList.add("oculto");
    LINHAS_EXIBIDAS.forEach((linha) => container.appendChild(criarCardLinha(linha)));
  }
}

function renderizarFavoritas() {
  const container = document.getElementById("lista-favoritas");
  const msgSemFavoritas = document.getElementById("msg-sem-favoritas");
  const favoritos = obterFavoritos();

  container.innerHTML = "";

  if (favoritos.length === 0) {
    msgSemFavoritas.textContent =
      "Você ainda não tem linhas favoritas. Toque na estrela de uma linha para adicionar.";
    container.appendChild(msgSemFavoritas);
    msgSemFavoritas.classList.remove("oculto");
    return;
  }

  const linhas = favoritos.map(obterLinhaPorId).filter(Boolean);
  linhas.forEach((linha) => container.appendChild(criarCardLinha(linha)));
  if (linhas.length < favoritos.length) {
    msgSemFavoritas.textContent = "Não foi possível carregar uma ou mais linhas favoritas.";
    container.appendChild(msgSemFavoritas);
    msgSemFavoritas.classList.remove("oculto");
  }
}

function renderizarTelaFavoritos() {
  const container = document.getElementById("lista-favoritos-tela");
  const msgVazio = document.getElementById("msg-favoritos-vazio");
  const favoritos = obterFavoritos();

  container.innerHTML = "";

  if (favoritos.length === 0) {
    msgVazio.textContent =
      "Você ainda não favoritou nenhuma linha. Vá até Início e toque na estrela de uma linha para adicioná-la aqui.";
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
  const termo = document.getElementById("input-busca").value;
  let erroBusca = null;
  try {
    if (!LINHAS_CARREGADAS) {
      LINHAS = await buscarLinhasNaApi();
      LINHAS_CARREGADAS = true;
    }
    LINHAS_EXIBIDAS = termo ? await buscarLinhasNaApi(termo) : LINHAS;
  } catch (erro) {
    console.error(erro);
    if (!LINHAS_CARREGADAS) LINHAS = [];
    LINHAS_EXIBIDAS = [];
    erroBusca = erro;
  }
  renderizarListaLinhas();
  if (erroBusca) {
    document.getElementById("msg-sem-resultado").textContent =
      `Não foi possível carregar as linhas. ${erroBusca.message}`;
  } else {
    document.getElementById("msg-sem-resultado").textContent =
      "Nenhuma linha encontrada para essa busca.";
  }
  renderizarFavoritas();
  renderizarTelaFavoritos();
  renderizarFavoritasParadas("lista-paradas-favoritas-inicio", "msg-paradas-favoritas-inicio");
  renderizarFavoritasParadas("lista-paradas-favoritas-tela", "msg-paradas-favoritas-tela");
}

/* ---------- MODAL DE DETALHES DA LINHA ---------- */

async function abrirModalLinha(idLinha) {
  let linha = obterLinhaPorId(idLinha);
  if (!linha) {
    try {
      const linhas = await buscarLinhasNaApi(String(idLinha));
      linha = linhas.find((item) => String(item.id) === String(idLinha));
      if (linha) LINHAS.push(linha);
    } catch (erro) {
      console.error(erro);
      mostrarErroApi(`Não foi possível carregar os detalhes da linha. ${erro.message}`);
      return;
    }
  }
  if (!linha) {
    mostrarErroApi("Linha não encontrada.");
    return;
  }

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

  let erroCarregamento = null;
  try {
    const resultado = await buscarHorariosNaApi(
      linhaSelecionadaId,
      tipoDiaSelecionado
    );
    pontosLinhaAtual = resultado.pontos || [];
  } catch (erro) {
    console.error(erro);
    pontosLinhaAtual = [];
    erroCarregamento = erro;
  }

  if (pontosLinhaAtual.length === 0) {
    document.getElementById("seletor-ponto-wrapper").classList.add("oculto");
    const aviso = document.createElement("p");
    aviso.className = "mensagem-vazia";
    aviso.textContent = erroCarregamento
      ? `Não foi possível carregar os horários. ${erroCarregamento.message}`
      : "Esta linha não opera nesse tipo de dia.";
    container.replaceChildren(aviso);
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

function aplicarTema(tema) {
  const escuro = tema === "escuro";
  document.documentElement.dataset.tema = escuro ? "escuro" : "claro";
  document.getElementById("meta-theme-color").setAttribute("content", escuro ? "#08251B" : "#12372A");
  const botao = document.getElementById("btn-tema");
  botao.setAttribute("aria-label", escuro ? "Ativar tema claro" : "Ativar tema escuro");
  botao.innerHTML = escuro
    ? '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M4.93 4.93l1.42 1.42m11.3 11.3 1.42 1.42M2 12h2m16 0h2M4.93 19.07l1.42-1.42m11.3-11.3 1.42-1.42"/></svg>'
    : '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20.5 15.5A8.5 8.5 0 0 1 8.5 3.5 8.5 8.5 0 1 0 20.5 15.5Z"/></svg>';
}

function atualizarEstadoConexao() {
  const offline = !navigator.onLine;
  document.getElementById("aviso-offline").classList.toggle("oculto", !offline);
}

/* ---------- EVENTOS ---------- */

document.addEventListener("DOMContentLoaded", () => {
  aplicarTema(document.documentElement.dataset.tema || "claro");
  renderizarTudo();
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

  document.getElementById("aba-linhas").addEventListener("click", () => selecionarAbaBusca("linhas"));
  document.getElementById("aba-paradas").addEventListener("click", () => selecionarAbaBusca("paradas"));
  document.getElementById("btn-localizacao").addEventListener("click", usarLocalizacaoParaParadas);
  document.getElementById("btn-localizacao-mapa").addEventListener("click", centralizarNaMinhaLocalizacao);

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
