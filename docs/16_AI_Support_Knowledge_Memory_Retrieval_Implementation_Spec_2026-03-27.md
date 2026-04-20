# AI Support Knowledge Memory Retrieval Implementation Spec

Date: 2026-03-27

Scope: turn the optimized knowledge-memory retrieval architecture into a directly implementable technical specification for `TicketManagement`.

Status: this document is intended to be implementation-ready for v1.

## 1. Goal

Implement a `docs-com` grounded knowledge retrieval layer that remains high quality when `kb_chunks.embedding` is unavailable.

The implementation must:

- keep `BangWork/docs-com` as the primary knowledge source
- keep `kb_chunks` as the final citation source
- add a memory-graph retrieval layer above chunks
- integrate into the existing `github-kb -> search-orchestrator -> support-agent` stack
- avoid any new deterministic customer-answer path

## 2. Scope Boundary

## In Scope

- new KB memory graph tables
- extraction pipeline during sync/reindex
- retrieval repository methods
- query rewriting
- graph expansion
- fused reranking
- chunk grounding
- evaluation and diagnostics

## Out Of Scope

- replacing support-agent
- customer-answer deterministic rule trees
- direct customer answers from memory entries
- production UI for graph visualization
- user-personalization memory

## 3. Final Data Model

## 3.1 Migration Name

Add a new migration:

- `018_kb_memory_graph.sql`

## 3.2 Required Extensions

Use:

- `pg_trgm`
- existing `vector` extension may remain installed but is not required for this feature

Migration preamble:

```sql
DO $$
BEGIN
  CREATE EXTENSION IF NOT EXISTS pg_trgm;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'pg_trgm extension is not available: %', SQLERRM;
END $$;
```

## 3.3 `kb_memory_entries`

```sql
CREATE TABLE IF NOT EXISTS kb_memory_entries (
  id UUID PRIMARY KEY,
  repo_id UUID NOT NULL REFERENCES kb_repo_registrations(id) ON DELETE CASCADE,
  branch TEXT NOT NULL,
  doc_id UUID NOT NULL REFERENCES kb_documents(id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  memory_kind TEXT NOT NULL,
  title TEXT,
  canonical_claim TEXT NOT NULL,
  summary TEXT NOT NULL,
  product_area TEXT NOT NULL DEFAULT 'general',
  doc_kind TEXT NOT NULL DEFAULT 'general',
  action_type TEXT,
  deployment_model TEXT,
  object_type TEXT,
  is_static BOOLEAN NOT NULL DEFAULT false,
  is_latest BOOLEAN NOT NULL DEFAULT true,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'superseded', 'inactive')),
  build_version TEXT NOT NULL,
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  search_text TEXT NOT NULL,
  search_vector TSVECTOR,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_kb_memory_entries_active
  ON kb_memory_entries(repo_id, branch, status, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_kb_memory_entries_doc
  ON kb_memory_entries(doc_id, memory_kind, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_kb_memory_entries_kind
  ON kb_memory_entries(product_area, doc_kind, memory_kind, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_kb_memory_entries_search
  ON kb_memory_entries USING GIN (search_vector);

CREATE INDEX IF NOT EXISTS idx_kb_memory_entries_claim_trgm
  ON kb_memory_entries USING GIN (canonical_claim gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_kb_memory_entries_summary_trgm
  ON kb_memory_entries USING GIN (summary gin_trgm_ops);
```

## 3.4 `kb_memory_sources`

```sql
CREATE TABLE IF NOT EXISTS kb_memory_sources (
  memory_id UUID NOT NULL REFERENCES kb_memory_entries(id) ON DELETE CASCADE,
  doc_id UUID NOT NULL REFERENCES kb_documents(id) ON DELETE CASCADE,
  chunk_id TEXT NOT NULL REFERENCES kb_chunks(id) ON DELETE CASCADE,
  heading_path TEXT NOT NULL,
  source_score NUMERIC(8,6) NOT NULL DEFAULT 1,
  source_metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (memory_id, chunk_id)
);

CREATE INDEX IF NOT EXISTS idx_kb_memory_sources_chunk
  ON kb_memory_sources(chunk_id);

CREATE INDEX IF NOT EXISTS idx_kb_memory_sources_doc
  ON kb_memory_sources(doc_id, memory_id);
```

