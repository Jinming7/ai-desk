CREATE TABLE IF NOT EXISTS ai_search_sessions (
  id UUID PRIMARY KEY,
  query TEXT NOT NULL,
  answer TEXT NOT NULL,
  confidence NUMERIC NOT NULL DEFAULT 0,
  retrieval_status TEXT NOT NULL,
  unresolved_reason_code TEXT,
  suggested_next_step TEXT NOT NULL,
  model TEXT NOT NULL DEFAULT 'nexusflow-search-v1',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ai_search_sessions_created_at ON ai_search_sessions(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_search_sessions_next_step ON ai_search_sessions(suggested_next_step, created_at DESC);

CREATE TABLE IF NOT EXISTS ai_search_references (
  id UUID PRIMARY KEY,
  session_id UUID NOT NULL REFERENCES ai_search_sessions(id) ON DELETE CASCADE,
  document_id TEXT NOT NULL,
  title TEXT NOT NULL,
  snippet TEXT NOT NULL,
  source_url TEXT NOT NULL,
  score NUMERIC NOT NULL,
  retrieved_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ai_search_references_session ON ai_search_references(session_id);

CREATE TABLE IF NOT EXISTS ai_search_metrics_events (
  id UUID PRIMARY KEY,
  session_id UUID REFERENCES ai_search_sessions(id) ON DELETE SET NULL,
  metric_name TEXT NOT NULL,
  metric_value NUMERIC NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ai_search_metrics_events_name_created ON ai_search_metrics_events(metric_name, created_at DESC);

CREATE TABLE IF NOT EXISTS ai_search_escalations (
  id UUID PRIMARY KEY,
  session_id UUID NOT NULL REFERENCES ai_search_sessions(id) ON DELETE CASCADE,
  idempotency_key TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL,
  question TEXT NOT NULL,
  conversation JSONB NOT NULL DEFAULT '[]'::jsonb,
  reason_code TEXT NOT NULL,
  retrieval_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
  correlation_id TEXT NOT NULL,
  attempts INT NOT NULL DEFAULT 0,
  resolved_payload JSONB,
  created_ticket_id UUID REFERENCES tickets(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(session_id)
);

CREATE INDEX IF NOT EXISTS idx_ai_search_escalations_status ON ai_search_escalations(status, updated_at DESC);

CREATE TABLE IF NOT EXISTS ai_search_escalation_events (
  id UUID PRIMARY KEY,
  escalation_id UUID NOT NULL REFERENCES ai_search_escalations(id) ON DELETE CASCADE,
  from_status TEXT,
  to_status TEXT NOT NULL,
  actor_type TEXT NOT NULL,
  correlation_id TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ai_search_escalation_events_escalation ON ai_search_escalation_events(escalation_id, created_at DESC);
