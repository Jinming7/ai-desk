# KB Production Readiness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the current partial KB substrate into a fully publishable, repository-native, production-usable knowledge base with one coherent published snapshot, complete core artifact coverage, grounded retrieval evidence, and explicit rollout/rollback safety.

**Architecture:** The implementation must preserve the Part 01 to Part 09 rebuild contract: one shared DB, publication-based serving only, strict separation between build state and serving state, and one coherent published snapshot per `knowledge_space + repo_id + branch`. The work proceeds in six phases: environment normalization, build/finalization closure, repository-native artifact completion, validation and acceptance, shared-DB-safe publication and rollout, then historical cleanup after the new serving truth is trusted.

**Tech Stack:** TypeScript, Node.js, PostgreSQL, `pg`, `tsx`, `tsc`, repository-local KB services under `apps/api/src/modules/github-kb`, support retrieval runtime under `apps/api/src/modules/ai`, SQL migrations under `apps/api/src/db/migrations`.

---

## Why This Plan Exists

Current verified state on April 2, 2026:

- `kb_publications = 0`
- `kb_serving_versions = 0`
- the only build is still `support-local / master / 47a873debcde934bfd318d680eab197f5248a3b2 / building`
- raw KB rows exist, but publication-scoped serving rows are still `0`
- live artifact coverage is still docs-only:
  `kb_documents=22`, `kb_chunks=158`, `kb_citation_units=158`, `kb_memory_entries=143`
- live canonical structured artifacts are still missing:
  `kb_openapi_operations=0`, `kb_code_symbols=0`, `kb_config_surfaces=0`, `kb_schema_objects=0`, `kb_test_behaviors=0`

Therefore the next step is not rollout. The next step is to complete the KB until all production gates are satisfied.

## Non-Negotiable Done Criteria

The KB is only considered ready when all of the following are true:

- one validated and published snapshot exists for the target scope
- runtime retrieval resolves only through `kb_publications`
- `kb_serving_versions` matches the current publication pointer
- the current published build has non-zero counts for the required canonical artifact families
- the current published build passes build validation with no blocking errors
- retrieval and answer-path evaluation confirm publication-scoped reads and grounded citations
- rollback target exists and is visible in release status
- historical stale data is classified and cleanup-safe, even if deletion is staged after rollout

## Approved Follow-Up Design: Async Embed + Gated Publish

The repository now has an approved follow-up design for embedding throughput:

- structural artifacts may be written before embedding work completes
- embedding execution may run asynchronously after artifact persistence
- publication truth remains unchanged: only `kb_publications` may make a build runtime-visible
- no published build may continue mutating its embedding state after publication

This means the allowed model is:

1. persist build-scoped artifacts
2. enqueue build-scoped embedding work for enabled families
3. wait until embedding work reaches a terminal state for that build
4. validate according to per-family embedding policy
5. publish only after validation

The following model is explicitly rejected:

- publish a lexical-only or partially embedded build first
- continue backfilling embeddings into the same `published_build_version`
- let runtime quality drift without a new publication event

Sequencing rule for this plan:

- do not interrupt the current Phase 1 closure to insert this larger state-machine refactor
- complete one isolated non-prod build-only validation run first
- keep async embedding implementation as a dedicated follow-up before production rollout

Reference documents:

- `docs/superpowers/specs/2026-04-03-kb-async-embedding-gated-publish-design.md`
- `docs/superpowers/plans/2026-04-03-kb-async-embedding-gated-publish-implementation-plan.md`

## Required Preconditions

### Environment normalization

- [ ] Confirm Node version meets workspace requirement.
Run: `node -v`
Expected: `v20.20.1` or newer within the repo range.

- [ ] Confirm npm version and active binary path.
Run: `npm -v && which node && which npm`
Expected: binaries resolve to the intended Node 20 toolchain, not a stale Node 16 shell.

- [ ] Confirm local test DB availability before relying on integration tests.
Run: `psql postgresql://postgres:postgres@localhost:5432/nexusflow -Atqc "select 1"`
Expected: `1`

