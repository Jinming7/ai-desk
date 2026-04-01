# AI Support Agent Rebuild Plan Part 01

Date: 2026-04-01

Status: proposed

Scope:

- define the final target system precisely
- freeze the non-negotiable architecture constraints
- define the single-database safety model
- define the build and publication model that all later parts must obey
- document the current confirmed failure state so later implementation work does not regress into the same class of bugs

This document is the first part of the rebuild plan for the AI-driven support engineer agent.

It is intentionally foundational.

No later module design is allowed to contradict this document unless this document is explicitly revised first.

---

## 1. Final Goal

The target system is an `AI-driven support engineer agent`.

It is not:

- a keyword search service
- a vector search demo
- a rule tree
- a path-regex router
- a conditional answer builder
- a document search box with LLM summarization pasted on top

The target system must support:

1. AI-driven understanding of the customer question
2. AI-driven identification of missing information
3. AI-driven retrieval planning
4. AI-driven knowledge retrieval from repository-derived knowledge
5. AI-driven evidence selection and validation
6. AI-driven troubleshooting and support reasoning
7. customer-facing grounded answers with traceable citations
8. safe escalation or clarification when evidence is insufficient

The repository knowledge base exists to support this agent.

The retrieval layer is only one subsystem inside that agent.

Retrieval quality matters only insofar as it improves:

- issue diagnosis
- support accuracy
- groundedness
- clarification quality
- escalation quality
- customer answer quality

---

## 2. Repository Principles To Preserve

The rebuild must preserve the existing repository principles already captured in `AGENTS.md`.

The most important ones are:

1. customer-facing support remains `AI-driven` by default
2. no new deterministic rule trees for support answers
3. no stacking of regex patches over narrow user questions as the primary fix
4. `BangWork/docs-com` remains the canonical support knowledge source when grounded documentation exists
5. support answers come from the shared support-agent pipeline
6. conversation history remains multi-turn and role-aware
7. customer-facing answers prioritize:
   - direct answer
   - what to do now
   - minimum missing info
   - grounded citations

This rebuild is allowed to refactor implementation heavily.

It is not allowed to change the above product philosophy.

---

## 3. Current Confirmed Failure State

The current system has three coupled failure domains:

### 3.1 Knowledge build and publish semantics are broken

Current confirmed facts:

- `kb_serving_versions` is empty
- `kb_sync_checkpoints` is empty
- runtime therefore falls back to reading `is_active = true`
- `kb_documents` currently contains:
  - `719` active rows
  - `391` distinct active paths
  - `237` duplicated active paths
- multiple failed or incomplete `build_version` groups remain active together

This proves the current runtime corpus is not one coherent serving snapshot.

It is a merged residue of historical runs.

### 3.2 Staged full-sync writes still leak directly into active serving data

Current code review confirmed that staged builds still write rows as active:

- `kb_documents` upsert writes `is_active = true`
- `kb_chunks` upsert writes `is_active = true`
- staged full-run jobs therefore mutate runtime-visible state before finalization

This violates the intended design already documented elsewhere in the repository.

### 3.3 Memory layer is also polluted

Current confirmed facts:

- active memory rows are already accumulated across many build versions
- `kb_memory_entries` active rows are in the thousands
- active memory build count is very high
- there is no serving version filter currently gating memory reads

Therefore the problem is not only document-level contamination.

The retrieval abstraction layer is already contaminated too.

### 3.4 Retrieval and orchestration are still partially path- and lexical-biased

Current repository review also confirms:

- path and title heuristics still influence retrieval significantly
- query expansion is still partly lexical-table based
- case-frame stabilization still does not fully control first-pass retrieval quality

This means even if the database were clean, retrieval quality would still be below target.

### 3.5 Full sync reliability is already a proven operational problem

Recent failures include:

- partial full runs
- repeated retries
- duplicated active versions
- `kb_memory_sources_pkey` conflicts
- timeout-related failed runs

This means the fix cannot be limited to prompt tuning or rerank tuning.

The foundation has to be rebuilt first.

---

## 4. Non-Negotiable Hard Constraints

These constraints are frozen.

Every later part must satisfy them.

### 4.1 Single shared database

