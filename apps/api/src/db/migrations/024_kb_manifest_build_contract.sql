ALTER TABLE kb_sync_manifest_items
  ADD COLUMN IF NOT EXISTS source_family TEXT,
  ADD COLUMN IF NOT EXISTS content_checksum TEXT,
  ADD COLUMN IF NOT EXISTS source_acquisition_mode TEXT NOT NULL DEFAULT 'remote',
  ADD COLUMN IF NOT EXISTS skip_reason TEXT;

ALTER TABLE kb_sync_manifest_items
  DROP CONSTRAINT IF EXISTS kb_sync_manifest_items_build_status_check;

ALTER TABLE kb_sync_manifest_items
  ADD CONSTRAINT kb_sync_manifest_items_build_status_check
  CHECK (build_status IN ('pending', 'reused', 'rebuilt', 'failed', 'skipped'));

ALTER TABLE kb_sync_manifest_items
  DROP CONSTRAINT IF EXISTS kb_sync_manifest_items_source_acquisition_mode_check;

ALTER TABLE kb_sync_manifest_items
  ADD CONSTRAINT kb_sync_manifest_items_source_acquisition_mode_check
  CHECK (source_acquisition_mode IN ('remote', 'local_mirror'));

CREATE INDEX IF NOT EXISTS idx_kb_sync_manifest_skip_reason
  ON kb_sync_manifest_items(run_id, build_status, skip_reason, path);