- [ ] Confirm shared DB runtime variables exactly match repository `.env`.
Run:
```bash
awk 'BEGIN{FS="="} /^(DATABASE_URL|GITHUB_TOKEN_READONLY|GITHUB_KB_BOOTSTRAP_INCLUDE_PATHS|GITHUB_KB_ENABLE_LOCAL_DOCS_MIRROR|LOCAL_DOCS_COM_PATH)=/ {if($1=="DATABASE_URL"){print $1"=[masked]"} else {print}}' .env
```
Expected:
`GITHUB_KB_ENABLE_LOCAL_DOCS_MIRROR=false`
and `DATABASE_URL` present.

- [ ] Confirm docs-com source mode is still remote.
Run:
```bash
set -a; source .env >/dev/null 2>&1
printf '%s\n' "$GITHUB_KB_ENABLE_LOCAL_DOCS_MIRROR" "$LOCAL_DOCS_COM_PATH"
```
Expected:
`false`
and local mirror path not used as an active runtime source.

- [ ] Confirm the live docs-com registration is pinned to the GitLab production source, not the legacy GitHub source.
Run:
```bash
set -a; source .env >/dev/null 2>&1
psql "$DATABASE_URL" -P pager=off -F $'\t' -Atqc "
select id, repo_url, repo_owner, repo_name, default_branch, public_base_url, is_active
from kb_repo_registrations
where repo_owner='docs' and repo_name='docs-com'
order by updated_at desc;
"
```
Expected:
the active registration points to `https://git.ones.pro/docs/docs-com`,
branch `master`,
and the public base URL remains `docs.ones.com`.

### Architecture freeze

- [ ] Re-read these source-of-truth docs before changing behavior:
  - `AGENTS.md`
  - `docs/20_AI_Support_Agent_Rebuild_Part_01_System_Model_And_Single_DB_Publishing.md`
  - `docs/21_AI_Support_Agent_Rebuild_Part_02_Single_DB_Build_Sync_Publish_And_Repair.md`
  - `docs/22_AI_Support_Agent_Rebuild_Part_03_Repository_Knowledge_Model_And_Retrieval_Units.md`
  - `docs/27_AI_Support_Agent_Rebuild_Part_07_KB_Build_Pipeline_And_Cleanup_Compatibility.md`
  - `docs/28_AI_Support_Agent_Rebuild_Part_08_Rollout_Rollback_And_Operations.md`
  - `docs/30_AI_Support_Agent_Rebuild_Part_09_Historical_KB_Cleanup_And_Decontamination.md`

## File Map

### Core files likely to change

- Modify: `apps/api/src/modules/github-kb/service.ts`
  Responsibility: build orchestration, finalize/validate/publish transitions, full-sync job execution, build inventory/status.

- Modify: `apps/api/src/modules/github-kb/repository.ts`
  Responsibility: build/publication persistence, artifact counts, validation snapshots, publication-scoped search queries.

- Modify: `apps/api/src/modules/github-kb/memory-service.ts`
  Responsibility: build-scoped memory graph sync, relation/profile generation, staged versus published lifecycle behavior.

- Modify: `apps/api/src/modules/github-kb/memory-repository.ts`
  Responsibility: memory source/citation linkage, active/inactive semantics, publication-scoped memory reads.

- Modify: `apps/api/src/modules/github-kb/source/manifest-builder.ts`
  Responsibility: source-family inclusion logic, skip-reason ledger, canonical family manifest coverage.

- Modify: `apps/api/src/modules/github-kb/builders/repository-knowledge-builder.ts`
  Responsibility: parser-to-artifact assembly for doc, openapi, config, code, schema, and test families.

- Modify: `apps/api/src/modules/github-kb/parsers/*.ts`
  Responsibility: family-aware structured extraction quality and degradation metadata.

- Modify: `apps/api/src/modules/github-kb/release/service.ts`
  Responsibility: promotion preview, rollback readiness checks, release status coherence.

- Modify: `apps/api/src/modules/github-kb/cleanup/service.ts`
  Responsibility: dry-run inventory, protected build reporting, operator-safe cleanup readiness.

- Modify: `apps/api/src/db/migrations/*.sql`
  Responsibility: only if schema changes are required to complete canonical artifact lineage or validation.

### Test files to update or add

