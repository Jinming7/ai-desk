# AI Support Agent Regression Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the remaining architecture-level regressions in the AI support agent rebuild so that publication-based serving, single-DB safety, runtime stage contracts, and evaluation gates are trustworthy enough for rollout readiness review.

**Architecture:** Keep the existing rebuild direction. Do not replace the shared AI-driven support pipeline with rule patches. Tighten the current publication substrate, checkpoint semantics, OpenClaw stage bindings, and evaluation semantics so the system behaves as one coherent publication-scoped runtime under a single shared database.

**Tech Stack:** TypeScript, Node.js, tsx test runner, Express API, PostgreSQL, OpenClaw runtime integration, repository-native KB substrate, publication-based serving.

---

## 1. Problem Statement

The current rebuild is no longer at the "architecture not formed" stage. The support runtime, publication substrate, repository-native build pipeline, evaluation framework, and rollout/cleanup control plane all exist in code. The remaining problem is that several high-risk compatibility surfaces still drift away from the rebuild contract:

1. `kb_publications` is the intended serving truth, but release and cleanup status still consult legacy `kb_serving_versions`, which has no `knowledge_space` dimension.
2. Full sync completion still advances `kb_sync_checkpoints` even when the build is not published, which can move incremental sync baselines ahead of runtime-visible snapshots.
3. The support runtime stage graph contains stages that are not fully represented in default OpenClaw routing, so some stages silently fall back to a global default agent.
4. Evaluation and release green signals are not yet strong enough to decide rollout because retrieval status mapping is too coarse and key DB-backed suites can skip or fail when the local test DB is unavailable.

This plan fixes those regressions without expanding scope into new features.

## 2. Confirmed Current State

Verified during review on 2026-04-02:

- `npm run build -w apps/api` passed.
- Focused suites passed:
  - `NODE_ENV=test npx tsx --test apps/api/src/modules/ai/search-orchestrator.test.ts`
  - `NODE_ENV=test npx tsx --test apps/api/src/modules/ai/support-agent.test.ts`
  - `NODE_ENV=test npx tsx --test apps/api/src/modules/ai/hybrid-retrieval.test.ts`
  - `NODE_ENV=test npx tsx --test apps/api/src/tests/evals/evaluation-framework.test.ts`
  - `NODE_ENV=test npx tsx --test apps/api/src/tests/release.integration.test.ts`
  - `NODE_ENV=test npx tsx --test apps/api/src/tests/github-kb-cleanup/dry-run.integration.test.ts`
- Stronger DB-backed verification is still incomplete:
  - `NODE_ENV=test npx tsx --test apps/api/src/tests/github-kb.integration.test.ts`
  - Review run failed with `ECONNREFUSED` during `beforeEach` DB reset.
- `release.integration.test.ts` and `github-kb-cleanup/dry-run.integration.test.ts` can skip when the local DB is unavailable, so a green file-level result does not yet prove end-to-end shared-DB readiness.

## 3. Hard Constraints

These are mandatory. Any implementation that violates them is a failed fix, even if tests pass.

1. Do not reintroduce `is_active` row truth as runtime serving truth.
2. Do not let unfinished, build-only, failed, local, or preview builds become production-visible.
3. Do not mix artifacts from different `build_version` values inside one retrieval/read path.
4. Do not solve support quality regressions with new query regexes, path routers, hardcoded answer branches, or post-answer rewrites.
5. Do not implement rerank in this remediation track.
6. Do not build cleanup apply executor in this remediation track.
7. Do not perform destructive DB cleanup, backfill, or manual row edits as part of code implementation.
8. Keep `BangWork/docs-com` as the canonical source when grounded docs are available.

## 4. Non-Goals

The following items are explicitly out of scope for this remediation cycle:

- Cross-encoder rerank or LLM rerank
- New specialist roles
- New retrieval families beyond what is required to close current regressions
- Cleanup apply executor
- New rollout automation that assumes the current gates are already trustworthy
- Broad prompt redesign of the support agent when the real issue is substrate/runtime semantics

## 5. Files And Responsibilities

### Workstream A: Publication Truth And Release/Cleanup Semantics

- Modify: `apps/api/src/modules/github-kb/service.ts`
- Modify: `apps/api/src/modules/github-kb/repository.ts`
- Modify: `apps/api/src/modules/github-kb/release/service.ts`
- Modify: `apps/api/src/modules/github-kb/cleanup/service.ts`
- Modify or add: `apps/api/src/modules/github-kb/release/*.test.ts`
- Modify or add: `apps/api/src/tests/release.integration.test.ts`
- Modify or add: `apps/api/src/tests/github-kb-cleanup/dry-run.integration.test.ts`

