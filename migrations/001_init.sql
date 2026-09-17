-- Outbound Campaign Control Room — initial schema.
-- Single-user app: account_connection and pipeline_lock each hold exactly one row.

CREATE TABLE IF NOT EXISTS account_connection (
  id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  google_refresh_token TEXT,         -- AES-256-GCM ciphertext, base64 (see lib/crypto.ts)
  google_access_token TEXT,
  google_token_expiry TIMESTAMPTZ,
  gmail_connected BOOLEAN NOT NULL DEFAULT FALSE,
  sheet_url TEXT,
  sheet_id TEXT,
  sheet_connected BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS templates (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL DEFAULT 'first_outreach',
  subject TEXT NOT NULL,
  body_html TEXT NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  version INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS pipeline_runs (
  id SERIAL PRIMARY KEY,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ,
  leads_processed INTEGER NOT NULL DEFAULT 0,
  errors JSONB NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'running' -- running | completed | failed
);

CREATE TABLE IF NOT EXISTS pipeline_lock (
  id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  locked_at TIMESTAMPTZ,
  locked_by TEXT
);

INSERT INTO account_connection (id) VALUES (1) ON CONFLICT (id) DO NOTHING;
INSERT INTO pipeline_lock (id) VALUES (1) ON CONFLICT (id) DO NOTHING;
