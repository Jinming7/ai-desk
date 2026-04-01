# AI Support Agent Rebuild Part 02 Patch List

Date: 2026-04-01

Status: blocking fixes

Required pre-read:

1. `/Users/jeremypeng/Downloads/Workspace/TicketManagement/AGENTS.md`
2. `/Users/jeremypeng/Downloads/Workspace/TicketManagement/docs/20_AI_Support_Agent_Rebuild_Part_01_System_Model_And_Single_DB_Publishing.md`
3. `/Users/jeremypeng/Downloads/Workspace/TicketManagement/docs/21_AI_Support_Agent_Rebuild_Part_02_Single_DB_Build_Sync_Publish_And_Repair.md`

This patch list exists because the initial Part 02 implementation is directionally correct but still has blocking correctness gaps.

These blockers must be fixed before:

- Part 03 code is allowed to write new artifacts into the shared DB
- Part 03 code is allowed to connect to runtime retrieval
- any later retrieval or memory integration work begins

This document is intentionally narrow.

It is not a new architecture design.

It is a repair checklist for the currently identified Part 02 blockers.

---

## 1. Current Blocking Findings

The following findings are treated as confirmed blockers:

1. artifact identity is not isolated by `knowledge_space`
2. document and chunk identity still ignore `knowledge_space`
3. snapshot deactivation still mutates all spaces together
4. local promotion currently bypasses the space publish guard

Until these are fixed, the single-DB isolation model required by Part 02 is not actually safe enough to support DB-backed Part 03 development.

---

## 2. Patch Goal

Make Part 02 truly safe as the substrate for later work.

Specifically:

1. different `knowledge_space` values must be able to store the same repository build artifacts without collision
2. local / preview / prod must not overwrite each other’s document or chunk artifacts
3. cleanup/deactivation logic must not mutate rows in other spaces
4. local callers must not be able to publish into non-local spaces through the normal promotion path

---

## 3. Patch 01: Make Artifact Identity Space-Aware

Priority: `P0`

Blocking impact:

- same `repo + branch + path + build_version` built in different spaces can currently collide
- this breaks the core single-DB isolation promise

## Required files

- `/Users/jeremypeng/Downloads/Workspace/TicketManagement/apps/api/src/db/migrations/021_kb_publication_substrate.sql`
- `/Users/jeremypeng/Downloads/Workspace/TicketManagement/apps/api/src/modules/github-kb/repository.ts`
- `/Users/jeremypeng/Downloads/Workspace/TicketManagement/apps/api/src/modules/github-kb/chunker.ts`
- `/Users/jeremypeng/Downloads/Workspace/TicketManagement/apps/api/src/modules/github-kb/service.ts`

## Required changes

### 3.1 Update document uniqueness

Current problem:

- `kb_documents` still conflicts on `(repo_id, branch, path, build_version)`

Required change:

- artifact identity for documents must include `knowledge_space`

Target unique identity:

- `(knowledge_space, repo_id, branch, path, build_version)`

### 3.2 Update `doc_key`

Current problem:

- `doc_key` is derived from `repoId:path:buildVersion`

Required change:

- `doc_key` must include `knowledge_space`

Target shape:

- `knowledgeSpace:repoId:path:buildVersion`

### 3.3 Update chunk identity

Current problem:

- chunk ids are derived from `docKey`
- if `docKey` ignores `knowledge_space`, chunk ids collide across spaces

Required change:

- make chunk identity space-aware by ensuring the chunk input identity includes `knowledge_space`

Recommended implementation:

- fix `doc_key` first
- verify chunk id derivation now changes automatically
- if any chunk identity bypasses `doc_key`, update it to include `knowledge_space`

### 3.4 Validate downstream link stability

After changing document/chunk identity:

- verify memory source linkage
- verify document-chunk linkage
- verify rebuild idempotency inside one space

## Acceptance criteria

All of the following must be true:

1. `support-prod` and `support-preview` can store the same path/build without conflict
2. one space’s document write does not overwrite another space’s document row
3. one space’s chunk write does not overwrite another space’s chunk row
4. same-space reruns remain idempotent

---

## 4. Patch 02: Fix Space-Aware Upsert Behavior

Priority: `P0`

Blocking impact:

- even if the column exists, the write path is still unsafe until conflict identity is corrected end-to-end

## Required files

- `/Users/jeremypeng/Downloads/Workspace/TicketManagement/apps/api/src/modules/github-kb/repository.ts`
- `/Users/jeremypeng/Downloads/Workspace/TicketManagement/apps/api/src/modules/github-kb/service.ts`

## Required changes

### 4.1 `upsertDocument()`

Required:

- conflict target must align with space-aware uniqueness
- all update logic must remain same-space only

### 4.2 `upsertChunk()`

Required:

- same logical chunk in different spaces must not share one physical row identity

### 4.3 Verify build rerun behavior

Required:

- rerunning the same build inside the same space remains idempotent
- rerunning in another space creates isolated artifacts, not overwritten artifacts

## Acceptance criteria

