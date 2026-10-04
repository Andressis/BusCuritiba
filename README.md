# Bus Cwb

Aplicação de consulta de linhas e horários de ônibus de Curitiba. O
projeto está separado em `frontend/` (aplicação web estática) e
`backend/` (API Node.js + MySQL).

A API fornece linhas e horários usando o endpoint público que a própria
página de horários da URBS usa internamente — sem GTFS, sem token, sem
cadastro.

Fonte dos dados:
- Lista de linhas: `https://www.urbs.curitiba.pr.gov.br/portal/wp-content/urbs_data/urbs_horarios/linhas_ativas.json`
- Horários por linha: `https://www.urbs.curitiba.pr.gov.br/portal/wp-content/urbs_data/urbs_horarios/linha_{codigo}_v2.json`

Requer **MySQL 8.0+ ou MariaDB 10.2+** (as consultas usam CTE e a
função de janela `ROW_NUMBER()`).

## Estrutura

```
frontend/
  index.html                    -> página da aplicação
  app.js                        -> lógica e chamadas à API
  style.css                     -> estilos
  manifest.json, service-worker.js, assets/, icons/
backend/
  package.json                  -> dependências e comandos da API
  .env.example                  -> exemplo de configuração local
  .env                          -> configuração local (não versionar)
  src/
    db.js                       -> conexão com o MySQL (mysql2/promise)
    server.js                   -> servidor Express (rotas da API)
    db/schema.sql               -> criação das tabelas
    routes/linhas.js             -> endpoints /api/linhas
    scripts/migrar.js            -> roda o schema.sql no banco
    scripts/importarHorariosUrbs.js -> baixa os dados da URBS e popula o banco
```

## Backend local

1. Entre na pasta `backend/` e instale as dependências: `npm install`.
2. Copie `backend/.env.example` para `backend/.env` e preencha os dados
   de um MySQL local ou remoto. O arquivo `.env` não deve ser publicado.
3. Ainda em `backend/`, rode `npm run migrar` e
   `npm run importar-horarios`.
4. Inicie a API com `npm start`. Por padrão, ela ficará em
   `http://localhost:3000`.

## Frontend

Publique o conteúdo de `frontend/` em uma hospedagem de arquivos
estáticos. Antes de publicar, configure `API_BASE_URL` em `frontend/app.js`
com a URL pública da API, incluindo `/api`. A API precisa permitir a
origem do frontend na variável `CORS_ORIGIN`.

Para testar localmente, sirva a pasta `frontend/` com um servidor HTTP
estático. Não abra `index.html` diretamente como arquivo, pois as
chamadas à API e o service worker precisam de uma origem HTTP(S).

Para atualizar a versão exibida e os parâmetros de cache dos arquivos
CSS e JS do frontend, altere `version` em `version.json` e execute
`npm run update-version` na raiz do projeto.

## Publicação do backend (cPanel / HostGator)

1. Em **Bancos de Dados → MySQL® Databases** (ou Database Wizard),
   crie um banco e um usuário, e adicione o usuário ao banco com
   todos os privilégios. Anote os três nomes (geralmente prefixados
   com o seu usuário de hospedagem).
2. Em **Setup Node.js App**, crie uma aplicação: escolha a versão do
   Node, selecione a pasta `backend/` como raiz da aplicação e use
   `src/server.js` como arquivo de start.
3. Envie o conteúdo da pasta `backend/` para essa aplicação (Git Version
   Control ou File Manager). Não suba `node_modules` nem `.env`.
4. Na tela do Node.js App, defina as variáveis de ambiente:
   `DB_HOST`, `DB_USER`, `DB_PASSWORD`, `DB_NAME`, `CORS_ORIGIN` e
   clique em **Run NPM Install**.
5. Pelo Terminal do cPanel (ou SSH), entre no ambiente virtual que o
   cPanel criou (o comando exato aparece na própria tela do Node.js
   App), navegue até a pasta do backend e rode:
   ```
   npm run migrar
   npm run importar-horarios
   ```
   A importação demora alguns minutos — são ~300 linhas, uma
   requisição por linha, com uma pequena pausa entre elas.
6. Reinicie a aplicação (**Restart** na tela do Node.js App) e teste
   `https://SEU-DOMINIO-OU-SUBDOMINIO/api/linhas`. Publique o frontend
   separadamente e configure `CORS_ORIGIN` com o endereço dele.

## Sobre os dados

- Cada linha tem "simulações" (versões da tabela horária válidas por
  período). O script usa só as simulações marcadas como `is_current`.
- Tipo de dia: `"1"` = dia útil, `"2"` = sábado, `"3"` = domingo/feriado.
  Uma linha que não circula aos domingos simplesmente não tem a chave `"3"`.
- Cada linha tem vários **pontos/terminais**, cada um com sua própria
  lista de horários. O `ponto_principal` salvo em `linhas` é o ponto
  com mais horários cadastrados, usado para calcular o "próximo
  horário" mostrado na lista inicial do app.
- O "próximo horário" é calculado dinamicamente (fuso horário de
  Curitiba, não o do servidor): dia da semana atual + primeiro
  horário do melhor ponto que ainda não passou, com fallback para o
  ponto com mais horários se o `ponto_principal` não operar naquele
  dia. Feriados não são tratados automaticamente.

## Endpoints

- `GET /api/linhas?busca=203` → lista linhas com o próximo horário calculado
- `GET /api/linhas/:id/horarios?tipoDia=util|sabado|domingo` → horários
  de todos os pontos/terminais da linha
- `GET /api/status` → confirma se o banco está de pé e quando foi a
  última importação
