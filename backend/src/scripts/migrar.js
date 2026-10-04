/* ============================================================
   Roda o schema.sql contra o banco MySQL definido nas variáveis
   DB_HOST / DB_USER / DB_PASSWORD / DB_NAME.

   Uso: npm run migrar

   Diferente do pool principal (src/db.js), aqui usamos uma conexão
   à parte com "multipleStatements" ligado, só para poder rodar o
   arquivo .sql inteiro de uma vez. Isso não é ativado no pool da
   aplicação por segurança.
   ============================================================ */
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const mysql = require("mysql2/promise");

async function main() {
  const caminhoSchema = path.join(__dirname, "..", "db", "schema.sql");
  const sql = fs.readFileSync(caminhoSchema, "utf8");

  const conexao = await mysql.createConnection({
    host: process.env.DB_HOST || "localhost",
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    multipleStatements: true,
  });

  console.log("Aplicando schema.sql no banco...");

  try {
    await conexao.query(sql);
  } catch (erro) {
    // Reexecutar o script não deve quebrar por causa do índice extra
    // (CREATE INDEX não aceita "IF NOT EXISTS" no MySQL).
    if (erro.code === "ER_DUP_KEYNAME") {
      console.log("Índice já existia, ignorando.");
    } else {
      throw erro;
    }
  }

  console.log("Tabelas criadas/atualizadas com sucesso.");
  await conexao.end();
}

main().catch((erro) => {
  console.error("Falha ao migrar o banco:", erro);
  process.exit(1);
});
