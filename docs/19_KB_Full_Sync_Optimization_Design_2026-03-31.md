# KB Full Sync Optimization Design

Date: 2026-03-31

Status: proposed

Owner scope: `docs-com` full sync architecture hardening, throughput optimization, and database-safe rollout

Primary objective:

- guarantee KB quality first
- guarantee no database pollution during full sync
- complete `docs-com` full sync within `2-3 hours` under production serverless constraints
- preserve current customer-facing support quality during rollout

## Executive Summary

The recommended design is:

- keep `BangWork/docs-com` as the only canonical KB source
- keep `kb_documents` and `kb_chunks` as the grounding layer
- keep `knowledge memory graph` as the primary retrieval layer target
- stop treating one linear `full sync` chain as the unit of work
- introduce a `run-based`, `sharded`, `finalize-only` full sync architecture

The key design decision is:

- do **not** optimize by blindly increasing batch size
- do **not** optimize by writing final checkpoint early
- do **not** optimize by allowing partial runs to mutate serving state
- optimize by:
  - one immutable `target_head`
  - one `full sync run`
  - three independent prefix shards
  - reuse of already-correct artifacts
  - atomic finalize
  - stable external drain

The three shards are:

- `deploy-docs`
- `docs`
- `open-docs`

This is the only practical path that simultaneously satisfies:

- finish in `2-3 hours`
- avoid restart/idempotency collisions
- avoid deactivation mistakes
- avoid checkpoint drift
- avoid serving mixed broken state to runtime retrieval

## 1. Background And Current Findings

## 1.1 Current Production Shape

Current `docs-com` sync is driven by:

- `GET /api/v1/internal/kb/docs-com/status`
- `POST /api/v1/internal/kb/docs-com/ensure`
- `POST /api/v1/internal/kb/sync/full`
- `POST /api/v1/internal/kb/sync/run`

Current job execution semantics:

- a `full` job processes one batch
- if unfinished, it enqueues one continuation job with a `cursor`
- `sync/run` only claims `queued` jobs
- serverless runtime does not keep an in-process loop alive by default

Relevant implementation locations:

- [apps/api/src/modules/github-kb/service.ts](/Users/jeremypeng/Downloads/Workspace/TicketManagement/apps/api/src/modules/github-kb/service.ts)
- [apps/api/src/modules/github-kb/repository.ts](/Users/jeremypeng/Downloads/Workspace/TicketManagement/apps/api/src/modules/github-kb/repository.ts)
- [apps/api/src/modules/github-kb/github-client.ts](/Users/jeremypeng/Downloads/Workspace/TicketManagement/apps/api/src/modules/github-kb/github-client.ts)
- [apps/api/src/app.ts](/Users/jeremypeng/Downloads/Workspace/TicketManagement/apps/api/src/app.ts)
- [apps/api/src/config/runtime-env.ts](/Users/jeremypeng/Downloads/Workspace/TicketManagement/apps/api/src/config/runtime-env.ts)
- [vercel.json](/Users/jeremypeng/Downloads/Workspace/TicketManagement/vercel.json)

## 1.2 Measured Constraints

Observed on current production chain:

- `GITHUB_KB_REMOTE_SYNC_BATCH_SIZE = 8`
- Vercel function `maxDuration = 300s`
- recent full batches average about `232.6s`
- recent slow batches reached about `341s`
- current effective throughput is about `123.8 docs/hour/lane`

Implications:

- current single-lane design needs about `5.3h` for full `656` docs
- increasing batch size is not the main answer because current batch time is already near the runtime limit
- throughput must come mainly from controlled parallelism and reuse, not larger single batches

## 1.3 Current Defects

The current design has five structural defects.

### Defect A: Continuation identity is not run-scoped

Continuation idempotency currently keys on:

- `mode`
- `repo`
- `branch`
- `head`
- `cursor`

It does not key on:

- `full sync run id`
- `logical shard`

Result:

- restarting from an older cursor can collide with historical `succeeded` continuation rows
- a new full run can be silently swallowed by old idempotency keys

### Defect B: Cursor is global and lexicographic

Current full sync walks one sorted global path list.

