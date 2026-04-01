# AI Support Deer-Flow / Supermemory Research And Knowledge Retrieval Design

Date: 2026-03-27

Scope: perform a source-based architecture study of `bytedance/deer-flow` and `supermemoryai/supermemory`, analyze the current `TicketManagement` support retrieval stack, and propose a complete knowledge retrieval design that can replace the practical value of embeddings for `docs-com` grounded support answers.

## Executive Summary

The conclusion is straightforward:

- `deer-flow` is **not** a knowledge retrieval engine
- `supermemory` **is** a memory and retrieval product, but its open-source repository primarily exposes **SDKs, docs, API models, UI components, and plugins**, not the full backend engine

So the correct approach is not:

- copy `deer-flow` memory data structures directly
- pretend we can fully clone `supermemory` internals line-by-line from open-source server code

The correct approach is:

1. borrow `deer-flow`'s **engineering patterns**:
   - asynchronous extraction
   - storage abstraction
   - isolated persistence
   - decoupled write path vs. read path
2. borrow `supermemory`'s **product and retrieval model**:
   - unified ontology over docs + memories + relationships
   - memory graph
   - query rewriting
   - reranking
   - hybrid retrieval
   - profile-like fast context surfaces
3. adapt both into the current `github-kb -> search-orchestrator -> support-agent` architecture

The resulting design should be:

- `docs-com` remains the canonical source of truth
- `kb_documents` and `kb_chunks` remain the grounded evidence layer
- a new `knowledge memory graph` becomes the primary retrieval layer
- support answers still cite `docs-com` chunks only

This document treats that as the target architecture.

## Research Method

The research used:

- local clone of `bytedance/deer-flow`
- local clone of `supermemoryai/supermemory`
- direct source inspection of code, docs, and API models
- direct comparison against current `TicketManagement` support retrieval code

### Repositories inspected

- `https://github.com/bytedance/deer-flow`
- `https://github.com/supermemoryai/supermemory`

### Important limitation

`supermemory`'s public repository does **not** contain the full production retrieval engine implementation.

What is publicly available is still highly useful:

- conceptual architecture
- processing pipeline model
- public API shapes
- memory graph data model
- retrieval features
- SDK and tool integration patterns

That is enough to copy the design direction, but not enough to claim we have their exact server implementation.

## Part 1. Deer-Flow Research

## 1.1 What Deer-Flow Actually Is

From `README.md` and `backend/CLAUDE.md`, DeerFlow is a:

- LangGraph-based super agent harness
- multi-tool, multi-subagent orchestration runtime
- sandboxed execution system
- long-term memory enabled agent framework

Its memory system is designed for:

- user context retention
- agent personalization
- prompt injection of remembered context

It is not designed as a document-grounded support KB retrieval engine.

## 1.2 Deer-Flow Memory Architecture

The relevant components are:

- `agents/middlewares/memory_middleware.py`
- `agents/memory/queue.py`
- `agents/memory/updater.py`
- `agents/memory/storage.py`
- `agents/memory/prompt.py`
- `agents/lead_agent/prompt.py`

### Workflow

DeerFlow memory works like this:

1. after the agent finishes a turn, `MemoryMiddleware` filters messages
2. the filtered conversation is queued asynchronously
3. a debounced queue batches updates
4. an LLM extracts structured memory updates
5. memory is persisted through a storage provider
6. later turns inject memory summaries and facts back into the system prompt

### Memory shape

The memory structure is centered on:

- user summaries:
  - `workContext`
  - `personalContext`
  - `topOfMind`
- history summaries:
  - `recentMonths`
  - `earlierContext`
  - `longTermBackground`
- discrete facts:
  - `content`
  - `category`
  - `confidence`
  - `source`

### Strong patterns worth copying

These are the parts of DeerFlow that are genuinely useful for this project:

1. **Asynchronous extraction pipeline**
   - memory update is not in the critical path of answering
   - extracted structure is built in the background

