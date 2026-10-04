-- ============================================================
-- BUS CWB - Schema do banco (MySQL / MariaDB)
--
-- Alimentado pelos dados públicos da URBS (mesmo endpoint usado
-- pela própria página de horários do site oficial, sem GTFS e
-- sem necessidade de cadastro/token):
--   https://www.urbs.curitiba.pr.gov.br/portal/wp-content/urbs_data/urbs_horarios/
--
-- Requer MySQL 8.0+ (ou MariaDB 10.2+) por causa do CTE / window
-- function usados nas consultas da API.
-- ============================================================

CREATE TABLE IF NOT EXISTS linhas (
  id                VARCHAR(20) PRIMARY KEY,  -- COD da linha (ex: "250", "X43")
  numero            VARCHAR(20) NOT NULL,     -- igual ao id, mantido para exibição
  nome              VARCHAR(150) NOT NULL,    -- NOME da linha
  categoria_servico VARCHAR(60),              -- CONVENCIONAL, TRONCAL, EXPRESSO, LIGEIRAO, etc.
  cor               VARCHAR(30),              -- NOME_COR (AMARELA, VERMELHA, VERDE, LARANJA, PRATA...)
  somente_cartao    TINYINT(1) NOT NULL DEFAULT 0,
  pagamento         VARCHAR(60),              -- ex: "Dinheiro / Cartao"
  ponto_principal   VARCHAR(150),             -- ponto/terminal usado para calcular "proximo horario"
  atualizado_em     TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
                    ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- tipo_dia: 'util' | 'sabado' | 'domingo'
-- ponto: nome do terminal/ponto de origem daquele horário
--        (uma linha tem vários pontos, cada um com sua própria lista)
CREATE TABLE IF NOT EXISTS horarios (
  id       BIGINT AUTO_INCREMENT PRIMARY KEY,
  linha_id VARCHAR(20) NOT NULL,
  tipo_dia ENUM('util', 'sabado', 'domingo') NOT NULL,
  ponto    VARCHAR(150) NOT NULL,
  horario  VARCHAR(5) NOT NULL,               -- "HH:MM"
  adapt    TINYINT(1) NOT NULL DEFAULT 1,     -- veículo adaptado/acessível
  CONSTRAINT fk_horarios_linha FOREIGN KEY (linha_id) REFERENCES linhas(id) ON DELETE CASCADE,
  UNIQUE KEY uq_horario (linha_id, tipo_dia, ponto, horario)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE INDEX idx_horarios_linha_tipo_ponto
  ON horarios (linha_id, tipo_dia, ponto, horario);

-- Controle de quando foi a última importação do endpoint da URBS
CREATE TABLE IF NOT EXISTS importacoes (
  id             BIGINT AUTO_INCREMENT PRIMARY KEY,
  executado_em   TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  linhas_total   INT,
  horarios_total INT,
  observacao     VARCHAR(255)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
