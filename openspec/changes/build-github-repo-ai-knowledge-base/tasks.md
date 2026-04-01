## 1. Repository Access and Sync Foundation

- [x] 1.1 Define repository registration config (repo URL, branch, include/exclude paths, polling interval) and validate at service startup
- [x] 1.2 Implement read-only GitHub client with scope validation and outbound policy guardrails (block write endpoints)
- [x] 1.3 Create PostgreSQL schema for sync jobs, sync checkpoints, and snapshot metadata
- [x] 1.4 Implement full-sync orchestrator flow (enqueue, run, checkpoint commit SHA, status transitions)

## 2. Incremental Synchronization Pipeline

- [x] 2.1 Implement GitHub webhook endpoint for push events with signature verification and branch filtering
- [x] 2.2 Implement polling fallback worker to detect head SHA drift and enqueue incremental sync
- [x] 2.3 Implement commit-range diff resolver for added/modified/deleted files
- [x] 2.4 Add idempotency keys and retry/backoff policy for sync jobs

## 3. Parsing, Chunking, and Index Upsert

- [x] 3.1 Implement Markdown parser that preserves heading hierarchy, code blocks, and tables
- [x] 3.2 Implement structural chunker with deterministic chunk ID generation and overlap strategy
- [x] 3.3 Create PostgreSQL schema for documents, chunks, embedding metadata, and active/inactive flags
- [x] 3.4 Implement document/chunk upsert logic with deletion handling for removed source files

## 4. Embedding and Hybrid Index Construction

- [x] 4.1 Integrate OpenAI-compatible embedding client with model/version tracking per chunk
- [x] 4.2 Implement embedding worker queue with transient failure retry and dead-letter handling
- [x] 4.3 Add pgvector index strategy and PostgreSQL full-text (`tsvector` + GIN) indexing pipeline
- [x] 4.4 Implement index maintenance jobs for re-embed and reindex operations

## 5. Retrieval API and Profile Behavior

- [x] 5.1 Define retrieval API contract for query input, profile selection (`search`/`agent`), and response schema
- [x] 5.2 Implement vector retrieval candidate generator and keyword retrieval candidate generator
- [x] 5.3 Implement hybrid ranking (fusion + metadata boosts) with profile-specific thresholds/top-k
- [x] 5.4 Add source citation payload fields (`repo`, `branch`, `path`, `source_url`, `commit_sha`) in every hit

## 6. Low-Confidence Fallback and Quality Controls

- [x] 6.1 Implement confidence scoring and threshold policy per retrieval profile
- [x] 6.2 Implement low-confidence read-through fallback that fetches GitHub content in read-only mode
- [x] 6.3 Annotate fallback results (`fallback_used`) and ensure fallback snippets include citations
- [x] 6.4 Add retrieval quality evaluation scripts for precision/recall sampling and threshold tuning

## 7. Operations, Security, and Delivery

- [x] 7.1 Add Docker deployment definitions for API, workers, and PostgreSQL with pgvector
- [x] 7.2 Add observability (sync lag, indexing throughput, retrieval latency, fallback rate, error rates)
- [x] 7.3 Add integration tests for full sync, incremental sync, idempotent replay, and deletion propagation
- [x] 7.4 Add security/compliance tests that assert no GitHub write operation is reachable in runtime paths
