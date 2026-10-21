const API_ADMINISTRACAO = "https://api.buscwb.com.br/api/admin";
const CHAVE_TOKEN_ADMINISTRACAO = "buscwb_token_administracao";
let tokenAdministracao = sessionStorage.getItem(CHAVE_TOKEN_ADMINISTRACAO) || "";
let paginaAtual = 1;
let idsLinhasEmpresas = new Set();

function mostrarMensagem(texto, erro = false) {
  const mensagem = document.getElementById("mensagem-administracao");
  mensagem.textContent = texto;
  mensagem.classList.toggle("erro", erro);
}

async function requisitarAdministracao(caminho, opcoes = {}) {
  const cabecalhos = new Headers(opcoes.headers || {});
  cabecalhos.set("Authorization", `Bearer ${tokenAdministracao}`);
  if (opcoes.body !== undefined) cabecalhos.set("Content-Type", "application/json");
  let resposta;
  try {
    resposta = await fetch(`${API_ADMINISTRACAO}${caminho}`, { ...opcoes, headers: cabecalhos });
  } catch {
    throw new Error("Não foi possível conectar à administração. Verifique sua conexão.");
  }
  const dados = await resposta.json().catch(() => ({}));
  if (resposta.status === 401) {
    encerrarSessao();
    throw new Error("Sessão encerrada. Entre novamente.");
  }
  if (!resposta.ok) throw new Error(dados.mensagem || "Não foi possível concluir a operação.");
  return dados;
}

function encerrarSessao() {
  tokenAdministracao = "";
  sessionStorage.removeItem(CHAVE_TOKEN_ADMINISTRACAO);
  document.getElementById("painel-administracao").classList.add("oculto");
  document.getElementById("tela-login").classList.remove("oculto");
  document.getElementById("btn-sair").classList.add("oculto");
}

function criarElemento(nome, texto, classe) {
  const elemento = document.createElement(nome);
  if (texto !== undefined && texto !== null) elemento.textContent = String(texto);
  if (classe) elemento.className = classe;
  return elemento;
}

function trocarAba(nome) {
  document.querySelectorAll(".aba").forEach((botao) => {
    botao.classList.toggle("ativa", botao.dataset.aba === nome);
  });
  ["reclamacoes", "painel", "empresas"].forEach((secao) => {
    document.getElementById(`secao-${secao}`).classList.toggle("oculto", secao !== nome);
  });
}

function criarAcao(texto, acao) {
  const botao = criarElemento("button", texto, "acao-reclamacao");
  botao.type = "button";
  botao.addEventListener("click", acao);
  return botao;
}

async function executarAcaoAdmin(acao) {
  try {
    await acao();
  } catch (erro) {
    mostrarMensagem(erro.message, true);
  }
}

function rotuloTipo(tipo) {
  const rotulos = {
    atraso: "Atraso",
    lotado: "Ônibus lotado",
    motorista: "Conduta de motorista",
    veiculo_sujo_defeito: "Veículo sujo ou com defeito",
    acessibilidade: "Acessibilidade",
    infraestrutura: "Infraestrutura",
    outro: "Outro",
  };
  return rotulos[tipo] || tipo;
}

