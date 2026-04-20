DO $$
BEGIN
  CREATE EXTENSION IF NOT EXISTS pg_trgm;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'pg_trgm extension is not available: %', SQLERRM;
END $$;

CREATE TABLE IF NOT EXISTS kb_memory_entries (
  id UUID PRIMARY KEY,
  repo_id UUID NOT NULL REFERENCES kb_repo_registrations(id) ON DELETE CASCADE,
  branch TEXT NOT NULL,
  doc_id UUID NOT NULL REFERENCES kb_documents(id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  memory_kind TEXT NOT NULL,
  title TEXT,
  canonical_claim TEXT NOT NULL,
  summary TEXT NOT NULL,
  product_area TEXT NOT NULL DEFAULT 'general',
  doc_kind TEXT NOT NULL DEFAULT 'general',
  action_type TEXT,
  deployment_model TEXT,
  object_type TEXT,
  is_static BOOLEAN NOT NULL DEFAULT false,
  is_latest BOOLEAN NOT NULL DEFAULT true,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'superseded', 'inactive')),
  build_version TEXT NOT NULL,
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  search_text TEXT NOT NULL,
  search_vector TSVECTOR,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_kb_memory_entries_active
  ON kb_memory_entries(repo_id, branch, status, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_kb_memory_entries_doc
  ON kb_memory_entries(doc_id, memory_kind, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_kb_memory_entries_kind
  ON kb_memory_entries(product_area, doc_kind, memory_kind, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_kb_memory_entries_search
  ON kb_memory_entries USING GIN (search_vector);

CREATE INDEX IF NOT EXISTS idx_kb_memory_entries_claim_trgm
  ON kb_memory_entries USING GIN (canonical_claim gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_kb_memory_entries_summary_trgm
  ON kb_memory_entries USING GIN (summary gin_trgm_ops);

CREATE TABLE IF NOT EXISTS kb_memory_sources (
  memory_id UUID NOT NULL REFERENCES kb_memory_entries(id) ON DELETE CASCADE,
  doc_id UUID NOT NULL REFERENCES kb_documents(id) ON DELETE CASCADE,
  chunk_id TEXT NOT NULL REFERENCES kb_chunks(id) ON DELETE CASCADE,
  heading_path TEXT NOT NULL,
  source_score NUMERIC(8,6) NOT NULL DEFAULT 1,
  source_metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (memory_id, chunk_id)
);

CREATE INDEX IF NOT EXISTS idx_kb_memory_sources_chunk
  ON kb_memory_sources(chunk_id);

CREATE INDEX IF NOT EXISTS idx_kb_memory_sources_doc
  ON kb_memory_sources(doc_id, memory_id);

CREATE TABLE IF NOT EXISTS kb_memory_relations (
  id UUID PRIMARY KEY,
  from_memory_id UUID NOT NULL REFERENCES kb_memory_entries(id) ON DELETE CASCADE,
  to_memory_id UUID NOT NULL REFERENCES kb_memory_entries(id) ON DELETE CASCADE,
  relation_type TEXT NOT NULL CHECK (relation_type IN ('updates', 'extends', 'derives')),
  weight NUMERIC(8,6) NOT NULL DEFAULT 1,
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (from_memory_id, to_memory_id, relation_type)
);

CREATE INDEX IF NOT EXISTS idx_kb_memory_rel_from
  ON kb_memory_relations(from_memory_id, relation_type);

CREATE INDEX IF NOT EXISTS idx_kb_memory_rel_to
  ON kb_memory_relations(to_memory_id, relation_type);

CREATE TABLE IF NOT EXISTS kb_memory_aliases (
  id UUID PRIMARY KEY,
  memory_id UUID NOT NULL REFERENCES kb_memory_entries(id) ON DELETE CASCADE,
  alias TEXT NOT NULL,
  alias_type TEXT NOT NULL,
  weight NUMERIC(8,6) NOT NULL DEFAULT 1,
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (memory_id, alias, alias_type)
);

CREATE INDEX IF NOT EXISTS idx_kb_memory_aliases_memory
  ON kb_memory_aliases(memory_id);

CREATE INDEX IF NOT EXISTS idx_kb_memory_aliases_alias_trgm
  ON kb_memory_aliases USING GIN (alias gin_trgm_ops);

CREATE TABLE IF NOT EXISTS kb_memory_signals (
  id UUID PRIMARY KEY,
  memory_id UUID NOT NULL REFERENCES kb_memory_entries(id) ON DELETE CASCADE,
  signal_type TEXT NOT NULL,
  signal_value TEXT NOT NULL,
  weight NUMERIC(8,6) NOT NULL DEFAULT 1,
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (memory_id, signal_type, signal_value)
);

CREATE INDEX IF NOT EXISTS idx_kb_memory_signals_type_value
  ON kb_memory_signals(signal_type, signal_value);

CREATE INDEX IF NOT EXISTS idx_kb_memory_signals_value_trgm
  ON kb_memory_signals USING GIN (signal_value gin_trgm_ops);

CREATE TABLE IF NOT EXISTS kb_memory_profiles (
  id UUID PRIMARY KEY,
  repo_id UUID NOT NULL REFERENCES kb_repo_registrations(id) ON DELETE CASCADE,
  branch TEXT NOT NULL,
  profile_key TEXT NOT NULL,
  profile_kind TEXT NOT NULL,
  title TEXT NOT NULL,
  static_summary TEXT NOT NULL,
  dynamic_summary TEXT,
  build_version TEXT NOT NULL,
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (repo_id, branch, profile_key, build_version)
);

CREATE INDEX IF NOT EXISTS idx_kb_memory_profiles_active
  ON kb_memory_profiles(repo_id, branch, is_active, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_kb_memory_profiles_key
  ON kb_memory_profiles(profile_key);