2. **Write path and read path are separated**
   - answer generation is not blocked on memory extraction
   - retrieval reads from persisted state only

3. **Storage abstraction**
   - `MemoryStorage` is a clean interface
   - file storage is the default, but the architecture allows replacement

4. **Atomic persistence**
   - writes use temp file + replace
   - cache invalidation is explicit

5. **Deduplication and contradiction handling**
   - updater removes superseded or duplicate facts

6. **Prompt injection is budgeted**
   - memory context is token-limited
   - high-value facts are prioritized

## 1.3 What Not To Copy From Deer-Flow

These parts are not suitable as the main retrieval design for `TicketManagement`:

1. **Conversation-derived memory as the main knowledge source**
   - our support system must stay grounded in `BangWork/docs-com`

2. **Single memory blob as retrieval substrate**
   - DeerFlow's memory is prompt context, not a citation-grade knowledge graph

3. **Fact-centric user profile structure**
   - our problem is support knowledge retrieval, not user personalization

## 1.4 Deer-Flow Takeaway

For this project, DeerFlow contributes:

- engineering workflow patterns
- async build patterns
- storage abstraction patterns
- structured extraction patterns

It does **not** contribute the final retrieval ontology.

## Part 2. Supermemory Research

## 2.1 What Supermemory Claims To Be

From `README.md`, Supermemory positions itself as:

- a memory and context engine for AI
- unified memory + RAG + user profiles + connectors
- a system built around a single memory structure and ontology

The core product concepts that matter for us are:

- memory extraction
- knowledge graph relationships
- hybrid search
- query rewriting
- reranking
- profile + search in one call

## 2.2 Publicly Visible Supermemory Design

The strongest public signals come from:

- `README.md`
- `apps/docs/memory-api/*`
- `apps/docs/user-profiles/*`
- `apps/docs/memory-graph/*`
- `skills/supermemory/references/architecture.md`
- `packages/validation/api.ts`
- `packages/ui/memory-graph/types.ts`

### Important note on openness

The public repo exposes:

- public API contracts
- UI graph model
- SDK wrappers
- docs describing the ingestion pipeline

It does not expose the full production backend implementation for:

- semantic indexing internals
- graph-building internals
- relationship inference internals
- ranking stack internals

So the proper engineering stance is:

- we can copy the **design**
- we cannot claim to copy the exact backend code path

## 2.3 Supermemory's Core Architectural Concepts

### A. Unified ontology

Supermemory treats memory, retrieved context, documents, and profiles as one system rather than disconnected modules.

That is the most important design idea to carry over.

### B. Processing pipeline

The docs describe a six-stage pipeline:

1. queued
2. extracting
3. chunking
4. embedding
5. indexing
6. done

Even though their public docs assume embeddings exist, the broader pattern is useful:

- ingestion is staged
- memory building is asynchronous
- indexing is separate from extraction

### C. Living knowledge graph

Supermemory explicitly frames the system as a living knowledge graph rather than a static document store.

Its memory relationships include:

- `updates`
- `extends`
- `derives`

This is extremely relevant for support retrieval because:

- docs change over time
- troubleshooting guidance often supersedes older guidance
- one operational page extends another
- some useful support facts are derived from multiple source pages

### D. Static vs dynamic memory

Supermemory distinguishes:

- static facts
- dynamic / episodic context

In our support KB this maps well to:

- static product facts:
  - capabilities
  - scopes
  - API path semantics
  - product object definitions
- dynamic operational knowledge:
  - troubleshooting guidance
  - version-sensitive deployment notes
  - latest recommended steps

### E. Profile + search dual retrieval

Supermemory exposes:

- profile retrieval for fast broad context
- search retrieval for exact query-specific context

For support retrieval, this concept is useful but must be adapted.

We do not need user profiles.

We do need an analogous fast context surface:

- product-area profile
- feature-area profile
- integration surface profile

This can provide low-latency stable context before deeper search.

### F. Search features exposed publicly

