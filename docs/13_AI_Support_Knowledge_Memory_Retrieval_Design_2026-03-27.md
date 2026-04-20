# AI Support Knowledge Memory Retrieval Design

Date: 2026-03-27

Scope: design a high-quality knowledge retrieval architecture that does not depend on embeddings, while preserving `BangWork/docs-com` as the primary evidence source for customer-facing support answers.

## Executive Summary

The current problem is not that the KB is empty.

The KB corpus is now present, but `kb_chunks.embedding` is still unavailable because the embeddings provider is returning `429 insufficient_quota`.

This means the current retrieval path degrades to keyword and document fallback retrieval, which is not strong enough for:

- Chinese troubleshooting phrasing
- synonym / paraphrase matching
- symptom-to-cause matching
- UI wording that differs from doc titles
- operational troubleshooting that depends on section-level evidence rather than page-level overlap

The replacement for embeddings should not be conversation memory.

The replacement should be a `knowledge memory` layer built from `docs-com` itself:

- `kb_documents` and `kb_chunks` remain the source of truth
- a new `knowledge memory` layer stores structured retrieval units derived from those docs
- retrieval first matches against structured knowledge memory
- final customer-facing evidence still comes from grounded `docs-com` chunks with citations

This design preserves the repository principles:

- no deterministic answer trees
- no one-off query regex patches for customer questions
- `BangWork/docs-com` stays the primary knowledge source
- multi-turn support orchestration remains AI-driven

## Problem Statement

### Confirmed Current State

- `docs-com` KB data already exists in the shared database
- `deploy-docs/`, `docs/`, and `open-docs/` active document families are present
- legacy `blog/` noise has been deactivated
- sync checkpoint has been updated
- preview `docs-com/status` is healthy
- active chunks currently have `embedding = null`

### Why Current Retrieval Still Underperforms

Without embeddings, the current system relies primarily on:

- chunk lexical search on `title`, `path`, `heading_path`, `content`, and `search_vector`
- document fallback retrieval when chunk confidence is low
- route-aware rerank after retrieval

This is insufficient when the user query and the source doc use different wording.

Example:

- user asks: `GitHub 集成授权后回调页面显示 page not found，怎么排查？`
- relevant doc may contain signals such as `Redirect URI`, callback URL, and `baseURL`
- the wording overlap is partial rather than exact
- retrieval may hit the document title but fail to expose the answer-bearing passage strongly enough for downstream evidence selection

## Design Goal

Build a high-quality retrieval system that preserves grounded citation quality without requiring live embeddings.

The design must:

1. improve first-pass recall for troubleshooting, API, how-to, and behavior questions
2. support Chinese, English, and mixed-language queries
3. support symptom-oriented and paraphrased questions
4. keep `docs-com` as the final citation source
5. integrate into the existing `github-kb -> search-orchestrator -> support-agent` pipeline
6. avoid adding deterministic answer branches or query-specific hacks

## Non-Goals

The following are explicitly out of scope as primary solutions:

- replacing the support agent with a rule tree
- directly answering from memory without grounded citations
- treating conversation transcript memory as a retrieval substitute
- adding one-off regexes for specific known questions
- creating a second customer-facing answer path beside the shared support-agent pipeline

## Core Concept

The key architectural change is to add a `Knowledge Memory Layer` between raw chunks and support retrieval.

### Current Model

- `kb_documents`: canonical document records
- `kb_chunks`: chunked text used for retrieval and citation

### Proposed Model

- `kb_documents`: canonical document records
- `kb_chunks`: canonical citation-bearing raw evidence
- `kb_memory_cards`: structured knowledge units derived from docs/chunks
- `kb_memory_aliases`: synonym and phrasing expansion for each memory card
- `kb_memory_signals`: exact retrieval signals such as error codes, URLs, scopes, API paths, and symptom phrases
- `kb_memory_edges`: graph links between related knowledge units

In this design:

- `chunks` remain evidence
- `memory cards` become the primary retrieval surface
- `edges` provide lightweight semantic expansion without embeddings

## What A Knowledge Memory Card Represents

A memory card is not a generated answer.

It is a normalized retrieval unit extracted from a source chunk or section, designed to bridge user phrasing and canonical docs wording.