- Modify: `apps/api/src/tests/github-kb.integration.test.ts`
- Modify: `apps/api/src/tests/release.integration.test.ts`
- Modify: `apps/api/src/tests/github-kb-cleanup/dry-run.integration.test.ts`
- Modify: `apps/api/src/tests/github-kb-cleanup/classifier.test.ts`
- Modify: `apps/api/src/modules/ai/hybrid-retrieval.test.ts`
- Modify: `apps/api/src/modules/github-kb/repository-knowledge-builder.test.ts`
- Create if needed: focused tests under `apps/api/src/tests/github-kb/`

## Phase 0: Normalize the Execution Environment

**Outcome:** all subsequent verification commands are trustworthy and reproducible.

**Blocking risks addressed:** stale Node 16 shell, unavailable local integration DB, mixed env between shell and repo, false negatives from test harness.

### Task 0.1: Lock the local toolchain

**Files:**
- Modify if needed: `.nvmrc` or local runtime instructions if the repo already uses them
- Verify: `package.json`
- Verify: `apps/api/package.json`

- [ ] Record the required Node and npm toolchain in the working shell.
Run:
```bash
node -v
npm -v
```
Expected:
Node satisfies `package.json` engine requirement.

- [ ] Re-run the simplest API compile check with the normalized toolchain.
Run: `npm run build -w apps/api`
Expected: exit code `0`.

### Task 0.2: Restore integration-test realism

**Files:**
- Verify: `apps/api/src/tests/github-kb.integration.test.ts`
- Verify: `apps/api/src/tests/release.integration.test.ts`
- Verify: `apps/api/src/tests/github-kb-cleanup/dry-run.integration.test.ts`

- [ ] Bring up or point to a safe local PostgreSQL test DB.
Run:
```bash
psql postgresql://postgres:postgres@localhost:5432/nexusflow -Atqc "select 1"
```
Expected: `1`

- [ ] Run the focused integration suites that prove build/publish/cleanup semantics.
Run:
```bash
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/nexusflow NODE_ENV=test npx tsx --test apps/api/src/tests/release.integration.test.ts
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/nexusflow NODE_ENV=test npx tsx --test apps/api/src/tests/github-kb-cleanup/dry-run.integration.test.ts
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/nexusflow NODE_ENV=test npx tsx --test apps/api/src/tests/github-kb.integration.test.ts
```
Expected:
all three exit `0`.

**Go/No-Go gate:**

- Do not continue to Phase 1 until the environment can run the integration suites without shell/toolchain noise.

## Phase 1: Close the Build -> Validate -> Publish Substrate

**Outcome:** one build can complete, validate, and publish without leaking ambiguity into serving truth.

**Blocking risks addressed:** build stuck in `building`, no validation results, no publication rows, no serving pointer, expired leases, dead-letter drift.

### Task 1.1: Identify why the current build never leaves `building`

**Files:**
- Modify: `apps/api/src/modules/github-kb/service.ts`
- Modify: `apps/api/src/modules/github-kb/repository.ts`
- Test: `apps/api/src/tests/github-kb.integration.test.ts`

- [ ] Inspect the current live build record, jobs, and lease state before changing code.
Run:
```bash
set -a; source .env >/dev/null 2>&1
psql "$DATABASE_URL" -P pager=off -F $'\t' -Atqc "
select knowledge_space, repo_id, branch, build_version, status, validation_passed, updated_at from kb_builds order by updated_at desc;
select id, source, status, repo_id, branch, payload_json::text, created_at from kb_sync_jobs order by created_at desc limit 20;
select lease_key, owner_id, owner_env, expires_at, (expires_at < now()) as expired from kb_ingest_leases order by updated_at desc;
"
```
Expected:
clear evidence for whether the failure is finalization, queue resumption, or stale lease handling.

- [ ] Add or tighten failure-path transitions so a build cannot remain indefinitely in `building` after terminal job failure.
Implementation target:
`service.ts` should mark build/run terminally failed or resumable with explicit conditions.

- [ ] Add a focused regression test for stale or dead-letter full-sync finalization.
Run:
```bash
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/nexusflow NODE_ENV=test npx tsx --test apps/api/src/tests/github-kb.integration.test.ts
```
Expected:
new regression passes and proves the prior stuck state cannot recur.

### Task 1.2: Enforce one coherent validation snapshot per completed build

**Files:**
- Modify: `apps/api/src/modules/github-kb/service.ts`
- Modify: `apps/api/src/modules/github-kb/repository.ts`
- Test: `apps/api/src/tests/github-kb.integration.test.ts`

