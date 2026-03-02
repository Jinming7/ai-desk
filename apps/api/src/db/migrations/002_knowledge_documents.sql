CREATE TABLE IF NOT EXISTS knowledge_documents (
  id UUID PRIMARY KEY,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  domain TEXT NOT NULL,
  visibility TEXT NOT NULL,
  quality TEXT NOT NULL,
  actionability TEXT NOT NULL,
  product_area TEXT NOT NULL,
  version_range TEXT,
  risk_level TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_kd_domain_visibility_quality
  ON knowledge_documents(domain, visibility, quality);

CREATE INDEX IF NOT EXISTS idx_kd_fulltext
  ON knowledge_documents
  USING GIN (to_tsvector('english', title || ' ' || content));

INSERT INTO knowledge_documents (
  id, title, content, domain, visibility, quality, actionability, product_area, version_range, risk_level
)
SELECT
  'c8b0de59-7a39-44d4-b0be-a6b9e1b3d511',
  'Troubleshoot SSO Login Callback Failures',
  'If users are redirected back to login after SSO callback, verify callback URL, tenant mapping, and system clock skew. Capture browser console and request ID for support follow-up.',
  'public_kb',
  'customer',
  'verified',
  'troubleshooting',
  'auth',
  'all',
  'medium'
WHERE NOT EXISTS (
  SELECT 1 FROM knowledge_documents WHERE id = 'c8b0de59-7a39-44d4-b0be-a6b9e1b3d511'
);

INSERT INTO knowledge_documents (
  id, title, content, domain, visibility, quality, actionability, product_area, version_range, risk_level
)
SELECT
  'a84716d4-37b8-4cb5-b870-1e2a0f2ef071',
  'Reset API Token and Validate Integration Access',
  'For 401 or permission errors, rotate API token, confirm workspace-level access, and retest with curl before opening a ticket.',
  'public_kb',
  'customer',
  'verified',
  'howto',
  'api',
  'all',
  'low'
WHERE NOT EXISTS (
  SELECT 1 FROM knowledge_documents WHERE id = 'a84716d4-37b8-4cb5-b870-1e2a0f2ef071'
);