Each memory card should describe one support-relevant unit such as:

- a concept
- a procedure
- an API operation
- a troubleshooting pattern
- a UI behavior
- a limitation or prerequisite

### Example

For a GitHub OAuth callback troubleshooting section, a memory card may capture:

- canonical claim:
  `GitHub OAuth callback page not found usually indicates Redirect URI or baseURL mismatch`
- aliases:
  - `github callback 404`
  - `oauth page not found`
  - `redirect uri mismatch`
  - `授权回调找不到页面`
- signals:
  - `callback`
  - `redirect uri`
  - `baseURL`
  - `oauth`
  - `github`
- linked source:
  - doc path
  - heading path
  - chunk ids

This allows the system to match the user symptom first, then return to the original `docs-com` chunk for citation.

## Data Model

## Table 1. `kb_memory_cards`

Purpose:

- store normalized retrieval units derived from source docs/chunks

Suggested fields:

- `id UUID PRIMARY KEY`
- `repo_id UUID NOT NULL`
- `doc_id UUID NOT NULL`
- `chunk_id TEXT`
- `branch TEXT NOT NULL`
- `path TEXT NOT NULL`
- `heading_path TEXT NOT NULL`
- `memory_type TEXT NOT NULL`
- `canonical_claim TEXT NOT NULL`
- `summary TEXT NOT NULL`
- `product_area TEXT NOT NULL`
- `doc_kind TEXT NOT NULL`
- `deployment_model TEXT`
- `action_type TEXT`
- `object_type TEXT`
- `confidence NUMERIC NOT NULL DEFAULT 0`
- `metadata JSONB NOT NULL DEFAULT '{}'::jsonb`
- `is_active BOOLEAN NOT NULL DEFAULT true`
- `created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`
- `updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`

Recommended indexes:

- `BTREE(repo_id, branch, is_active, updated_at DESC)`
- `BTREE(product_area, doc_kind, memory_type)`
- `GIN(to_tsvector('english', canonical_claim || ' ' || summary))`
- `GIN(metadata)`

## Table 2. `kb_memory_aliases`

Purpose:

- capture paraphrases, bilingual terms, UI labels, and retrieval-friendly synonyms

Suggested fields:

- `id UUID PRIMARY KEY`
- `memory_id UUID NOT NULL`
- `alias TEXT NOT NULL`
- `alias_type TEXT NOT NULL`
- `weight NUMERIC NOT NULL DEFAULT 1`
- `metadata JSONB NOT NULL DEFAULT '{}'::jsonb`

Recommended indexes:

- `BTREE(memory_id)`
- `GIN(alias gin_trgm_ops)` or equivalent trigram / ngram support

## Table 3. `kb_memory_signals`

Purpose:

- store structured exact-match retrieval handles

Suggested fields:

- `id UUID PRIMARY KEY`
- `memory_id UUID NOT NULL`
- `signal_type TEXT NOT NULL`
- `signal_value TEXT NOT NULL`
- `weight NUMERIC NOT NULL DEFAULT 1`
- `metadata JSONB NOT NULL DEFAULT '{}'::jsonb`

Suggested signal types:

- `error_code`
- `url`
- `api_path`
- `http_method`
- `scope`
- `object`
- `action`
- `symptom`
- `setting`
- `ui_label`
- `callback`

Recommended indexes:

- `BTREE(memory_id)`
- `BTREE(signal_type, signal_value)`
- `GIN(signal_value gin_trgm_ops)` if supported

## Table 4. `kb_memory_edges`

Purpose:

- provide graph-based retrieval expansion without embeddings

Suggested fields:

- `id UUID PRIMARY KEY`
- `from_memory_id UUID NOT NULL`
- `to_memory_id UUID NOT NULL`
- `edge_type TEXT NOT NULL`
- `weight NUMERIC NOT NULL DEFAULT 1`
- `metadata JSONB NOT NULL DEFAULT '{}'::jsonb`

Suggested edge types:

- `same_topic`
- `prerequisite`
- `next_step`
- `same_error_family`
- `same_feature`
- `same_ui_surface`

Recommended indexes:

- `BTREE(from_memory_id, edge_type)`
- `BTREE(to_memory_id, edge_type)`

## Memory Build Pipeline

