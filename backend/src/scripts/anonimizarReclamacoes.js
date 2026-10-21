require("dotenv").config();
const { pool } = require("../db");

pool
  .query(
    "UPDATE reclamacoes SET nome = NULL WHERE criada_em < NOW() - INTERVAL 12 MONTH AND nome IS NOT NULL"
  )
  .then(([resultado]) => {
    console.log(`${resultado.affectedRows} nomes anonimizados.`);
  })
  .catch((erro) => {
    console.error("Falha ao anonimizar reclamações:", erro);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