async function carregarReclamacoes() {
  const parametros = new URLSearchParams({ pagina: String(paginaAtual) });
  const status = document.getElementById("filtro-status").value;
  const linha = document.getElementById("filtro-linha").value.trim();
  const empresa = document.getElementById("filtro-empresa").value.trim();
  if (status) parametros.set("status", status);
  if (linha) parametros.set("linha", linha);
  if (empresa) parametros.set("empresa", empresa);
  const dados = await requisitarAdministracao(`/reclamacoes?${parametros}`);
  const lista = document.getElementById("lista-reclamacoes");
  lista.replaceChildren();
  dados.reclamacoes.forEach((reclamacao) => {
    const cartao = criarElemento("article", null, "cartao-reclamacao");
    cartao.appendChild(criarElemento("h3", `#${reclamacao.id} · ${reclamacao.linha_id || "Sem linha"} · ${rotuloTipo(reclamacao.tipo)}`));
    cartao.appendChild(criarElemento("p", reclamacao.descricao));
    const campos = [
      `Status: ${reclamacao.status}`,
      `Data: ${reclamacao.ocorrido_em || reclamacao.criada_em || "Não informada"}`,
      `Empresa: ${reclamacao.empresa || `possíveis: ${reclamacao.empresas_possiveis || "Indefinida"}`}`,
      `Prefixo: ${reclamacao.prefixo || "Não informado"}${reclamacao.servico_veiculo ? ` · ${reclamacao.servico_veiculo}` : ""}`,
      `Parada: ${reclamacao.parada_num || "Não informada"}`,
      reclamacao.lat !== null && reclamacao.lng !== null ? `Coordenadas: ${reclamacao.lat}, ${reclamacao.lng}` : "",
      `Nome: ${reclamacao.nome || "Não informado"}`,
      reclamacao.marcada ? "Marcada para revisão" : "",
    ].filter(Boolean);
    cartao.appendChild(criarElemento("p", campos.join(" · "), "metadados"));
    const acoes = criarElemento("div", null, "acoes-reclamacao");
    [
      ["Aprovar", "aprovada"],
      ["Rejeitar", "rejeitada"],
      ["Marcar como encaminhada", "encaminhada"],
    ].forEach(([texto, novoStatus]) => {
      acoes.appendChild(criarAcao(texto, async () => {
        await executarAcaoAdmin(async () => {
          await requisitarAdministracao(`/reclamacoes/${encodeURIComponent(reclamacao.id)}`, {
            method: "PATCH",
            body: JSON.stringify({ status: novoStatus }),
          });
          await carregarReclamacoes();
        });
      }));
    });
    acoes.appendChild(criarAcao("Excluir", async () => {
      await executarAcaoAdmin(async () => {
        if (!window.confirm("Excluir esta reclamação?")) return;
        await requisitarAdministracao(`/reclamacoes/${encodeURIComponent(reclamacao.id)}`, { method: "DELETE" });
        await carregarReclamacoes();
      });
    }));
    cartao.appendChild(acoes);
    lista.appendChild(cartao);
  });
  if (!dados.reclamacoes.length) lista.appendChild(criarElemento("p", "Nenhuma reclamação encontrada.", "cartao"));
  document.getElementById("pagina-atual").textContent = `Página ${dados.pagina} · ${dados.total} relatos`;
  document.getElementById("pagina-anterior").disabled = paginaAtual <= 1;
  document.getElementById("pagina-proxima").disabled = paginaAtual * dados.porPagina >= dados.total;
}

function preencherTabela(id, cabecalhos, linhas) {
  const container = document.getElementById(id);
  container.replaceChildren();
  const tabela = criarElemento("table", null, "tabela-resumo");
  const cabecalho = document.createElement("thead");
  const linhaCabecalho = document.createElement("tr");
  cabecalhos.forEach((campo) => linhaCabecalho.appendChild(criarElemento("th", campo)));
  cabecalho.appendChild(linhaCabecalho);
  tabela.appendChild(cabecalho);
  const corpo = document.createElement("tbody");
  linhas.forEach((linha) => {
    const tr = document.createElement("tr");
    cabecalhos.forEach((campo) => tr.appendChild(criarElemento("td", linha[campo])));
    corpo.appendChild(tr);
  });
  tabela.appendChild(corpo);
  if (!linhas.length) container.appendChild(criarElemento("p", "Sem dados no período.", "metadados"));
  else container.appendChild(tabela);
}

function rotuloTipoPlural(tipo) {
  const rotulos = {
    atraso: "atrasos",
    lotado: "ônibus lotados",
    motorista: "condutas de motorista",
    veiculo_sujo_defeito: "veículos sujos ou com defeito",
    acessibilidade: "acessibilidade",
    infraestrutura: "infraestrutura",
    outro: "outros",
  };
  return rotulos[tipo] || rotuloTipo(tipo).toLocaleLowerCase("pt-BR");
}

function criarCelulaTotalLinha(item, indice) {
  const celula = document.createElement("td");
  const detalhes = Object.entries(item.por_tipo || {})
    .filter(([, total]) => Number(total) > 0)
    .map(([tipo, total]) => `${total} ${rotuloTipoPlural(tipo)}`);
  const resumo = detalhes.length
    ? detalhes.join(", ")
    : "Detalhamento por tipo indisponível";
  const indicador = criarElemento("span", item.total, "total-com-detalhes");
  const identificador = `detalhes-linha-${indice}`;
  indicador.tabIndex = 0;
  indicador.setAttribute("role", "img");
  indicador.setAttribute("aria-label", `Total de ${item.total} relatos. ${resumo}.`);
  indicador.setAttribute("aria-describedby", identificador);
  const dica = criarElemento("span", resumo, "dica-detalhes-linha");
  dica.id = identificador;
  dica.setAttribute("role", "tooltip");
  indicador.appendChild(dica);
  celula.appendChild(indicador);
  return celula;
}

