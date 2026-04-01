# AI Support Agent Rebuild Plan Part 02

Date: 2026-04-01

Status: implementation-ready design

Required pre-read:

1. `/Users/jeremypeng/Downloads/Workspace/TicketManagement/AGENTS.md`
2. `/Users/jeremypeng/Downloads/Workspace/TicketManagement/docs/20_AI_Support_Agent_Rebuild_Part_01_System_Model_And_Single_DB_Publishing.md`

This part must be implemented together with the constraints defined in `AGENTS.md` and Part 01.

If this document appears to conflict with Part 01, Part 01 wins unless Part 01 is explicitly revised first.

Scope:

- redesign the KB build and publication substrate for a single shared database
- define full sync and incremental sync semantics
- define staging, validation, and publication rules
- define the cleanup and repair plan for the already polluted corpus
- define the implementation order, migration plan, and verification plan

This document is intentionally detailed because later AI developers will use it directly for implementation.

---

## 1. What This Part Delivers

Part 01 froze the architecture contract.

Part 02 turns that contract into an implementable systems design for:

- same-database environment isolation
- build lifecycle
- publication lifecycle
- full sync state machine
- incremental sync state machine
- repair of current corrupted KB state

This part is the first rebuild document that **can and should lead to code changes**.

However, implementation must still follow the phased order defined here.

Do not jump directly to runtime retrieval changes before finishing the substrate work in this document.

---

## 2. Why This Part Must Come First

Current confirmed production facts:

- no active serving snapshot pointer exists
- runtime falls back to `is_active`
- failed or incomplete builds remain active together
- local and preview would be unsafe under the current model because the DB is shared
- memory artifacts are also accumulated across many build versions

That means:

- retrieval quality work on top of current data would be invalid
- answer quality work on top of current data would be invalid
- embedding enablement on top of current data would also be invalid

Therefore the first real implementation phase must rebuild:

1. build isolation
2. publication boundaries
3. sync state transitions
4. repair and cleanup

Only after that should retrieval redesign proceed.

---

## 3. Design Objectives

Part 02 must satisfy all of the following.

### 3.1 Single shared DB must become safe

The same database must safely support:

- local development
- preview deployment
- production deployment
- background repair or rebuild jobs

### 3.2 No unfinished build may become runtime-visible

Writing build artifacts is allowed.

Serving them before publication is forbidden.

### 3.3 Runtime must read exactly one published snapshot

Every runtime KB query must resolve through:

- `knowledge_space`
- `repo_id`
- `branch`
- published `build_version`

### 3.4 Full sync and incremental sync must become idempotent and restart-safe

This includes:

- crash safety
- continuation safety
- duplicate job safety
- rerun safety
- stale-running-job safety
- publication safety

### 3.5 Existing polluted state must be repairable with minimal risk

The system must provide an ordered cleanup strategy that:

- does not destroy valid source artifacts unnecessarily
- does not publish half-built state
- does not require a second database
- allows recovery if repair is interrupted

---

## 4. Current Confirmed Root Causes This Part Fixes

This section is implementation guidance and should be treated as the direct defect list.

### 4.1 `staged` does not actually mean staged

Current code path:

- `indexDocumentContent()` accepts `activationMode`
- full sync uses `activationMode: "staged"`
- but underlying document and chunk upserts still set `is_active = true`

Result:

- staged artifacts become live immediately

This must be eliminated.

### 4.2 Runtime serving pointer is absent

Current DB state:

- `kb_serving_versions` empty
- `kb_sync_checkpoints` empty

Result:

- runtime query methods fall back to `is_active = true`

This fallback must be removed from serving semantics.

### 4.3 Publication is not treated as a first-class transition

Current intended architecture wants:

- run-based full sync
- shard-based work
- finalize-only activation

But actual behavior still lets row-level writes determine visibility.

This part replaces that with explicit publication objects.

### 4.4 Historical failed builds remain logically active

Current DB confirms:

- old builds
- failed builds
- partially running builds

all contribute active rows.

This proves artifact lifecycle and publication lifecycle are not being separated.

### 4.5 Memory lifecycle is coupled incorrectly to active rows

Current memory rows are accumulated across many build versions and remain active together.

This proves the same publication boundary problem exists above the raw corpus layer too.

---

## 5. Final Same-Database Isolation Model

