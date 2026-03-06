ALTER TABLE ones_sync_config
  ADD COLUMN IF NOT EXISTS list_projects_path TEXT NOT NULL DEFAULT '/api/v1/projects';