- [ ] Ensure finalization always runs `updateBuildArtifactCounts`, `replaceBuildValidationResults`, and status transition to `validated` before publication.

- [ ] Add a test that asserts:
  - `kb_build_validation_results` is non-empty for a completed build
  - `kb_builds.status = validated` before promotion
  - failed validation blocks publication

- [ ] Verify with a local build-only run.
Run:
```bash
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/nexusflow NODE_ENV=test npx tsx --test apps/api/src/tests/github-kb.integration.test.ts
```
Expected:
test proves non-published completed builds still have a durable validation snapshot.

### Task 1.3: Publish one validated local snapshot and verify serving truth

**Files:**
- Modify: `apps/api/src/modules/github-kb/service.ts`
- Modify: `apps/api/src/modules/github-kb/release/service.ts`
- Test: `apps/api/src/tests/release.integration.test.ts`
- Test: `apps/api/src/tests/github-kb.integration.test.ts`

- [ ] Produce one successful local build and promote it explicitly to `support-local`.
Run:
```bash
set -a; source .env >/dev/null 2>&1
node -e "import('./apps/api/src/modules/github-kb/service.js').then(async m => { const out = await m.ensureDocsComKnowledgeBase({ actor: 'internal_operator', publicationMode: 'build_only' }); console.log(JSON.stringify(out)); process.exit(0); }).catch(err => { console.error(err); process.exit(1); })"
```
Expected:
build completes without implicit prod publication.

- [ ] Promote the validated build through the explicit promotion path, not ad-hoc row edits.

- [ ] Verify publication and serving alignment.
Run:
```bash
set -a; source .env >/dev/null 2>&1
psql "$DATABASE_URL" -P pager=off -F $'\t' -Atqc "
select knowledge_space, repo_id, branch, published_build_version, published_at from kb_publications;
select repo_id, branch, active_build_version, activated_at from kb_serving_versions;
"
```
Expected:
one `support-local` publication exists and `kb_serving_versions.active_build_version` matches it.

**Go/No-Go gate:**

- Do not continue to Phase 2 until one non-prod knowledge space has a validated published snapshot and serving reads are publication-scoped.

## Phase 2: Expand the KB from Docs-Only into Repository-Native Coverage

**Outcome:** the build path can ingest the canonical artifact families needed by the support agent.

**Blocking risks addressed:** markdown-only scope, architecture present only in code and schema, no openapi/code/config/schema/test artifacts in live builds, and retry-time structured artifact conflicts that are hard to observe or repair.

### Task 2.1: Expand source scope from markdown-only to required repository-native families

**Files:**
- Modify: `.env.example`
- Modify: runtime/operator documentation if scope changes are intentional
- Modify: `apps/api/src/modules/github-kb/service.ts`
- Modify: `apps/api/src/modules/github-kb/source/manifest-builder.ts`
- Test: `apps/api/src/tests/github-kb.integration.test.ts`

- [ ] Define the exact include-path contract for required source families.
Minimum required families:
  - docs
  - openapi specs
  - config surfaces
  - schema/sql
  - code symbols
  - test behaviors

- [ ] Ensure manifest generation records eligible versus skipped rows for those families with explicit skip reasons.

- [ ] Add tests that prove representative files from each family enter the manifest or are intentionally skipped with machine-readable reasons.

### Task 2.2: Make structured-family extraction produce durable build artifacts

**Files:**
- Modify: `apps/api/src/modules/github-kb/builders/repository-knowledge-builder.ts`
- Modify: `apps/api/src/modules/github-kb/parsers/openapi-parser.ts`
- Modify: `apps/api/src/modules/github-kb/parsers/code-parser.ts`
- Modify: `apps/api/src/modules/github-kb/parsers/config-parser.ts`
- Modify: `apps/api/src/modules/github-kb/parsers/schema-parser.ts`
- Modify: `apps/api/src/modules/github-kb/parsers/test-parser.ts`
- Test: `apps/api/src/modules/github-kb/repository-knowledge-builder.test.ts`

- [ ] For each family, add or tighten fixture-driven tests proving:
  - canonical artifact row is built
  - citation units are generated
  - memory entries carry grounded citation linkage
  - degraded parser metadata is explicit when fallback parsing is used

