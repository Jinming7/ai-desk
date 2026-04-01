ALTER TABLE kb_repo_registrations
  ADD COLUMN IF NOT EXISTS public_base_url TEXT;

ALTER TABLE kb_documents
  ADD COLUMN IF NOT EXISTS repo_source_url TEXT;

ALTER TABLE kb_documents
  ADD COLUMN IF NOT EXISTS public_source_url TEXT;

UPDATE kb_documents
SET repo_source_url = COALESCE(repo_source_url, source_url)
WHERE repo_source_url IS NULL;

UPDATE kb_documents
SET public_source_url = COALESCE(public_source_url, source_url)
WHERE public_source_url IS NULL;

ALTER TABLE kb_documents
  ALTER COLUMN repo_source_url SET NOT NULL;

ALTER TABLE ai_search_references
  ADD COLUMN IF NOT EXISTS repo_source_url TEXT;

ALTER TABLE ai_search_references
  ADD COLUMN IF NOT EXISTS repo TEXT;

ALTER TABLE ai_search_references
  ADD COLUMN IF NOT EXISTS path TEXT;

ALTER TABLE ai_search_references
  ADD COLUMN IF NOT EXISTS commit_sha TEXT;
