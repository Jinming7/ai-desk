ALTER TABLE kb_documents
  ADD COLUMN IF NOT EXISTS knowledge_space TEXT NOT NULL DEFAULT 'support-prod';

ALTER TABLE kb_chunks
  ADD COLUMN IF NOT EXISTS knowledge_space TEXT NOT NULL DEFAULT 'support-prod';

ALTER TABLE kb_memory_entries
  ADD COLUMN IF NOT EXISTS knowledge_space TEXT NOT NULL DEFAULT 'support-prod';

ALTER TABLE kb_memory_profiles
  ADD COLUMN IF NOT EXISTS knowledge_space TEXT NOT NULL DEFAULT 'support-prod';

ALTER TABLE kb_documents
  DROP CONSTRAINT IF EXISTS kb_documents_repo_id_branch_path_build_version_key;

ALTER TABLE kb_documents
  DROP CONSTRAINT IF EXISTS kb_documents_repo_id_branch_path_key;

ALTER TABLE kb_documents
  ADD CONSTRAINT kb_documents_space_repo_branch_path_build_version_key
  UNIQUE (knowledge_space, repo_id, branch, path, build_version);

CREATE INDEX IF NOT EXISTS idx_kb_documents_space_build
  ON kb_documents(knowledge_space, repo_id, branch, build_version, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_kb_chunks_space_build
  ON kb_chunks(knowledge_space, repo_id, branch, build_version, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_kb_memory_entries_space_build
  ON kb_memory_entries(knowledge_space, repo_id, branch, build_version, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_kb_memory_profiles_space_build
  ON kb_memory_profiles(knowledge_space, repo_id, branch, build_version, updated_at DESC);

CREATE TABLE IF NOT EXISTS kb_builds (
  id UUID PRIMARY KEY,
  knowledge_space TEXT NOT NULL,
  repo_id UUID NOT NULL REFERENCES kb_repo_registrations(id) ON DELETE CASCADE,
  branch TEXT NOT NULL,
  build_version TEXT NOT NULL,
  target_head TEXT NOT NULL,
  build_kind TEXT NOT NULL CHECK (build_kind IN ('full', 'incremental', 'repair', 'reindex')),
  requested_by TEXT NOT NULL,
  requested_from_env TEXT NOT NULL CHECK (requested_from_env IN ('local', 'preview', 'prod', 'operator')),
  status TEXT NOT NULL CHECK (status IN ('building', 'built', 'validated', 'published', 'failed', 'abandoned', 'superseded')),
  source_snapshot_total INT NOT NULL DEFAULT 0,
  documents_built INT NOT NULL DEFAULT 0,
  chunks_built INT NOT NULL DEFAULT 0,
  memory_entries_built INT NOT NULL DEFAULT 0,
  embeddings_built INT NOT NULL DEFAULT 0,
  validation_passed BOOLEAN NOT NULL DEFAULT false,
  validation_summary_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  error_message TEXT,
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (knowledge_space, repo_id, branch, build_version)
);

CREATE INDEX IF NOT EXISTS idx_kb_builds_lookup
  ON kb_builds(knowledge_space, repo_id, branch, status, updated_at DESC);

CREATE TABLE IF NOT EXISTS kb_publications (
  knowledge_space TEXT NOT NULL,
  repo_id UUID NOT NULL REFERENCES kb_repo_registrations(id) ON DELETE CASCADE,
  branch TEXT NOT NULL,
  published_build_version TEXT NOT NULL,
  published_head TEXT NOT NULL,
  published_by TEXT NOT NULL,
  published_from_env TEXT NOT NULL CHECK (published_from_env IN ('local', 'preview', 'prod', 'operator')),
  published_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (knowledge_space, repo_id, branch)
);

CREATE INDEX IF NOT EXISTS idx_kb_publications_repo_branch
  ON kb_publications(repo_id, branch, knowledge_space, published_at DESC);

CREATE TABLE IF NOT EXISTS kb_build_validation_results (
  id UUID PRIMARY KEY,
  build_id UUID NOT NULL REFERENCES kb_builds(id) ON DELETE CASCADE,
  validation_kind TEXT NOT NULL,
  passed BOOLEAN NOT NULL,
  severity TEXT NOT NULL CHECK (severity IN ('info', 'warn', 'error')),
  summary TEXT NOT NULL,
  details_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_kb_build_validation_results_build
  ON kb_build_validation_results(build_id, created_at DESC);

CREATE TABLE IF NOT EXISTS kb_ingest_leases (
  lease_key TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  owner_env TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_kb_ingest_leases_expiry
  ON kb_ingest_leases(expires_at, updated_at DESC);