function preencherTabelaLinhas(linhas) {
  const container = document.getElementById("painel-linhas");
  container.replaceChildren();
  if (!linhas.length) {
    container.appendChild(criarElemento("p", "Sem dados no período.", "metadados"));
    return;
  }
  const tabela = document.createElement("table");
  tabela.className = "tabela-resumo";
  const cabecalho = document.createElement("thead");
  const linhaCabecalho = document.createElement("tr");
  ["Linha", "Relatos", "Aprovadas"].forEach((titulo) => {
    linhaCabecalho.appendChild(criarElemento("th", titulo));
  });
  cabecalho.appendChild(linhaCabecalho);
  tabela.appendChild(cabecalho);
  const corpo = document.createElement("tbody");
  linhas.forEach((item, indice) => {
    const linha = document.createElement("tr");
    linha.appendChild(criarElemento("td", item.linha_id));
    linha.appendChild(criarCelulaTotalLinha(item, indice));
    linha.appendChild(criarElemento("td", item.aprovadas));
    corpo.appendChild(linha);
  });
  tabela.appendChild(corpo);
  container.appendChild(tabela);
}

async function carregarPainel() {
  const dados = await requisitarAdministracao("/painel");
  document.getElementById("total-30-dias").textContent = `Total de relatos nos últimos 30 dias: ${dados.ultimos_30_dias}`;
  preencherTabelaLinhas(dados.linhas);
  preencherTabela("painel-empresas", ["empresa", "total"], dados.empresas.map((item) => ({
    empresa: item.empresa, total: item.total,
  })));
  preencherTabela("painel-tipos", ["tipo", "total"], dados.tipos.map((item) => ({
    tipo: rotuloTipo(item.tipo), total: item.total,
  })));
}

function campoLinhaEmpresa(empresa, posicao) {
  const linha = criarElemento("div", null, "linha-empresa");
  const entradaLinha = document.createElement("input");
  entradaLinha.value = empresa.linha_id;
  entradaLinha.maxLength = 20;
  entradaLinha.setAttribute("aria-label", "Código da linha");
  const entradaEmpresa = document.createElement("input");
  entradaEmpresa.value = empresa.empresa;
  entradaEmpresa.maxLength = 150;
  entradaEmpresa.setAttribute("aria-label", "Empresa");
  const entradaConsorcio = document.createElement("input");
  entradaConsorcio.value = empresa.consorcio || "";
  entradaConsorcio.maxLength = 150;
  entradaConsorcio.setAttribute("aria-label", "Consórcio");
  const remover = criarElemento("button", "Remover");
  remover.type = "button";
  remover.addEventListener("click", () => linha.remove());
  linha.dataset.posicao = String(posicao);
  linha.append(entradaLinha, entradaEmpresa, entradaConsorcio, remover);
  return linha;
}

async function carregarEmpresas() {
  const dados = await requisitarAdministracao("/empresas");
  idsLinhasEmpresas = new Set(dados.empresas.map((empresa) => String(empresa.linha_id)));
  const lista = document.getElementById("lista-empresas-linha");
  lista.replaceChildren();
  dados.empresas.forEach((empresa, indice) => lista.appendChild(campoLinhaEmpresa(empresa, indice)));
  const prefixos = await requisitarAdministracao("/prefixos");
  const listaPrefixos = document.getElementById("lista-prefixos");
  listaPrefixos.replaceChildren();
  prefixos.prefixos.forEach((prefixo) => {
    const linha = criarElemento("div", null, "linha-prefixo");
    const letra = document.createElement("input");
    letra.value = prefixo.letra;
    letra.maxLength = 1;
    letra.setAttribute("aria-label", "Letra do prefixo");
    const empresa = document.createElement("input");
    empresa.value = prefixo.empresa;
    empresa.maxLength = 150;
    empresa.setAttribute("aria-label", "Empresa do prefixo");
    const remover = criarElemento("button", "Remover");
    remover.type = "button";
    remover.addEventListener("click", () => linha.remove());
    linha.append(letra, empresa, remover);
    listaPrefixos.appendChild(linha);
  });
}

async function carregarAba(nome) {
  trocarAba(nome);
  mostrarMensagem("");
  try {
    if (nome === "reclamacoes") await carregarReclamacoes();
    if (nome === "painel") await carregarPainel();
    if (nome === "empresas") await carregarEmpresas();
  } catch (erro) {
    mostrarMensagem(erro.message, true);
  }
}

