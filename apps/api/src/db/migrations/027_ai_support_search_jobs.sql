CREATE TABLE IF NOT EXISTS ai_support_search_jobs (
  id UUID PRIMARY KEY,
  session_id UUID NOT NULL,
  request_key TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (
    status IN ('queued', 'running', 'partial_result_ready', 'completed', 'failed_retryable', 'failed_terminal', 'cancelled')
  ),
  query TEXT NOT NULL,
  answer_language TEXT NOT NULL DEFAULT 'en',
  current_round INT NOT NULL DEFAULT 0,
  request_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  stage_state_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  result_json JSONB,
  attempts INT NOT NULL DEFAULT 0,
  max_attempts INT NOT NULL DEFAULT 3,
  next_run_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  lease_key TEXT,
  lease_expires_at TIMESTAMPTZ,
  worker_id TEXT,
  error_message TEXT,
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ai_support_search_jobs_dispatch
  ON ai_support_search_jobs(status, next_run_at, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_ai_support_search_jobs_session
  ON ai_support_search_jobs(session_id, created_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS idx_ai_support_search_jobs_session_active
  ON ai_support_search_jobs(session_id)
  WHERE status IN ('queued', 'running', 'partial_result_ready', 'failed_retryable');
