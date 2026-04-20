CREATE TABLE IF NOT EXISTS channel_threads (
  id UUID PRIMARY KEY,
  channel_type TEXT NOT NULL,
  tenant_key TEXT NOT NULL DEFAULT 'default',
  external_thread_id TEXT NOT NULL,
  external_user_id TEXT,
  session_id UUID REFERENCES ai_search_sessions(id) ON DELETE SET NULL,
  latest_state TEXT NOT NULL DEFAULT 'ACTIVE',
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_channel_threads_unique
  ON channel_threads(channel_type, tenant_key, external_thread_id);

CREATE TABLE IF NOT EXISTS conversation_events (
  id UUID PRIMARY KEY,
  session_id UUID REFERENCES ai_search_sessions(id) ON DELETE CASCADE,
  channel_thread_id UUID REFERENCES channel_threads(id) ON DELETE SET NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  source_type TEXT NOT NULL DEFAULT 'portal',
  source_event_id TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_conversation_events_session
  ON conversation_events(session_id, created_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS idx_conversation_events_source_event
  ON conversation_events(source_type, source_event_id)
  WHERE source_event_id IS NOT NULL;
