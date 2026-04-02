# AI Support Agent Rebuild Plan Part 09

Date: 2026-04-01

Status: implementation-ready design

Required pre-read:

1. `/Users/jeremypeng/Downloads/Workspace/TicketManagement/AGENTS.md`
2. `/Users/jeremypeng/Downloads/Workspace/TicketManagement/docs/20_AI_Support_Agent_Rebuild_Part_01_System_Model_And_Single_DB_Publishing.md`
3. `/Users/jeremypeng/Downloads/Workspace/TicketManagement/docs/21_AI_Support_Agent_Rebuild_Part_02_Single_DB_Build_Sync_Publish_And_Repair.md`
4. `/Users/jeremypeng/Downloads/Workspace/TicketManagement/docs/22_AI_Support_Agent_Rebuild_Part_03_Repository_Knowledge_Model_And_Retrieval_Units.md`
5. `/Users/jeremypeng/Downloads/Workspace/TicketManagement/docs/24_AI_Support_Agent_Rebuild_Part_04_Hybrid_Retrieval_And_Orchestration.md`
6. `/Users/jeremypeng/Downloads/Workspace/TicketManagement/docs/26_AI_Support_Agent_Rebuild_Part_06_Evaluation_Acceptance_And_Regression.md`
7. `/Users/jeremypeng/Downloads/Workspace/TicketManagement/docs/27_AI_Support_Agent_Rebuild_Part_07_KB_Build_Pipeline_And_Cleanup_Compatibility.md`
8. `/Users/jeremypeng/Downloads/Workspace/TicketManagement/docs/28_AI_Support_Agent_Rebuild_Part_08_Rollout_Rollback_And_Operations.md`

This part must be implemented together with the constraints defined in `AGENTS.md`, Part 01, Part 02, Part 03, Part 04, Part 06, Part 07, and Part 08.

If this document appears to conflict with an earlier part, the earlier part wins unless explicitly revised first.

Scope:

- define how to clean historical polluted KB data safely
- define how to identify obsolete, failed, abandoned, duplicate, and superseded KB artifacts
- define cleanup execution order in a single shared DB
- define what can be deleted, what must be retained, and what must never be touched
- define cleanup verification and rollback-safety rules

---

## 1. Pre-Implementation Confirmation

Before implementing anything in this part, the developer must confirm all of the following.

### 1.1 Hard prerequisites

Confirm:

- Part 02 publication-based serving is live and trusted
- runtime no longer depends on `is_active` as serving truth
- new KB builds are `knowledge_space`-aware and `build_version`-aware
- Part 08 release controls can identify current publication and rollback targets

If any of the above is false or unknown, stop and re-check earlier parts before touching historical data.

### 1.2 This part is cleanup execution design, not new KB construction

This part defines:

- historical data classification
- cleanup candidate selection
- cleanup execution order
- cleanup verification

This part does **not** define:

- new parser logic
- new retrieval channels
- production rollout of new retrieval behavior

Those belong to earlier parts.

### 1.3 Shared DB safety confirmation

Because the project uses one shared DB:

- cleanup must never assume a separate prod/test DB exists
- cleanup must not delete current published artifacts
- cleanup must be resumable and idempotent
- cleanup must prefer scoped, build-based deletion over broad table-wide deletion

If the cleanup approach cannot guarantee those constraints, stop and redesign before coding.

---

## 2. What This Part Delivers

This part answers one question:

> How do we safely remove historical polluted KB data now that the new publication-based model exists?

The answer is:

- not by truncating KB tables
- not by deleting everything except the latest row
- not by using `is_active` alone

Cleanup must be:

1. classification-driven
2. publication-aware
3. build-scoped
4. resumable
5. verified after each stage

---

## 3. Frozen Cleanup Principle

Historical cleanup exists to remove polluted and obsolete data, not to reconstruct serving truth.

Serving truth already comes from publication.

Therefore:

- cleanup must never be used to "make runtime correct"
- runtime correctness must already be publication-based before cleanup begins
- cleanup should reduce noise, storage, and operator confusion without changing customer-facing truth unexpectedly

The fixed cleanup order is:

1. classify
2. protect live serving scope
3. remove clearly dead build-scoped artifacts
4. remove superseded artifacts
5. remove orphaned linkage rows
6. verify counts and serving integrity

---

## 4. Historical Data Categories

Historical KB rows must be classified before any deletion.

### 4.1 Protected data

Never delete in cleanup stage unless explicitly superseded by a later dedicated archive plan:

- current published build for any active scope
- artifacts belonging to current published build
- rollback target build if retained by rollout policy
- latest validated build still under review

### 4.2 Clearly deletable data

Safe cleanup candidates:

- failed builds with no publication
- abandoned builds with no publication
- unfinished partial builds left terminally stale
- duplicate active rows from old pre-publication model that are not referenced by any publication
- orphaned memory-source linkage rows for deleted or invalid builds
- orphaned chunk/citation/embedding rows from non-published dead builds

### 4.3 Requires operator confirmation

Needs explicit review before deletion:

- superseded builds that might still be desired as manual rollback history
- large old validated builds in non-production spaces
- rows that are technically unreferenced but were produced very recently

### 4.4 Must never be cleanup-keyed by `is_active` alone

Do not classify rows as live or dead only by:

- `is_active`
- recency alone
- path duplication alone

All cleanup decisions must anchor back to:

- `knowledge_space`
- `repo_id`
- `branch`
- `build_version`
- publication references
- build status

---

## 5. Cleanup Units

Cleanup must operate on build-scoped units, not on free-floating rows first.

### 5.1 Primary cleanup unit

Primary unit:

- one `knowledge_space + repo_id + branch + build_version`

This unit determines:

- which documents belong to the build
- which chunks belong to the build
- which memory rows belong to the build
- which canonical artifacts belong to the build
- which citation rows belong to the build
- which embeddings belong to the build

### 5.2 Secondary cleanup unit

Secondary unit:

- orphaned linkage or child rows that remain after a build-scoped deletion plan

Examples:

- orphaned `kb_memory_sources`
- orphaned `kb_memory_aliases`
- orphaned `kb_memory_signals`
- orphaned `kb_memory_relations`

### 5.3 Cleanup boundary

Never issue cleanup against:

- entire `kb_documents`
- entire `kb_chunks`
- entire `kb_memory_entries`

without first constraining by build-scoped lineage.

---

## 6. Required Cleanup Inventory

Before deleting anything, the system must produce an inventory report.

For each candidate build, record:

- `knowledge_space`
- `repo_id`
- `branch`
- `build_version`
- build status
- whether published now
- whether referenced as rollback target
- artifact counts by family
- memory counts
- citation counts
- embedding counts
- duplicate-path anomaly count
- cleanup reason candidates

Recommended cleanup reason labels:

- `failed_without_publication`
- `abandoned_without_publication`
- `stale_partial_build`
- `superseded_nonrollback_build`
- `legacy_duplicate_active_rows`
- `orphaned_child_rows`

This inventory must be human-reviewable before destructive cleanup starts.

---

## 7. Cleanup Execution Order

### 7.1 Stage A: Dry-run inventory only

At this stage:

- no deletion is performed
- candidate counts and affected builds are listed
- protected builds are listed separately

Output must include:

- total rows by table to be affected
- builds grouped by cleanup reason
- current published and rollback-protected builds

### 7.2 Stage B: Dead non-published build cleanup

First actual deletion stage:

- failed builds with no publication
- abandoned builds with no publication
- stale partial builds with no publication

Why first:

- lowest rollback value
- highest pollution likelihood
- least risk to serving truth

### 7.3 Stage C: Superseded non-protected build cleanup

Second deletion stage:

- builds superseded by later publication
- excluding any build currently designated as rollback-retained

This stage must be policy-driven:

- keep last `N` validated rollback candidates if desired
- or keep only one prior rollback candidate per scope

### 7.4 Stage D: Orphan cleanup

After build-scoped deletions:

- remove orphaned linkage rows
- remove orphaned embeddings
- remove rows whose parent build no longer exists

### 7.5 Stage E: Legacy duplicate-row cleanup

Only after earlier stages:

- clean old duplicate `kb_documents` / `kb_chunks` / `kb_memory_entries`
- only where they can be attributed to non-published dead builds

This is intentionally late because legacy duplicates are the easiest place to over-delete if lineage is not respected.

---

## 8. Deletion Rules By Table Family

### 8.1 Build tables

`kb_builds`

- delete only after dependent artifact rows are safely removed or if soft-retention policy says keep summary rows
- recommended: retain a compact build summary row even after artifact deletion, if storage allows

### 8.2 Core KB artifact tables

Delete by build scope:

- `kb_documents`
- `kb_chunks`
- `kb_openapi_operations`
- `kb_code_symbols`
- `kb_config_surfaces`
- `kb_schema_objects`
- `kb_test_behaviors`
- `kb_citation_units`