This section is normative.

All later tables and transitions must obey it.

## 5.1 Isolation dimensions

The new isolation model is based on:

- `knowledge_space`
- `repo_id`
- `branch`
- `build_version`

These dimensions together replace “whatever is active” as the meaning of runtime visibility.

## 5.2 Required knowledge spaces

At minimum:

- `support-prod`
- `support-preview`
- `support-local`

Optional future spaces:

- `support-shadow`
- `support-eval`

## 5.3 Runtime visibility policy

### Production runtime

Must read only:

- `knowledge_space = support-prod`
- current published build for that repo and branch

### Preview runtime

Must read only:

- `knowledge_space = support-preview`
- current published build for that repo and branch

### Local runtime

Must read only:

- `knowledge_space = support-local`
- current published build for that repo and branch

Local tools may be given explicit diagnostic routes to inspect other spaces, but the customer-facing runtime path must never read across spaces by default.

## 5.4 Publication authority policy

### Local worker

May publish only to:

- `support-local`

### Preview worker

May publish only to:

- `support-preview`

### Production worker

May publish only to:

- `support-prod`

### Operator override

Cross-space publication is allowed only through an explicit authenticated operator endpoint with audit trail.

It must never happen implicitly by normal worker execution.

---

## 6. New Core Tables And Table Semantics

This section defines the minimum required schema changes.

It is acceptable to keep existing tables and add columns rather than fully replacing them, but the semantics below must be preserved.

## 6.1 `kb_builds`

Purpose:

- represent one isolated knowledge build

Required fields:

- `id UUID PRIMARY KEY`
- `knowledge_space TEXT NOT NULL`
- `repo_id UUID NOT NULL`
- `branch TEXT NOT NULL`
- `build_version TEXT NOT NULL`
- `target_head TEXT NOT NULL`
- `build_kind TEXT NOT NULL CHECK (build_kind IN ('full','incremental','repair','reindex'))`
- `requested_by TEXT NOT NULL`
- `requested_from_env TEXT NOT NULL CHECK (requested_from_env IN ('local','preview','prod','operator'))`
- `status TEXT NOT NULL CHECK (status IN ('building','built','validated','published','failed','abandoned','superseded'))`
- `source_snapshot_total INT NOT NULL DEFAULT 0`
- `documents_built INT NOT NULL DEFAULT 0`
- `chunks_built INT NOT NULL DEFAULT 0`
- `memory_entries_built INT NOT NULL DEFAULT 0`
- `embeddings_built INT NOT NULL DEFAULT 0`
- `validation_passed BOOLEAN NOT NULL DEFAULT false`
- `validation_summary_json JSONB NOT NULL DEFAULT '{}'::jsonb`
- `error_message TEXT`
- `started_at TIMESTAMPTZ`
- `finished_at TIMESTAMPTZ`
- `created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`
- `updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`

Required constraints:

- unique on `(knowledge_space, repo_id, branch, build_version)`
- index on `(knowledge_space, repo_id, branch, status, updated_at desc)`

Semantics:

- this is the canonical build lifecycle table
- all artifacts must belong to one build
- all publication validation starts here

## 6.2 `kb_publications`

Purpose:

- explicit runtime serving pointer

Required fields:

- `knowledge_space TEXT NOT NULL`
- `repo_id UUID NOT NULL`
- `branch TEXT NOT NULL`
- `published_build_version TEXT NOT NULL`
- `published_head TEXT NOT NULL`
- `published_by TEXT NOT NULL`
- `published_from_env TEXT NOT NULL CHECK (published_from_env IN ('local','preview','prod','operator'))`
- `published_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`
- `updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`
- `PRIMARY KEY (knowledge_space, repo_id, branch)`

Semantics:

- exactly one row per knowledge space / repo / branch
- this is the only source of runtime visibility
- replacing this row is atomic publication

This table supersedes current serving semantics.

It may coexist with `kb_serving_versions` during migration, but `kb_publications` becomes the final source of truth.

## 6.3 `kb_build_validation_results`

Purpose:

- store structured validation outputs before publication

Required fields:

- `id UUID PRIMARY KEY`
- `build_id UUID NOT NULL REFERENCES kb_builds(id) ON DELETE CASCADE`
- `validation_kind TEXT NOT NULL`
- `passed BOOLEAN NOT NULL`
- `severity TEXT NOT NULL CHECK (severity IN ('info','warn','error'))`
- `summary TEXT NOT NULL`
- `details_json JSONB NOT NULL DEFAULT '{}'::jsonb`
- `created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`

Examples of `validation_kind`:

- `manifest_complete`
- `document_count_match`
- `chunk_orphan_check`
- `memory_source_integrity`
- `citation_resolvability`
- `embedding_coverage`
- `duplicate_active_guard`
- `cross_build_visibility_guard`

## 6.4 `kb_ingest_leases`

Purpose:

- prevent conflicting publishers and provide safe distributed control in one DB

Required fields:

- `lease_key TEXT PRIMARY KEY`
- `owner_id TEXT NOT NULL`
- `owner_env TEXT NOT NULL`
- `expires_at TIMESTAMPTZ NOT NULL`
- `metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb`
- `updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`

Lease keys required initially:

- `publish:support-prod:<repo_id>:<branch>`
- `publish:support-preview:<repo_id>:<branch>`
- `publish:support-local:<repo_id>:<branch>`
- `build:<knowledge_space>:<repo_id>:<branch>`

Semantics:

- publication requires lease ownership
- full build orchestration requires build lease ownership
- stale leases may be recovered after TTL

---

## 7. Existing Artifact Tables: New Required Semantics

Existing tables do not need to be dropped immediately.

But their meaning must change.

## 7.1 `kb_documents`

Must continue to store:

- normalized canonical document artifacts

Required new semantics:

- every row belongs to one `build_version`
- rows are build artifacts, not serving truth
- runtime visibility is controlled by publication

### Required columns

If not already present, ensure:

- `knowledge_space TEXT NOT NULL DEFAULT 'support-prod'`
- `build_version TEXT NOT NULL`

### Required rule

`is_active` may remain for transitional maintenance purposes, but runtime code must stop using it as serving truth.

## 7.2 `kb_chunks`

Same rules as documents.

Required:

- `knowledge_space`
- `build_version`

## 7.3 `kb_memory_entries`

Same rules as documents and chunks.

Required:

- `knowledge_space`
- `build_version`
- `status`

Important:

- memory lifecycle must align to build lifecycle
- runtime memory lookup must resolve through publication first

## 7.4 `kb_memory_sources`

This table maps memory to citation-bearing chunks.

Required rule:

- every source chunk must belong to the same build version as the memory entry or be proven publication-compatible through explicit same-build validation

Cross-build source linkage is forbidden.

---

## 8. Required Migration Strategy

Migration must happen in phases.

Do not attempt a one-shot destructive rewrite.

## Phase A. Add publication primitives

Add:

- `kb_builds`
- `kb_publications`
- `kb_build_validation_results`
- `kb_ingest_leases`
- `knowledge_space` columns where missing

At this phase:

- runtime still temporarily works with old logic
- no serving behavior change yet

## Phase B. Make build writes publication-aware

Update write paths so that:

- all new artifacts are written with `knowledge_space`
- staged writes no longer imply runtime visibility
- `is_active` is no longer used to determine publication

## Phase C. Add runtime publication resolution

Update read paths to:

1. resolve publication pointer
2. if no publication pointer exists, return `KB unavailable`
3. read only artifacts in the published build

At this phase, old polluted active rows stop affecting runtime.

## Phase D. Repair and republish

Create clean builds and publish them explicitly per knowledge space.

## Phase E. Clean obsolete artifacts

After validation and soak:

- mark old contaminated rows as abandoned or inactive for maintenance
- optionally retain for audit

---

## 9. Required Write-Path Changes

This section describes exact implementation behavior expected from write paths.

## 9.1 `indexDocumentContent()` contract

Current contract is insufficient because `activationMode` does not actually isolate visibility.

New contract:

Inputs:

- `knowledgeSpace`
- `buildVersion`
- `publicationMode`
- `repoId`
- `branch`
- `commitSha`
- `path`
- `content`

Where:

- `publicationMode` may be `build_only` or `publish_inline`

Rules:

1. `build_only`
   - writes artifacts only
   - never changes runtime visibility

2. `publish_inline`
   - allowed only for tightly controlled local operator tooling if ever needed
   - not allowed for normal prod full sync

Normal production sync must use:

- `build_only`

