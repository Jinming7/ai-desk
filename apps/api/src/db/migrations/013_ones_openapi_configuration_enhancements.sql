ALTER TABLE ones_sync_config
  ADD COLUMN IF NOT EXISTS endpoint_templates_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS allowed_ticket_type_keys JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS status_mapping_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS workflow_mapping_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS config_version INT NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS publish_state TEXT NOT NULL DEFAULT 'draft',
  ADD COLUMN IF NOT EXISTS publish_checks_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS change_reason TEXT,
  ADD COLUMN IF NOT EXISTS rolled_back_from UUID;

UPDATE ones_sync_config
SET
  endpoint_templates_json = COALESCE(endpoint_templates_json, '{}'::jsonb),
  allowed_ticket_type_keys = COALESCE(allowed_ticket_type_keys, '[]'::jsonb),
  status_mapping_json = COALESCE(status_mapping_json, '{}'::jsonb),
  workflow_mapping_json = COALESCE(workflow_mapping_json, '{}'::jsonb),
  publish_state = COALESCE(NULLIF(publish_state, ''), 'draft'),
  publish_checks_json = COALESCE(publish_checks_json, '{}'::jsonb),
  config_version = COALESCE(config_version, 1);

CREATE INDEX IF NOT EXISTS idx_ones_sync_config_active_version
  ON ones_sync_config (is_active, config_version DESC, updated_at DESC);