## 3.5 `kb_memory_relations`

```sql
CREATE TABLE IF NOT EXISTS kb_memory_relations (
  id UUID PRIMARY KEY,
  from_memory_id UUID NOT NULL REFERENCES kb_memory_entries(id) ON DELETE CASCADE,
  to_memory_id UUID NOT NULL REFERENCES kb_memory_entries(id) ON DELETE CASCADE,
  relation_type TEXT NOT NULL CHECK (relation_type IN ('updates', 'extends', 'derives')),
  weight NUMERIC(8,6) NOT NULL DEFAULT 1,
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (from_memory_id, to_memory_id, relation_type)
);

CREATE INDEX IF NOT EXISTS idx_kb_memory_rel_from
  ON kb_memory_relations(from_memory_id, relation_type);

CREATE INDEX IF NOT EXISTS idx_kb_memory_rel_to
  ON kb_memory_relations(to_memory_id, relation_type);
```

## 3.6 `kb_memory_aliases`

```sql
CREATE TABLE IF NOT EXISTS kb_memory_aliases (
  id UUID PRIMARY KEY,
  memory_id UUID NOT NULL REFERENCES kb_memory_entries(id) ON DELETE CASCADE,
  alias TEXT NOT NULL,
  alias_type TEXT NOT NULL,
  weight NUMERIC(8,6) NOT NULL DEFAULT 1,
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (memory_id, alias, alias_type)
);

CREATE INDEX IF NOT EXISTS idx_kb_memory_aliases_memory
  ON kb_memory_aliases(memory_id);

CREATE INDEX IF NOT EXISTS idx_kb_memory_aliases_alias_trgm
  ON kb_memory_aliases USING GIN (alias gin_trgm_ops);
```

## 3.7 `kb_memory_signals`

```sql
CREATE TABLE IF NOT EXISTS kb_memory_signals (
  id UUID PRIMARY KEY,
  memory_id UUID NOT NULL REFERENCES kb_memory_entries(id) ON DELETE CASCADE,
  signal_type TEXT NOT NULL,
  signal_value TEXT NOT NULL,
  weight NUMERIC(8,6) NOT NULL DEFAULT 1,
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (memory_id, signal_type, signal_value)
);

CREATE INDEX IF NOT EXISTS idx_kb_memory_signals_type_value
  ON kb_memory_signals(signal_type, signal_value);

CREATE INDEX IF NOT EXISTS idx_kb_memory_signals_value_trgm
  ON kb_memory_signals USING GIN (signal_value gin_trgm_ops);
```

## 3.8 `kb_memory_profiles`

```sql
CREATE TABLE IF NOT EXISTS kb_memory_profiles (
  id UUID PRIMARY KEY,
  repo_id UUID NOT NULL REFERENCES kb_repo_registrations(id) ON DELETE CASCADE,
  branch TEXT NOT NULL,
  profile_key TEXT NOT NULL,
  profile_kind TEXT NOT NULL,
  title TEXT NOT NULL,
  static_summary TEXT NOT NULL,
  dynamic_summary TEXT,
  build_version TEXT NOT NULL,
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (repo_id, branch, profile_key, build_version)
);

CREATE INDEX IF NOT EXISTS idx_kb_memory_profiles_active
  ON kb_memory_profiles(repo_id, branch, is_active, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_kb_memory_profiles_key
  ON kb_memory_profiles(profile_key);
```

## 3.9 Build Versioning

Use `build_version` on `kb_memory_entries` and `kb_memory_profiles`.

Format:

- `${commitSha}:${timestampMillis}`

Purpose:

- prevent half-built memory graph becoming active
- allow active-set switching during reindex

## 4. TypeScript Types

Add:

- `apps/api/src/modules/github-kb/memory-types.ts`

Required types:

```ts
export type KbMemoryKind =
  | "concept"
  | "procedure"
  | "api_operation"
  | "permission_rule"
  | "troubleshooting_pattern"
  | "behavior_rule"
  | "constraint"
  | "ui_surface";

export type KbMemoryRelationType = "updates" | "extends" | "derives";

export interface KbMemoryEntry {
  id: string;
  repo_id: string;
  branch: string;
  doc_id: string;
  path: string;
  memory_kind: KbMemoryKind;
  title: string | null;
  canonical_claim: string;
  summary: string;
  product_area: string;
  doc_kind: string;
  action_type: string | null;
  deployment_model: string | null;
  object_type: string | null;
  is_static: boolean;
  is_latest: boolean;
  status: "active" | "superseded" | "inactive";
  build_version: string;
  metadata_json: Record<string, unknown>;
  search_text: string;
  created_at: string;
  updated_at: string;
}

export interface MemoryRetrievalHit {
  memoryId: string;
  docId: string;
  path: string;
  title: string | null;
  canonicalClaim: string;
  summary: string;
  memoryKind: KbMemoryKind;
  productArea: string;
  docKind: string;
  score: number;
  source: "memory_entry" | "alias" | "signal" | "profile" | "relation";
  metadata?: Record<string, unknown>;
}
```

## 5. Extraction Protocol

## 5.1 Extraction Timing

Memory extraction must happen inside `github-kb` indexing after chunks are written.

Implementation point:

- after `indexDocumentContent()` finishes chunk upserts for a doc

## 5.2 Extraction Schema

Extraction output must conform to:

```json
{
  "entries": [
    {
      "memory_kind": "troubleshooting_pattern",
      "title": "GitHub OAuth callback page not found",
      "canonical_claim": "GitHub OAuth callback page not found usually indicates Redirect URI or baseURL mismatch.",
      "summary": "Check the generated authorize URL, Redirect URI, callback configuration, and current environment baseURL alignment.",
      "product_area": "integrations",
      "doc_kind": "troubleshooting",
      "action_type": "troubleshooting",
      "deployment_model": "general",
      "object_type": "github_oauth",
      "is_static": false,
      "aliases": [
        { "alias": "github callback 404", "alias_type": "en_phrase", "weight": 0.96 },
        { "alias": "授权回调找不到页面", "alias_type": "zh_phrase", "weight": 0.98 }
      ],
      "signals": [
        { "signal_type": "callback", "signal_value": "callback", "weight": 0.92 },
        { "signal_type": "redirect_uri", "signal_value": "redirect uri", "weight": 0.99 },
        { "signal_type": "baseurl", "signal_value": "baseurl", "weight": 0.95 }
      ],
      "source_chunk_ids": ["chunk_a", "chunk_b"]
    }
  ]
}
```

## 5.3 Extraction Rules

For each chunk:

1. create at most 3 memory entries
2. each entry must map to 1..5 source chunks
3. `canonical_claim` must be one support-meaningful sentence
4. `summary` must be 1..3 sentences
5. aliases must contain:
   - at least one phrase variant when possible
   - bilingual variants when source/query space suggests it
6. signals must contain exact handles only
7. if extraction confidence is too low, skip the entry

## 5.4 Deterministic Validation

Before upsert, validate:

- `canonical_claim.length >= 24`
- `summary.length >= 24`
- `source_chunk_ids.length >= 1`
- `memory_kind` is valid
- `product_area` and `doc_kind` are non-empty
- aliases unique after normalize
- signals unique after normalize

Normalization:

- trim
- lowercase
- collapse whitespace

## 5.5 Mapping Existing Metadata

Use current `supportEvidence` as defaults:

- `product_area`
- `deployment_model`
- `permissions`
- `actions`
- `objects`
- `prerequisites`
- `limitations`

This reduces extraction drift and keeps retrieval aligned with existing support metadata.

## 6. Relation Construction Rules

## 6.1 `updates`

Create an `updates` edge when all are true:

- same `product_area`
- same `object_type` or overlapping strong signals
- one entry is clearly newer or more specific
- claims are compatible but one supersedes the other

Examples:

- older callback troubleshooting note replaced by newer baseURL guidance
- old scope requirement replaced by newer scope list

## 6.2 `extends`

Create an `extends` edge when:

- same product surface
- one entry adds prerequisite, continuation, or additional check
- the target is not a contradiction or replacement

Examples:

- setup guide extends capability summary
- troubleshooting step extends FAQ symptom entry

## 6.3 `derives`

Create only when:

- 2 or more active entries from same area imply a stable support conclusion
- derived entry is still grounded by source chunks

Restriction for v1:

- do not auto-create derived entries globally
- only create derived relations for curated high-confidence cases

## 7. Build Lifecycle

## 7.1 Current Entry Point

Modify:

- `apps/api/src/modules/github-kb/service.ts`

Implementation order inside `indexDocumentContent()`:

1. `upsertDocument`
2. `deactivateChunksByDocument`
3. `upsertChunk` loop
4. `deactivateMemoryArtifactsByDocument(doc.id)`
5. `extractMemoryEntriesForDocument(...)`
6. `upsertMemoryEntry / aliases / signals / sources`
7. after full batch, run relation/profile rebuild for affected doc family

## 7.2 Repository Methods

Add to:

- `apps/api/src/modules/github-kb/memory-repository.ts`

Required methods:

```ts
upsertMemoryEntry(...)
replaceMemoryAliases(memoryId, aliases)
replaceMemorySignals(memoryId, signals)
replaceMemorySources(memoryId, sources)
deactivateMemoryArtifactsByDocument(docId)
markPriorBuildVersionInactive(repoId, branch, path, keepBuildVersion)
searchMemoryEntries(...)
searchMemoryAliases(...)
searchMemorySignals(...)
searchMemoryProfiles(...)
expandMemoryRelations(...)
resolveMemorySourcesToChunks(...)
```

## 7.3 Activation Strategy

For a single document index:

1. build all entries with `build_version = currentBuildVersion`
2. replace aliases/signals/sources for those entries
3. mark prior entries for same document/path as `inactive`
4. leave only current build active

For full reindex:

1. use one build version per run
2. deactivate stale memory entries not present in latest active document set

## 8. Retrieval Repository SQL Behavior

## 8.1 `searchMemoryEntries`

Inputs:

- `repoId?`
- `branch?`
- `queries: string[]`
- `limit`

Score components:

- `canonical_claim ILIKE`
- `summary ILIKE`
- `path/title ILIKE`
- `search_vector` rank for English

Return top `limit * 3` raw candidates.

## 8.2 `searchMemoryAliases`

Inputs:

- normalized query terms
- case-frame hints

Match:

- trigram similarity
- exact alias match bonus

## 8.3 `searchMemorySignals`

Inputs:

- extracted signals from the user query

Supported extracted signals:

- method
- api path
- scope
- callback
- redirect uri
- baseurl
- error code
- page text

Exact matches should receive the strongest base score.

## 8.4 `searchMemoryProfiles`

Inputs:

- `product_area`
- `object`
- `action_type`

Return:

- one or two profile summaries for retrieval priors

Profiles are not final evidence.

## 8.5 `resolveMemorySourcesToChunks`

Inputs:

- `memoryIds[]`
- `limitPerMemory`

Return:

- canonical chunk rows
- path
- heading path
- support metadata

## 9. Query Rewriting

Add:

- `buildMemoryRetrievalQueries(...)`

Location:

- `apps/api/src/modules/ai/search-orchestrator.ts`

Required rewrite classes:

1. original query
2. normalized query
3. symptom-centered query
4. object/action query
5. route-aware query
6. exact-signal query

Maximum rewrites:

- `6`

Deduplication rule:

- normalized lowercase string equality

## 10. Ranking Formula

## 10.1 Memory Candidate Score

For each raw candidate:

```text
final_score =
  0.28 * exact_signal_score +
  0.16 * alias_match_score +
  0.14 * canonical_claim_score +
  0.08 * summary_score +
  0.08 * heading_title_score +
  0.12 * case_frame_score +
  0.08 * doc_kind_score +
  0.04 * relation_bonus +
  0.02 * recency_bonus
```

All component scores normalized to `0..1`.

## 10.2 Case Frame Score

Use:

- `product_area` match
- `deployment_model` match
- `question_type` compatibility
- `action_type` compatibility

Suggested mapping:

- exact `product_area` match: `+1.0`
- wrong non-empty product area: `-0.35`
- required `doc_kind` exact match: `+1.0`
- required `doc_kind` compatible family match: `+0.55`
- wrong family: `-0.25`

## 10.3 Relation Bonus

Apply only after direct retrieval:

- `updates`: `+0.20` if newer target replaces direct stale hit
- `extends`: `+0.12`
- `derives`: `+0.08`

