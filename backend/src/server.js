require("dotenv").config();
const express = require("express");
const cors = require("cors");
const linhasRouter = require("./routes/linhas");
const { pool } = require("./db");

const app = express();
app.set("trust proxy", 1);

const origensPermitidas = (process.env.CORS_ORIGIN || "*")
  .split(",")
  .map((o) => o.trim());

app.use(
  cors({
    origin: origensPermitidas.includes("*") ? true : origensPermitidas,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);
app.use(express.json({ limit: "20kb" }));

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
    console.error("Erro ao verificar o banco:", erro);
    res.status(500).json({ banco: "erro" });
  }
});

app.use("/api/linhas", linhasRouter);
app.use("/api/mapa", require("./routes/mapa"));
app.use("/api/reclamacoes", require("./routes/reclamacoes"));
app.get("/api/config", (req, res) => {
  res.json({ emailUrbs: process.env.URBS_EMAIL_RECLAMACAO || "" });
});
app.use("/api/admin", require("./routes/admin"));

app.use((erro, req, res, next) => {
  if (res.headersSent) return next(erro);
  if (erro.type === "entity.too.large") {
    return res.status(413).json({ mensagem: "O envio excede o tamanho permitido." });
  }
  console.error("Erro não tratado na API:", erro);
  res.status(500).json({ mensagem: "Ocorreu um erro interno. Tente novamente." });
});

const PORTA = process.env.PORT || 3000;
app.listen(PORTA, () => {
  console.log(`Bus Cwb backend rodando na porta ${PORTA}`);
});
