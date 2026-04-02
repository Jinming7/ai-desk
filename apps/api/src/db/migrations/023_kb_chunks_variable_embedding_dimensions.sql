DROP INDEX IF EXISTS idx_kb_chunks_embedding_hnsw;

ALTER TABLE kb_chunks
  ALTER COLUMN embedding TYPE vector
  USING CASE
    WHEN embedding IS NULL THEN NULL
    ELSE embedding::vector
  END;

CREATE INDEX IF NOT EXISTS idx_kb_chunks_embedding_model_build
  ON kb_chunks(knowledge_space, repo_id, branch, build_version, embedding_model)
  WHERE embedding IS NOT NULL;