Result:

- if the chain resumes inside `docs/...`, it never naturally goes back to missing earlier `deploy-docs/...`
- historical gaps before the cursor are invisible to the current continuation chain

### Defect C: Full checkpoint is the only durable completion marker

Current checkpoint semantics are correct for completion, but insufficient for progress.

Result:

- a batch `succeeded` does not prove the full run finished
- progress visibility depends on job chain archaeology instead of explicit run state

### Defect D: Serving state and build state are not separated

Current full sync writes directly into serving tables:

- `kb_documents`
- `kb_chunks`

Result:

- a partially completed full run can mutate serving records before the run is complete
- there is no atomic activation boundary for a new full snapshot

### Defect E: Remote full sync repeatedly lists the entire tree

Current full batches call `listFilesAtCommit()` per batch, then slice the same full snapshot again.

Result:

- repeated GitHub tree reads
- avoidable CPU and network overhead
- increased runtime per batch without increasing actual progress

## 2. Goals And Non-Goals

## 2.1 Goals

The design must satisfy all of the following:

1. preserve KB correctness above all throughput considerations
2. prevent database pollution during partial or failed full runs
3. guarantee `last_full_synced_commit_sha` is written only after a truly complete full run
4. finish full sync in `2-3 hours`
5. preserve or improve current customer-facing retrieval quality
6. allow safe interruption, resume, retry, and rollback
7. allow explicit progress visibility by shard and by run

## 2.2 Non-Goals

This design does not aim to:

- change support-agent answer formatting
- replace `BangWork/docs-com` as source of truth
- introduce a new customer-facing answer path
- use local docs mirror in production
- trade correctness for raw ingestion speed

## 3. Design Principles

## 3.1 Quality Before Speed

Speed is useful only if:

- the resulting corpus is complete
- citations remain grounded
- retrieval quality does not regress

## 3.2 No Partial Run May Corrupt Serving State

An unfinished full run must never:

- publish an incomplete active snapshot
- write a false final checkpoint
- deactivate valid serving documents

## 3.3 Full Sync Completion Is A Run-Level Property

Completion belongs to:

- one `run_id`
- one `target_head`
- all required shards

It does not belong to:

- one batch
- one cursor
- one continuation job

## 3.4 Reuse Before Recompute

If an existing artifact is already correct for the target head, reuse it.

Do not rebuild:

- documents
- chunks
- memory artifacts
- embeddings

unless the artifact is missing, stale, or invalid.

## 3.5 Memory-First Direction, Retrieval-Safe Rollout

Repository design direction is:

- `memory graph` as primary retrieval layer

But current production code still performs hybrid retrieval:

- memory
- lexical
- vector

Therefore:

- the full sync optimization must not assume vector dependence has already been fully removed
- the rollout must preserve current retrieval quality until runtime retrieval is fully memory-first

## 4. Target Architecture

The optimized design introduces five additional layers of control.

## Layer 1. Run Coordination

New:

- `kb_sync_runs`
- `kb_sync_run_shards`
- `kb_sync_manifest_items`

Purpose:

- define one immutable full sync run against one immutable target head
- persist progress explicitly
- separate planning from execution

## Layer 2. Staged Build Identity

New concept:

- `build_version`

Format:

- `${targetHead}:${runId}`

Purpose:

- tag all artifacts created by one full sync run
- allow atomic switch from old serving snapshot to new serving snapshot

## Layer 3. Safe Serving Pointer

New:

- `kb_serving_versions`

Purpose:

- record which `build_version` is currently visible to retrieval for a given repo/branch
- allow fast rollback by switching a pointer instead of mutating all rows

## Layer 4. Sharded Executors

New:

- one logical executor lane per shard

Shards:

- `deploy-docs`
- `docs`
- `open-docs`

Purpose:

- parallelize safely
- prevent earlier-prefix starvation
- keep ETA bounded by the slowest shard rather than the whole corpus

## Layer 5. Finalize-Only Activation

New:

- one explicit finalizer step after all shards succeed

Purpose:

- activate new build atomically
- write final checkpoint atomically
- run deactivation atomically

