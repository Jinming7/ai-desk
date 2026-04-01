CREATE TABLE IF NOT EXISTS ai_search_dialog_states (
  session_id UUID PRIMARY KEY REFERENCES ai_search_sessions(id) ON DELETE CASCADE,
  state TEXT NOT NULL DEFAULT 'CLARIFICATION_REQUIRED',
  clarification_round INT NOT NULL DEFAULT 0,
  show_create_ticket_now BOOLEAN NOT NULL DEFAULT false,
  answer_language TEXT NOT NULL DEFAULT 'en',
  follow_up_question TEXT,
  transcript JSONB NOT NULL DEFAULT '[]'::jsonb,
  retrieval_outcome JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ai_search_dialog_states_state
  ON ai_search_dialog_states(state, updated_at DESC);

CREATE TABLE IF NOT EXISTS ai_search_ticket_drafts (
  id UUID PRIMARY KEY,
  session_id UUID NOT NULL REFERENCES ai_search_sessions(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'draft',
  ticket_type_key TEXT,
  ticket_type_confidence NUMERIC NOT NULL DEFAULT 0,
  draft_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  missing_required_fields JSONB NOT NULL DEFAULT '[]'::jsonb,
  provenance_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_ticket_id UUID REFERENCES tickets(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ai_search_ticket_drafts_session
  ON ai_search_ticket_drafts(session_id, status, updated_at DESC);

CREATE TABLE IF NOT EXISTS ai_search_handoff_events (
  id UUID PRIMARY KEY,
  session_id UUID NOT NULL REFERENCES ai_search_sessions(id) ON DELETE CASCADE,
  draft_id UUID REFERENCES ai_search_ticket_drafts(id) ON DELETE SET NULL,
  ticket_id UUID REFERENCES tickets(id) ON DELETE SET NULL,
  event_type TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ai_search_handoff_events_session
  ON ai_search_handoff_events(session_id, created_at DESC);