- [ ] Re-run the repository knowledge builder tests after each family lands.
Run:
```bash
npx tsx --test apps/api/src/modules/github-kb/repository-knowledge-builder.test.ts
```
Expected:
exit `0` with family-specific fixture coverage extended.

### Task 2.3: Harden structured-artifact identity, observability, and repairability

**Files:**
- Modify: `apps/api/src/modules/github-kb/repository.ts`
- Modify: `apps/api/src/modules/github-kb/service.ts`
- Test: `apps/api/src/tests/github-kb.integration.test.ts`

- [ ] Before the next publication gate, ensure structured artifact upserts are not only retry-safe but also diagnosable.
Minimum requirements:
  - natural-key conflict paths are explicit in validation or diagnostics
  - collision symptoms can be traced back to `build_version + source_doc_id + source artifact identity`
  - any repair path remains build-scoped and does not require destructive table-wide cleanup

- [ ] Add a focused regression proving same-build retries do not silently corrupt or cross-contaminate other structured artifacts.

- [ ] Add operator-facing verification or SQL probes that can quickly isolate a suspect structured family without touching unrelated build rows.

### Task 2.4: Prove the live build now has non-zero structured artifacts

**Files:**
- Verify: `apps/api/src/modules/github-kb/repository.ts`
- Verify: `apps/api/src/modules/github-kb/service.ts`
- Test: `apps/api/src/tests/github-kb.integration.test.ts`

- [ ] Run a fresh build-only sync in `support-local`.

- [ ] Verify artifact inventory for the newest build.
Run:
```bash
set -a; source .env >/dev/null 2>&1
psql "$DATABASE_URL" -P pager=off -F $'\t' -Atqc "
with b as (
  select knowledge_space, repo_id, branch, build_version
  from kb_builds
  where knowledge_space='support-local'
  order by updated_at desc
  limit 1
)
select 'kb_documents', count(*) from kb_documents d join b on d.knowledge_space=b.knowledge_space and d.repo_id=b.repo_id and d.branch=b.branch and d.build_version=b.build_version
union all
select 'kb_openapi_operations', count(*) from kb_openapi_operations d join b on d.knowledge_space=b.knowledge_space and d.repo_id=b.repo_id and d.branch=b.branch and d.build_version=b.build_version
union all
select 'kb_code_symbols', count(*) from kb_code_symbols d join b on d.knowledge_space=b.knowledge_space and d.repo_id=b.repo_id and d.branch=b.branch and d.build_version=b.build_version
union all
select 'kb_config_surfaces', count(*) from kb_config_surfaces d join b on d.knowledge_space=b.knowledge_space and d.repo_id=b.repo_id and d.branch=b.branch and d.build_version=b.build_version
union all
select 'kb_schema_objects', count(*) from kb_schema_objects d join b on d.knowledge_space=b.knowledge_space and d.repo_id=b.repo_id and d.branch=b.branch and d.build_version=b.build_version
union all
select 'kb_test_behaviors', count(*) from kb_test_behaviors d join b on d.knowledge_space=b.knowledge_space and d.repo_id=b.repo_id and d.branch=b.branch and d.build_version=b.build_version
order by 1;
"
```
Expected:
non-zero counts for the core structured artifact families that are in scope.

**Go/No-Go gate:**

- Do not continue to Phase 3 until the live build inventory proves the KB is no longer docs-only.

## Phase 3: Tighten Grounding, Validation, and Acceptance

**Outcome:** the build is not only large enough, but coherent, grounded, and publishable.

**Blocking risks addressed:** orphaned linkage, memory without grounding, same-build coherence gaps, false confidence from raw row counts.

### Task 3.1: Tighten build validation into a publish gate, not an informational summary

**Files:**
- Modify: `apps/api/src/modules/github-kb/service.ts`
- Modify: `apps/api/src/modules/github-kb/repository.ts`
- Test: `apps/api/src/tests/github-kb.integration.test.ts`

- [ ] Extend validation checks to block publication when any of these are materially broken:
  - zero required family counts
  - orphan chunk/document links
  - cross-build memory-source links
  - missing grounding coverage above agreed threshold
  - degraded parser coverage above agreed threshold for required families

- [ ] Persist all validation rows to `kb_build_validation_results`.

### Task 3.2: Enforce grounding completeness for memory and citations