There is currently only one database.

There is no separate prod/test/preview database split.

Therefore:

- local debugging must not pollute production-visible serving data
- preview validation must not pollute production-visible serving data
- failed runs must not pollute production-visible serving data
- partial runs must not pollute production-visible serving data

This is the most important systems constraint in the rebuild.

### 4.2 Same database must support local, preview, and prod safely

The architecture must work correctly when the same database is used by:

- local developer processes
- preview deployments
- production deployments
- background workers

This requires strict same-database isolation by publication model, not by separate databases.

### 4.3 Runtime retrieval must read one published snapshot only

No runtime retrieval path may query “all active rows” as a fallback.

All runtime retrieval must read from exactly one published build boundary.

If no published build exists, the system must behave as:

- `KB unavailable`

not as:

- “use whatever rows happen to be active”

### 4.4 Build state and serving state must be separated

Builds may exist in the database before publication.

That is allowed.

What is forbidden is:

- unfinished build artifacts becoming runtime-visible serving artifacts

### 4.5 Canonical source remains repository-derived

The primary support knowledge still comes from repository-derived content:

- docs
- openapi
- config
- code
- tests
- runbooks
- schemas

Conversation memory is not allowed to replace repository knowledge.

### 4.6 Customer answer path remains unified

The support agent remains the only customer-answer pipeline.

No sidecar deterministic answering path may be added.

---

## 5. Target System Model

The rebuilt system will have six layers.

## Layer 1. Source Layer

Raw repository source of truth:

- markdown pages
- MDX pages
- OpenAPI specs
- config files
- code symbols
- SQL migrations
- tests
- deploy docs
- troubleshooting docs

This layer is immutable per `repo + commit`.

## Layer 2. Build Layer

Artifacts produced for one build run:

- normalized documents
- chunks
- code symbol spans
- memory entries
- aliases
- signals
- relations
- embedding vectors
- validation metrics

This layer is isolated per `build_version`.

Build artifacts are not runtime-visible merely because they exist.

## Layer 3. Publication Layer

One publication pointer decides what runtime can see.

Publication is:

- atomic
- explicit
- environment-scoped
- knowledge-space scoped

Only published builds are retrievable at runtime.

## Layer 4. Knowledge Retrieval Layer

Runtime retrieval uses:

- retrieval units
- symbol-aware search
- metadata filters
- hybrid retrieval
- reranking
- memory graph expansion
- grounding back to citation units

This layer is agent-serving, not end-user serving.

## Layer 5. AI Agent Runtime Layer

This layer is the support pipeline:

- route
- evidence plan
- case frame
- retrieval plan
- retrieval execution
- evidence selection
- verification
- answer composition

The OpenClaw multi-agent topology belongs here.

## Layer 6. Evaluation And Operations Layer

This layer controls:

- build validation
- sync progress
- publication safety
- retrieval evals
- answer evals
- rollback
- metrics
- incident visibility

---

## 6. Core Domain Terms

These terms are frozen to avoid ambiguity in later design documents.

### 6.1 `build_version`

A unique identifier for one isolated build of repository-derived knowledge artifacts.

Recommended format:

- `${commitSha}:${runId}`

Never use timestamp-only build versions for production publication.

Timestamp-only forms are allowed only for strictly local experimental drafts and should not participate in serving publication.

### 6.2 `knowledge_space`

A logical serving namespace.

Initial required spaces:

- `support-prod`
- `support-preview`
- `support-local`

This is the main same-database isolation mechanism.

### 6.3 `publication`

An atomic pointer from:

- `knowledge_space + repo + branch`

to:

- exactly one `build_version`

### 6.4 `retrieval unit`

A repository-derived normalized object optimized for matching user intent.

Examples:

- API operation
- troubleshooting pattern
- config surface
- code symbol responsibility
- permission rule
- behavior rule

### 6.5 `citation unit`

A repository-derived evidence object used in final customer grounding.

Examples:

- document chunk
- OpenAPI span
- code span
- config snippet
- SQL snippet
- test snippet

### 6.6 `runtime visible`

An artifact is runtime-visible only if:

1. it belongs to the published build for the current knowledge space
2. its artifact state is valid
3. its parent build is published