1. same build rerun in same space updates the same artifact rows
2. same build rerun in different space creates separate artifact rows
3. no cross-space overwrite is observed for docs or chunks

---

## 5. Patch 03: Scope Deactivation Helpers By Knowledge Space

Priority: `P1`

Blocking impact:

- full build completion can still mutate row lifecycle state across spaces

## Required files

- `/Users/jeremypeng/Downloads/Workspace/TicketManagement/apps/api/src/modules/github-kb/repository.ts`
- `/Users/jeremypeng/Downloads/Workspace/TicketManagement/apps/api/src/modules/github-kb/service.ts`

## Required functions to change

- `deactivateDocumentsMissingFromSnapshot()`
- `deactivateDocumentByPath()`
- any caller of these functions

## Required changes

### 5.1 Add `knowledgeSpace` to deactivation APIs

Both helper functions must become explicitly space-aware.

They must filter by:

- `repo_id`
- `branch`
- `knowledge_space`

### 5.2 Update all call sites

Full build completion paths must pass the current build’s `knowledgeSpace`.

This includes:

- local mirror full sync path
- remote full sync path
- any incremental delete or rename paths

### 5.3 Review `deactivateChunksByDocument()`

This function currently uses only `docId`.

If `docId` is already guaranteed space-safe after Patch 01 and Patch 02, it may remain as-is.

If not, add an explicit same-space guard.

## Acceptance criteria

1. preview full build cannot flip prod rows inactive
2. local build cannot flip prod rows inactive
3. prod build only changes prod-space artifact lifecycle rows

---

## 6. Patch 04: Remove Local Promotion Bypass

Priority: `P1`

Blocking impact:

- local internal caller can currently promote into a non-local knowledge space through the normal path

## Required file

- `/Users/jeremypeng/Downloads/Workspace/TicketManagement/apps/api/src/modules/github-kb/service.ts`

## Required changes

### 6.1 Fix `promoteValidatedBuild()`

Current unsafe behavior:

- local env is rewritten to `operator`
- `operator` is allowed to publish anywhere

Required change:

- do not rewrite `local` to `operator` in the standard promotion path

### 6.2 Preserve current conservative policy

Until a dedicated override flow exists:

- `local` may only promote to `support-local`
- `preview` may only promote to `support-preview`
- `prod` may only promote to `support-prod`

### 6.3 Future override remains separate

Do not solve operator override in this patch.

That should be a later, explicit, audited feature.

## Acceptance criteria

1. local runtime cannot promote to `support-prod`
2. local runtime cannot promote to `support-preview`
3. preview runtime cannot promote to `support-prod`
4. same-space promotion still works

---

## 7. Patch 05: Add Blocking Regression Tests

Priority: `P1`

This patch is required before Part 02 can be treated as stable enough for downstream DB-backed work.

## Required tests

### 7.1 `knowledge_space document isolation`

Assert:

- same `repo + branch + path + build_version`
- two spaces
- both rows coexist

### 7.2 `knowledge_space chunk isolation`

Assert:

- same logical content
- same build version
- different spaces
- no chunk id collision or overwrite

### 7.3 `publication isolation across spaces`

Assert:

- preview publication does not affect prod read path
- local publication does not affect prod read path

### 7.4 `deactivation isolation`

Assert:

- snapshot cleanup in one space does not flip another space’s rows

### 7.5 `local promotion guard`

Assert:

- local promotion into non-local space is rejected

## Test execution note

If the local integration DB is unavailable, still add the tests now.

They become required verification gates once the DB is runnable.

---

## 8. Patch 06: Temporary Development Guardrail For Part 03

Priority: `P1`

Until P0/P1 patches above are complete:

- Part 03 may only produce offline or non-persisted outputs
- Part 03 must not write new artifact families into the shared DB
- Part 03 must not connect to runtime retrieval

This is a process guardrail, not a schema change.

---

## 9. Recommended Patch Order

This order is mandatory.

1. Patch 01: artifact identity becomes space-aware
2. Patch 02: write-path upserts align to new identity
3. Patch 03: deactivation helpers become space-aware
4. Patch 04: remove local promotion bypass
5. Patch 05: add regression tests
6. Re-verify Part 02 acceptance before allowing DB-backed Part 03 work

---

## 10. What Is Allowed While These Patches Are In Progress

### Allowed now

- continue Part 02 fixes
- continue Part 03 offline parser/extractor/builder work
- continue eval dataset preparation

### Not allowed yet

- Part 03 DB-backed artifact persistence
- Part 03 runtime integration
- Part 04 implementation
- production publication of new retrieval-unit artifact families

---

## 11. Exit Criteria

This patch list is considered complete only when:

1. artifact identity includes `knowledge_space` end-to-end
2. upsert behavior is same-space idempotent and cross-space isolated
3. deactivation helpers are scoped by `knowledge_space`
4. local promotion cannot bypass same-space publish rules
5. blocking regression tests exist and pass in a runnable environment

Only after these exit criteria are met may DB-backed Part 03 implementation proceed.

