## Context

We need an external AI knowledge system for a ticket platform, using an existing GitHub repository as the single source of truth. The repository is strictly read-only from this system's perspective, and the platform must avoid query-time repository scans. The target stack is Python/FastAPI, PostgreSQL + pgvector + full-text search, OpenAI-compatible embedding API, and Docker deployment.

The solution must support two consumers with different retrieval needs:
- AI Search: fast, concise, precision-biased retrieval.
- AI Agent: broader context, higher recall, and richer citation/fallback behavior.

## Goals / Non-Goals

**Goals:**
- Build a read-only ingestion path from GitHub repository to external knowledge indexes.
- Support initial full sync and continuous incremental sync (webhook-first, polling fallback).
- Parse Markdown docs into structured, traceable chunks and generate embeddings.
- Provide hybrid retrieval (vector + keyword) with unified API and profile-specific behavior.
- Return source-grounded citations (`repo`, `path`, `url`, `commit_sha`).
- Support low-confidence read-only source fetch from GitHub for supplemental context.
- Ensure idempotent sync/index updates and deterministic conflict handling.

**Non-Goals:**
- Writing any data back to GitHub (commits/PR/issues/comments/files).
- Real-time query-time full repository traversal.
- Cross-repository federation in this phase.
- End-user chat orchestration or answer generation policy (retrieval only).

## Decisions

### 1) Component Architecture
Use five deployable modules:
- `api-gateway` (FastAPI): retrieval and sync control APIs.
- `sync-orchestrator` (worker): schedules full/incremental sync jobs.
- `ingestion-worker` (worker): fetches GitHub tree/content and emits normalized documents.
- `indexer-worker` (worker): chunking, embedding, and index upsert.
- `postgres` (single data plane): metadata tables + `pgvector` + full-text indexes.

Supporting infrastructure:
- GitHub webhook receiver endpoint inside `api-gateway`.
- Queue (Postgres-backed job table or Redis queue; default Postgres job table to reduce dependencies).

Rationale: clear separation of concerns with minimal operational footprint in Docker.

### 2) Read-Only GitHub Access Model
Use GitHub App or fine-grained PAT with read-only scopes:
- `contents:read`
- `metadata:read`
- optional `pull_requests:read` only if PR metadata is needed later

All write APIs are disallowed in code via an explicit outbound allowlist (GET-only routes) and credential policy.

Rationale: enforce source-of-truth + least privilege by design and implementation.

### 3) Sync Model (Full + Incremental)
- Full sync: fetch configured branch head SHA, traverse repo tree, pull eligible files, compute document fingerprints, and upsert snapshot.
- Incremental sync:
  - Primary: GitHub webhook (`push`) triggers delta job with before/after SHAs.
  - Fallback: polling branch head SHA every N minutes; if changed, compute diff by commit range.

Rationale: webhook provides freshness; polling provides reliability when webhook delivery fails.

### 4) Data Versioning and Idempotency
Store indexing by `(repo_id, branch, commit_sha)` snapshot lineage.
- `documents` keyed by stable `doc_key = repo:path` plus current `content_hash`.
- `chunks` keyed by deterministic `chunk_id = sha256(doc_key + heading_path + chunk_ordinal + chunk_hash)`.
- Upsert semantics (`ON CONFLICT`) for all mutable entities.
- Soft-delete stale documents/chunks when removed from source.

Rationale: deterministic identity guarantees idempotent retries and safe reprocessing.

### 5) Parsing and Chunking
Primary parser: Markdown AST with structural awareness.
Chunking rules:
- Split by heading hierarchy first.
- Preserve fenced code blocks and tables as atomic chunks where feasible.
- Target chunk size ~300-800 tokens with overlap 40-80 tokens.
- Record metadata: heading path, section order, file type, language hints.

Rationale: improves semantic retrieval quality and citation explainability.

### 6) Indexing Strategy
For each chunk:
- Store `content`, metadata, and `embedding vector` in pgvector column.
- Store normalized lexical text in `tsvector` column using PostgreSQL FTS.
- Build HNSW/IVFFlat index for vectors (choose by data size; start with HNSW for latency) and GIN index for FTS.

Rationale: hybrid search combines semantic recall with precise keyword matching.

### 7) Retrieval Profiles and Ranking
Unified `/v1/retrieval/query` endpoint with `profile` parameter:
- `search` profile: smaller `top_k`, stricter score thresholds, prioritize precision.
- `agent` profile: larger `top_k`, allow broader recall and diversity.

Hybrid ranking pipeline:
1. Vector candidate retrieval.
2. FTS candidate retrieval.
3. Reciprocal rank fusion + metadata priors (path/title boosts).
4. Confidence scoring and cutoff.

Rationale: one API surface, differentiated behavior by use case.

### 8) Low-Confidence Read-Through Fallback
If hybrid confidence is below threshold:
- Fetch read-only GitHub raw content for top candidate paths or nearby files.
- Re-chunk in-memory (no immediate persistent write required unless async backfill enabled).
- Return fallback results with explicit `fallback_used=true` and citation tags.

Rationale: improve answerability while preserving non-realtime full-scan constraint.

### 9) Citation Contract
Each hit must return:
- `repo`
- `branch`
- `path`
- `commit_sha`
- `source_url` (blob URL with commit SHA)
- optional `line_span` if parser can track offsets

Rationale: ensures traceability and trust for AI Search/Agent consumers.

### 10) Operational Controls
- Job states: `queued/running/succeeded/failed/dead-letter`.
- Retry with exponential backoff and idempotency keys.
- Metrics: sync lag, indexed docs/chunks, embedding failure rate, retrieval latency, low-confidence rate.
- Admin APIs for backfill, reindex, and sync status.

Rationale: production-safe operation and troubleshooting.

## Risks / Trade-offs

- [Webhook missed or delayed] -> Mitigation: polling fallback + periodic reconciliation full scan.
- [Embedding model drift causes ranking instability] -> Mitigation: model version fields + rolling re-embed jobs.
- [Large markdown files degrade chunk quality] -> Mitigation: adaptive chunk size and section-level truncation policy.
- [Hot branch churn increases indexing load] -> Mitigation: debounce windows and commit coalescing.
- [PostgreSQL index growth] -> Mitigation: partitioning by repo/branch and archival of old snapshots.
- [Read-only policy regression in code changes] -> Mitigation: egress policy tests and integration guardrails for forbidden GitHub write routes.

## Migration Plan

1. Provision PostgreSQL with pgvector and required extensions.
2. Deploy `api-gateway`, `sync-orchestrator`, `ingestion-worker`, `indexer-worker` via Docker Compose.
3. Configure read-only GitHub credentials and repo/branch registry.
4. Run first full sync and validate document/chunk/embedding counts.
5. Enable webhook endpoint and polling fallback.
6. Enable retrieval API for AI Search first, then AI Agent profile.
7. Monitor quality/latency metrics and tune chunking/ranking thresholds.

Rollback:
- Disable sync jobs and webhook consumer.
- Switch retrieval endpoint to previous backend.
- Keep indexed data for postmortem, then purge by snapshot if required.

## Open Questions

- Should incremental sync index per commit immediately or batch by time window (for high-commit repos)?
- What confidence threshold should trigger fallback per profile (`search` vs `agent`)?
- Is line-level citation mandatory in v1 or acceptable as path-level citation only?
