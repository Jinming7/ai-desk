# AI Support Knowledge Memory Retrieval Optimized Design

Date: 2026-03-27

Scope: provide the optimized end-state design for `docs-com` grounded support retrieval after reviewing:

- the original knowledge-memory proposal
- current `TicketManagement` retrieval architecture
- source-based research on `deer-flow`
- source-based research on `supermemory`

This document is the recommended implementation target.

## Executive Summary

The optimized design is:

- keep `BangWork/docs-com` as the only canonical knowledge source
- keep `kb_documents` and `kb_chunks` as the grounding and citation layer
- add a new `knowledge memory graph` as the primary retrieval layer
- keep `support-agent` as the only customer-answer pipeline

The main architectural change is to move retrieval from:

- `raw chunk lexical retrieval + document fallback`

to:

- `query rewrite + memory entry retrieval + alias/signal retrieval + graph expansion + rerank + chunk grounding`

This design copies:

- `deer-flow`'s engineering pattern:
  - asynchronous extraction
  - write/read separation
  - storage abstraction discipline
  - atomic update mindset
- `supermemory`'s retrieval model:
  - memory graph
  - `updates / extends / derives`
  - query rewriting
  - reranking
  - dual-layer context model

It does **not** copy:

- DeerFlow's conversation-memory data model as the support KB
- Supermemory's embeddings-first assumptions
- any new customer-facing answer path outside the existing support-agent pipeline

## 1. Current Problem

The immediate production issue is not corpus completeness.

The immediate issue is:

- active `docs-com` KB data exists
- active `kb_chunks.embedding` is empty
- retrieval quality falls back to lexical search and document fallback

This causes systematic degradation for:

- Chinese troubleshooting questions
- symptom-driven queries
- UI-wording mismatch
- OAuth / callback / permission problems
- questions where the answer-bearing phrase is not the document title

The current stack can still retrieve something, but not reliably enough to sustain grounded support answers at the expected quality level.

## 2. Design Goal

Build a high-quality retrieval layer that works even when `embedding = null`.

The design must:

1. keep `docs-com` as the final evidence and citation source
2. improve first-pass recall for support queries
3. support Chinese, English, and mixed technical phrasing
4. support symptom-oriented, paraphrased, and multi-hop retrieval
5. fit into the current `github-kb -> search-orchestrator -> support-agent` stack
6. avoid deterministic one-off answer patches

## 3. Design Principles

## 3.1 Source Of Truth

Only `BangWork/docs-com` should be treated as the canonical support knowledge source when grounded documentation exists.

## 3.2 Retrieval Units Are Not Citation Units

The system must distinguish:

- retrieval units:
  - optimized for matching user intent
- citation units:
  - optimized for grounded answer evidence

This is the most important structural change.

## 3.3 Retrieval Must Be Graph-Aware

Support knowledge is not flat.

The retrieval layer must model:

- superseded guidance
- supporting guidance
- derived support conclusions

## 3.4 Write Path Must Be Asynchronous

Knowledge extraction and graph building should happen during sync/reindex or in a queued post-processing step, not inline with customer requests.

## 3.5 Answer Path Stays Shared

The customer-facing answer must still come from:

- support-agent routing
- evidence selection
- evidence verification
- answer composition

No parallel deterministic answer branch should be introduced.

## 4. Optimized Target Architecture

The architecture should be organized into four layers.

## Layer 1. Corpus Layer

Existing:

- `kb_repo_registrations`
- `kb_documents`

Purpose:

- represent source repositories and canonical documents

## Layer 2. Grounding Layer

Existing:

- `kb_chunks`

Purpose:

- represent chunk-level grounded evidence
- preserve path, heading, snippet, and final citation surface

## Layer 3. Knowledge Memory Graph

New:

- `kb_memory_entries`
- `kb_memory_sources`
- `kb_memory_relations`
- `kb_memory_aliases`
- `kb_memory_signals`
- `kb_memory_profiles`

Purpose:

- provide the primary retrieval substrate

## Layer 4. Runtime Retrieval And Answering

Existing but enhanced:

- `search-orchestrator`
- `support-agent`

Purpose:

- route-aware retrieval
- evidence selection
- grounded answer generation

## 5. Data Model