## 5. Data Model

## 5.1 `kb_sync_runs`

```sql
CREATE TABLE kb_sync_runs (
  id UUID PRIMARY KEY,
  repo_id UUID NOT NULL REFERENCES kb_repo_registrations(id) ON DELETE CASCADE,
  branch TEXT NOT NULL,
  sync_mode TEXT NOT NULL CHECK (sync_mode = 'full'),
  target_head TEXT NOT NULL,
  source_snapshot_total INT NOT NULL,
  status TEXT NOT NULL CHECK (
    status IN ('planned', 'running', 'finalizing', 'succeeded', 'failed', 'cancelled')
  ),
  requested_by TEXT NOT NULL,
  run_reason TEXT,
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (repo_id, branch, sync_mode, target_head, status)
);
```

Notes:

- at most one active `running/finalizing` full run per repo/branch
- `target_head` is immutable once the run starts

## 5.2 `kb_sync_run_shards`

```sql
CREATE TABLE kb_sync_run_shards (
  id UUID PRIMARY KEY,
  run_id UUID NOT NULL REFERENCES kb_sync_runs(id) ON DELETE CASCADE,
  repo_id UUID NOT NULL REFERENCES kb_repo_registrations(id) ON DELETE CASCADE,
  branch TEXT NOT NULL,
  shard_key TEXT NOT NULL CHECK (shard_key IN ('deploy-docs', 'docs', 'open-docs')),
  prefix TEXT NOT NULL,
  total_docs INT NOT NULL,
  completed_docs INT NOT NULL DEFAULT 0,
  reusable_docs INT NOT NULL DEFAULT 0,
  rebuilt_docs INT NOT NULL DEFAULT 0,
  failed_docs INT NOT NULL DEFAULT 0,
  next_cursor TEXT,
  status TEXT NOT NULL CHECK (
    status IN ('planned', 'queued', 'running', 'succeeded', 'failed')
  ),
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  last_heartbeat_at TIMESTAMPTZ,
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (run_id, shard_key)
);
```

## 5.3 `kb_sync_manifest_items`

```sql
CREATE TABLE kb_sync_manifest_items (
  id UUID PRIMARY KEY,
  run_id UUID NOT NULL REFERENCES kb_sync_runs(id) ON DELETE CASCADE,
  repo_id UUID NOT NULL REFERENCES kb_repo_registrations(id) ON DELETE CASCADE,
  branch TEXT NOT NULL,
  target_head TEXT NOT NULL,
  path TEXT NOT NULL,
  shard_key TEXT NOT NULL,
  blob_sha TEXT NOT NULL,
  size_bytes INT NOT NULL DEFAULT 0,
  needs_rebuild BOOLEAN NOT NULL DEFAULT true,
  reuse_reason TEXT,
  build_status TEXT NOT NULL DEFAULT 'pending' CHECK (
    build_status IN ('pending', 'reused', 'rebuilt', 'failed')
  ),
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (run_id, path)
);
```

Purpose:

- freeze the exact source snapshot at run start
- avoid repeated `listFilesAtCommit()` on every batch
- support reuse planning before execution begins

## 5.4 `kb_serving_versions`

```sql
CREATE TABLE kb_serving_versions (
  repo_id UUID NOT NULL REFERENCES kb_repo_registrations(id) ON DELETE CASCADE,
  branch TEXT NOT NULL,
  active_build_version TEXT NOT NULL,
  active_head TEXT NOT NULL,
  activated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (repo_id, branch)
);
```

Purpose:

- define the only build visible to runtime retrieval

## 5.5 Serving Build Columns

The following tables need build identity:

- `kb_documents`
- `kb_chunks`
- `kb_memory_entries`
- `kb_memory_sources`
- `kb_memory_aliases`
- `kb_memory_signals`
- `kb_memory_profiles`

For `kb_memory_*`, `build_version` already exists or is aligned with the current design direction.

For `kb_documents` and `kb_chunks`, add:

```sql
ALTER TABLE kb_documents ADD COLUMN build_version TEXT;
ALTER TABLE kb_chunks ADD COLUMN build_version TEXT;
```

