ALTER TABLE kb_documents
  ADD COLUMN IF NOT EXISTS build_version TEXT;

UPDATE kb_documents
SET build_version = commit_sha
WHERE build_version IS NULL;

ALTER TABLE kb_documents
  ALTER COLUMN build_version SET NOT NULL;

ALTER TABLE kb_chunks
  ADD COLUMN IF NOT EXISTS build_version TEXT;

UPDATE kb_chunks
SET build_version = commit_sha
WHERE build_version IS NULL;

ALTER TABLE kb_chunks
  ALTER COLUMN build_version SET NOT NULL;

ALTER TABLE kb_documents
  DROP CONSTRAINT IF EXISTS kb_documents_repo_id_branch_path_key;

ALTER TABLE kb_documents
  ADD CONSTRAINT kb_documents_repo_id_branch_path_build_version_key
  UNIQUE (repo_id, branch, path, build_version);

CREATE INDEX IF NOT EXISTS idx_kb_docs_build_version
  ON kb_documents(repo_id, branch, build_version, is_active, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_kb_chunks_build_version
  ON kb_chunks(repo_id, branch, build_version, is_active, updated_at DESC);

CREATE TABLE IF NOT EXISTS kb_sync_runs (
  id UUID PRIMARY KEY,
  repo_id UUID NOT NULL REFERENCES kb_repo_registrations(id) ON DELETE CASCADE,
  branch TEXT NOT NULL,
  sync_mode TEXT NOT NULL CHECK (sync_mode = 'full'),
  target_head TEXT NOT NULL,
  source_snapshot_total INT NOT NULL,
  status TEXT NOT NULL CHECK (
    status IN ('planned', 'running', 'finalizing', 'succeeded', 'failed', 'cancelled')
  ),
  requested_by TEXT NOT NULL,
  run_reason TEXT,
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_kb_sync_runs_active_full
  ON kb_sync_runs(repo_id, branch)
  WHERE sync_mode = 'full' AND status IN ('planned', 'running', 'finalizing');

CREATE INDEX IF NOT EXISTS idx_kb_sync_runs_lookup
  ON kb_sync_runs(repo_id, branch, created_at DESC);

CREATE TABLE IF NOT EXISTS kb_sync_run_shards (
  id UUID PRIMARY KEY,
  run_id UUID NOT NULL REFERENCES kb_sync_runs(id) ON DELETE CASCADE,
  repo_id UUID NOT NULL REFERENCES kb_repo_registrations(id) ON DELETE CASCADE,
  branch TEXT NOT NULL,
  shard_key TEXT NOT NULL CHECK (shard_key IN ('deploy-docs', 'docs', 'open-docs')),
  prefix TEXT NOT NULL,
  total_docs INT NOT NULL,
  completed_docs INT NOT NULL DEFAULT 0,
  reusable_docs INT NOT NULL DEFAULT 0,
  rebuilt_docs INT NOT NULL DEFAULT 0,
  failed_docs INT NOT NULL DEFAULT 0,
  next_cursor TEXT,
  status TEXT NOT NULL CHECK (
    status IN ('planned', 'queued', 'running', 'succeeded', 'failed')
  ),
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  last_heartbeat_at TIMESTAMPTZ,
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (run_id, shard_key)
);

CREATE INDEX IF NOT EXISTS idx_kb_sync_run_shards_lookup
  ON kb_sync_run_shards(run_id, status, shard_key);

CREATE TABLE IF NOT EXISTS kb_sync_manifest_items (
  id UUID PRIMARY KEY,
  run_id UUID NOT NULL REFERENCES kb_sync_runs(id) ON DELETE CASCADE,
  repo_id UUID NOT NULL REFERENCES kb_repo_registrations(id) ON DELETE CASCADE,
  branch TEXT NOT NULL,
  target_head TEXT NOT NULL,
  path TEXT NOT NULL,
  shard_key TEXT NOT NULL CHECK (shard_key IN ('deploy-docs', 'docs', 'open-docs')),
  blob_sha TEXT NOT NULL,
  size_bytes INT NOT NULL DEFAULT 0,
  needs_rebuild BOOLEAN NOT NULL DEFAULT true,
  reuse_reason TEXT,
  build_status TEXT NOT NULL DEFAULT 'pending' CHECK (
    build_status IN ('pending', 'reused', 'rebuilt', 'failed')
  ),
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (run_id, path)
);

CREATE INDEX IF NOT EXISTS idx_kb_sync_manifest_shard_status
  ON kb_sync_manifest_items(run_id, shard_key, build_status, path);

CREATE TABLE IF NOT EXISTS kb_serving_versions (
  repo_id UUID NOT NULL REFERENCES kb_repo_registrations(id) ON DELETE CASCADE,
  branch TEXT NOT NULL,
  active_build_version TEXT NOT NULL,
  active_head TEXT NOT NULL,
  activated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (repo_id, branch)
);