## 5.1 `kb_memory_entries`

This replaces the simpler `kb_memory_cards` concept.

Purpose:

- represent the first-class retrieval unit

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
- `doc_kind TEXT NOT NULL`
- `action_type TEXT`
- `deployment_model TEXT`
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

Recommended indexes:

- `BTREE(repo_id, branch, status, updated_at DESC)`
- `BTREE(product_area, doc_kind, memory_kind)`
- `GIN(search_vector)`
- trigram / n-gram indexes for `canonical_claim`, `summary`, and `search_text`

## 5.2 `kb_memory_sources`

This is a required optimization over the original design.

Purpose:

- map one memory entry to one or more source chunks

Suggested fields:

- `memory_id UUID NOT NULL`
- `doc_id UUID NOT NULL`
- `chunk_id TEXT NOT NULL`
- `heading_path TEXT NOT NULL`
- `source_score NUMERIC(8,6) NOT NULL DEFAULT 1`
- `source_metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb`
- `PRIMARY KEY (memory_id, chunk_id)`

Why this table is necessary:

- one support memory often spans multiple chunks
- one troubleshooting conclusion may need multiple supporting passages
- retrieval units and grounding units should not be forced into a 1:1 relationship

## 5.3 `kb_memory_relations`

This should adopt the Supermemory-style relation model directly.

Purpose:

- encode graph structure over memory entries

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

Semantics:

- `updates`
  - new guidance supersedes older guidance
- `extends`
  - adds supporting context, prerequisites, or next-step detail
- `derives`
  - synthesized support concept inferred from multiple memories

Recommended indexes:

- `BTREE(from_memory_id, relation_type)`
- `BTREE(to_memory_id, relation_type)`

## 5.4 `kb_memory_aliases`

Purpose:

- support paraphrase and multilingual retrieval

Suggested fields:

- `id UUID PRIMARY KEY`
- `memory_id UUID NOT NULL`
- `alias TEXT NOT NULL`
- `alias_type TEXT NOT NULL`
- `weight NUMERIC(8,6) NOT NULL DEFAULT 1`
- `metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb`

Suggested `alias_type` values:

- `zh_phrase`
- `en_phrase`
- `symptom`
- `ui_label`
- `error_phrase`
- `path_hint`
- `operation_variant`

Recommended indexes:

- `BTREE(memory_id)`
- trigram / n-gram index on `alias`

## 5.5 `kb_memory_signals`

Purpose:

- store exact and near-exact retrieval handles

Suggested fields:

- `id UUID PRIMARY KEY`
- `memory_id UUID NOT NULL`
- `signal_type TEXT NOT NULL`
- `signal_value TEXT NOT NULL`
- `weight NUMERIC(8,6) NOT NULL DEFAULT 1`
- `metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb`

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

Recommended indexes:

- `BTREE(signal_type, signal_value)`
- `BTREE(memory_id)`
- trigram index on `signal_value` for fuzzy matches

## 5.6 `kb_memory_profiles`

This is the main new addition missing from the original `docs/13` design.

Purpose:

- provide low-latency stable context for high-volume support surfaces

This is **not** a user profile.

It is a support knowledge profile.

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

Use cases:

- fast retrieval of broad product-area context
- route-aware retrieval priors
- early narrowing before deeper search

## 6. Build Pipeline

The optimized build pipeline combines:

- current `github-kb` sync flow
- DeerFlow-style async extraction discipline
- Supermemory-style staged indexing

## 6.1 Stage 1. Sync Canonical Docs

Keep existing:

- repo registration
- file collection
- parse
- document upsert
- chunk upsert

## 6.2 Stage 2. Build Memory Entries

For each active document and chunk:

1. use current `supportEvidence` as the base metadata
2. extract one or more memory entries
3. assign `memory_kind`
4. assign static vs dynamic
5. populate `search_text`
6. populate aliases
7. populate signals
8. populate source links to chunks

Extraction rules:

- one memory entry should represent one support-relevant unit
- extraction should be schema-constrained
- memory entries are retrieval-facing, not answer-facing

## 6.3 Stage 3. Build Relations

After memory entries exist:

1. build `updates`
   - newer version or clearly superseding guidance
2. build `extends`
   - related setup, prerequisite, or operational continuation