From docs and SDKs, Supermemory publicly exposes:

- semantic search
- hybrid search
- metadata filtering
- query rewriting
- reranking
- related memory inclusion
- forgotten memory inclusion

Even without their backend code, these feature flags tell us what the retrieval stack is expected to support.

## 2.4 Supermemory Memory Graph Model

The public memory graph component exposes a concrete type model:

- documents
- memory entries
- version relations
- relation types
- graph edges

The most useful parts are:

### Document + memory duality

A document is not the final unit of retrieval.

Each document has multiple memory entries.

This is directly applicable to `TicketManagement`:

- `kb_documents` stay as document roots
- `kb_chunks` stay as evidence-bearing chunks
- new `kb_memory_entries` become the primary retrieval units

### Memory relations

Public relation types:

- `updates`
- `extends`
- `derives`

These are almost exactly the three relation families we need.

### Space / container partitioning

Supermemory supports:

- `containerTags`
- `userId`
- project-scoped grouping

For us, the analog is not user partitioning but support retrieval segmentation:

- repo / branch
- corpus family (`docs`, `open-docs`, `deploy-docs`)
- product area
- deployment model
- doc kind

## 2.5 What To Copy Directly From Supermemory

These should be copied almost directly as product design:

1. **Memory graph as first-class retrieval layer**
2. **Document plus memory-entry dual model**
3. **Relation types: updates / extends / derives**
4. **Search pipeline options: rewrite + rerank + filter + related**
5. **Partitioning / scoping model**
6. **Asynchronous ingestion pipeline**
7. **Static vs dynamic memory distinction**

## 2.6 What Must Be Adapted

These parts require adaptation rather than literal copying:

1. **Embeddings-first assumptions**
   - our immediate target is high quality retrieval with `embedding = null`

2. **User profile design**
   - we need support knowledge profiles, not user biographies

3. **Forgetting semantics**
   - for docs KB, staleness is mainly handled by source reindex and deactivation, not TTL-based forgetting

4. **Full graph visualization**
   - useful for internal diagnostics, not required for MVP retrieval quality recovery

## Part 3. Current TicketManagement Architecture Analysis

## 3.1 Current Retrieval Stack

The current stack is:

- `github-kb`
  - syncs `BangWork/docs-com`
  - builds `kb_documents` and `kb_chunks`
- `search-orchestrator`
  - performs retrieval
  - merges local docs and github-kb hits
  - reranks for route compatibility
- `support-agent`
  - generates route and case frame
  - selects evidence
  - verifies claims
  - composes final answer

### Current strengths

1. `docs-com` is already treated as the canonical knowledge source
2. support-agent already produces structured retrieval intent:
   - `question_type`
   - `product_area`
   - `action_type`
   - `required_doc_kinds`
3. chunk metadata already includes a `supportEvidence` structure
4. retrieval and evidence selection are already separated from final answer composition

### Current bottlenecks

1. `kb_chunks` are still the primary retrieval unit
2. retrieval quality falls hard when embeddings are absent
3. lexical retrieval alone is too weak for:
   - Chinese troubleshooting phrasing
   - operational symptom matching
   - paraphrase-heavy support questions
4. there is no first-class relationship graph over knowledge units
5. there is no query rewrite and related-memory expansion layer inside the KB domain model

## 3.2 Why A Direct Supermemory-Style Memory Layer Fits

The current system already has the right answer pipeline.

What it lacks is the right retrieval substrate.

That means we should not redesign:

- support-agent orchestration
- evidence selector
- evidence judge
- answer composer

We should redesign:

- retrieval data model
- retrieval build pipeline
- retrieval query execution

## Part 4. Target Architecture

## 4.1 Design Principles

The new retrieval architecture should obey these rules:

1. `docs-com` remains the primary and final evidence source
2. all customer-facing citations must still come from canonical source chunks
3. retrieval should first operate over structured knowledge memory, not raw chunks alone
4. memory graph build must be asynchronous and source-driven
5. search quality must remain acceptable when embeddings are missing
6. no deterministic customer-answer rule tree should be introduced

