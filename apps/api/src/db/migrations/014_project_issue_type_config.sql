CREATE TABLE IF NOT EXISTS ones_project_issue_type_configs (
  id UUID PRIMARY KEY,
  project_key TEXT NOT NULL,
  issue_type_key TEXT NOT NULL,
  issue_type_name TEXT NOT NULL,
  enabled_for_customer BOOLEAN NOT NULL DEFAULT false,
  field_schema_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  status_mapping_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(project_key, issue_type_key)
);

CREATE INDEX IF NOT EXISTS idx_ones_project_issue_type_configs_project
  ON ones_project_issue_type_configs(project_key, enabled_for_customer, updated_at DESC);