### 6.7 `build isolation`

Artifacts from different build versions may coexist in the same database.

They must not be visible to the same runtime query unless explicitly requested for operations or diagnostics.

---

## 7. Same-Database Isolation Model

This is the most important architectural decision in the rebuild.

The system must behave as if there were separate environments, even though there is only one database.

The isolation boundary will therefore be:

- `knowledge_space`
- `repo_id`
- `branch`
- `build_version`

Not:

- `is_active`

Not:

- “latest rows”

Not:

- environment variables alone

### 7.1 Required knowledge spaces

At minimum:

- `support-prod`
- `support-preview`
- `support-local`

Optional later:

- `support-shadow`
- `support-eval`

### 7.2 Visibility rules

#### Production runtime

Production support runtime may read only:

- `knowledge_space = support-prod`
- published build only

#### Preview runtime

Preview runtime may read only:

- `knowledge_space = support-preview`
- published build only

Preview must not automatically see `support-prod` experimental or local builds.

#### Local runtime

Local runtime may read:

- `support-local`

It may optionally be allowed to read `support-preview` or `support-prod` in explicit read-only debug mode, but only through a separate operator path, never as default serving behavior.

### 7.3 Publication authority rules

Only approved publisher flows may update a publication pointer.

Initial rule:

- local processes may publish only to `support-local`
- preview deployment may publish only to `support-preview`
- production worker may publish only to `support-prod`

Any future override must require an explicit operator action and audit trail.

### 7.4 Why this is mandatory

Without this model, any of the following will continue to corrupt runtime:

- local reindex
- preview partial run
- failed production full run
- experimental memory rebuild
- one-off repair script

---

## 8. Publication Model

Publication replaces the current broken semantics around `is_active`.

## 8.1 Required rule

No build artifacts are runtime-serving merely because they have been written.

Build completion and serving activation are different operations.

## 8.2 Publication lifecycle

Each build moves through:

1. `building`
2. `built`
3. `validated`
4. `published`
5. `superseded` or `abandoned`

### 8.2.1 `building`

Artifacts are being generated.

No runtime visibility.

### 8.2.2 `built`

Artifact generation finished, but validation has not passed yet.

No runtime visibility.

### 8.2.3 `validated`

All mandatory quality gates passed.

Still no runtime visibility until publication.

### 8.2.4 `published`

Publication pointer now targets this build.

Runtime may read it.

### 8.2.5 `superseded`

A newer published build replaced it.

Kept for rollback or audit until retention cleanup.

### 8.2.6 `abandoned`

Failed, partial, or intentionally discarded build.

Never runtime-visible.

---

## 9. Required Safety Invariants

These invariants must become hard assertions in code, validation, and operations.

### 9.1 One publication pointer per knowledge space / repo / branch

At any time there may be at most one published active build for:

- `knowledge_space`
- `repo_id`
- `branch`

### 9.2 No runtime query without a publication pointer

If no publication exists for the requested knowledge space, runtime retrieval must return:

- `KB unavailable`

and must not silently fall back to arbitrary rows.

### 9.3 Failed build cannot be published

A build with:

- incomplete manifest
- failed validation
- incomplete artifact families
- missing critical references

must be unpublishable.

### 9.4 Partial build must remain query-invisible

Even if documents, chunks, memory rows, and embeddings have been written, they remain invisible until publication.

### 9.5 Publication must be atomic

The publication pointer update must be the only operation that changes runtime visibility.

### 9.6 Runtime reads must resolve through publication first

All search and retrieval repository methods must first resolve:

- published build version for the requested knowledge space

Only then query documents, chunks, memory entries, and vectors.

### 9.7 Cross-build mixing is forbidden

The runtime must never mix:

- document from build A
- chunk from build B
- memory from build C

inside one answer path.

All retrieved artifacts for one runtime request must belong to the same published build.

### 9.8 Local and preview builds must not mutate prod publication

This must be true even if they share the same DB and even if they run the same code.

---

## 10. Why `is_active` Is No Longer A Valid Serving Primitive

The current system relies too heavily on `is_active`.

That model is rejected for serving semantics.

Reasons:

1. `is_active` is row-level, but correctness is build-level
2. row-level active flags cannot represent atomic snapshot publication
3. partial runs can turn on rows before the snapshot is complete
4. shared DB local and preview activity can mutate flags accidentally
5. runtime cannot prove a coherent snapshot from row-level activity alone

In the rebuilt system:

- `is_active` may continue to exist as artifact lifecycle metadata
- but runtime visibility must be controlled by publication pointers

This is a crucial design freeze.

---

## 11. Required Repository Knowledge Model Direction

The target system must not treat the repository as only markdown pages.

Repository-derived knowledge must eventually be modeled in these object families:

1. `doc_page`
2. `doc_chunk`
3. `openapi_operation`
4. `code_symbol`
5. `config_surface`
6. `data_schema`
7. `test_evidence`
8. `runbook_pattern`
9. `error_behavior`
10. `memory_entry`

This document does not yet define those structures in full detail.

That will happen in later parts.

But this direction is frozen now so later implementation does not drift back into “markdown-only retrieval”.

---

## 12. OpenClaw Multi-Agent Fit

The rebuild does not replace the current OpenClaw multi-agent topology.

It strengthens the knowledge substrate underneath it.

The existing support topology already implies these stages:

- router
- evidence planner
- planner
- support evidence selector
- specialist agents
- evidence judge
- citation curator
- citation selector
- answer composer

This means the knowledge system must support:

1. fast retrieval for router/planner context
2. high-precision retrieval for evidence selector
3. provenance-rich grounding for citation stages
4. stable, repeatable retrieval inputs across stages

The rebuild must therefore optimize for:

- structured retrieval APIs
- deterministic publication visibility
- low-noise reference pools
- traceable grounding metadata

It must not optimize for:

- free-form search only
- giant unfiltered recall sets
- stage-specific ad hoc hacks

---

## 13. Required Implementation Direction For Part 02 And Beyond

The following work order is mandatory.

### Phase 1. Repair the build and publication substrate

Before retrieval redesign goes live, the system must:

- stop leaking staged rows into serving
- establish publication pointers
- isolate local/preview/prod in the same DB
- clean contaminated active data safely

### Phase 2. Redesign repository ingestion and knowledge build artifacts

Only after the serving boundary is fixed should we rebuild:

- document normalization
- chunking
- symbol extraction
- memory generation
- embeddings

### Phase 3. Redesign runtime retrieval

Only then should we replace:

- lexical-heavy retrieval
- path-heavy reranking
- query-table hacks

with:

- metadata-first retrieval
- hybrid retrieval
- symbol-aware retrieval
- memory graph retrieval
- rerank and grounding

### Phase 4. Tighten AI support reasoning and answer quality

Only after the retrieval substrate is trustworthy should we:

- optimize evidence planning
- optimize verification
- optimize customer answer composition

This ordering is mandatory because otherwise later improvements will be built on contaminated serving state.

---

## 14. Explicit Prohibitions

The following are forbidden as “fixes”:

1. continuing to publish staged build rows by setting `is_active = true`
2. continuing to let runtime fall back to “all active rows”
3. solving answer misses with more regex over user queries
4. solving retrieval misses with more path-prefix heuristics
5. directly answering from memory without grounding
6. treating local debug runs as safe because they use the same code
7. publishing build outputs without validating manifest completeness
8. allowing preview or local processes to mutate prod publication pointers

---

## 15. Acceptance Criteria For Part 01

Part 01 is considered accepted only if later implementation follows these exact principles:

1. the rebuilt system is clearly defined as an AI-driven support engineer agent
2. the single-database safety model is treated as a first-class architectural constraint
3. serving visibility is publication-based, not `is_active`-based
4. build state and serving state are separated
5. no runtime retrieval is allowed without an explicit published build
6. OpenClaw multi-agent orchestration remains the answer path
7. later parts use these definitions consistently

---

## 16. Output Of This Part

This part intentionally does not contain migration SQL or code changes yet.

What it delivers is the architecture contract that later implementation must obey.

Part 02 will define:

- exact ingestion and full-sync state machine
- exact build tables and publication tables
- exact local / preview / prod same-database isolation workflow
- exact cleanup and repair sequence for the currently polluted data