3. build `derives`
   - synthesized patterns from multiple related memory entries

Conservative rollout recommendation:

- enable `updates` and `extends` first
- enable `derives` only after eval confirms precision

## 6.4 Stage 4. Build Profiles

Aggregate stable memory entries into feature/product profiles.

Each profile should summarize:

- what this surface is
- what common constraints apply
- what typical troubleshooting surfaces exist

Profiles should be generated only for well-defined knowledge areas.

## 6.5 Stage 5. Activate Atomically

This is the most important engineering requirement borrowed from DeerFlow patterns.

Memory graph data should not be half-visible during rebuild.

Recommended activation strategy:

- build new memory artifacts for the affected corpus/version
- validate counts and source mappings
- switch active set only after build completion

Implementation options:

- per-document transaction replace
- batch versioning plus `status = active`

## 7. Retrieval Runtime

This is the main optimized runtime path.

## 7.1 Step 1. Generate Retrieval Intent

Keep current `support-agent` route and case frame generation.

The retrieval layer should consume:

- `question_type`
- `product_area`
- `action_type`
- `required_doc_kinds`
- `goal`
- `symptom`
- `object`

This remains the contract between routing and retrieval.

## 7.2 Step 2. Query Rewriting

Adopt Supermemory's rewrite concept directly.

For each incoming question, generate a bounded set of rewrites:

- original query
- normalized query
- symptom-focused rewrite
- object/action rewrite
- exact-signal rewrite
- route-aware rewrite

Rules:

- limit to 3-6 rewrites
- deduplicate aggressively
- attach rewrites to diagnostics

## 7.3 Step 3. Multi-Channel Retrieval

For each rewrite, retrieve from all of the following:

1. `memory entry lexical search`
2. `alias search`
3. `signal search`
4. `profile search`
5. `raw chunk lexical search`
6. `document fallback`

This is the minimum acceptable retrieval stack.

## 7.4 Step 4. Graph Expansion

From top memory hits, expand:

- 1 hop on `updates`
- 1 hop on `extends`
- optionally 1 hop on `derives`

Rules:

- `updates` can replace stale guidance
- `extends` can add supporting context
- `derives` must be low-priority unless supported by multiple direct hits

## 7.5 Step 5. Fusion And Rerank

The final ranking should combine:

- `rewrite_match_score`
- `canonical_claim_score`
- `alias_match_score`
- `exact_signal_score`
- `profile_match_score`
- `heading_title_score`
- `body_score`
- `product_area_match_score`
- `doc_kind_match_score`
- `action_type_match_score`
- `relation_bonus`
- `recency_bonus`
- `source_quality_bonus`

Suggested ranking principles:

- exact signals outrank generic lexical overlap
- route-compatible hits outrank topical but wrong-family hits
- troubleshooting patterns outrank capability pages for troubleshooting questions
- API operation memories outrank broad narrative docs for API questions

## 7.6 Step 6. Ground Back To Chunks

After memory entries are ranked:

1. resolve top entries through `kb_memory_sources`
2. load linked chunks
3. build query-anchored snippets
4. emit final `SearchReference[]` from canonical chunks only

This ensures:

- retrieval quality comes from memory graph
- answer grounding still comes from docs-com chunks

## 7.7 Step 7. Existing Support Pipeline Continues

Keep:

- evidence selector
- evidence judge
- answer composer

The retrieval design should improve the inputs to these stages, not replace them.

## 8. Non-Embedding Quality Strategy

Because embeddings may remain unavailable for some time, the system must explicitly optimize for non-vector retrieval.

Recommended indexing strategy:

1. keep `tsvector` for English prose
2. add trigram or equivalent CJK-friendly lexical indexing for:
   - Chinese phrases
   - mixed-language text
   - UI labels
   - URLs
   - API paths
3. add exact indexes for strong signals:
   - scope
   - callback
   - redirect URI
   - method/path
   - error codes

Recommended text preparation:

- normalize punctuation and whitespace
- preserve technical casing in stored fields
- keep bilingual aliases
- emphasize section titles and operational phrases in `search_text`

## 9. Module Architecture Recommendation

The optimized rollout should favor minimum disruption.

## 9.1 Near-Term Recommendation