document.getElementById("form-login").addEventListener("submit", async (evento) => {
  evento.preventDefault();
  mostrarMensagem("");
  try {
    let resposta;
    try {
      resposta = await fetch(`${API_ADMINISTRACAO}/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ senha: document.getElementById("senha-administracao").value }),
      });
    } catch {
      throw new Error("Não foi possível conectar para entrar. Verifique sua conexão.");
    }
    const dados = await resposta.json().catch(() => ({}));
    if (resposta.status === 404) {
      throw new Error("O painel ainda não está disponível no servidor. Publique a versão atualizada do backend e tente novamente.");
    }
    if (!resposta.ok) throw new Error(dados.mensagem || "Não foi possível entrar.");
    tokenAdministracao = dados.token;
    sessionStorage.setItem(CHAVE_TOKEN_ADMINISTRACAO, tokenAdministracao);
    document.getElementById("tela-login").classList.add("oculto");
    document.getElementById("painel-administracao").classList.remove("oculto");
    document.getElementById("btn-sair").classList.remove("oculto");
    document.getElementById("senha-administracao").value = "";
    await carregarAba("reclamacoes");
  } catch (erro) {
    mostrarMensagem(erro.message, true);
  }
});

document.querySelectorAll(".aba").forEach((botao) => {
  botao.addEventListener("click", () => carregarAba(botao.dataset.aba));
});
document.getElementById("btn-sair").addEventListener("click", encerrarSessao);
document.getElementById("filtros-reclamacoes").addEventListener("submit", (evento) => {
  evento.preventDefault();
  paginaAtual = 1;
  carregarReclamacoes().catch((erro) => mostrarMensagem(erro.message, true));
});
document.getElementById("pagina-anterior").addEventListener("click", () => {
  paginaAtual = Math.max(1, paginaAtual - 1);
  carregarReclamacoes().catch((erro) => mostrarMensagem(erro.message, true));
});
document.getElementById("pagina-proxima").addEventListener("click", () => {
  paginaAtual += 1;
  carregarReclamacoes().catch((erro) => mostrarMensagem(erro.message, true));
});

document.getElementById("form-empresa-linha").addEventListener("submit", (evento) => {
  evento.preventDefault();
  const empresa = {
    linha_id: document.getElementById("nova-empresa-linha").value.trim(),
    empresa: document.getElementById("nova-empresa-nome").value.trim(),
    consorcio: document.getElementById("nova-empresa-consorcio").value.trim(),
  };
  idsLinhasEmpresas.add(empresa.linha_id);
  document.getElementById("lista-empresas-linha").appendChild(campoLinhaEmpresa(empresa));
  evento.target.reset();
});
document.getElementById("btn-salvar-empresas").addEventListener("click", async () => {
  const empresas = [...document.querySelectorAll("#lista-empresas-linha .linha-empresa")].map((linha) => {
    const [linhaId, empresa, consorcio] = linha.querySelectorAll("input");
    return { linha_id: linhaId.value.trim(), empresa: empresa.value.trim(), consorcio: consorcio.value.trim() || null };
  });
  try {
    await requisitarAdministracao("/empresas", {
      method: "PUT",
      body: JSON.stringify({ empresas, linha_ids: [...idsLinhasEmpresas] }),
    });
    mostrarMensagem("Empresas atualizadas.");
    await carregarEmpresas();
  } catch (erro) {
    mostrarMensagem(erro.message, true);
  }
});

document.getElementById("form-prefixo").addEventListener("submit", (evento) => {
  evento.preventDefault();
  const linha = criarElemento("div", null, "linha-prefixo");
  const letra = document.createElement("input");
  letra.value = document.getElementById("novo-prefixo-letra").value.trim().toUpperCase();
  letra.maxLength = 1;
  letra.setAttribute("aria-label", "Letra do prefixo");
  const empresa = document.createElement("input");
  empresa.value = document.getElementById("novo-prefixo-empresa").value.trim();
  empresa.maxLength = 150;
  empresa.setAttribute("aria-label", "Empresa do prefixo");
  const remover = criarElemento("button", "Remover");
  remover.type = "button";
  remover.addEventListener("click", () => linha.remove());
  linha.append(letra, empresa, remover);
  document.getElementById("lista-prefixos").appendChild(linha);
  evento.target.reset();
});
document.getElementById("btn-salvar-prefixos").addEventListener("click", async () => {
  const prefixos = [...document.querySelectorAll("#lista-prefixos .linha-prefixo")].map((linha) => {
    const [letra, empresa] = linha.querySelectorAll("input");
    return { letra: letra.value.trim().toUpperCase(), empresa: empresa.value.trim() };
  });
  try {
    await requisitarAdministracao("/prefixos", { method: "PUT", body: JSON.stringify({ prefixos }) });
    mostrarMensagem("Prefixos atualizados.");
    await carregarEmpresas();
  } catch (erro) {
    mostrarMensagem(erro.message, true);
  }
});

if (tokenAdministracao) {
  document.getElementById("tela-login").classList.add("oculto");
  document.getElementById("painel-administracao").classList.remove("oculto");
  document.getElementById("btn-sair").classList.remove("oculto");
  carregarAba("reclamacoes").catch((erro) => mostrarMensagem(erro.message, true));
}
