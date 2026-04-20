ALTER TABLE kb_builds
  ADD COLUMN IF NOT EXISTS promoted_from_build_id UUID REFERENCES kb_builds(id) ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS idx_kb_builds_promoted_from
  ON kb_builds(promoted_from_build_id)
  WHERE promoted_from_build_id IS NOT NULL;
