# AI Support Agent Rebuild Plan Part 07

Date: 2026-04-01

Status: implementation-ready design

Required pre-read:

1. `/Users/jeremypeng/Downloads/Workspace/TicketManagement/AGENTS.md`
2. `/Users/jeremypeng/Downloads/Workspace/TicketManagement/docs/20_AI_Support_Agent_Rebuild_Part_01_System_Model_And_Single_DB_Publishing.md`
3. `/Users/jeremypeng/Downloads/Workspace/TicketManagement/docs/21_AI_Support_Agent_Rebuild_Part_02_Single_DB_Build_Sync_Publish_And_Repair.md`
4. `/Users/jeremypeng/Downloads/Workspace/TicketManagement/docs/22_AI_Support_Agent_Rebuild_Part_03_Repository_Knowledge_Model_And_Retrieval_Units.md`
5. `/Users/jeremypeng/Downloads/Workspace/TicketManagement/docs/24_AI_Support_Agent_Rebuild_Part_04_Hybrid_Retrieval_And_Orchestration.md`
6. `/Users/jeremypeng/Downloads/Workspace/TicketManagement/docs/25_AI_Support_Agent_Rebuild_Part_05_OpenClaw_Runtime_And_Stage_Contracts.md`
7. `/Users/jeremypeng/Downloads/Workspace/TicketManagement/docs/26_AI_Support_Agent_Rebuild_Part_06_Evaluation_Acceptance_And_Regression.md`

This part must be implemented together with the constraints defined in `AGENTS.md`, Part 01, Part 02, Part 03, Part 04, Part 05, and Part 06.

If this document appears to conflict with an earlier part, the earlier part wins unless explicitly revised first.

Scope:

- define the KB construction pipeline that can start immediately
- define how repository content is pulled, parsed, transformed, embedded, validated, and written as build-scoped artifacts
- define how this work remains safe in a single shared DB
- define how the build pipeline must prepare for future historical-data cleanup without executing cleanup yet
- define what can be implemented now, what may write only to isolated spaces, and what must not yet touch production serving

---

## 1. Pre-Implementation Confirmation

Before implementing anything in this part, the developer must confirm all of the following.

### 1.1 Hard prerequisites

Confirm:

- Part 02 publication-based serving is the only runtime source of truth
- Part 03 repository artifact schema exists in code and DB substrate
- Part 04 retrieval runtime remains feature-controlled
- the project still uses a single shared DB
- no new KB build work will bypass `knowledge_space`, `build_version`, or `publication`

If any of the above is false or unknown, stop and re-check earlier parts before implementing the KB build pipeline.

### 1.2 This part defines build-side KB construction, not production cutover

This part defines:

- how repo content becomes KB artifacts
- how builders run safely
- how embeddings are produced
- how build validation works
- how cleanup compatibility is preserved

This part does **not** define:

- production retrieval cutover
- runtime answer-path enablement
- historical data cleanup execution
- production rollout policy

Those belong to later parts.

### 1.3 Shared DB safety confirmation

Because the project uses one shared DB:

- any new build-side writes must target explicit `knowledge_space`
- production-visible spaces must not be polluted by local or experimental runs
- isolated verification should prefer isolated DB; if unavailable, use isolated `knowledge_space` and never promote implicitly

If the implementation path cannot guarantee these rules, stop and redesign before coding.

---

## 2. What This Part Delivers

This part answers one question:

> How should we build the KB now, safely and correctly, from the repository source of truth?

The answer is:

- not by runtime direct GitHub search
- not by raw markdown-only ingestion
- not by writing rows straight into serving state

The KB must be built as a staged pipeline:

1. repository snapshot acquisition
2. source manifest generation
3. family-aware parsing
4. canonical artifact construction
5. retrieval abstraction construction
6. citation-unit construction
7. embedding generation
8. build validation
9. optional publish, only after explicit validation and approval

---

## 3. Frozen KB Construction Principle

The repository remains the canonical knowledge source.

The DB remains the runtime knowledge substrate.

Therefore:

- the build pipeline must pull repository content and transform it into build-scoped artifacts
- the runtime must read only published snapshots, never raw repo data
- builders must preserve artifact lineage so later cleanup is possible
- no build write may become serving-visible merely because it exists in the DB

The fixed build order is:

1. resolve target repository snapshot
2. enumerate included source files
3. normalize source metadata
4. parse by family
5. build canonical artifacts
6. build retrieval abstractions
7. build citation units
8. generate embeddings
9. validate
10. persist build results
11. publish only through explicit publication flow

---

## 4. KB Source Model

### 4.1 Canonical source

The KB must be built from repository snapshots, not live runtime API lookups.

Primary source:

- GitHub repository snapshot at a specific commit

Optional source metadata:

- repo id
- branch
- commit sha
- commit time
- source fetch time
- manifest path

### 4.2 Source acquisition modes

Allowed acquisition modes:

- remote GitHub snapshot fetch
- controlled local mirror only for approved disaster-recovery or local debug paths

Default:

- remote mode

The build pipeline must always record which acquisition mode was used.

### 4.3 Source families

The builder must classify repository files into source families:

- docs
- openapi
- code
- config
- schema/sql
- tests
- operational runbooks
- support-specific metadata files when present

If a file cannot be confidently assigned:

- record it as unsupported or skipped
- do not silently ingest it as generic text

---

## 5. Build Pipeline Stages

### 5.1 Stage A: Snapshot Resolution

Inputs:

- `knowledge_space`
- `repo_id`
- `branch`
- optional explicit `commit_sha`
- build mode: `full` or `incremental`

Outputs:

- resolved target commit
- `build_version`
- source snapshot metadata

Rules:

- every build must resolve to one immutable repo snapshot
- `build_version` must remain the identity for all downstream artifacts
- retries of the same logical build must preserve `build_version` if the run is continuing

### 5.2 Stage B: Source Manifest Generation

Inputs:

- repo snapshot
- include path rules
- file-family rules

Outputs:

- manifest items for eligible files
- skip reasons for excluded files

Rules:

- every included file must have stable `path`, `family`, `checksum`, and snapshot provenance
- every skipped file should have a machine-readable skip reason
- the manifest is the first cleanup-compatible ledger of what this build intended to create

### 5.3 Stage C: Family-Aware Parsing

Inputs:

- manifest item
- file content
- family-specific parser

Outputs:

- parser result
- degraded-quality flags when parsing falls back
- normalized source metadata

Rules:

- docs use heading/content-aware parsing
- openapi uses operation-aware parsing
- code uses structure-aware or AST-aware parsing
- config uses key/surface-aware parsing
- schema uses table/object-aware parsing
- tests use behavior/assertion-aware parsing
- parsing degradation must be recorded explicitly in metadata

### 5.4 Stage D: Canonical Artifact Construction

Inputs:

- parser outputs
- source metadata

Outputs:

- `kb_openapi_operations`
- `kb_code_symbols`
- `kb_config_surfaces`
- `kb_schema_objects`
- `kb_test_behaviors`
- any future canonical family artifacts

Rules:

- each artifact must retain:
  - `knowledge_space`
  - `repo_id`
  - `branch`
  - `build_version`
  - source path
  - source hash
  - source family
  - source span or object identity when available

### 5.5 Stage E: Retrieval Abstraction Construction

Inputs:

- canonical artifacts
- docs chunks
- support-oriented alias and signal extraction

Outputs:

- `kb_memory_entries`
- `kb_memory_aliases`
- `kb_memory_signals`
- `kb_memory_relations`

Rules:

- retrieval abstractions are built from repo-derived artifacts, not from free-form hallucinated summaries
- every memory entry must link back to build-scoped sources
- every memory source linkage must remain same-build coherent

### 5.6 Stage F: Citation Construction

Inputs:

- docs chunks
- canonical artifacts
- source spans

Outputs:

- `kb_citation_units`
- `kb_chunks`

Rules:

- citation units must be answer-groundable
- citation content must preserve stable evidence identity
- chunk identity and citation identity must remain `knowledge_space`-aware and `build_version`-aware

### 5.7 Stage G: Embedding Generation

Inputs:

- selected retrieval objects
- selected grounding objects
- embedding config