Implement knowledge memory inside `github-kb` first.

Suggested new modules:

- `apps/api/src/modules/github-kb/memory-types.ts`
- `apps/api/src/modules/github-kb/memory-repository.ts`
- `apps/api/src/modules/github-kb/memory-extractor.ts`
- `apps/api/src/modules/github-kb/memory-service.ts`

Why:

- shares the same source lifecycle
- easier to keep memory graph aligned with docs sync
- lower migration risk

## 9.2 Medium-Term Recommendation

If future sources expand beyond `docs-com`, extract to:

- `apps/api/src/modules/knowledge-memory/*`

Do not do this first.

## 10. Concrete Changes By Area

## 10.1 Database

Add a new migration for:

- `kb_memory_entries`
- `kb_memory_sources`
- `kb_memory_relations`
- `kb_memory_aliases`
- `kb_memory_signals`
- `kb_memory_profiles`

## 10.2 Ingestion

Modify:

- `apps/api/src/modules/github-kb/service.ts`

Add:

- memory-entry extraction after chunk build
- relation build
- profile build
- activation semantics

## 10.3 Retrieval

Modify:

- `apps/api/src/modules/github-kb/repository.ts`
- `apps/api/src/modules/ai/search-orchestrator.ts`

Add retrieval methods:

- `searchMemoryEntries()`
- `searchMemoryAliases()`
- `searchMemorySignals()`
- `searchMemoryProfiles()`
- `expandMemoryRelations()`
- `resolveMemorySourcesToChunks()`

## 10.4 Diagnostics

Extend diagnostics to capture:

- rewritten queries
- direct memory hits
- relation expansion count
- signal-hit reasons
- profile-hit reasons
- final chunk-grounding reasons

## 11. Rollout Plan

## Phase 0. Safety Constraints

Before implementation:

- no answer-side query hacks
- no direct customer answers from memory graph
- no second support-answer path

## Phase 1. Schema And Build Foundation

Deliver:

- memory graph schema
- memory extraction during sync/reindex
- source mappings
- aliases and signals

Acceptance:

- active docs produce active memory entries
- every active memory entry resolves to at least one active chunk

## Phase 2. Retrieval Integration

Deliver:

- query rewriting
- multi-channel retrieval
- graph expansion
- fusion rerank

Acceptance:

- retrieval quality no longer depends on embeddings to be viable
- known support cases prefer the correct docs family

## Phase 3. Profile Layer

Deliver:

- support knowledge profiles for major product surfaces

Acceptance:

- lower latency and better recall for common support areas

## Phase 4. Evaluation

Track:

- top-1 grounded recall
- citation coverage
- unsupported rate
- unnecessary handoff rate
- wrong-doc-family hit rate

## 12. Risks And Controls

## 12.1 Overly Broad Relations

Risk:

- graph expansion may increase false positives

Control:

- start conservative
- enable `derives` later

## 12.2 LLM Extraction Drift

Risk:

- poor extraction quality may pollute memory entries

Control:

- strict extraction schema
- deterministic validation
- source-link requirements

## 12.3 Hidden Rule Regression

Risk:

- teams may patch misses with answer-side hacks

Control:

- make retrieval layer the only supported fix path

## 12.4 Chinese Retrieval Gaps

Risk:

- English-oriented indexing remains insufficient

Control:

- trigram / n-gram indexing
- bilingual aliases
- support symptom vocabulary extraction

## 13. Final Recommendation

Compared with the original `docs/13` proposal, the optimized design makes six key upgrades:

1. `memory cards` become `memory entries`
2. retrieval units are separated from citation units through `kb_memory_sources`
3. relation types are normalized to `updates / extends / derives`
4. a support knowledge `profile` layer is added
5. build and activation semantics are made asynchronous and atomic
6. runtime retrieval is fully specified as rewrite -> multi-channel retrieve -> expand -> rerank -> ground

This is the recommended complete retrieval design for the project.

## Recommended Immediate Next Step

Implement in this order:

1. schema migration
2. memory extraction skeleton in `github-kb`
3. retrieval repository methods
4. search-orchestrator integration
5. eval-driven tuning on current failing support cases

This preserves the current support-agent architecture while delivering the largest retrieval-quality improvement under the current non-embedding constraint.
