# KB Async Embedding Gated Publish Design

**Date:** 2026-04-03

**Status:** Approved for future implementation

**Owner intent:** improve KB build throughput by decoupling artifact persistence from embedding execution, without weakening publication truth, rollback safety, or snapshot coherence.

---

## Goal

Allow the KB build pipeline to persist repository-derived artifacts first and execute embedding generation asynchronously, while preserving these invariants:

- runtime reads only one published snapshot
- `build_version` remains the coherence boundary for retrieval, validation, evaluation, and rollback
- unfinished or partially embedded builds never become runtime-visible by accident
- published snapshots never drift in-place after publication

## Problem Statement

Current build execution performs some embedding work inline during document indexing. That keeps build semantics simple, but it serializes network-bound embedding calls into the hottest ingest path.

This creates two different concerns:

1. structural ingest latency
2. embedding completeness and retrieval quality

Those concerns should be separated operationally, but they must still converge before publication.

## Approved Design

### 1. Build stages

The build pipeline is split logically into:

1. snapshot resolution
2. manifest generation
3. structured artifact persistence
4. embedding task creation
5. asynchronous embedding execution
6. build validation
7. explicit publication

Artifacts may be written before embeddings complete. Publication may not happen before embedding work reaches a terminal state for the build.

### 2. Serving truth

Serving semantics do not change:

- runtime still resolves the active build through `kb_publications`
- `kb_serving_versions` must still match the published build
- no row-level `is_active` signal becomes serving truth
- if no publication exists, runtime remains `KB unavailable`

### 3. Snapshot immutability rule

The critical rule is:

`No embedding worker may mutate a build after that build becomes published.`

This rule exists because otherwise one `published_build_version` would change over time without a new publication event, which would break:

- reproducible evaluation
- rollback semantics
- operator reasoning about snapshot quality

### 4. Embedding policy model

Each embedding-enabled family must be configured as one of:

- `disabled`
- `best_effort`
- `required`

Policy meaning:

- `disabled`: no embedding tasks are created
- `best_effort`: embedding tasks run, failures are recorded, validation may still pass if all tasks are terminal
- `required`: validation must fail or remain blocked until required tasks complete successfully

Important constraint:

- even `best_effort` tasks must be terminal before publication
- a build may validate with missing best-effort embeddings
- a build may not publish while best-effort tasks are still pending/running

### 5. Initial embedding scope

Initial target families:

- `kb_chunks`
- retrieval text derived from `kb_memory_entries`

Later optional target families:

- selected `kb_openapi_operations`
- selected `kb_code_symbols`
- other canonical artifacts only when runtime retrieval actually consumes them

Explicit non-goal:

- do not return to blanket embedding of all citation rows

### 6. Task model

Implementation should introduce a build-scoped embedding task ledger with enough information to support:

- idempotent enqueue
- retry after transient provider/database failure
- per-family policy
- terminal failure recording
- cleanup visibility

Minimum conceptual fields:

- `knowledge_space`
- `repo_id`
- `branch`
- `build_version`
- `target_family`
- `target_table`
- `target_row_id`
- `embedding_model`
- `embedding_version`
- `policy`
- `status`
- `attempt_count`
- `lease/ownership`
- `last_error`

### 7. Build lifecycle

Recommended lifecycle without adding serving ambiguity:

1. build starts in `building`
2. structural ingest completes
3. embedding tasks are enqueued
4. async workers drain embedding backlog
5. when all embedding tasks are terminal, validation runs
6. build becomes `validated` or `failed`
7. publication remains explicit and separate

Existing build statuses can remain:

- `building`
- `built`
- `validated`
- `published`
- `failed`
- `abandoned`

If a dedicated intermediate status is added later, it must not weaken publication safety and is not required for the initial implementation.

### 8. Validation rules

Validation must add build-scoped embedding checks that distinguish:

- `pending`
- `ready`
- `failed`
- `skipped`

Publication must be blocked if either of the following is true:

- any `required` embedding target is not ready
- any embedding task for the build is still pending or running

This preserves snapshot immutability at publish time.

### 9. Cleanup and release integration

Cleanup dry-run and release status must surface embedding task state so operators can see:

- whether a build is still waiting on embeddings
- whether failures are best-effort or blocking
- whether a rollback target has complete embedding state

### 10. Runtime impact

Runtime retrieval remains hybrid:

- lexical retrieval continues to work when some best-effort embeddings are missing
- vector retrieval reads only the published build's vectors
- publication-scoped reads remain mandatory

This design improves build throughput without changing runtime truth.

## Rejected Alternatives

### A. Publish first, backfill embeddings later

Rejected because it causes the published snapshot to drift in-place.

### B. Skip embeddings entirely for production

Rejected because repository-native retrieval is expected to benefit from embeddings, especially for paraphrase, mixed-language matching, and semantic bridging.

### C. Query-time embedding of repository artifacts

Rejected because the repository docs already require embedding to belong to build-scoped artifacts, not ad-hoc runtime mutation.

## Sequencing Decision

This design is approved, but it is not inserted into the current Phase 1 closure mid-flight.

Execution order:

1. finish the current real non-prod build-only validation gate
2. prove one non-prod validated and published snapshot exists
3. implement async embedding before production rollout if the enabled embedding families depend on it for acceptable build throughput

## Verification Requirements

Implementation is only acceptable if it proves all of the following:

- embedding task enqueue is idempotent across retries
- transient worker failure can resume without cross-build corruption
- validation blocks publication while embedding work is pending
- best-effort failures are persisted and visible
- published builds never receive post-publication embedding writes
- cleanup dry-run reports pending/failed embedding state coherently
- rollback targets retain stable embedding completeness metadata

## Required Tests

- unit tests for embedding task policy resolution
- integration tests for async enqueue and retry semantics
- integration tests proving publication is blocked by pending required embeddings
- integration tests proving published builds cannot be mutated by late workers
- release/cleanup tests proving operator surfaces report embedding readiness correctly

## Out Of Scope

- production rollout itself
- destructive cleanup
- switching runtime truth away from publication
- widening embedding scope to every citation row