## 4.2 Canonical Data Layers

The system should have four layers:

### Layer 1. Source Corpus

Existing:

- `kb_repo_registrations`
- `kb_documents`

Purpose:

- canonical docs-com source of truth

### Layer 2. Grounding Layer

Existing:

- `kb_chunks`

Purpose:

- citation-bearing source passages

### Layer 3. Knowledge Memory Layer

New:

- `kb_memory_entries`
- `kb_memory_sources`
- `kb_memory_relations`
- `kb_memory_profiles`
- `kb_memory_aliases`
- `kb_memory_signals`

Purpose:

- high-quality retrieval substrate

### Layer 4. Support Retrieval Runtime

Existing but enhanced:

- `search-orchestrator`
- `support-agent`

Purpose:

- route-aware retrieval
- evidence selection
- grounded answer generation

## 4.3 New Data Model

## Table A. `kb_memory_entries`

Purpose:

- the primary retrieval unit, analogous to Supermemory memory entries

Suggested fields:

- `id UUID PRIMARY KEY`
- `repo_id UUID NOT NULL`
- `branch TEXT NOT NULL`
- `doc_id UUID NOT NULL`
- `memory_kind TEXT NOT NULL`
- `title TEXT`
- `canonical_claim TEXT NOT NULL`
- `summary TEXT NOT NULL`
- `product_area TEXT NOT NULL`
- `action_type TEXT`
- `deployment_model TEXT`
- `doc_kind TEXT NOT NULL`
- `object_type TEXT`
- `is_static BOOLEAN NOT NULL DEFAULT false`
- `is_latest BOOLEAN NOT NULL DEFAULT true`
- `status TEXT NOT NULL DEFAULT 'active'`
- `metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb`
- `search_text TEXT NOT NULL`
- `search_vector TSVECTOR`
- `created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`
- `updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`

Recommended `memory_kind` values:

- `concept`
- `procedure`
- `api_operation`
- `permission_rule`
- `troubleshooting_pattern`
- `behavior_rule`
- `constraint`
- `ui_surface`

## Table B. `kb_memory_sources`

Purpose:

- link one memory entry to one or more grounding chunks

Suggested fields:

- `memory_id UUID NOT NULL`
- `doc_id UUID NOT NULL`
- `chunk_id TEXT NOT NULL`
- `heading_path TEXT NOT NULL`
- `source_score NUMERIC(8,6) NOT NULL DEFAULT 1`
- `source_metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb`
- `PRIMARY KEY (memory_id, chunk_id)`

This is essential because a support memory unit can be grounded by:

- one chunk
- multiple supporting chunks in one document
- related chunks across multiple documents

## Table C. `kb_memory_relations`

Purpose:

- copy Supermemory's graph relation design

Suggested fields:

- `id UUID PRIMARY KEY`
- `from_memory_id UUID NOT NULL`
- `to_memory_id UUID NOT NULL`
- `relation_type TEXT NOT NULL`
- `weight NUMERIC(8,6) NOT NULL DEFAULT 1`
- `metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb`

Allowed values:

- `updates`
- `extends`
- `derives`

Interpretation:

- `updates`: new guidance supersedes older guidance
- `extends`: adds supporting context or prerequisites
- `derives`: synthesized support concept inferred from multiple source memories

## Table D. `kb_memory_aliases`

Purpose:

- support paraphrase, Chinese phrasing, UI wording, and support symptom phrasing without embeddings

Suggested fields:

- `id UUID PRIMARY KEY`
- `memory_id UUID NOT NULL`
- `alias TEXT NOT NULL`
- `alias_type TEXT NOT NULL`
- `weight NUMERIC(8,6) NOT NULL DEFAULT 1`

Suggested `alias_type` values:

- `zh_phrase`
- `en_phrase`
- `symptom`
- `ui_label`
- `path_hint`
- `error_phrase`
- `operation_variant`