Knowledge memory should be built during the existing sync / reindex flow, not as a separate product.

### Source Of Truth

The only canonical content source remains:

- `BangWork/docs-com`
- indexed through existing `kb_documents` and `kb_chunks`

### Build Stages

1. `Document parse`
   - keep existing markdown section parsing
2. `Chunk generation`
   - keep chunking as the evidence layer
3. `Memory extraction`
   - derive one or more memory cards per chunk / section
4. `Alias extraction`
   - derive likely user phrasings, bilingual variants, UI labels, and symptom phrases
5. `Signal extraction`
   - derive exact handles such as scope, path, callback, endpoint, button names, error phrases
6. `Graph linking`
   - link related memory cards within a doc and across related docs

### Extraction Strategy

Do not extract free-form chain-of-thought.

Only extract retrieval-facing structure:

- what this unit is about
- how a customer might ask for it
- exact signals that should match it
- what product area / doc kind it belongs to
- what source chunks can ground it

### Memory Types

Recommended `memory_type` taxonomy:

- `concept`
- `procedure`
- `api_operation`
- `troubleshooting`
- `behavior`
- `constraint`
- `ui_surface`
- `permission_requirement`

## Chunking Requirements For Knowledge Memory

The current chunker is workable for general content but needs stronger answer-locality guarantees for support retrieval.

Priority improvements:

1. split troubleshooting sections more aggressively
2. isolate FAQ questions and answers into dedicated chunks
3. isolate operational warning / limitation blocks
4. isolate list steps when each step carries retrieval-relevant wording
5. preserve section titles in chunk-local retrieval metadata
6. improve snippet anchoring so matched evidence is visible even if it appears late in the chunk

This is required because knowledge memory should point back to chunks that expose the actual support evidence, not just generic introductions.

## Retrieval Architecture

Retrieval should become a multi-channel lexical and graph retrieval system.

### Stage A. Query Understanding

Use the existing support-agent route and case-frame pipeline to build a retrieval plan.

The retrieval plan should capture:

- normalized query
- language
- `product_area`
- `question_type`
- `action_type`
- `required_doc_kinds`
- extracted exact signals
- symptom phrases
- likely object and action pairs
- deployment model hints

This keeps the retrieval system AI-driven without falling back to static rule trees.

### Stage B. Candidate Generation

Run these channels in parallel:

1. `Chunk lexical retrieval`
   - current chunk search remains active

2. `Memory card lexical retrieval`
   - search `canonical_claim` and `summary`

3. `Alias retrieval`
   - search `kb_memory_aliases.alias`

4. `Signal retrieval`
   - exact or fuzzy search on `kb_memory_signals`

5. `Graph expansion`
   - once top memory cards are found, expand 1 hop through `kb_memory_edges`

6. `Document fallback`
   - keep existing doc-level fallback as a last resort

### Stage C. Fusion And Rerank

Use weighted fusion rather than a single rank source.

Suggested score components:

- `exact_signal_score`
- `alias_match_score`
- `canonical_claim_score`
- `heading_title_score`
- `body_lexical_score`
- `product_area_match_score`
- `doc_kind_match_score`
- `route_caseframe_match_score`
- `graph_proximity_score`
- `source_authority_score`

Suggested ranking behavior:

- exact signal matches should dominate generic term overlap
- route-compatible memory cards should outrank broad text matches
- troubleshooting cards should outrank capability cards for troubleshooting questions
- cards with better chunk-grounding quality should rank higher

### Stage D. Grounding Back To Docs

The final references passed into evidence selection must still be `docs-com` source chunks.

Process:

1. retrieve and rank memory cards
2. map top memory cards back to linked chunks
3. rebuild query-anchored snippets from the linked chunks
4. pass those chunk references into evidence selector / judge / answer composer

This keeps the retrieval layer strong without violating grounded citation requirements.

## How This Replaces The Practical Value Of Embeddings

Embeddings mainly help with:

- paraphrase matching
- bilingual and mixed-language matching
- symptom-oriented phrasing
- non-title wording
- loose semantic adjacency

Knowledge memory replaces those benefits through:

- curated aliases
- exact and fuzzy signal extraction
- product-area and doc-kind alignment
- graph edges between related memory units
- route-aware reranking

