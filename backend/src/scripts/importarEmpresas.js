require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { pool } = require("../db");

function lerCamposCsv(linha) {
  const campos = [];
  let campo = "";
  let entreAspas = false;
  for (let indice = 0; indice < linha.length; indice += 1) {
    const caractere = linha[indice];
    if (caractere === '"' && entreAspas && linha[indice + 1] === '"') {
      campo += '"';
      indice += 1;
    } else if (caractere === '"') {
      entreAspas = !entreAspas;
    } else if (caractere === "," && !entreAspas) {
      campos.push(campo.trim());
      campo = "";
    } else {
      campo += caractere;
    }
  }
  campos.push(campo.trim());
  return campos;
}

async function main() {
  const caminho = path.join(__dirname, "..", "..", "data", "linhas_empresas.csv");
  if (!fs.existsSync(caminho)) {
    console.warn("Arquivo backend/data/linhas_empresas.csv não encontrado; nenhuma empresa foi importada.");
    return;
  }
  const linhas = fs.readFileSync(caminho, "utf8").replace(/^\uFEFF/, "").split(/\r?\n/);
  const dados = linhas.slice(1).map(lerCamposCsv).filter((campos) =>
    campos.length >= 3 && campos[0] && campos[1]
  );
  if (!dados.length) {
    console.log("Nenhuma empresa válida encontrada no CSV.");
    return;
  }
  const conexao = await pool.getConnection();
  try {
    await conexao.beginTransaction();
    for (const [codigo, empresa, consorcio] of dados) {
      await conexao.query(
        "INSERT IGNORE INTO linha_empresa (linha_id, empresa, consorcio) VALUES (?, ?, ?)",
        [codigo, empresa, consorcio || null]
      );
    }
    await conexao.commit();
    console.log(`${dados.length} relações de linha e empresa processadas.`);
  } catch (erro) {
    await conexao.rollback();
    throw erro;
  } finally {
    conexao.release();
  }
}

main()
  .catch((erro) => {
    console.error("Falha ao importar empresas:", erro);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