## Table E. `kb_memory_signals`

Purpose:

- store exact support retrieval handles

Suggested fields:

- `id UUID PRIMARY KEY`
- `memory_id UUID NOT NULL`
- `signal_type TEXT NOT NULL`
- `signal_value TEXT NOT NULL`
- `weight NUMERIC(8,6) NOT NULL DEFAULT 1`

Suggested `signal_type` values:

- `scope`
- `api_path`
- `http_method`
- `error_code`
- `error_text`
- `callback`
- `redirect_uri`
- `baseurl`
- `object`
- `action`
- `setting_key`
- `page_name`

## Table F. `kb_memory_profiles`

Purpose:

- adapt Supermemory's profile idea for support retrieval

This is not a user profile.

It is a stable fast-context profile for a product or feature surface.

Suggested fields:

- `id UUID PRIMARY KEY`
- `profile_key TEXT NOT NULL UNIQUE`
- `profile_kind TEXT NOT NULL`
- `title TEXT NOT NULL`
- `static_summary TEXT NOT NULL`
- `dynamic_summary TEXT`
- `metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb`
- `created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`
- `updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`

Examples:

- `integrations/github`
- `openapi/comments`
- `deployment/private`

Use case:

- low-latency injection of broad feature context before memory search
- faster grounding for stable product surfaces

## 4.4 Build Pipeline

This should combine DeerFlow's engineering pattern with Supermemory's staged ingestion model.

### Stage 1. Sync source docs

Keep current `github-kb` sync flow:

- repo registration
- checkpoints
- document upsert
- chunk upsert

### Stage 2. Build memory entries

For each active document/chunk:

1. derive support metadata from current `supportEvidence`
2. extract 1..N structured memory entries
3. assign `memory_kind`
4. assign static vs dynamic
5. upsert aliases and signals
6. upsert chunk source mappings

### Stage 3. Build graph relations

After all memory entries for a document family exist:

1. build `updates` edges
   - newer source guidance supersedes older source guidance
2. build `extends` edges
   - prerequisites, related steps, companion docs
3. build `derives` edges
   - synthesized support units built from source clusters

### Stage 4. Build profiles

For stable feature families:

- aggregate high-confidence static memories into `kb_memory_profiles`
- aggregate recent dynamic support notes into `dynamic_summary`

### Stage 5. Activate atomically

Borrowing DeerFlow's write-path discipline:

- new memory data should be built to a new active set or version group
- old active set should not be partially mutated during rebuild
- switch active records only after memory build completes

In Postgres, this can be done with:

- per-doc deactivation + replace inside transaction boundaries
- or build version IDs and flip `is_active`

## 4.5 Retrieval Flow

This is the core runtime design.

### Step 1. Route and case frame generation

Keep current `support-agent` route planning.

Inputs already available:

- `question_type`
- `product_area`
- `action_type`
- `required_doc_kinds`
- `goal`
- `symptom`
- `object`

This becomes the retrieval intent contract.

### Step 2. Query rewriting

Copy Supermemory's design concept directly.

The retrieval layer should generate multiple rewrites and search all of them.

Rewrite sources:

- original user query
- normalized query
- case-frame structured rewrite
- symptom-centered rewrite
- object/action rewrite
- exact-signal rewrite

Rules:

- limit to 3-6 rewrites
- deduplicate aggressively
- log rewritten queries in diagnostics

### Step 3. Multi-channel retrieval

Each rewrite should search multiple channels in parallel:

1. `memory entry lexical search`
   - `canonical_claim`
   - `summary`
   - `search_text`

2. `alias search`
   - `kb_memory_aliases.alias`

3. `signal search`
   - exact or fuzzy match on `kb_memory_signals`

4. `profile retrieval`
   - match `kb_memory_profiles`

5. `raw chunk retrieval`
   - current fallback and direct evidence search

6. `document fallback`
   - last-resort doc-level retrieval

