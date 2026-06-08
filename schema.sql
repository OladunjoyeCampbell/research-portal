-- ══════════════════════════════════════════════════════════════
--  Multi‑study schema for AlgoLadder Research Portal
-- ══════════════════════════════════════════════════════════════

-- Studies table
CREATE TABLE IF NOT EXISTS studies (
  id            SERIAL        PRIMARY KEY,
  study_key     VARCHAR(50)   UNIQUE NOT NULL,
  title_en      TEXT          NOT NULL,
  title_ha      TEXT          NOT NULL,
  description_en TEXT,
  description_ha TEXT,
  status        VARCHAR(20)   NOT NULL DEFAULT 'draft',
  capacity      INTEGER       NOT NULL DEFAULT 100,
  config        JSONB         NOT NULL DEFAULT '{}'::jsonb,
  created_at    TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

-- Participants (core identity)
CREATE TABLE IF NOT EXISTS participants (
  id                BIGSERIAL     PRIMARY KEY,
  participant_code  VARCHAR(10)   UNIQUE NOT NULL,
  name              VARCHAR(150)  NOT NULL,
  matric            VARCHAR(50)   UNIQUE NOT NULL,
  email             VARCHAR(100),
  lang              VARCHAR(5)    NOT NULL DEFAULT 'en',
  demographics      JSONB         NOT NULL DEFAULT '{}'::jsonb,
  consent_general   BOOLEAN       NOT NULL DEFAULT FALSE,
  created_at        TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

-- Enrolments (links participant to study)
CREATE TABLE IF NOT EXISTS enrolments (
  id                BIGSERIAL     PRIMARY KEY,
  participant_id    BIGINT        NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
  study_id          INT           NOT NULL REFERENCES studies(id) ON DELETE CASCADE,
  status            VARCHAR(20)   NOT NULL DEFAULT 'enrolled',
  data              JSONB         NOT NULL DEFAULT '{}'::jsonb,
  started_at        TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  last_active       TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  completed_at      TIMESTAMPTZ,
  duration_ms       INTEGER,
  UNIQUE(participant_id, study_id)
);

-- Indexes
CREATE INDEX idx_enrolments_participant ON enrolments(participant_id);
CREATE INDEX idx_enrolments_study       ON enrolments(study_id);
CREATE INDEX idx_enrolments_status      ON enrolments(status);
CREATE INDEX idx_participants_matric    ON participants(UPPER(matric));
CREATE INDEX idx_participants_code      ON participants(participant_code);

-- Insert default AlgoLadder study (ID = 1)
INSERT INTO studies (study_key, title_en, title_ha, description_en, description_ha, status, capacity, config)
VALUES (
  'algoladder_2025',
  'AlgoLadder – Bilingual Computational Thinking Tutor',
  'AlgoLadder – Mai Koyarwa na Tunani na Kwamfuta',
  'A scaffolded tutor to improve algorithmic thinking (pre‑test, 10 puzzles, post‑test).',
  'Mai koyarwa mai tallafi don inganta tunanin algoritm (gwajin farko, tambayoyi 10, gwajin ƙarshe).',
  'open',
  100,
  '{}'::jsonb   -- The frontend will populate config dynamically on first use or via admin
) ON CONFLICT (study_key) DO NOTHING;