### 8.3 Retrieval abstraction tables

Delete by build scope:

- `kb_memory_entries`
- `kb_memory_sources`
- `kb_memory_aliases`
- `kb_memory_signals`
- `kb_memory_relations`
- `kb_memory_profiles`

### 8.4 Publication tables

Do not delete current publication rows as part of historical cleanup.

`kb_publications`

- should change only via explicit publication or rollback flow
- cleanup must not infer publication changes

### 8.5 Serving compatibility tables

If legacy compatibility tables still exist, such as:

- `kb_serving_versions`

cleanup may remove stale compatibility rows only if:

- runtime no longer depends on them
- their values are derivable from publication or already obsolete

This should be done conservatively and separately from primary artifact deletion.

---

## 9. Rollback-Safe Retention Policy

Cleanup must not eliminate the ability to recover from recent rollout problems.

Recommended minimum retention:

- keep current published build
- keep one prior rollback candidate build per active scope
- keep latest validated non-published build under active review

Optional stronger retention:

- keep last 2 validated builds per active scope

The retention policy must be explicit and configurable.

---

## 10. Cleanup Verification

Every cleanup stage must end with verification.

### 10.1 Required verification checks

After each stage, verify:

- current publication still resolves correctly
- rollback target still exists if policy says it should
- no publication points to deleted build
- no orphan count remains above expected threshold
- no runtime query starts reading mixed or missing data

### 10.2 Count verification

Track:

- rows deleted by table
- remaining rows by table
- protected rows untouched
- candidate inventory reconciled with actual deletions

### 10.3 Runtime verification

At minimum:

- release status endpoint still reports coherent active scope
- publication status still matches serving state
- retrieval or support smoke checks do not regress because of cleanup

---

## 11. Cleanup Execution Mode

### 11.1 Dry-run mode

Must exist first.

Returns:

- candidate builds
- row counts
- protected builds
- proposed deletion plan

No writes.

### 11.2 Apply mode

Deletes one cleanup stage at a time.

Requirements:

- explicit operator trigger
- explicit stage selection
- structured summary result

### 11.3 Chunked apply mode

For large cleanup sets:

- process builds in small batches
- record progress after each batch
- allow safe restart

This is especially important in a single shared DB.

---

## 12. Recommended Implementation Modules

Recommended modules:

- cleanup inventory builder
- cleanup candidate classifier
- cleanup planner
- cleanup executor
- orphan verifier
- cleanup summary reporter

Recommended repository areas:

- `apps/api/src/modules/github-kb/cleanup/*`
- `apps/api/src/tests/github-kb-cleanup/*`
- `docs/` for operator cleanup runbook

The final file layout may follow repository conventions, but inventory, planning, execution, and verification should stay separate.

---

## 13. Acceptance For This Part

This part is considered implemented successfully only if all of the following are true.

### 13.1 Inventory acceptance

- the system can produce a dry-run inventory of cleanup candidates
- protected builds are identified clearly
- candidates are grouped by explicit cleanup reason

### 13.2 Execution acceptance

- dead non-published builds can be removed without affecting serving truth
- superseded builds can be removed according to retention policy
- orphaned linkage rows can be cleaned safely

### 13.3 Safety acceptance

- current published build is never deleted
- rollback-retained build is not deleted accidentally
- cleanup can be resumed after interruption
- cleanup does not depend on `is_active`

---

## 14. Development Dependency Conclusion

### 14.1 Can start immediately in parallel

The following work may start now and may be developed in parallel:

- cleanup inventory builder
- cleanup reason classifier
- dry-run reporting
- protected-build resolver
- cleanup operator runbook

### 14.2 Can be developed now but must not delete production-visible data yet

The following may be implemented now, but should remain dry-run or isolated until verified:

- cleanup executor
- orphan cleanup helpers
- chunked apply mode
- deletion summary reporting

### 14.3 Must wait for prior work before full execution

The following must wait before actual shared-DB cleanup execution:

- destructive cleanup against historical polluted KB rows
- cleanup of superseded builds in active scopes
- cleanup of legacy compatibility rows

Required preconditions:

- Part 08 release status and rollback controls are stable
- operators can identify current publication and rollback targets
- a clean dry-run inventory has been reviewed

### 14.4 Must not be bundled into this part

Do not bundle the following into Part 09:

- new retrieval rollout
- production runtime behavior changes
- parser or artifact schema redesign

Those are separate workstreams.

