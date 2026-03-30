DO $$
BEGIN
  CREATE EXTENSION IF NOT EXISTS vector;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'pgvector extension is not available: %', SQLERRM;
END$$;

CREATE TABLE IF NOT EXISTS kb_repo_registrations (
  id UUID PRIMARY KEY,
  repo_owner TEXT NOT NULL,
  repo_name TEXT NOT NULL,
  repo_url TEXT NOT NULL,
  default_branch TEXT NOT NULL,
  include_paths TEXT[] NOT NULL DEFAULT ARRAY['**/*.md']::text[],
  exclude_paths TEXT[] NOT NULL DEFAULT ARRAY[]::text[],
  polling_interval_seconds INT NOT NULL DEFAULT 300,
  auth_mode TEXT NOT NULL DEFAULT 'github_token_readonly',
  is_active BOOLEAN NOT NULL DEFAULT true,
  last_validated_at TIMESTAMPTZ,
  last_validation_error TEXT,
  created_by TEXT NOT NULL DEFAULT 'system',
  updated_by TEXT NOT NULL DEFAULT 'system',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (repo_owner, repo_name, default_branch)
);

CREATE INDEX IF NOT EXISTS idx_kb_repo_active ON kb_repo_registrations(is_active, updated_at DESC);

CREATE TABLE IF NOT EXISTS kb_sync_checkpoints (
  repo_id UUID NOT NULL REFERENCES kb_repo_registrations(id) ON DELETE CASCADE,
  branch TEXT NOT NULL,
  last_synced_commit_sha TEXT,
  last_synced_at TIMESTAMPTZ,
  last_full_synced_commit_sha TEXT,
  last_full_synced_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (repo_id, branch)
);

CREATE TABLE IF NOT EXISTS kb_sync_jobs (
  id UUID PRIMARY KEY,
  repo_id UUID NOT NULL REFERENCES kb_repo_registrations(id) ON DELETE CASCADE,
  branch TEXT NOT NULL,
  sync_mode TEXT NOT NULL CHECK (sync_mode IN ('full', 'incremental', 'reindex')),
  source TEXT NOT NULL CHECK (source IN ('manual', 'webhook', 'polling', 'system')),
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'dead_letter')),
  idempotency_key TEXT NOT NULL UNIQUE,
  before_commit_sha TEXT,
  after_commit_sha TEXT,
  payload_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  attempts INT NOT NULL DEFAULT 0,
  max_attempts INT NOT NULL DEFAULT 5,
  next_run_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_kb_sync_jobs_dispatch
  ON kb_sync_jobs(status, next_run_at, created_at);

CREATE TABLE IF NOT EXISTS kb_documents (
  id UUID PRIMARY KEY,
  repo_id UUID NOT NULL REFERENCES kb_repo_registrations(id) ON DELETE CASCADE,
  doc_key TEXT NOT NULL UNIQUE,
  branch TEXT NOT NULL,
  path TEXT NOT NULL,
  title TEXT NOT NULL,
  source_url TEXT NOT NULL,
  commit_sha TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  content TEXT NOT NULL,
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (repo_id, branch, path)
);

CREATE INDEX IF NOT EXISTS idx_kb_docs_active
  ON kb_documents(repo_id, branch, is_active, updated_at DESC);

CREATE TABLE IF NOT EXISTS kb_chunks (
  id TEXT PRIMARY KEY,
  doc_id UUID NOT NULL REFERENCES kb_documents(id) ON DELETE CASCADE,
  repo_id UUID NOT NULL REFERENCES kb_repo_registrations(id) ON DELETE CASCADE,
  branch TEXT NOT NULL,
  path TEXT NOT NULL,
  commit_sha TEXT NOT NULL,
  heading_path TEXT NOT NULL,
  ordinal INT NOT NULL,
  content TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  token_count INT NOT NULL DEFAULT 0,
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  embedding VECTOR(1536),
  embedding_model TEXT,
  embedding_version TEXT,
  lexical_content TEXT NOT NULL DEFAULT '',
  search_vector TSVECTOR,
  confidence_hint NUMERIC(8,6) NOT NULL DEFAULT 0,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_kb_chunks_active
  ON kb_chunks(repo_id, branch, is_active, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_kb_chunks_doc
  ON kb_chunks(doc_id, ordinal);

CREATE INDEX IF NOT EXISTS idx_kb_chunks_search
  ON kb_chunks USING GIN (search_vector);

DO $$
BEGIN
  CREATE INDEX IF NOT EXISTS idx_kb_chunks_embedding_hnsw
    ON kb_chunks USING hnsw (embedding vector_cosine_ops)
    WHERE is_active = true;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'Unable to create HNSW index (will continue without it): %', SQLERRM;
END$$;

CREATE TABLE IF NOT EXISTS kb_metrics_events (
  id UUID PRIMARY KEY,
  repo_id UUID REFERENCES kb_repo_registrations(id) ON DELETE SET NULL,
  metric_name TEXT NOT NULL,
  metric_value NUMERIC(18,6) NOT NULL,
  tags_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_kb_metrics_lookup
  ON kb_metrics_events(metric_name, created_at DESC);

CREATE TABLE IF NOT EXISTS kb_github_webhook_events (
  id UUID PRIMARY KEY,
  delivery_id TEXT NOT NULL UNIQUE,
  event_type TEXT NOT NULL,
  repo_full_name TEXT NOT NULL,
  payload_json JSONB NOT NULL,
  signature TEXT,
  status TEXT NOT NULL DEFAULT 'received',
  error_message TEXT,
  processed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_kb_webhook_status
  ON kb_github_webhook_events(status, created_at DESC);