Responsibility:

- Remove architecture drift between `kb_publications` and compatibility status surfaces.
- Make rollback and cleanup protection publication-scoped and `knowledge_space`-aware.
- Preserve compatibility only if it cannot contradict publication truth.

### Workstream B: Checkpoint And Incremental Baseline Safety

- Modify: `apps/api/src/modules/github-kb/service.ts`
- Modify: `apps/api/src/modules/github-kb/repository.ts`
- Modify or add: `apps/api/src/modules/github-kb/service.test.ts`
- Modify or add: `apps/api/src/tests/github-kb.integration.test.ts`

Responsibility:

- Stop unpublished full builds from advancing incremental baselines.
- Ensure polling and repair logic derive incremental baselines from published state or an explicitly approved equivalent.

### Workstream C: OpenClaw Stage Contract Alignment

- Modify: `apps/api/src/modules/ai/agent-router.ts`
- Modify: `apps/api/src/modules/ai/support-agent.ts`
- Modify or add: `apps/api/src/modules/ai/support-agent.test.ts`
- Modify or add: `apps/api/src/modules/ai/search-orchestrator.test.ts`

Responsibility:

- Ensure every runtime stage used by the support pipeline has a defined routing contract.
- Remove silent fallback where a stage-specific live agent is expected.
- Tighten heuristics only by reducing contradiction, not by adding new hardcoded case handling.

### Workstream D: Evaluation And Rollout Gate Trust

- Modify: `apps/api/src/tests/ai-support-agent.business-eval.ts`
- Modify: `apps/api/src/tests/evals/evaluation-framework.test.ts`
- Modify: `apps/api/src/modules/ai/release/service.ts`
- Modify or add: `apps/api/src/tests/release.integration.test.ts`

Responsibility:

- Distinguish `kb_unavailable` from `no_results` and similar retrieval outcomes.
- Make release reporting honest about skipped vs executed DB-backed verification.
- Prevent false confidence during rollout readiness review.

### Workstream E: Verification Harness And Shared-DB Readiness

- Modify or add: `apps/api/src/tests/github-kb.integration.test.ts`
- Modify or add: `apps/api/src/tests/release.integration.test.ts`
- Modify or add: `apps/api/src/tests/github-kb-cleanup/dry-run.integration.test.ts`
- Optional if needed: `apps/api/src/tests/test-db-harness.ts`

Responsibility:

- Make DB-backed tests fail or report clearly for missing local DB prerequisites.
- Preserve safety checks against non-local databases.
- Provide one trustworthy validation path that proves the substrate under a local test DB.

## 6. Implementation Order

Must execute in this order:

1. Workstream A: publication truth and release/cleanup semantics
2. Workstream B: checkpoint and incremental baseline safety
3. Workstream C: runtime stage contract alignment
4. Workstream D: evaluation semantics and release signal trust
5. Workstream E: stronger DB-backed verification and rollout-readiness proof

Reason:

- Workstream A and B define the state model.
- Workstream C depends on trustworthy substrate/runtime assumptions.
- Workstream D is only useful after A-C semantics are clear.
- Workstream E is the proof layer and should validate the repaired behavior, not mask unfinished semantics.

## 7. Task Plan

### Task 1: Make Publication The Only Trustworthy Serving Source Across Release And Cleanup

**Files:**
- Modify: `apps/api/src/modules/github-kb/service.ts`
- Modify: `apps/api/src/modules/github-kb/repository.ts`
- Modify: `apps/api/src/modules/github-kb/release/service.ts`
- Modify: `apps/api/src/modules/github-kb/cleanup/service.ts`
- Test: `apps/api/src/tests/release.integration.test.ts`
- Test: `apps/api/src/tests/github-kb-cleanup/dry-run.integration.test.ts`

- [ ] **Step 1: Write failing tests for multi-space release and cleanup semantics**

Add or extend tests that create at least two publications for the same `repo_id` and `branch` but different `knowledge_space` values, then assert that:

```ts
const docsComStatus = await getKbReleaseStatus({
  knowledgeSpace: "docs_com",
  repoId,
  branch
});
const repoCodeStatus = await getKbReleaseStatus({
  knowledgeSpace: "repo_code",
  repoId,
  branch
});

assert.notEqual(
  docsComStatus.currentPublication?.publishedBuildVersion,
  repoCodeStatus.currentPublication?.publishedBuildVersion
);
assert.equal(
  docsComStatus.servingTruth.source,
  "publication"
);
assert.equal(
  repoCodeStatus.servingTruth.source,
  "publication"
);
```