Then adjust uniqueness to support parallel versions:

- current `UNIQUE (repo_id, branch, path)` on `kb_documents` is not sufficient
- current model must move to version-aware uniqueness

Recommended target uniqueness:

- `kb_documents UNIQUE (repo_id, branch, path, build_version)`
- `kb_chunks PRIMARY KEY (id)` may remain, but chunk ids should include build identity or deterministic doc/version identity

## 5.6 Why Versioned Serving Is Required

Without versioned serving, a partial run can:

- overwrite current serving rows in place
- leave mixed `old_head + new_head` state visible to retrieval
- make rollback expensive and error-prone

With versioned serving:

- new run writes only to a new `build_version`
- retrieval continues reading the old serving version
- finalize atomically flips the serving pointer
- rollback is a pointer switch, not a mass rewrite

This is the core anti-pollution mechanism.

## 6. Run Lifecycle

## 6.1 Run Initialization

When `ensure(mode=full)` or a new explicit `full run create` endpoint is called:

1. resolve active registration and branch
2. fetch immutable `target_head`
3. fetch remote tree once
4. build manifest of allowed markdown paths
5. classify each path into shard:
   - `deploy-docs/...`
   - `docs/...`
   - `open-docs/...`
6. compute reuse plan
7. create one `kb_sync_runs` row
8. create three `kb_sync_run_shards` rows
9. enqueue one initial execution job per shard

No serving state is changed in this step.

## 6.2 Reuse Planning

For each manifest item, determine one of:

- `reusable_complete`
- `needs_doc_rebuild`
- `needs_chunk_rebuild`
- `needs_memory_rebuild`
- `needs_embedding_backfill_only`

Recommended reuse rules:

### Reusable Complete

A path is reusable for the new run when all are true:

- there is an existing document version for the same `target_head`
- document content hash matches current source content hash, or source blob SHA matches a stored artifact fingerprint
- required chunk set exists and is internally complete
- required memory graph artifacts exist for the same build head or are independently version-safe
- if retrieval runtime still depends on vectors, required embeddings for active chunks exist or are explicitly accepted as non-blocking by rollout policy

### Needs Rebuild

Rebuild when any of these are true:

- path does not exist in serving data
- path exists but commit/build does not match target head
- document/chunk artifact set is incomplete
- memory graph artifacts are missing or stale
- integrity verification fails

## 6.3 Shard Execution

Each shard executes against only its own manifest subset.

Each shard batch:

1. read next `N` manifest items for this shard where `build_status='pending'`
2. for reusable items:
   - mark `build_status='reused'`
   - increment `reusable_docs`
3. for rebuild items:
   - fetch file content
   - write document version for `build_version`
   - build chunk versions for `build_version`
   - build memory graph artifacts for `build_version`
   - handle embedding according to rollout policy
   - mark `build_status='rebuilt'`
4. update shard progress
5. enqueue continuation for the same `run_id + shard_key` if remaining

## 6.4 Finalization

A run may enter `finalizing` only when all three shard rows are `succeeded`.

Finalizer steps:

1. verify every manifest item is either `reused` or `rebuilt`
2. verify no shard has `failed_docs > 0`
3. verify all required memory artifacts for the new build are active and complete
4. verify retrieval-visible integrity checks pass
5. compute deactivation set:
   - all paths in old active build not present in new manifest
6. atomically:
   - set new `active_build_version`
   - set new `active_head`
   - write `last_synced_commit_sha`
   - write `last_full_synced_commit_sha`
   - mark old build inactive from serving perspective
   - mark run `succeeded`

Only this step changes what retrieval serves.

## 7. Execution Model And Job Identity

## 7.1 Replace Global Cursor Identity

Current continuation key:

- `sync-continuation:full:${repo}:${branch}:${head}:${cursor}`

Recommended continuation key:

- `sync-continuation:full:${runId}:${shardKey}:${head}:${cursor}`

Benefits:

- no collisions with previous historical runs
- no accidental reuse of stale `succeeded` continuation rows
- explicit shard ownership

## 7.2 Job Payload

Recommended full job payload:

```json
{
  "runId": "uuid",
  "shardKey": "docs",
  "cursor": "docs/ones-project/...",
  "targetHead": "47a873...",
  "buildVersion": "47a873...:run-uuid",
  "requestedBy": "internal_operator",
  "allowEmbeddingInline": true
}
```

## 7.3 Dispatch Rules

At claim time:

- at most one `running` job per `run_id + shard_key`
- total concurrent full jobs per repo/branch defaults to `3`
- one lane per shard

This keeps concurrency bounded and predictable.

## 8. Full Sync Read/Write Pipeline

## 8.1 Source Snapshot

At run start, call remote tree API once:

- `listFilesAtCommit(target_head)`

Persist:

- `path`
- `blob_sha`
- `size`
- `shard_key`

Do not re-list full tree inside every batch.

## 8.2 Document Build

For rebuild items:

1. fetch file content
2. normalize content
3. compute content hash
4. write versioned document row

## 8.3 Chunk Build

For rebuild items:

1. parse sections
2. build chunks
3. write versioned chunk rows
4. mark chunk completeness for the manifest item

## 8.4 Memory Build

For rebuild items:

1. extract memory entries from chunk set
2. write memory entries, aliases, signals, sources
3. build relations and profiles
4. keep build_version isolated from serving until finalize

This aligns with:

- [docs/15_AI_Support_Knowledge_Memory_Retrieval_Optimized_Design_2026-03-27.md](/Users/jeremypeng/Downloads/Workspace/TicketManagement/docs/15_AI_Support_Knowledge_Memory_Retrieval_Optimized_Design_2026-03-27.md)
- [docs/16_AI_Support_Knowledge_Memory_Retrieval_Implementation_Spec_2026-03-27.md](/Users/jeremypeng/Downloads/Workspace/TicketManagement/docs/16_AI_Support_Knowledge_Memory_Retrieval_Implementation_Spec_2026-03-27.md)

## 8.5 Embedding Policy

The repository direction is memory-first, but current runtime still performs hybrid retrieval.

Therefore the recommended rollout policy is:

### Phase 1 Policy

- do **not** make embedding the critical path for already-reusable docs
- preserve existing valid embeddings by reuse
- for rebuilt docs:
  - keep inline embedding enabled while runtime still depends on vector candidates
  - if an embedding fails transiently, mark chunk `embedding_state='pending'`
  - enqueue embedding backfill for that chunk

### Phase 2 Policy

Only after runtime retrieval is verified to be memory-first and vector-optional:

- remove embedding from full sync critical path entirely
- run embeddings as asynchronous enrichment only

This avoids a quality regression while still allowing full sync throughput to improve.

## 9. Anti-Pollution Guarantees

This section is the most important part of the design.

## 9.1 Pollution Definition

Database pollution means any of the following:

- serving retrieval sees a half-built new snapshot
- final checkpoint claims full completion when only partial work finished
- old valid docs are deactivated before new snapshot is complete
- wrong source head or wrong source mode is published
- a failed run leaves serving pointers in a mixed or ambiguous state

## 9.2 Required Guards

The optimized design must enforce all of these guards:

1. one immutable `target_head` per run
2. one immutable `build_version` per run
3. no final checkpoint writes before run finalization
4. no deactivation before run finalization
5. retrieval always filters by `active_build_version`
6. all new artifacts carry `build_version`
7. only the finalizer may advance serving pointer
8. rollback is pointer-based, not content-rewrite-based
9. stale or failed runs never become serving-visible

## 9.3 Why Current In-Place Upsert Is Insufficient

Current full sync upserts `kb_documents` and `kb_chunks` in place.

That is acceptable for incremental mutation against the current active build, but not for a high-safety full rebuild because:

- a partial run can expose mixed-head state
- serving and build concerns are coupled
- rollback is difficult

Therefore versioned serving is not optional if strict anti-pollution is required.

## 10. Throughput Strategy

## 10.1 Why Sharding Is The Main Lever

Measured current throughput:

- about `123.8 docs/hour/lane`

Approximate full-corpus times by prefix at current throughput:

- `deploy-docs 107` -> about `0.86h`
- `docs 306` -> about `2.47h`
- `open-docs 243` -> about `1.96h`

With three lanes, total runtime is bounded by the slowest shard:

- about `2.47h`

This already fits the target window.

## 10.2 Why Bigger Batch Size Is Not The Main Lever

Current batch size `8` already produces:

- average `232.6s`
- slow cases above `300s`

Given `maxDuration=300s`, larger batches increase timeout risk more than they increase reliable throughput.

Recommended default:

- keep batch size near current value during first rollout
- gain throughput through shard concurrency and reuse
- only tune batch size after per-shard latency stabilizes

## 10.3 Reuse Impact

If the system reuses already-valid artifacts:

- already-correct docs are marked complete without content fetch, chunking, or embedding
- actual wall-clock runtime becomes less than the raw `2.47h` estimate

This is the second major lever after sharding.

## 11. Scheduling And Drain

## 11.1 Current Constraint

In serverless mode:

- background loops do not stay alive
- `sync/run` must be triggered externally

## 11.2 Recommended Dispatcher

Use one formal external drain source:

- Vercel cron, or
- dedicated lightweight worker

Recommended cadence:

- every `5-10 seconds`

Recommended claim limit:

- `3-4`

Recommended concurrency:

- max `3` concurrent full jobs for `docs-com`
- one per shard

## 11.3 Dispatch Rules

`sync/run` should:

- prefer `queued` jobs for active runs
- avoid claiming multiple jobs for the same shard simultaneously
- mark stale running jobs back to queued after heartbeat timeout

## 12. Status And Observability

## 12.1 New Status Shape

Extend `docs-com/status` to include:

- current active full run
- run target head
- serving build version
- per-shard totals
- per-shard completed counts
- per-shard ETA
- reusable vs rebuilt counts
- failed docs count
- finalize readiness

## 12.2 Required Metrics

Emit at least:

- `kb_full_run_started`
- `kb_full_run_finalized`
- `kb_full_run_failed`
- `kb_full_shard_docs_total`
- `kb_full_shard_docs_reused`
- `kb_full_shard_docs_rebuilt`
- `kb_full_shard_duration_seconds`
- `kb_full_finalize_duration_seconds`
- `kb_embedding_backfill_pending`

## 12.3 Required Alerts

Alert when:

- any full shard has no heartbeat for `> 10 min`
- any active run exceeds `4h`
- any run reaches `failed`
- finalize preconditions fail
- serving build version and checkpoint head diverge

## 13. API Contract Changes

## 13.1 Keep Existing Endpoints

Continue supporting:

- `POST /api/v1/internal/kb/docs-com/ensure`
- `POST /api/v1/internal/kb/sync/run`
- `GET /api/v1/internal/kb/docs-com/status`

## 13.2 Add Run-Oriented Endpoints

Recommended additions:

- `POST /api/v1/internal/kb/sync/full-runs`
  - create a new run
- `POST /api/v1/internal/kb/sync/full-runs/:runId/finalize`
  - manual finalize retry if needed
- `GET /api/v1/internal/kb/sync/full-runs/:runId`
  - detailed run status
- `GET /api/v1/internal/kb/sync/full-runs/:runId/manifest`
  - manifest inspection

These are operator-focused, not customer-facing.

## 14. Migration Plan

The migration should be split into safe phases.

## Phase 0. Preconditions

- local mirror remains disabled in production
- current `docs-com` registration and repo id are verified
- current checkpoint remains the serving source of truth until new finalize logic exists

## Phase 1. Add Coordination Tables

Add:

- `kb_sync_runs`
- `kb_sync_run_shards`
- `kb_sync_manifest_items`
- `kb_serving_versions`

This phase is additive and safe.

## Phase 2. Add Build Versioning

Add `build_version` support to:

- `kb_documents`
- `kb_chunks`

Introduce version-aware uniqueness and queries.

This is the most important schema migration.

## Phase 3. Read Path Gating

Update retrieval queries to filter by:

- active `build_version` from `kb_serving_versions`

Do not yet change full sync execution semantics in this phase.

## Phase 4. Run-Based Full Sync Writer