## 9.2 `upsertDocument()` new required behavior

Current behavior sets `is_active=true` unconditionally.

This must change.

New required behavior:

- always write `knowledge_space`
- always write `build_version`
- never treat row insertion as publication
- `is_active` if retained should reflect row artifact availability, not serving visibility

Recommended transitional rule:

- keep `is_active=true` only to mean “artifact row is not deleted”
- never use it for serving

## 9.3 `upsertChunk()` new required behavior

Same as documents.

## 9.4 `syncDocumentMemoryGraph()` new required behavior

Current behavior may mark prior versions inactive only in `immediate` mode, but runtime still sees many active builds if no publication exists.

New required behavior:

- every memory artifact must carry `knowledge_space` and `build_version`
- memory artifact writes never change runtime visibility directly
- relation building and profile building operate within one build scope
- same-build validation is mandatory before publication

## 9.5 Deactivation functions must stop being serving controls

Functions such as:

- missing-from-snapshot deactivation
- chunk deactivation
- prior build inactivation

must be reinterpreted as build hygiene and retention management only.

They must not be the primary runtime-serving control anymore.

---

## 10. Runtime Read-Path Changes

This section is mandatory for later implementation.

All KB read paths must use the following flow.

## 10.1 Step 1: resolve knowledge space

Knowledge space must come from runtime environment or explicit operator context.

Required default mapping:

- local runtime -> `support-local`
- preview runtime -> `support-preview`
- prod runtime -> `support-prod`

## 10.2 Step 2: resolve published build

Lookup:

- `kb_publications where knowledge_space = ? and repo_id = ? and branch = ?`

If none exists:

- return `KB unavailable`

Do not fallback to:

- `kb_serving_versions`
- `kb_sync_checkpoints`
- `is_active`

except during a tightly bounded transitional migration flag described later.

## 10.3 Step 3: query artifacts only within published build

Every runtime query must enforce:

- document `build_version = published_build_version`
- chunk `build_version = published_build_version`
- memory `build_version = published_build_version`

## 10.4 Step 4: disallow cross-build citation assembly

If a memory entry points to chunks from a different build:

- treat it as invalid
- record validation failure
- exclude from runtime retrieval

---

## 11. Full Sync State Machine

This section defines the exact end-to-end state machine.

## 11.1 Trigger conditions

Full sync may be triggered by:

- manual operator action
- scheduled maintenance
- explicit rebuild request
- large drift or corruption repair workflow

Full sync must not be started merely because a single incremental webhook arrived.

## 11.2 Full sync lifecycle

### State 1. `planned`

The run is created with:

- target head fixed
- source snapshot frozen
- manifest generated
- shards created
- build record created

### State 2. `running`

Shard workers process manifest items into build-scoped artifacts.

Rules:

- artifacts are build-only
- no serving change
- heartbeat required

### State 3. `built`

All manifest items completed successfully.

Requirements:

- no pending manifest rows
- no failed manifest rows
- all shard totals matched

### State 4. `validated`

Validation suite passes.

Required checks:

- manifest completeness
- duplicate path check within build
- chunk orphan check
- memory source integrity
- cross-build contamination guard
- embedding integrity if embeddings enabled
- minimum required doc family presence

### State 5. `published`

Publication pointer updated atomically.

### State 6. `superseded`

A newer build for the same knowledge space replaces it.

### Failure state. `failed`

Any incomplete or invalid run.

Never runtime-visible.

### Terminal discard state. `abandoned`

Used for failed historical or manually discarded builds.

Never runtime-visible.

## 11.3 Shard model

Keep the current shard categories for docs-com:

- `deploy-docs`
- `docs`
- `open-docs`

Rules:

- every shard writes into the same build scope
- shard success alone does not publish
- full build is complete only when all required shards are complete

## 11.4 Continuation rules

Continuation job identity must include:

- `knowledge_space`
- `run_id`
- `shard_key`
- `target_head`
- `cursor`

This prevents collisions with historical continuations.

## 11.5 Heartbeat and stale-job recovery

Required:

- stale running jobs are re-queued after TTL
- stale build lease recovery is explicit
- stale shard heartbeat is visible in diagnostics

But re-queueing a stale job must not change publication state.

---

## 12. Incremental Sync State Machine

Incremental sync must coexist with full sync safely.

