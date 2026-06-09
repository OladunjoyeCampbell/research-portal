-- ══════════════════════════════════════════════════════════════
--  Multi‑study schema with all missing features
--  Run this in Supabase (it will drop existing tables – be careful!)
--  For production, use ALTER TABLE statements instead.
-- ══════════════════════════════════════════════════════════════

DROP TABLE IF EXISTS reminders_queue CASCADE;
DROP TABLE IF EXISTS admin_audit_log CASCADE;
DROP TABLE IF EXISTS enrolments CASCADE;
DROP TABLE IF EXISTS participants CASCADE;
DROP TABLE IF EXISTS studies CASCADE;

-- Studies table
CREATE TABLE studies (
  id            SERIAL        PRIMARY KEY,
  study_key     VARCHAR(50)   UNIQUE NOT NULL,
  title_en      TEXT          NOT NULL,
  title_ha      TEXT,
  description_en TEXT,
  description_ha TEXT,
  status        VARCHAR(20)   NOT NULL DEFAULT 'draft',
  capacity      INTEGER       NOT NULL DEFAULT 100,
  end_date      TIMESTAMPTZ,                          -- ethics expiry
  instruments   JSONB         NOT NULL DEFAULT '[]'::jsonb, -- array of instrument objects
  delayed_post_test_weeks INTEGER NOT NULL DEFAULT 0,
  config        JSONB         NOT NULL DEFAULT '{}'::jsonb,
  created_at    TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

-- Participants
CREATE TABLE participants (
  id                BIGSERIAL     PRIMARY KEY,
  participant_code  VARCHAR(10)   UNIQUE NOT NULL,
  name              VARCHAR(150)  NOT NULL,
  matric            VARCHAR(50)   UNIQUE NOT NULL,
  email             VARCHAR(100),
  lang              VARCHAR(5)    NOT NULL DEFAULT 'en',
  academic_session  VARCHAR(20),                      -- e.g., '2025/2026'
  class_section     VARCHAR(50),
  lecturer_id       VARCHAR(50),
  demographics      JSONB         NOT NULL DEFAULT '{}'::jsonb,
  consent_general   BOOLEAN       NOT NULL DEFAULT FALSE,
  created_at        TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

-- Enrolments
CREATE TABLE enrolments (
  id                BIGSERIAL     PRIMARY KEY,
  participant_id    BIGINT        NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
  study_id          INT           NOT NULL REFERENCES studies(id) ON DELETE CASCADE,
  status            VARCHAR(20)   NOT NULL DEFAULT 'enrolled', -- enrolled, in_progress, completed, withdrawn, waiting_followup
  randomisation_group VARCHAR(20) DEFAULT 'control',   -- treatment or control
  instrument_version VARCHAR(20)  NOT NULL DEFAULT '1.0.0',
  data              JSONB         NOT NULL DEFAULT '{}'::jsonb,
  missing_data_flags JSONB         NOT NULL DEFAULT '{}'::jsonb,
  started_at        TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  last_active       TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  completed_at      TIMESTAMPTZ,
  withdrawn_at      TIMESTAMPTZ,
  duration_ms       INTEGER,
  last_reminder_sent TIMESTAMPTZ,
  reminder_count    INT           NOT NULL DEFAULT 0,
  UNIQUE(participant_id, study_id)
);

-- Admin audit log
CREATE TABLE admin_audit_log (
  id BIGSERIAL PRIMARY KEY,
  admin_pin VARCHAR(10),
  action VARCHAR(100) NOT NULL,
  target_type VARCHAR(50),
  target_id VARCHAR(100),
  details JSONB,
  ip_address INET,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Reminders queue (for external messaging)
CREATE TABLE reminders_queue (
  id BIGSERIAL PRIMARY KEY,
  enrolment_id BIGINT REFERENCES enrolments(id) ON DELETE CASCADE,
  type VARCHAR(20) NOT NULL,   -- 'whatsapp', 'sms', 'email'
  recipient VARCHAR(100) NOT NULL,
  message TEXT NOT NULL,
  status VARCHAR(20) DEFAULT 'pending',
  scheduled_for TIMESTAMPTZ NOT NULL,
  sent_at TIMESTAMPTZ,
  error TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes
CREATE INDEX idx_enrolments_participant ON enrolments(participant_id);
CREATE INDEX idx_enrolments_study ON enrolments(study_id);
CREATE INDEX idx_enrolments_status ON enrolments(status);
CREATE INDEX idx_enrolments_last_active ON enrolments(last_active);
CREATE INDEX idx_participants_matric ON participants(UPPER(matric));
CREATE INDEX idx_participants_code ON participants(participant_code);
CREATE INDEX idx_reminders_scheduled ON reminders_queue(scheduled_for) WHERE status = 'pending';

-- Insert default AlgoLadder study (ID = 1)
INSERT INTO studies (study_key, title_en, title_ha, description_en, description_ha, status, capacity, end_date, delayed_post_test_weeks, config)
VALUES (
  'algoladder_2026',
  'AlgoLadder – Bilingual Computational Thinking Tutor',
  'AlgoLadder – Mai Koyarwa na Tunani na Kwamfuta',
  'A scaffolded tutor to improve algorithmic thinking (pre‑test, 10 puzzles, post‑test).',
  'Mai koyarwa mai tallafi don inganta tunanin algoritm (gwajin farko, tambayoyi 10, gwajin ƙarshe).',
  'open',
  100,
  '2026-12-31 23:59:59+00',  -- ethics expiry
  0,                          -- no delayed post-test
  '{}'::jsonb                 -- config will be populated by seed script
) ON CONFLICT (study_key) DO NOTHING;