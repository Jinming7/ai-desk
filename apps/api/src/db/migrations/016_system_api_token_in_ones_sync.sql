ALTER TABLE ones_sync_config
  ADD COLUMN IF NOT EXISTS system_auth_secret_encrypted TEXT;
