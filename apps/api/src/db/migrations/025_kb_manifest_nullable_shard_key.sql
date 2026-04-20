ALTER TABLE kb_sync_manifest_items
  ALTER COLUMN shard_key DROP NOT NULL;

ALTER TABLE kb_sync_manifest_items
  DROP CONSTRAINT IF EXISTS kb_sync_manifest_items_shard_key_check;

ALTER TABLE kb_sync_manifest_items
  ADD CONSTRAINT kb_sync_manifest_items_shard_key_check
  CHECK (shard_key IS NULL OR shard_key IN ('deploy-docs', 'docs', 'open-docs'));