## 12.1 Primary rule

Incremental sync must never mutate the currently published build in place.

Instead, incremental sync must choose one of two modes:

1. `patch build`
2. `queued full rebuild fallback`

## 12.2 Patch build mode

Allowed only if:

- changed paths are small in scope
- artifact family dependencies are contained
- no schema-wide or topology-wide rebuild is required

Patch build flow:

1. fork from currently published build metadata
2. create a new build version
3. rebuild changed artifacts only
4. copy forward unchanged artifact references logically
5. validate
6. publish atomically

Important:

- patch build still creates a new build version
- it does not mutate the old published build in place

## 12.3 Full rebuild fallback mode

If patch safety cannot be proven, incremental trigger must enqueue:

- full rebuild

This is mandatory for:

- broad include path changes
- chunking strategy changes
- memory extraction changes
- embedding model changes
- source normalization changes

---

## 13. Current Data Repair Plan

This section is critical.

It describes how to clean the already polluted state safely.

Do not skip these steps.

## 13.1 Repair principle

Do not begin by deleting rows.

First make runtime stop reading polluted rows.

The safe order is:

1. add publication model
2. change runtime to publication-based reads
3. create clean published build
4. only then cleanup contaminated historical artifacts

## 13.2 Immediate diagnosis snapshot

Before any repair write:

Capture:

- active document counts by build_version
- active chunk counts by build_version
- active memory counts by build_version
- duplicated active paths
- incomplete full runs
- current sync jobs
- current repo registrations

Save these into an operator repair report.

## 13.3 Transitional freeze rule

Before structural migration:

- do not run uncontrolled repair scripts
- do not run ad hoc local full sync into the shared DB
- do not attempt manual row deletions to “make counts look right”

## 13.4 First clean publication target

Build a new clean full build for:

- `knowledge_space = support-prod`
- `repo = docs-com`
- current intended target head

This build must be validated before publication.

Once published:

- runtime production support reads only that build
- all historical polluted rows become invisible to runtime immediately

This is the key safety turning point.

## 13.5 Historical contaminated rows handling

After clean publication:

Mark old builds as:

- `failed`
- `abandoned`
- `superseded`

depending on actual provenance

Retention strategy:

- keep recent failed builds for audit and debugging
- do not let them participate in runtime serving

## 13.6 `kb_serving_versions` and `kb_sync_checkpoints`

Current state is empty.

Migration rule:

- do not attempt to reintroduce them as the long-term source of truth
- either:
  - migrate them into `kb_publications`, or
  - keep them as compatibility views only

Final runtime source of truth must be `kb_publications`.

---

## 14. Publication Validation Gates

Publication is forbidden unless all required gates pass.

Initial mandatory gates:

1. manifest complete
2. no failed manifest items
3. no duplicate paths inside the target build
4. every memory source resolves to a chunk in the same build
5. every published chunk references a published document in the same build
6. required doc families present:
   - `docs`
   - `deploy-docs`
   - `open-docs`
7. retrieval minimum coverage checks pass on a seed eval set

If embeddings are enabled, add:

8. embedding coverage threshold reached
9. embedding dimension and model consistency check

---

## 15. Embedding Policy In This Part

You said embeddings are allowed and can be provided directly if useful.

This part therefore assumes embeddings are part of the target design, but only after substrate repair.

Rules:

1. embedding vectors are build artifacts
2. embeddings must be versioned by build
3. embedding model changes must create a new build
4. runtime must not mix chunks embedded with inconsistent model or dimension inside the same build
5. embedding failure must fail validation if below threshold for a build that declares embeddings required

This part does not yet define the retrieval architecture using embeddings in detail.

That comes in later parts.

But the build substrate must already be embedding-safe.

---

## 16. API And Worker Changes Required In This Part

This section is directly actionable.

## 16.1 Worker behavior

Current worker:

- claims queued jobs
- runs job
- writes artifacts
- marks job success/failure

New required worker behavior:

1. resolve environment -> knowledge_space
2. acquire build lease
3. create or continue build
4. write build-scoped artifacts only
5. complete shards
6. run validation
7. publish only if allowed in this environment
8. release lease

## 16.2 Required new internal APIs

### `POST /api/v1/internal/kb/builds/full`

Purpose:

- start a full build in a specific knowledge space

