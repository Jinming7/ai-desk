ALTER TABLE tickets
  ADD COLUMN IF NOT EXISTS assigned_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_customer_reply_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_agent_reply_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS ai_suggestion_pending BOOLEAN NOT NULL DEFAULT FALSE;

CREATE TABLE IF NOT EXISTS support_ux_events (
  id UUID PRIMARY KEY,
  actor TEXT NOT NULL,
  event_type TEXT NOT NULL,
  ticket_id UUID,
  queue_key TEXT,
  trace_id TEXT,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_support_ux_events_created ON support_ux_events(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_support_ux_events_ticket ON support_ux_events(ticket_id, created_at DESC);

UPDATE tickets
SET assigned_at = COALESCE(assigned_at, created_at)
WHERE assigned_at IS NULL;