**Files:**
- Modify: `apps/api/src/modules/github-kb/memory-service.ts`
- Modify: `apps/api/src/modules/github-kb/memory-repository.ts`
- Test: `apps/api/src/tests/github-kb.integration.test.ts`
- Test: `apps/api/src/modules/ai/hybrid-retrieval.test.ts`

- [ ] Ensure memory entries for structured families resolve to either chunk sources, citation sources, or both, with explicit rules per family.

- [ ] Add regression tests proving:
  - memory entries do not silently persist ungrounded in cases where grounding is expected
  - retrieval grounding resolves back to same-build citation evidence
  - no cross-build child linkage appears in validation snapshots

- [ ] Verify with live SQL spot checks.
Run:
```bash
set -a; source .env >/dev/null 2>&1
psql "$DATABASE_URL" -P pager=off -F $'\t' -Atqc "
select count(*) from kb_memory_entries e left join kb_memory_citations c on c.memory_id=e.id where c.memory_id is null;
select count(*) from kb_memory_entries e left join kb_memory_sources s on s.memory_id=e.id where s.memory_id is null;
"
```
Expected:
counts align with intentional family policy, not accidental omissions.

### Task 3.3: Run acceptance suites for publication-scoped retrieval

**Files:**
- Modify: `apps/api/src/modules/ai/hybrid-retrieval-provider.ts`
- Modify: `apps/api/src/modules/ai/hybrid-retrieval.ts`
- Test: `apps/api/src/modules/ai/hybrid-retrieval.test.ts`
- Test: `apps/api/src/tests/github-kb.integration.test.ts`

- [ ] Verify runtime retrieval still returns `kb_unavailable` when no publication exists.

- [ ] Verify once a publication exists, retrieval channels only return candidates from `published_build_version`.

- [ ] Run focused retrieval tests.
Run:
```bash
npx tsx --test apps/api/src/modules/ai/hybrid-retrieval.test.ts
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/nexusflow NODE_ENV=test npx tsx --test apps/api/src/tests/github-kb.integration.test.ts
```
Expected:
publication-scoped retrieval assertions pass.

**Go/No-Go gate:**

- Do not continue to any rollout or production-facing work until the build is publishable by validation and the retrieval path is proven publication-scoped end to end.

## Phase 4: Shared-DB-Safe Non-Prod Publication and Evaluation

**Outcome:** the rebuilt KB works on a published snapshot in a non-prod scope with clear rollback posture.

**Blocking risks addressed:** jumping straight to prod, unmeasured retrieval quality, no rollback candidate, hidden publication/serving mismatch.

### Task 4.1: Publish to `support-local` or `support-preview` and freeze an evaluation target

**Files:**
- Modify if needed: `apps/api/src/modules/github-kb/release/service.ts`
- Test: `apps/api/src/tests/release.integration.test.ts`

- [ ] Publish one validated build into a non-prod scope through the official promotion path.

- [ ] Verify release status shows:
  - current publication
  - serving pointer match
  - rollback candidate
  - validation snapshot summary

- [ ] Run:
```bash
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/nexusflow NODE_ENV=test npx tsx --test apps/api/src/tests/release.integration.test.ts
```
Expected:
promotion preview and rollback readiness tests pass.

### Task 4.2: Run KB and answer-path evaluation before prod

**Files:**
- Verify: `apps/api/src/modules/github-kb/eval.ts`
- Verify: `apps/api/src/modules/ai/evals/*`
- Modify tests/fixtures if needed

- [ ] Run build-side and answer-side evaluation using the published non-prod snapshot.

- [ ] Record minimum acceptance thresholds for:
  - publication-scoped read rate
  - citation presence rate
  - no `kb_unavailable` false positives when publication exists
  - no missing required artifact families

- [ ] Archive the evaluation output in the repo or operator artifacts before considering prod.

**Go/No-Go gate:**

- Do not publish to `support-prod` until evaluation explicitly says the KB is publishable and rollback-ready.
- Do not publish to `support-prod` until the async embedding design decision has either:
  - been implemented for the enabled embedding families, or
  - been explicitly waived with release evidence proving current synchronous embedding throughput is acceptable.

## Phase 5: Production Publication and Operator Confidence

**Outcome:** the KB can honestly be called “fully usable” for the production support agent.