For cleanup dry-run, assert that protected builds are calculated from `kb_publications` scoped by `knowledge_space`, not from one global `(repo_id, branch)` serving row.

- [ ] **Step 2: Run the failing tests**

Run:

```bash
NODE_ENV=test npx tsx --test apps/api/src/tests/release.integration.test.ts
NODE_ENV=test npx tsx --test apps/api/src/tests/github-kb-cleanup/dry-run.integration.test.ts
```

Expected:

- At least one assertion fails under the current implementation because the compatibility state is not `knowledge_space` aware.

- [ ] **Step 3: Refactor release/cleanup status to treat publication as the canonical source**

Implementation requirements:

```ts
type ServingTruth =
  | {
      source: "publication";
      knowledgeSpace: KbKnowledgeSpace;
      publishedBuildVersion: string;
      publishedHead: string;
    }
  | {
      source: "kb_unavailable";
      knowledgeSpace: KbKnowledgeSpace;
    };
```

Rules:

- `publishValidatedBuild()` may continue writing a compatibility record only if the compatibility write cannot affect runtime semantics and cannot overwrite cross-space truth.
- `getKbReleaseStatus()` must derive current serving state from `repo.getPublication({ knowledgeSpace, repoId, branch })`.
- `getKnowledgeBaseCleanupDryRunReport()` must use publication-scoped protection and rollback candidate selection.
- Any legacy serving record returned to operators must be labeled as compatibility metadata only, not serving truth.

- [ ] **Step 4: Re-run focused tests**

Run:

```bash
NODE_ENV=test npx tsx --test apps/api/src/tests/release.integration.test.ts
NODE_ENV=test npx tsx --test apps/api/src/tests/github-kb-cleanup/dry-run.integration.test.ts
```

Expected:

- Tests pass.
- Release status reports publication-scoped serving truth.
- Cleanup dry-run protection no longer collapses multiple spaces into one serving view.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/github-kb/service.ts \
  apps/api/src/modules/github-kb/repository.ts \
  apps/api/src/modules/github-kb/release/service.ts \
  apps/api/src/modules/github-kb/cleanup/service.ts \
  apps/api/src/tests/release.integration.test.ts \
  apps/api/src/tests/github-kb-cleanup/dry-run.integration.test.ts
git commit -m "fix: align release and cleanup with publication truth"
```

### Task 2: Prevent Unpublished Full Builds From Advancing Incremental Sync Baselines

**Files:**
- Modify: `apps/api/src/modules/github-kb/service.ts`
- Modify: `apps/api/src/modules/github-kb/repository.ts`
- Test: `apps/api/src/modules/github-kb/service.test.ts`
- Test: `apps/api/src/tests/github-kb.integration.test.ts`

- [ ] **Step 1: Write failing tests for build-only full sync checkpoint behavior**

Add a focused test that performs:

1. create publication at build `v1`
2. run a full build-only sync that creates build `v2` but does not publish it
3. assert the checkpoint or incremental baseline still points to `v1`'s published head

Example shape:

```ts
assert.equal(
  await resolveIncrementalBase({
    knowledgeSpace: "docs_com",
    repoId,
    branch
  }),
  publishedHeadV1
);
```

Also add a polling-oriented test to confirm the next enqueued job uses the published baseline instead of the unpublished full-build head.

- [ ] **Step 2: Run tests to verify failure**

Run:

```bash
NODE_ENV=test npx tsx --test apps/api/src/modules/github-kb/service.test.ts
NODE_ENV=test npx tsx --test apps/api/src/tests/github-kb.integration.test.ts
```

Expected:

- At least one failure showing checkpoint advancement from an unpublished full build, or a failure caused by missing explicit baseline semantics.

- [ ] **Step 3: Implement publication-safe incremental baseline logic**

Implementation requirements:

```ts
type IncrementalBase =
  | { kind: "published"; commitSha: string; buildVersion: string }
  | { kind: "none" };