## 10.4 Rerank Cutoffs

- initial raw candidates per rewrite: `top 24`
- merged memory candidates before expansion: `top 20`
- expanded graph candidates after merge: `top 16`
- grounded chunk candidates sent downstream: `top 8`
- final `SearchReference[]`: `top 4`

## 11. Search-Orchestrator Changes

Modify:

- `apps/api/src/modules/ai/search-orchestrator.ts`

Add internal flow:

1. build rewrites
2. retrieve memory candidates
3. retrieve profile priors
4. expand relations
5. rerank memory candidates
6. resolve memory sources to chunks
7. merge with raw chunk/direct KB hits
8. rerank references for route

New helper functions:

```ts
private buildMemoryRetrievalQueries(...)
private extractExactSupportSignals(...)
private retrieveMemoryCandidates(...)
private rerankMemoryCandidates(...)
private groundMemoryCandidatesToReferences(...)
```

## 12. Reference Emission Contract

The output of retrieval must still be:

- `SearchReference[]`

Required invariants:

- every reference has a canonical `sourceUrl`
- every reference is grounded in an active `kb_chunk`
- memory-layer provenance is stored in `supportMetadata` or `chunkMetadata`

Suggested provenance fields:

```json
{
  "memory_id": "uuid",
  "memory_kind": "troubleshooting_pattern",
  "memory_source": "alias",
  "memory_relation_path": ["extends"]
}
```

## 13. Diagnostics

Add to retrieval diagnostics:

- rewritten queries
- extracted support signals
- memory candidate counts by source
- relation expansion counts
- grounded chunk counts
- reasons for top-1 candidate

This data should be attached under internal diagnostics only.

## 14. Evaluation Plan

## 14.1 Must-Pass Business Cases

Create a fixed eval set including at minimum:

1. `GitHub 集成授权后回调页面显示 page not found，怎么排查？`
2. OpenAPI scope lookup for issue comment creation
3. ONESQL capability/syntax question
4. deployment architecture / external database / shared storage question
5. behavior / rule / limitation question
6. generic how-to configuration question

## 14.2 Metrics

Track:

- top1_correct_doc_family_rate
- top1_answer_bearing_chunk_rate
- citation_coverage
- unsupported_verdict_rate
- unnecessary_handoff_rate
- wrong_openapi_bias_rate

## 14.3 Regression Gates

Do not ship if:

- top1_correct_doc_family_rate regresses
- unrelated OpenAPI pages outrank integration troubleshooting for the GitHub callback case
- answer-bearing chunk visibility does not improve

## 15. Implementation Order

## Step 1

Add migration `018_kb_memory_graph.sql`

## Step 2

Add:

- `memory-types.ts`
- `memory-repository.ts`
- `memory-extractor.ts`
- `memory-service.ts`

## Step 3

Wire memory extraction into `github-kb/service.ts`

## Step 4

Add retrieval methods and query rewriting in `search-orchestrator.ts`

## Step 5

Add tests:

- repository tests
- integration tests
- support eval tests

## Step 6

Run reindex on docs-com and evaluate before enabling for production traffic

## 16. Feature Flags

Add:

- `FEATURE_KB_MEMORY_GRAPH`
- `FEATURE_KB_MEMORY_QUERY_REWRITE`
- `FEATURE_KB_MEMORY_RELATION_EXPANSION`
- `FEATURE_KB_MEMORY_PROFILES`

Recommended rollout:

1. extraction on, runtime off
2. runtime on in preview only
3. relation expansion on after base retrieval is stable
4. production enable after eval pass

## 17. Definition Of Done

This feature is done when all are true:

1. `docs-com` reindex produces active memory entries and source mappings
2. retrieval works with `embedding = null`
3. top references for known support cases come from the correct product/doc family
4. final customer-facing answers still cite canonical docs-com chunks
5. support-agent handoff rate drops on current failing retrieval cases

## 18. Final Recommendation

This document is the implementation-ready v1 spec.

If engineering wants to begin coding now, the first task should be:

- create `018_kb_memory_graph.sql`

The second task should be:

- implement `memory-repository.ts`

The third task should be:

- wire extraction and search-orchestrator integration behind feature flags

That is the shortest path from design to working retrieval improvement.