### `POST /api/v1/internal/kb/builds/incremental`

Purpose:

- enqueue patch build or full-rebuild fallback

### `POST /api/v1/internal/kb/publications/promote`

Purpose:

- explicitly promote a validated build to published state

Must require:

- strong auth
- audit logging

### `GET /api/v1/internal/kb/publications/status`

Purpose:

- show current published build for each space

### `GET /api/v1/internal/kb/builds/:id`

Purpose:

- show build lifecycle, validation results, and artifact stats

## 16.3 Existing APIs that must change semantics

Current docs-com ensure and full-sync endpoints must be rewritten to operate on:

- build creation
- build continuation
- validation
- publication

not direct serving mutation.

---

## 17. Transitional Compatibility Rules

The rebuild may require a short transitional period.

Allowed temporary compatibility rule:

- runtime may support a feature-flagged compatibility resolver:
  - first look for `kb_publications`
  - if absent and only if migration flag explicitly enabled, read from old source

But this compatibility mode is allowed only during migration and must be removed after clean publication is live.

Default target:

- no compatibility fallback

---

## 18. Required Test Plan

This part must not be implemented without focused tests.

## 18.1 Unit tests

Must cover:

- build lifecycle transitions
- publication resolver
- lease acquisition and lease expiry
- invalid publication rejection
- runtime no-publication behavior

## 18.2 Integration tests

Must cover:

1. full build writes artifacts but runtime cannot see them before publication
2. publication pointer switch makes only one build visible
3. failed build remains invisible
4. preview publication does not affect prod runtime
5. local publication does not affect prod runtime
6. cross-build memory source linkage is rejected
7. duplicated active historical rows do not affect runtime after publication-based read path is enabled

## 18.3 Repair tests

Must cover:

- starting from polluted historical rows
- publishing one clean build
- runtime visibility becomes coherent immediately without deleting historical rows first

## 18.4 Regression probes against real DB

Before and after rollout verify:

- current publication status
- distinct runtime-visible path count
- duplicated runtime-visible paths
- build counts
- memory counts
- retrieval seed queries

---

## 19. Implementation Order

This order is mandatory.

### Step 1. Add schema primitives

Implement:

- `kb_builds`
- `kb_publications`
- `kb_build_validation_results`
- `kb_ingest_leases`
- `knowledge_space` columns where missing

No runtime change yet.

### Step 2. Refactor write paths

Implement:

- build-scoped writes
- no implicit serving activation
- knowledge-space propagation

### Step 3. Refactor runtime read paths

Implement:

- publication resolver
- `KB unavailable` when no publication exists
- strict published-build filtering

### Step 4. Implement validation and publication

Implement:

- validation suite
- explicit publish transition
- publication auth and lease guards

### Step 5. Build and publish clean snapshots

Implement:

- `support-prod` clean build
- `support-preview` clean build
- optional `support-local` clean build

### Step 6. Cleanup historical contamination

Implement:

- abandonment or superseding of historical contaminated builds
- retention-safe cleanup

---

## 20. Explicit Prohibitions During Implementation

While implementing this part, the following are forbidden:

1. using ad hoc SQL deletes as the primary repair method
2. reusing `is_active` as a publication mechanism
3. continuing to let staged writes influence runtime
4. publishing a build before validation
5. allowing preview/local workers to publish into `support-prod`
6. changing retrieval prompts first while substrate remains polluted
7. enabling embeddings in production publication before build isolation is fixed

---

## 21. Acceptance Criteria For Part 02

Part 02 is accepted only when all of the following are true.

1. a publication table exists and is used as serving truth
2. runtime retrieval resolves through published build only
3. no publication means `KB unavailable`
4. staged or failed builds are runtime-invisible
5. same DB safely supports local / preview / prod through knowledge-space isolation
6. a clean build can be published without deleting historical rows first
7. production runtime can stop reading polluted active rows immediately after clean publication

---

## 22. What Later Parts Will Assume

Part 03 and later will assume Part 02 has been implemented.

That means later parts will assume:

- published build resolution exists
- runtime visibility is coherent
- same-database isolation is real
- build artifacts are trustworthy as inputs to retrieval redesign

Part 03 will define:

- repository knowledge object model
- code-repository-native ingestion units
- retrieval units vs citation units
- symbol extraction
- chunking and code-aware segmentation