Outputs:

- embeddings for enabled object families

Recommended initial embedding targets:

- `kb_chunks`
- retrieval text derived from `kb_memory_entries`
- optionally canonical artifacts that materially improve dense retrieval

Rules:

- embedding generation must be feature-controlled
- missing embeddings must be tracked, not silently ignored
- embedding failures must not publish the build unless the enabled retrieval mode requires those embeddings

### 5.8 Stage H: Build Validation

Inputs:

- persisted artifacts
- manifest
- validation rules

Outputs:

- validation result rows
- build-level pass or fail
- cleanup candidate hints

Rules:

- validate artifact count stability
- validate same-build linkage
- validate required families exist
- validate citation build coherence
- validate embedding completeness for enabled features
- validate no cross-space identity collisions

### 5.9 Stage I: Optional Publication

This stage is out of scope for implementation in this part, but the builder must be compatible with it.

Rules:

- no implicit publication
- build persistence must leave enough metadata for later explicit promotion

---

## 6. Minimum Tables And Artifact Responsibilities

This part assumes the existing and planned tables remain the KB substrate.

### 6.1 Build-state tables

Required:

- `kb_builds`
- `kb_build_validation_results`
- `kb_sync_runs`
- `kb_sync_run_shards`
- `kb_sync_manifest_items`
- `kb_ingest_leases`

Responsibility:

- track build lifecycle
- track manifest coverage
- track validation status
- support later cleanup decisions

### 6.2 Repository-derived artifact tables

Required:

- `kb_documents`
- `kb_chunks`
- `kb_openapi_operations`
- `kb_code_symbols`
- `kb_config_surfaces`
- `kb_schema_objects`
- `kb_test_behaviors`
- `kb_citation_units`

Responsibility:

- hold build-scoped repository knowledge in structured and groundable form

### 6.3 Retrieval abstraction tables

Required:

- `kb_memory_entries`
- `kb_memory_sources`
- `kb_memory_aliases`
- `kb_memory_signals`
- `kb_memory_relations`
- `kb_memory_profiles`

Responsibility:

- bridge user support phrasing to repository-derived knowledge

### 6.4 Publication tables

Required:

- `kb_publications`

Responsibility:

- select exactly one runtime-visible build per knowledge scope and repo scope

---

## 7. Build Inputs And Outputs

### 7.1 Build request contract

The build request must include:

- `knowledge_space`
- `repo_id`
- `branch`
- optional `commit_sha`
- build mode
- embedding mode
- include paths or repo registration scope
- caller environment and actor identity

### 7.2 Build result contract

The build result must return:

- `build_version`
- resolved repo snapshot
- artifact counts by family
- parser degradation summary
- embedding summary
- validation summary
- publication status: not published, unless separately promoted

### 7.3 Cleanup-compatible metadata

Every build result must emit enough metadata to support later cleanup:

- which artifacts belong to this build
- whether the build ever became published
- whether the build failed or was abandoned
- artifact counts and hashes
- last referenced publication state

This is mandatory because historical cleanup is deferred, not canceled.

---

## 8. Embedding Strategy For KB Build

### 8.1 Why embeddings belong in build

Embeddings should be generated during build, not at query time, because:

- runtime latency stays predictable
- dense retrieval reads build-scoped vectors from the same published snapshot
- evaluation and rollback remain snapshot-coherent

### 8.2 Initial embedding scope

The initial recommended scope is:

- chunk embeddings
- memory-entry retrieval text embeddings

Optional later scope:

- selected canonical artifact embeddings

### 8.3 Embedding failure policy

The builder must support:

- `required`
- `best_effort`
- `disabled`

Recommended default for early rollout:

- `best_effort` for experimental spaces
- `required` only after the dense retrieval path becomes an accepted release dependency

### 8.4 Embedding metadata

Every embedded object should retain:

- embedding provider
- embedding model
- embedding dimension
- embedding version
- embedding timestamp
- source object id
- build_version

---

## 9. Historical Data Cleanup Compatibility

Historical KB cleanup will be handled later, but this part must prepare for it now.

### 9.1 What this part must do now

The KB build pipeline must:

- stop creating new ambiguous legacy rows
- make every new row attributable to one `knowledge_space` and one `build_version`
- make every build explicitly classifiable as published, failed, abandoned, or superseded
- emit machine-readable candidate signals for later cleanup

### 9.2 What this part must not do now

This part must not:

- delete historical rows by default
- truncate legacy tables
- opportunistically clean old builds during new builder work
- mix cleanup logic into build publication logic

### 9.3 Cleanup preparation outputs

The builder and validator should produce later-useful cleanup hints such as:

- builds with no publication and terminal failed status
- builds superseded by newer published builds in the same `knowledge_space`
- orphaned artifact families
- duplicate-path anomaly counts
- stale embedding rows for abandoned builds

These are not deletion commands. They are future cleanup signals.

### 9.4 Cleanup-safe invariant

No new implementation in this part may make future cleanup harder.

That means:

- no new artifact identity without `knowledge_space`
- no hidden cross-build references
- no loss of source lineage
- no writes that bypass build tracking

---

## 10. Recommended Implementation Modules

Recommended module split:

- repository snapshot resolver
- source manifest builder
- docs parser
- openapi parser
- code parser
- config parser
- schema parser
- test parser
- canonical artifact builders
- retrieval abstraction builder
- citation builder
- embedding worker
- build validator
- build summary reporter
- cleanup-signal reporter

Recommended repository areas:

- `apps/api/src/modules/github-kb/source/*`
- `apps/api/src/modules/github-kb/parsers/*`
- `apps/api/src/modules/github-kb/builders/*`
- `apps/api/src/modules/github-kb/embeddings/*`
- `apps/api/src/modules/github-kb/validation/*`
- `apps/api/src/modules/github-kb/reports/*`

The final file layout may follow repository conventions, but the responsibilities should remain separated.

---

## 11. Acceptance For This Part

This part is considered implemented successfully only if all of the following are true.

### 11.1 Build-side acceptance

- repository snapshot can be resolved deterministically
- manifest is produced with explicit include and skip reasons
- family-aware parsers run with machine-readable degradation markers
- canonical artifacts persist with build-scoped lineage
- memory entries persist with same-build source links
- citation units persist with stable evidence identity
- embeddings can be generated for enabled families

### 11.2 Safety acceptance

- all writes are `knowledge_space`-aware
- all writes are `build_version`-aware
- no build becomes runtime-visible without publication
- local or preview builders cannot accidentally pollute production serving

### 11.3 Cleanup compatibility acceptance

- every new build can be identified later as kept, failed, superseded, or cleanup candidate
- no new legacy-style ambiguous rows are introduced
- cleanup hint reporting exists, even if cleanup execution is still deferred

---

## 12. Development Dependency Conclusion

### 12.1 Can start immediately in parallel

The following work may start now and may be developed in parallel:

- repository snapshot resolver
- source manifest generation
- docs/openapi/code/config/schema/test parsers
- canonical artifact builders
- retrieval abstraction builders
- citation builders
- embedding generation pipeline
- build validator
- cleanup-signal reporting

### 12.2 Can be developed now but should write only to isolated build contexts

The following may be implemented now, but should write only to isolated spaces, isolated DB, or non-production build paths until later validation is complete:

- DB-backed artifact persistence
- embedding persistence
- build validation summaries on real build outputs
- full build execution for new artifact families

These should not be treated as production-ready serving inputs yet.

### 12.3 Must wait for prior work before full execution

The following must wait before full execution or adoption:

- production retrieval cutover to new KB artifacts
- production enablement of dense retrieval over new embeddings
- production enablement of stricter runtime stage contracts that depend on the new KB
- historical data deletion and cleanup execution

Required preconditions:

- Part 03 isolated DB validation is complete
- Part 04 retrieval evaluation is acceptable
- Part 05 runtime contracts are stable enough for shared rollout
- Part 06 evaluation gates are implemented enough to judge readiness

### 12.4 Must not be bundled into this part

Do not bundle the following into Part 07:

- production cutover
- old data deletion
- rerank provider rollout
- unrelated support-agent prompt changes

Those are separate workstreams.

