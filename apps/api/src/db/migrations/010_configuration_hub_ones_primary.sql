ALTER TABLE ones_sync_config
  ADD COLUMN IF NOT EXISTS data_source_mode TEXT NOT NULL DEFAULT 'ones_primary',
  ADD COLUMN IF NOT EXISTS ones_project_key TEXT,
  ADD COLUMN IF NOT EXISTS schema_hash TEXT,
  ADD COLUMN IF NOT EXISTS schema_synced_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS ones_webhook_events (
  id UUID PRIMARY KEY,
  external_event_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  ones_ticket_key TEXT,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  signature TEXT,
  status TEXT NOT NULL DEFAULT 'received',
  error TEXT,
  retries INT NOT NULL DEFAULT 0,
  trace_id TEXT,
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  processed_at TIMESTAMPTZ,
  UNIQUE(external_event_id, event_type, ones_ticket_key)
);

CREATE INDEX IF NOT EXISTS idx_ones_webhook_events_status ON ones_webhook_events(status, received_at DESC);

CREATE TABLE IF NOT EXISTS ones_sync_jobs (
  id UUID PRIMARY KEY,
  ticket_id UUID,
  ones_ticket_key TEXT,
  job_type TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'pending',
  error TEXT,
  retries INT NOT NULL DEFAULT 0,
  next_retry_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ones_sync_jobs_status ON ones_sync_jobs(status, next_retry_at, created_at DESC);

UPDATE ones_sync_config
SET data_source_mode = COALESCE(data_source_mode, 'ones_primary')
WHERE data_source_mode IS NULL;
