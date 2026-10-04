require("dotenv").config();
const express = require("express");
const cors = require("cors");
const linhasRouter = require("./routes/linhas");
const { pool } = require("./db");

const app = express();

const origensPermitidas = (process.env.CORS_ORIGIN || "*")
  .split(",")
  .map((o) => o.trim());

app.use(
  cors({
    origin: origensPermitidas.includes("*") ? true : origensPermitidas,
  })
);
app.use(express.json());

app.get("/", (req, res) => {
  res.json({ status: "ok", servico: "bus-cwb-backend" });
});

// Verifica se o banco está de pé e informa quando foi a última importação
app.get("/api/status", async (req, res) => {
  try {
    const [rows] = await pool.query(
      "SELECT executado_em, linhas_total, horarios_total FROM importacoes ORDER BY executado_em DESC LIMIT 1"
    );
    res.json({ banco: "conectado", ultimaImportacao: rows[0] || null });
  } catch (erro) {
    res.status(500).json({ banco: "erro", detalhe: erro.message });
  }
});

app.use("/api/linhas", linhasRouter);
app.use("/api/mapa", require("./routes/mapa"));

const PORTA = process.env.PORT || 3000;
app.listen(PORTA, () => {
  console.log(`Bus Cwb backend rodando na porta ${PORTA}`);
});
