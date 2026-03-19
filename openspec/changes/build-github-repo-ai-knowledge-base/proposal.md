## Why

The ticket system needs a reliable AI knowledge base grounded in an existing GitHub repository, but current retrieval lacks a structured indexing pipeline and deterministic source attribution. We need this now to support AI Search and AI Agent retrieval at scale without scanning the repository on every query.

## What Changes

- Introduce a read-only GitHub ingestion subsystem that can clone/fetch repository content and metadata without any write operations to GitHub.
- Add a full-sync and incremental-sync pipeline (webhook-first with polling fallback) to keep external knowledge indexes fresh.
- Add Markdown-focused parsing and structural chunking with stable chunk identity for idempotent upsert.
- Add embedding generation via OpenAI-compatible API and dual indexing in PostgreSQL (pgvector + full-text search).
- Add a unified retrieval service and API that supports two retrieval profiles: AI Search and AI Agent.
- Add source citation in retrieval responses, including repository, file path, commit SHA, and canonical URL.
- Add low-confidence fallback that performs read-only GitHub source fetch for supplemental context.
- Add operational controls for sync observability, retry, backfill, deduplication, and consistency checks.

## Capabilities

### New Capabilities
- `github-readonly-repo-ingestion`: Read repository content and commit metadata safely with strict read-only access controls.
- `knowledge-sync-and-indexing-pipeline`: Build and maintain document/chunk/embedding indexes through full and incremental sync.
- `hybrid-retrieval-and-citation-api`: Serve hybrid retrieval for AI Search/Agent profiles with confidence-aware fallback and citations.

### Modified Capabilities
- None.

## Impact

- Backend services: new ingestion worker, parser/chunker, embedding worker, retrieval API service, and sync scheduler.
- Data layer: PostgreSQL schema additions for repository snapshots, documents, chunks, embeddings, lexical indexes, and sync state.
- Infrastructure: GitHub webhook endpoint, queue/worker execution path, and Docker deployment updates.
- AI integration: unified retrieval contract for AI Search and AI Agent workflows with ranking and source-grounded responses.