async function resolveIncrementalBase(input: {
  knowledgeSpace: KbKnowledgeSpace;
  repoId: string;
  branch: string;
}): Promise<IncrementalBase> {
  const publication = await repo.getPublication(input);
  if (!publication?.published_head || !publication?.published_build_version) {
    return { kind: "none" };
  }
  return {
    kind: "published",
    commitSha: publication.published_head,
    buildVersion: publication.published_build_version
  };
}
```

Rules:

- Do not advance sync checkpoint solely because a full build finished.
- If a checkpoint remains necessary for operational visibility, it must not be the authoritative source for incremental base selection unless it is tied to the current publication contract.
- Polling and repair flows must consult publication-aware base resolution.

- [ ] **Step 4: Re-run tests**

Run:

```bash
NODE_ENV=test npx tsx --test apps/api/src/modules/github-kb/service.test.ts
NODE_ENV=test npx tsx --test apps/api/src/tests/github-kb.integration.test.ts
```

Expected:

- Tests pass under a local safe DB.
- Build-only full sync no longer moves incremental processing ahead of runtime-visible serving state.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/github-kb/service.ts \
  apps/api/src/modules/github-kb/repository.ts \
  apps/api/src/modules/github-kb/service.test.ts \
  apps/api/src/tests/github-kb.integration.test.ts
git commit -m "fix: keep incremental sync aligned to publication state"
```

### Task 3: Align OpenClaw Stage Routing With The Support Runtime Contract

**Files:**
- Modify: `apps/api/src/modules/ai/agent-router.ts`
- Modify: `apps/api/src/modules/ai/support-agent.ts`
- Test: `apps/api/src/modules/ai/support-agent.test.ts`
- Test: `apps/api/src/modules/ai/search-orchestrator.test.ts`

- [ ] **Step 1: Write failing tests for stage binding completeness**

Add or extend tests so that every stage invoked by `runSupportSearchAgent()` is asserted in the topology snapshot.

Example:

```ts
const topology = getAiTopologySnapshot();
assert.ok(
  topology.supportStages.stages.some((stage) => stage.stage === "support-citation-binder")
);
```

Also add one behavioral test that verifies a missing dedicated stage mapping is surfaced explicitly instead of silently routing to the global default agent without trace semantics.

- [ ] **Step 2: Run tests to verify failure**

Run:

```bash
NODE_ENV=test npx tsx --test apps/api/src/modules/ai/support-agent.test.ts
NODE_ENV=test npx tsx --test apps/api/src/modules/ai/search-orchestrator.test.ts
```

Expected:

- Current topology snapshot does not fully cover every runtime stage or fallback behavior is too implicit.

- [ ] **Step 3: Implement stage-contract alignment**

Implementation requirements:

```ts
type RoutedSupportStage =
  | "router"
  | "evidence-planner"
  | "planner"
  | "support-evidence-selector"
  | "api-specialist"
  | "howto-specialist"
  | "behavior-specialist"
  | "troubleshooting-specialist"
  | "evidence-judge"
  | "citation-curator"
  | "support-citation-binder"
  | "support-citation-selector"
  | "answer-composer";
```

Rules:

- If `support-citation-binder` is a real stage in the runtime, it must appear in topology and trace output.
- If the live gateway truly has no dedicated agent for a stage, represent that as an explicit stage-level fallback, not as a hidden omission.
- Do not solve route regressions by adding new regex routing branches.
- If heuristics in `stabilizeSupportRouteAndCaseFrame()` contradict the stage contract or business intent, only remove contradiction; do not expand the heuristic surface.

- [ ] **Step 4: Re-run tests**

Run:

```bash
NODE_ENV=test npx tsx --test apps/api/src/modules/ai/support-agent.test.ts
NODE_ENV=test npx tsx --test apps/api/src/modules/ai/search-orchestrator.test.ts
```

Expected:

- Topology snapshot and stage traces reflect the real runtime contract.
- Stage fallbacks are observable and intentional.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/ai/agent-router.ts \
  apps/api/src/modules/ai/support-agent.ts \
  apps/api/src/modules/ai/support-agent.test.ts \
  apps/api/src/modules/ai/search-orchestrator.test.ts
git commit -m "fix: align support runtime stages with routed topology"
```

### Task 4: Make Evaluation And Release Signals Semantically Trustworthy

**Files:**
- Modify: `apps/api/src/tests/ai-support-agent.business-eval.ts`
- Modify: `apps/api/src/tests/evals/evaluation-framework.test.ts`
- Modify: `apps/api/src/modules/ai/release/service.ts`
- Test: `apps/api/src/tests/release.integration.test.ts`

- [ ] **Step 1: Write failing tests for retrieval status mapping**

Add a test that proves:

- `kb_unavailable` means the KB could not be read because no publication or retrieval substrate was available
- `no_results` means retrieval ran but returned no usable evidence

Example:

```ts
const observation = mapRetrievalObservation(
  {
    query: "q",
    confidence: 0,
    hits: [],
    references: [],
    retrievalStatus: "no_results",
    fallbackUsed: false
  } as any,
  []
);