**Blocking risks addressed:** promotion without proof, no rollback target, mismatch between release status and runtime truth.

### Task 5.1: Prepare the first `support-prod` publication

**Files:**
- Modify only if needed: `apps/api/src/modules/github-kb/release/service.ts`
- Verify: `docs/28_AI_Support_Agent_Rebuild_Part_08_Rollout_Rollback_And_Operations.md`
- Verify: `docs/29_AI_Support_Agent_Rollout_Operator_Runbook.md`

- [ ] Confirm publication authority is correct for prod scope.

- [ ] Confirm rollback target already exists in a protected state.

- [ ] Confirm the candidate build is not the only usable build in history.

### Task 5.2: Publish and verify the production snapshot

- [ ] Publish the chosen validated build to `support-prod`.

- [ ] Immediately verify:
Run:
```bash
set -a; source .env >/dev/null 2>&1
psql "$DATABASE_URL" -P pager=off -F $'\t' -Atqc "
select knowledge_space, repo_id, branch, published_build_version, published_at from kb_publications where knowledge_space='support-prod';
select repo_id, branch, active_build_version, activated_at from kb_serving_versions;
"
```
Expected:
`support-prod` publication exists and matches the serving pointer.

- [ ] Run post-publish retrieval verification against the production knowledge space and confirm grounded citations resolve from the newly published build only.

**Production acceptance gate:**

- The KB can only be declared fully usable after this phase if all earlier gates are still passing.

## Phase 6: Historical Cleanup After Production Truth Is Stable

**Outcome:** operators can trust what they see in the DB, and stale rows stop creating ambiguity.

**Blocking risks addressed:** confusion from stale active rows, polluted dead artifacts, misleading operator interpretation.

### Task 6.1: Produce cleanup dry-run inventory

**Files:**
- Modify if needed: `apps/api/src/modules/github-kb/cleanup/service.ts`
- Modify if needed: `apps/api/src/modules/github-kb/cleanup/repository.ts`
- Test: `apps/api/src/tests/github-kb-cleanup/dry-run.integration.test.ts`
- Test: `apps/api/src/tests/github-kb-cleanup/classifier.test.ts`

- [ ] Run the dry-run report and review:
  - current published build
  - rollback-retained build
  - direct cleanup candidates
  - operator-review builds
  - orphaned child rows

- [ ] Do not delete anything until the dry-run report is human-reviewed and the current production publication is confirmed stable.

### Task 6.2: Execute cleanup in build-scoped units only

- [ ] Delete only build-scoped dead artifacts, never table-wide by `is_active`.

- [ ] Re-run release status and retrieval verification after every cleanup stage.

**Final gate:**

- Only after cleanup verification passes should the KB be described as both production-usable and operationally clean.

## Required Verification Matrix

These commands must all pass before the KB is declared ready:

- [ ] `npm run build -w apps/api`
- [ ] `npx tsx --test apps/api/src/modules/github-kb/repository-knowledge-builder.test.ts`
- [ ] `npx tsx --test apps/api/src/modules/ai/hybrid-retrieval.test.ts`
- [ ] `DATABASE_URL=postgresql://postgres:postgres@localhost:5432/nexusflow NODE_ENV=test npx tsx --test apps/api/src/tests/release.integration.test.ts`
- [ ] `DATABASE_URL=postgresql://postgres:postgres@localhost:5432/nexusflow NODE_ENV=test npx tsx --test apps/api/src/tests/github-kb-cleanup/dry-run.integration.test.ts`
- [ ] `DATABASE_URL=postgresql://postgres:postgres@localhost:5432/nexusflow NODE_ENV=test npx tsx --test apps/api/src/tests/github-kb.integration.test.ts`
- [ ] shared DB SQL checks confirming:
  - publication exists
  - serving pointer matches publication
  - structured artifact families are non-zero in the published build
  - publication-scoped serving counts are non-zero
  - rollback candidate exists

## The One-Sentence Decision Rule

Do not say “the KB is fully usable” until all of the following are simultaneously true:

- a published snapshot exists
- the serving pointer matches it
- the published build is validated
- core structured artifact families are populated
- retrieval is publication-scoped
- rollback is ready
- cleanup inventory is understood

If any one of those is false, the KB is still in completion work, not final production state.