Implement:

- run initialization
- manifest generation
- reuse planning
- shard execution
- run-scoped continuation ids

Still keep old path disabled or behind feature flag.

## Phase 5. Finalizer

Implement:

- finalize checks
- serving pointer switch
- checkpoint switch
- deactivation by manifest diff

## Phase 6. External Drain

Enable:

- cron or dedicated worker

Do not rely on ad hoc manual drain after this phase.

## Phase 7. Rollout

Rollout order:

1. staging
2. one controlled production run
3. confirm serving pointer switch
4. confirm checkpoint correctness
5. confirm search quality
6. retire old full sync path

## 15. Rollback Plan

Rollback must be pointer-based.

If a new build is bad:

1. identify prior `active_build_version`
2. switch `kb_serving_versions.active_build_version` back
3. leave bad build data non-serving
4. mark the failed run for cleanup

Do not rollback by:

- mass deleting docs
- mass deleting chunks
- forcing checkpoint backward without serving pointer rollback

## 16. Cleanup Plan

After successful finalize and a retention window:

- old non-serving builds may be garbage-collected

Recommended retention:

- keep at least `1` prior successful build
- keep failed builds for operator inspection for `24-72h`

Cleanup scope:

- old `kb_documents` versions
- old `kb_chunks` versions
- old memory build artifacts
- completed run metadata beyond retention

## 16.1 Implementation Priority

Recommended implementation order inside engineering delivery:

### Priority 0

- versioned serving model
- finalizer-only checkpoint activation
- run-scoped continuation ids

Without these three items, the design still retains database pollution risk.

### Priority 1

- manifest snapshot table
- shard execution
- external drain

These three items are the main throughput levers required for the `2-3 hour` target.

### Priority 2

- reuse classifier
- status and ETA visibility
- alerts and metrics

These improve runtime efficiency and operability.

### Priority 3

- embedding async backfill
- batch-size tuning
- cleanup automation

These are optimizations, not launch blockers.

## 16.2 Pre-Production Smoke Validation

Before enabling the new full sync path in production, run all of the following in staging or an isolated environment:

1. create a full run against a fixed head with a known manifest
2. confirm three shard rows are created and can progress independently
3. kill one shard mid-run and verify:
   - serving build version does not change
   - checkpoint does not change
   - deactivation does not run
4. resume the failed shard and verify the same run can complete
5. finalize the run and verify:
   - serving pointer flips once
   - checkpoint head equals target head
   - old build remains query-invisible but recoverable
6. rollback to previous build version and verify retrieval still works
7. run one customer-facing retrieval smoke suite for:
   - Chinese troubleshooting
   - OAuth callback and baseURL issues
   - permission or scope questions
   - `open-docs` OpenAPI retrieval

Production rollout should not begin until all seven checks pass.

## 17. Acceptance Criteria

The optimization is complete only when all are true:

1. one full run finishes within `2-3 hours`
2. all three shards complete successfully
3. `last_full_synced_commit_sha` equals the run `target_head`
4. `docs-com/status` shows:
   - correct source totals
   - correct active totals
   - non-null final checkpoint
   - no shard gaps
5. retrieval serves only the new `active_build_version`
6. rollback to previous build has been verified once
7. no customer-facing grounded answer regression is observed in smoke checks

## 18. Recommended Immediate Delivery Scope

To maximize outcome and minimize risk, the first implementation should include:

1. run tables
2. shard tables
3. manifest table
4. build version for documents and chunks
5. serving version pointer
6. run-scoped continuation keys
7. finalize-only checkpoint write
8. external drain

The first implementation should **not** include:

- aggressive batch-size tuning
- embedding removal from runtime retrieval
- new answer-generation branches

## 19. Final Recommendation

If the objective is:

- high-quality KB
- no database pollution
- full sync done in `2-3 hours`

then the recommended architecture is:

- `versioned serving + run-scoped sharded full sync + atomic finalize`

This is the minimum design that is both:

- fast enough
- safe enough

Anything smaller than this may improve throughput, but will not reliably guarantee both:

- production-grade correctness
- production-grade anti-pollution behavior