### Step 4. Graph expansion

From the top memory hits:

- expand 1 hop by `updates`
- expand 1 hop by `extends`
- optionally expand 1 hop by `derives`

Rules:

- `updates` should replace stale guidance
- `extends` should add supporting context
- `derives` should be lower priority unless multiple direct hits agree

### Step 5. Fusion and rerank

The ranking stack should be explicit and compositional.

Suggested score components:

- rewrite_match_score
- canonical_claim_score
- alias_match_score
- exact_signal_score
- profile_match_score
- chunk_heading_score
- chunk_body_score
- product_area_match_score
- doc_kind_match_score
- action_type_match_score
- graph_relation_bonus
- recency_bonus
- source_quality_bonus

Suggested weighting:

- exact support signals outrank loose text overlap
- route-compatible memories outrank general topical matches
- troubleshooting memories outrank capability docs for troubleshooting queries
- API operation memories outrank narrative docs for API queries

### Step 6. Ground back to chunks

After ranking memory entries:

1. resolve top memory entries to `kb_memory_sources`
2. retrieve linked chunks
3. build query-anchored snippets
4. emit `SearchReference[]` from canonical chunks only

This preserves the current answer pipeline while upgrading retrieval.

### Step 7. Evidence selection and answer generation

Keep current support flow:

- evidence selector
- evidence judge
- answer composer

No second answer path should be created.

## 4.6 Retrieval Without Embeddings

Because the immediate problem is `embedding = null`, the design must work without vectors.

This means:

- `search_text` needs strong lexical preparation
- aliases and signals become first-class
- trigram / n-gram indexing becomes important
- graph expansion compensates for missing vector semantics
- reranking becomes mandatory

Recommended non-vector indexing strategy:

1. PostgreSQL `tsvector` for English prose
2. trigram or equivalent for:
   - Chinese
   - mixed-language strings
   - URLs
   - API paths
   - UI labels
3. exact indexes for strong signals:
   - scope
   - callback
   - redirect URI
   - method/path
   - error codes

## Part 5. What Is Directly Copied vs Adapted

## 5.1 Directly Copied From Supermemory

These should be treated as direct design imports:

- memory entries as first-class retrieval units
- memory graph relation model:
  - `updates`
  - `extends`
  - `derives`
- query rewriting before retrieval
- reranking as optional but default-on quality enhancer
- profile + search dual-context pattern
- partitioned retrieval spaces

## 5.2 Directly Copied From Deer-Flow

These should be treated as direct engineering imports:

- async post-processing / extraction
- storage abstraction
- deduplication discipline
- cache invalidation and persistence hygiene
- strict separation of write pipeline from serving pipeline

## 5.3 Adapted Rather Than Copied

These must be adapted to current product constraints:

- Supermemory user profiles -> support knowledge profiles
- Supermemory embeddings-first stack -> lexical + graph + rerank stack
- DeerFlow conversation memory -> source-doc-derived knowledge memory

## Part 6. Required Code Architecture Changes

## 6.1 Minimal-Disruption Option

Keep memory building inside `github-kb`:

- `apps/api/src/modules/github-kb/memory-types.ts`
- `apps/api/src/modules/github-kb/memory-extractor.ts`
- `apps/api/src/modules/github-kb/memory-repository.ts`
- `apps/api/src/modules/github-kb/memory-service.ts`

Advantages:

- shares lifecycle with docs sync
- less migration risk
- easy to use existing repo registration and checkpoint flow

Recommendation:

- use this option first

## 6.2 Medium-Term Option

If future sources expand beyond `docs-com`, then extract to a standalone module:

- `apps/api/src/modules/knowledge-memory/*`

That becomes worthwhile only when memory sources include:

- docs-com
- support ticket resolutions
- release notes
- product metadata
- ops runbooks outside the docs repo

Recommendation:

- do **not** start with this split now
- design tables so future extraction is possible

## 6.3 Concrete Files To Change

### Database