This is less generic than embeddings, but more controllable and often better for support domains where:

- vocabulary is repetitive
- product surfaces are finite
- signals such as path, scope, URL, callback, and page wording matter heavily

## Chinese And Mixed-Language Retrieval Requirements

Without embeddings, high-quality Chinese retrieval requires explicit indexing support.

The design should include:

- trigram or n-gram lexical indexing for Chinese phrases
- bilingual aliases in memory cards
- explicit UI wording aliases
- exact string signal storage for English technical terms used inside Chinese questions
- stronger heading and title boosting

The system should not rely only on English `tsvector` for mixed-language support retrieval.

## Integration Points In Current Codebase

The following modules should remain the main integration points:

- `apps/api/src/modules/github-kb/service.ts`
  - build and upsert knowledge memory during sync / reindex
- `apps/api/src/modules/github-kb/repository.ts`
  - add memory retrieval repository methods
- `apps/api/src/modules/ai/search-orchestrator.ts`
  - call chunk and memory retrieval in parallel and fuse results
- `apps/api/src/modules/ai/support-agent.ts`
  - keep current support-agent orchestration and evidence-policy flow

This design intentionally avoids introducing a second answer generation flow.

## Rollout Plan

## Phase 1. Foundation

Deliverables:

- schema for memory cards, aliases, signals, and edges
- repository methods to upsert and deactivate memory data
- reindex path to generate memory artifacts from `docs-com`

Acceptance:

- full docs-com reindex produces memory cards for active docs
- each memory card points to at least one active source doc / chunk

## Phase 2. Retrieval Replacement

Deliverables:

- parallel retrieval over chunks, memory cards, aliases, and signals
- route-aware fusion scoring
- chunk grounding from top memory cards

Acceptance:

- retrieval no longer depends on embeddings being present
- top ranked candidates for key support eval cases come from the expected docs family

## Phase 3. Graph Expansion

Deliverables:

- memory edges
- one-hop graph expansion for closely related troubleshooting and prerequisite knowledge

Acceptance:

- related follow-up knowledge can be retrieved without direct title overlap

## Phase 4. Evaluation And Hardening

Deliverables:

- eval suite for answer-bearing passage recall
- metrics for top-1 grounding, citation coverage, handoff rate, and unsupported rate

Acceptance:

- troubleshooting evals no longer regress to unrelated API docs when relevant operational docs exist
- citation coverage improves without increasing false grounding

## Acceptance Criteria

The design is successful when all of the following are true:

1. the system can retrieve correct docs-com evidence even when the user phrasing does not match the source wording exactly
2. troubleshooting queries prioritize troubleshooting passages over generic API or capability pages
3. retrieval remains grounded in `docs-com` chunks
4. the system works with `embedding = null`
5. support answers show higher citation quality and lower unnecessary handoff rate

## Risks And Controls

### Risk 1. Memory Drift

Risk:

- memory cards may become stale or misaligned with updated docs

Control:

- rebuild memory only from the latest indexed docs
- tie memory lifecycle to chunk lifecycle
- deactivate memory cards when source docs/chunks are deactivated

### Risk 2. Over-Abstraction

Risk:

- memory summaries may become too broad and introduce false positives

Control:

- keep cards small and source-linked
- rank chunk-grounding quality explicitly
- require final evidence to come from original chunks

### Risk 3. Hidden Rule Creep

Risk:

- the system could degrade into manual query heuristics

Control:

- keep retrieval improvements generic
- prefer metadata, signals, and graph links extracted from docs
- do not add case-specific answer builders

## Open Questions

1. whether memory extraction should be fully deterministic, LLM-assisted, or hybrid
2. whether Chinese indexing should use `pg_trgm`, custom n-grams, or both
3. how much graph expansion to allow before precision starts dropping
4. whether `open-docs` API docs need a specialized memory subtype for endpoint and scope retrieval

## Recommended Next Step

Implement the retrieval foundation in this order:

1. memory schema
2. memory build during reindex
3. memory retrieval repository methods
4. orchestrator-level fusion retrieval
5. eval-driven tuning on known support failure cases

This sequencing restores retrieval quality without waiting for embedding quota recovery and without violating the support-agent architecture principles already defined in this repository.
