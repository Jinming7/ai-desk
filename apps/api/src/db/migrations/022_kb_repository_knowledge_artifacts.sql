CREATE TABLE IF NOT EXISTS kb_openapi_operations (
  id UUID PRIMARY KEY,
  knowledge_space TEXT NOT NULL,
  repo_id UUID NOT NULL REFERENCES kb_repo_registrations(id) ON DELETE CASCADE,
  branch TEXT NOT NULL,
  build_version TEXT NOT NULL,
  source_doc_id UUID NOT NULL REFERENCES kb_documents(id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  method TEXT NOT NULL,
  route_path TEXT NOT NULL,
  operation_id TEXT,
  summary TEXT,
  description TEXT,
  request_schema_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  response_schema_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  auth_scopes TEXT[] NOT NULL DEFAULT '{}'::text[],
  tags TEXT[] NOT NULL DEFAULT '{}'::text[],
  error_shapes_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  source_location_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (knowledge_space, repo_id, branch, build_version, method, route_path, operation_id)
);

CREATE INDEX IF NOT EXISTS idx_kb_openapi_operations_build
  ON kb_openapi_operations(knowledge_space, repo_id, branch, build_version, method, route_path);

CREATE TABLE IF NOT EXISTS kb_code_symbols (
  id UUID PRIMARY KEY,
  knowledge_space TEXT NOT NULL,
  repo_id UUID NOT NULL REFERENCES kb_repo_registrations(id) ON DELETE CASCADE,
  branch TEXT NOT NULL,
  build_version TEXT NOT NULL,
  source_doc_id UUID NOT NULL REFERENCES kb_documents(id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  language TEXT NOT NULL,
  symbol_kind TEXT NOT NULL,
  symbol_name TEXT NOT NULL,
  qualified_name TEXT NOT NULL,
  parent_symbol TEXT,
  start_line INT NOT NULL,
  end_line INT NOT NULL,
  signature_text TEXT NOT NULL,
  doc_comment TEXT,
  body_summary TEXT,
  dependency_refs_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (knowledge_space, repo_id, branch, build_version, path, qualified_name, start_line, end_line)
);

CREATE INDEX IF NOT EXISTS idx_kb_code_symbols_build
  ON kb_code_symbols(knowledge_space, repo_id, branch, build_version, path, symbol_kind);

CREATE TABLE IF NOT EXISTS kb_config_surfaces (
  id UUID PRIMARY KEY,
  knowledge_space TEXT NOT NULL,
  repo_id UUID NOT NULL REFERENCES kb_repo_registrations(id) ON DELETE CASCADE,
  branch TEXT NOT NULL,
  build_version TEXT NOT NULL,
  source_doc_id UUID NOT NULL REFERENCES kb_documents(id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  config_kind TEXT NOT NULL,
  config_key TEXT NOT NULL,
  normalized_key TEXT NOT NULL,
  default_value TEXT,
  description TEXT,
  required_for_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  related_components_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  source_location_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (knowledge_space, repo_id, branch, build_version, path, normalized_key)
);

CREATE INDEX IF NOT EXISTS idx_kb_config_surfaces_build
  ON kb_config_surfaces(knowledge_space, repo_id, branch, build_version, path, normalized_key);

CREATE TABLE IF NOT EXISTS kb_schema_objects (
  id UUID PRIMARY KEY,
  knowledge_space TEXT NOT NULL,
  repo_id UUID NOT NULL REFERENCES kb_repo_registrations(id) ON DELETE CASCADE,
  branch TEXT NOT NULL,
  build_version TEXT NOT NULL,
  source_doc_id UUID NOT NULL REFERENCES kb_documents(id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  object_kind TEXT NOT NULL,
  schema_name TEXT,
  object_name TEXT NOT NULL,
  normalized_name TEXT NOT NULL,
  definition_summary TEXT NOT NULL,
  related_tables_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  source_location_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (knowledge_space, repo_id, branch, build_version, path, object_kind, normalized_name)
);

CREATE INDEX IF NOT EXISTS idx_kb_schema_objects_build
  ON kb_schema_objects(knowledge_space, repo_id, branch, build_version, path, object_kind);

CREATE TABLE IF NOT EXISTS kb_test_behaviors (
  id UUID PRIMARY KEY,
  knowledge_space TEXT NOT NULL,
  repo_id UUID NOT NULL REFERENCES kb_repo_registrations(id) ON DELETE CASCADE,
  branch TEXT NOT NULL,
  build_version TEXT NOT NULL,
  source_doc_id UUID NOT NULL REFERENCES kb_documents(id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  behavior_key TEXT NOT NULL,
  title TEXT NOT NULL,
  summary TEXT NOT NULL,
  assertions_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  signals_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  source_location_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (knowledge_space, repo_id, branch, build_version, path, behavior_key)
);

CREATE INDEX IF NOT EXISTS idx_kb_test_behaviors_build
  ON kb_test_behaviors(knowledge_space, repo_id, branch, build_version, path, behavior_key);

CREATE TABLE IF NOT EXISTS kb_citation_units (
  id UUID PRIMARY KEY,
  knowledge_space TEXT NOT NULL,
  repo_id UUID NOT NULL REFERENCES kb_repo_registrations(id) ON DELETE CASCADE,
  branch TEXT NOT NULL,
  build_version TEXT NOT NULL,
  source_doc_id UUID NOT NULL REFERENCES kb_documents(id) ON DELETE CASCADE,
  citation_family TEXT NOT NULL,
  source_family TEXT NOT NULL,
  source_artifact_type TEXT NOT NULL,
  source_artifact_id UUID,
  citation_key TEXT NOT NULL,
  path TEXT NOT NULL,
  title TEXT NOT NULL,
  heading_path TEXT,
  snippet_text TEXT NOT NULL,
  source_location_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  authority_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  embedding vector,
  embedding_model TEXT,
  embedding_version TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (knowledge_space, repo_id, branch, build_version, citation_key)
);

CREATE INDEX IF NOT EXISTS idx_kb_citation_units_build
  ON kb_citation_units(knowledge_space, repo_id, branch, build_version, citation_family, path);

CREATE TABLE IF NOT EXISTS kb_memory_citations (
  memory_id UUID NOT NULL REFERENCES kb_memory_entries(id) ON DELETE CASCADE,
  citation_id UUID NOT NULL REFERENCES kb_citation_units(id) ON DELETE CASCADE,
  source_score NUMERIC(8,6) NOT NULL DEFAULT 1,
  source_metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (memory_id, citation_id)
);

CREATE INDEX IF NOT EXISTS idx_kb_memory_citations_citation
  ON kb_memory_citations(citation_id);
