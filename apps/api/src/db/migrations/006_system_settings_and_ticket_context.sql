CREATE TABLE IF NOT EXISTS system_settings (
  key TEXT PRIMARY KEY,
  value_json JSONB NOT NULL,
  updated_by TEXT NOT NULL DEFAULT 'system',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO system_settings(key, value_json, updated_by)
VALUES ('ai_agent_enabled', '{"enabled": true}'::jsonb, 'migration')
ON CONFLICT (key) DO NOTHING;

ALTER TABLE tickets
  ADD COLUMN IF NOT EXISTS customer_email TEXT,
  ADD COLUMN IF NOT EXISTS environment TEXT,
  ADD COLUMN IF NOT EXISTS reproducibility TEXT,
  ADD COLUMN IF NOT EXISTS impact_summary TEXT;