assert.equal(observation.retrievalStatus, "no_results");
```

Also add release/report tests that differentiate:

- executed DB-backed validation
- skipped DB-backed validation
- unavailable DB-backed validation

- [ ] **Step 2: Run tests to verify failure**

Run:

```bash
NODE_ENV=test npx tsx --test apps/api/src/tests/evals/evaluation-framework.test.ts
NODE_ENV=test npx tsx --test apps/api/src/tests/release.integration.test.ts
```

Expected:

- Current mapping and release reporting fail to distinguish these cases precisely.

- [ ] **Step 3: Implement truthful evaluation semantics**

Implementation requirements:

```ts
type RetrievalObservationStatus =
  | "grounded"
  | "no_results"
  | "kb_unavailable";

function mapRetrievalObservation(...) {
  if (hitResponse.hits.length > 0) return { retrievalStatus: "grounded", ... };
  if (hitResponse.retrievalStatus === "kb_unavailable") {
    return { retrievalStatus: "kb_unavailable", ... };
  }
  return { retrievalStatus: "no_results", ... };
}
```

Rules:

- Use explicit runtime retrieval status when available; do not infer `kb_unavailable` from `confidence === 0`.
- Release reporting must not imply rollout-ready confidence if DB-backed checks were skipped.
- Keep output operator-friendly: "passed", "skipped", "blocked", and "not_run" are preferable to vague booleans.

- [ ] **Step 4: Re-run tests**

Run:

```bash
NODE_ENV=test npx tsx --test apps/api/src/tests/evals/evaluation-framework.test.ts
NODE_ENV=test npx tsx --test apps/api/src/tests/release.integration.test.ts
```

Expected:

- Retrieval-status semantics are stable.
- Rollout decisions can see when evidence is weak because the DB-backed gate did not execute.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/tests/ai-support-agent.business-eval.ts \
  apps/api/src/tests/evals/evaluation-framework.test.ts \
  apps/api/src/modules/ai/release/service.ts \
  apps/api/src/tests/release.integration.test.ts
git commit -m "fix: make evaluation and release signals semantically honest"
```

### Task 5: Strengthen The DB-Backed Verification Harness Without Sacrificing Safety

**Files:**
- Modify: `apps/api/src/tests/github-kb.integration.test.ts`
- Modify: `apps/api/src/tests/release.integration.test.ts`
- Modify: `apps/api/src/tests/github-kb-cleanup/dry-run.integration.test.ts`
- Optional: `apps/api/src/tests/test-db-harness.ts`

- [ ] **Step 1: Write harness-level assertions**

Add shared helpers or explicit assertions that report one of these states:

```ts
type DbHarnessState =
  | { kind: "ready" }
  | { kind: "blocked"; reason: "db_unavailable" | "unsafe_database" };
```

Tests that need real DB semantics must:

- fail fast for unsafe database selection
- report clearly when local DB is unavailable
- avoid returning a misleading all-green summary

- [ ] **Step 2: Run harness-oriented suites**

Run:

```bash
NODE_ENV=test npx tsx --test apps/api/src/tests/github-kb.integration.test.ts
NODE_ENV=test npx tsx --test apps/api/src/tests/release.integration.test.ts
NODE_ENV=test npx tsx --test apps/api/src/tests/github-kb-cleanup/dry-run.integration.test.ts
```

Expected:

- Current behavior is inconsistent: some suites skip, some fail in setup, and the reporting layer does not make that distinction obvious.

- [ ] **Step 3: Implement consistent DB-backed validation behavior**

Rules:

- Keep the "never run against a non-local database" guard.
- Normalize readiness checks so DB-required suites all describe the same blocked state.
- Ensure release/cleanup decision surfaces can expose "blocked by local DB unavailability" rather than silently reading a green suite result.

- [ ] **Step 4: Re-run the DB-backed suites**

Run:

```bash
NODE_ENV=test npx tsx --test apps/api/src/tests/github-kb.integration.test.ts
NODE_ENV=test npx tsx --test apps/api/src/tests/release.integration.test.ts
NODE_ENV=test npx tsx --test apps/api/src/tests/github-kb-cleanup/dry-run.integration.test.ts
```

Expected:

- Under a healthy local DB, all suites run and pass.
- Without a local DB, the blocked state is explicit and cannot be mistaken for successful rollout evidence.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/tests/github-kb.integration.test.ts \
  apps/api/src/tests/release.integration.test.ts \
  apps/api/src/tests/github-kb-cleanup/dry-run.integration.test.ts \
  apps/api/src/tests/test-db-harness.ts
git commit -m "test: normalize db-backed verification reporting"
```

## 8. Final Verification Matrix

Run all of the following before declaring the remediation complete:

```bash
npm run build -w apps/api
NODE_ENV=test npx tsx --test apps/api/src/modules/ai/search-orchestrator.test.ts
NODE_ENV=test npx tsx --test apps/api/src/modules/ai/support-agent.test.ts
NODE_ENV=test npx tsx --test apps/api/src/modules/ai/hybrid-retrieval.test.ts
NODE_ENV=test npx tsx --test apps/api/src/modules/github-kb/service.test.ts
NODE_ENV=test npx tsx --test apps/api/src/tests/evals/evaluation-framework.test.ts
NODE_ENV=test npx tsx --test apps/api/src/tests/release.integration.test.ts
NODE_ENV=test npx tsx --test apps/api/src/tests/github-kb-cleanup/dry-run.integration.test.ts
NODE_ENV=test npx tsx --test apps/api/src/tests/github-kb.integration.test.ts
```

Only consider the remediation complete if:

1. Build succeeds.
2. Focused runtime and retrieval tests succeed.
3. Evaluation semantics tests succeed.
4. Release and cleanup integration tests succeed without ambiguous skips, or report an explicit blocked state that is surfaced in release readiness output.
5. `github-kb.integration.test.ts` proves publication-scoped substrate behavior under a local safe DB.

## 9. Acceptance Criteria

This remediation is accepted only when all of the following are true:

1. Release status, cleanup dry-run, and rollback candidate logic are publication-scoped and `knowledge_space` aware.
2. Unpublished full builds cannot move incremental sync baselines ahead of runtime-visible publications.
3. Every support runtime stage used by the main chain appears in topology and trace semantics with explicit fallback behavior.
4. Evaluation distinguishes `kb_unavailable` from `no_results`.
5. Rollout/release reporting does not overstate confidence when DB-backed validation is skipped or blocked.
6. The support runtime remains AI-driven and does not gain new deterministic answer-path patches.
7. Rerank is still deferred.
8. Cleanup apply executor is still deferred.

## 10. Parallelization Guidance

Can run in parallel:

- Task 1 and Task 3 after initial file ownership is assigned
- Task 4 in parallel with late Task 3 once runtime retrieval status semantics are clear

Should not start until predecessors are stable:

- Task 2 should begin after Task 1 design is fixed, because baseline semantics depend on publication truth.
- Task 5 should begin after Task 1-4 code lands, because it validates the repaired model.

Not part of this plan:

- rerank implementation
- cleanup apply executor
- rollout enablement that assumes production promotion is now safe

## 11. Rerank Decision Gate

Rerank is worth doing later, but only after this plan is complete.

Start rerank planning only when:

1. publication truth is fully unified
2. incremental baselines are publication-safe
3. runtime stage topology is explicit and stable
4. evaluation gates can distinguish retrieval failure classes honestly
5. DB-backed substrate verification is trustworthy

Recommended future insertion point:

- after hybrid recall fusion
- before final evidence selection

Why not now:

- the current risk is semantic correctness, not ranking sophistication
- hybrid retrieval is not yet the default trusted path
- rollout gates are not yet strong enough to judge rerank impact safely

## 12. Self-Review

Spec coverage check:

- Part 02 closure: covered by Task 1 and Task 2
- Part 05 closure: covered by Task 3
- Part 06 closure: covered by Task 4 and Task 5
- Part 08 and Part 09 readiness gating: covered by Task 1, Task 4, and Task 5
- rerank deferral: covered by Section 11

Placeholder scan:

- No `TODO`, `TBD`, or "implement later" placeholders remain.

Type consistency:

- The same publication-scoped, knowledge-space-aware terminology is used throughout the plan.

## 13. Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-04-02-ai-support-agent-regression-remediation-plan.md`.

Two execution options:

1. Subagent-Driven (recommended) - dispatch a fresh subagent per task, review between tasks, fast iteration
2. Inline Execution - execute tasks in this session using executing-plans, batch execution with checkpoints

If a future execution session uses this plan, it must preserve the current boundary: fix regressions, do not expand scope into rerank or cleanup apply.