Add a new migration after current KB migrations to create:

- `kb_memory_entries`
- `kb_memory_sources`
- `kb_memory_relations`
- `kb_memory_aliases`
- `kb_memory_signals`
- `kb_memory_profiles`

### Ingestion

Modify:

- `apps/api/src/modules/github-kb/service.ts`

Add:

- memory extraction after document/chunk build
- relation build for the affected corpus

### Retrieval

Modify:

- `apps/api/src/modules/github-kb/repository.ts`
- `apps/api/src/modules/ai/search-orchestrator.ts`

Add:

- `searchMemoryCandidates()`
- `expandMemoryRelations()`
- `resolveChunksForMemoryEntries()`
- rewrite + rerank + graph expansion flow

### Diagnostics

Extend:

- retrieval debug payloads
- business eval harness
- support diagnostics traces

Track:

- rewritten queries
- memory hits
- relation expansions
- exact signal hits
- profile hits
- chunk grounding success

## Part 7. Rollout Plan

## Phase 0. Guardrails

Before implementation:

- keep `docs-com` as the only customer-facing citation source
- do not add answer text special cases
- do not bypass support-agent

## Phase 1. Schema And Build

Deliver:

- new memory graph tables
- memory extraction during reindex
- source mapping and aliases/signals

Acceptance:

- every major docs family has memory entries
- memory entries map back to canonical chunks

## Phase 2. Retrieval Integration

Deliver:

- query rewriting
- memory retrieval channels
- graph expansion
- fused reranking

Acceptance:

- support retrieval works with `embedding = null`
- GitHub callback troubleshooting case ranks integration troubleshooting memories above unrelated OpenAPI pages

## Phase 3. Profile Layer

Deliver:

- support knowledge profiles for high-volume product surfaces

Acceptance:

- common product surfaces return better top-k recall and lower latency

## Phase 4. Evaluation

Measure:

- top-1 grounded hit rate
- citation coverage
- unsupported verdict rate
- unnecessary handoff rate
- wrong-doc-family hit rate

## Part 8. Risks

### Risk 1. Overbuilding the graph

If relation extraction is too aggressive, false positives will rise.

Mitigation:

- start with conservative `updates` and `extends`
- gate `derives` behind stricter thresholds

### Risk 2. LLM extraction drift

If memory entry extraction is too free-form, retrieval quality degrades.

Mitigation:

- use strict extraction schema
- add deterministic post-validation
- only activate entries linked to valid chunks

### Risk 3. Hidden answer-side hacks

If retrieval quality problems are patched in answer composition, architecture will degrade.

Mitigation:

- enforce retrieval-layer fixes only
- keep answer composer grounded and generic

### Risk 4. Chinese retrieval quality still weak

Mitigation:

- add trigram / n-gram index path
- add alias-heavy extraction for support symptoms and UI labels

## Part 9. Final Recommendation

The final recommendation is:

1. do **not** attempt to replace the support pipeline
2. do **not** treat DeerFlow memory as the final blueprint
3. do **directly copy** Supermemory's memory graph and retrieval model
4. do **directly copy** DeerFlow's async memory build discipline
5. implement a `docs-com grounded knowledge memory graph`

In concrete terms:

- `kb_chunks` remain the evidence layer
- `kb_memory_entries` become the retrieval layer
- `kb_memory_relations` become the semantic expansion layer
- `kb_memory_profiles` become the fast-context layer
- `search-orchestrator` becomes a graph-aware retrieval runner
- `support-agent` remains the answer orchestration layer

This is the cleanest path to high-quality knowledge retrieval without waiting for embedding quota recovery.

## Recommended Next Implementation Step

Implement this next, in order:

1. migration for memory graph tables
2. chunk-to-memory extraction pipeline
3. memory retrieval repository methods
4. query rewriting + reranking in `search-orchestrator`
5. evaluation on current known failure cases

That sequence gives the highest retrieval-quality upside with the lowest disruption to the existing support-agent architecture.
