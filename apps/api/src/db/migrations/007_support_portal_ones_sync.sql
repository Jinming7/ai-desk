ALTER TABLE tickets
  ADD COLUMN IF NOT EXISTS first_response_due_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS first_response_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS resolution_due_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS sla_paused_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS sla_pause_reason TEXT,
  ADD COLUMN IF NOT EXISTS sla_paused_total_seconds INT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS ones_ticket_type_key TEXT,
  ADD COLUMN IF NOT EXISTS ones_ticket_key TEXT,
  ADD COLUMN IF NOT EXISTS ones_sync_status TEXT NOT NULL DEFAULT 'not_configured',
  ADD COLUMN IF NOT EXISTS ones_sync_error TEXT,
  ADD COLUMN IF NOT EXISTS ai_mode_snapshot TEXT,
  ADD COLUMN IF NOT EXISTS ai_last_trace_id TEXT,
  ADD COLUMN IF NOT EXISTS ai_last_action TEXT,
  ADD COLUMN IF NOT EXISTS ai_last_confidence NUMERIC,
  ADD COLUMN IF NOT EXISTS ai_last_model TEXT,
  ADD COLUMN IF NOT EXISTS ai_last_fallback_applied BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE ai_runs
  ADD COLUMN IF NOT EXISTS trace_id TEXT,
  ADD COLUMN IF NOT EXISTS decision_action TEXT,
  ADD COLUMN IF NOT EXISTS model_name TEXT,
  ADD COLUMN IF NOT EXISTS confidence NUMERIC,
  ADD COLUMN IF NOT EXISTS evidence_json JSONB,
  ADD COLUMN IF NOT EXISTS fallback_applied BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS prompt_hash TEXT;

CREATE TABLE IF NOT EXISTS ones_sync_config (
  id UUID PRIMARY KEY,
  profile_name TEXT NOT NULL DEFAULT 'default',
  base_url TEXT NOT NULL,
  auth_type TEXT NOT NULL DEFAULT 'bearer',
  auth_header TEXT NOT NULL DEFAULT 'Authorization',
  auth_secret_encrypted TEXT NOT NULL,
  create_ticket_path TEXT NOT NULL,
  list_ticket_types_path TEXT NOT NULL,
  list_fields_path_template TEXT NOT NULL,
  timeout_ms INT NOT NULL DEFAULT 12000,
  retries INT NOT NULL DEFAULT 1,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  updated_by TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS ones_ticket_type_cache (
  id UUID PRIMARY KEY,
  type_key TEXT NOT NULL UNIQUE,
  type_name TEXT NOT NULL,
  fields_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  source_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS ones_field_mappings (
  id UUID PRIMARY KEY,
  ticket_type_key TEXT NOT NULL,
  flow TEXT NOT NULL,
  version INT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  mapping_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  validation_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  activated_at TIMESTAMPTZ,
  UNIQUE(ticket_type_key, flow, version)
);

CREATE INDEX IF NOT EXISTS idx_ones_field_mappings_active ON ones_field_mappings(ticket_type_key, flow, status);

CREATE TABLE IF NOT EXISTS ones_sync_audit_logs (
  id UUID PRIMARY KEY,
  actor TEXT NOT NULL,
  scope TEXT NOT NULL,
  event_type TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

UPDATE tickets
SET
  first_response_due_at = COALESCE(first_response_due_at, created_at + INTERVAL '1 hour'),
  resolution_due_at = COALESCE(resolution_due_at, created_at + INTERVAL '24 hours'),
  ai_mode_snapshot = COALESCE(ai_mode_snapshot, 'AI_ON')
WHERE first_response_due_at IS NULL
   OR resolution_due_at IS NULL
   OR ai_mode_snapshot IS NULL;
