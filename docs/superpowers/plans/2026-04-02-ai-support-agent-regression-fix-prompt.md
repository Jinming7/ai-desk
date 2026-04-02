# AI Support Agent Regression Fix Prompt

Use this prompt as the direct instruction set for an AI coding agent that will implement the regression-remediation work. It is intentionally strict. It should be pasted as-is or adapted only to add newly verified facts.

---

## Prompt

You are responsible for fixing the remaining architecture-level regressions in the `TicketManagement` AI support agent rebuild.

This is **not** a feature-expansion task.

Your job is to close the current regression and compatibility gaps so that the system more faithfully matches the existing rebuild documents and becomes eligible for a later rollout-readiness review.

### 0. Required reading before any code changes

Read these files first:

1. `/Users/jeremypeng/Downloads/Workspace/TicketManagement/AGENTS.md`
2. `/Users/jeremypeng/Downloads/Workspace/TicketManagement/docs/20_AI_Support_Agent_Rebuild_Part_01_System_Model_And_Single_DB_Publishing.md`
3. `/Users/jeremypeng/Downloads/Workspace/TicketManagement/docs/21_AI_Support_Agent_Rebuild_Part_02_Single_DB_Build_Sync_Publish_And_Repair.md`
4. `/Users/jeremypeng/Downloads/Workspace/TicketManagement/docs/24_AI_Support_Agent_Rebuild_Part_04_Hybrid_Retrieval_And_Orchestration.md`
5. `/Users/jeremypeng/Downloads/Workspace/TicketManagement/docs/25_AI_Support_Agent_Rebuild_Part_05_OpenClaw_Runtime_And_Stage_Contracts.md`
6. `/Users/jeremypeng/Downloads/Workspace/TicketManagement/docs/26_AI_Support_Agent_Rebuild_Part_06_Evaluation_Acceptance_And_Regression.md`
7. `/Users/jeremypeng/Downloads/Workspace/TicketManagement/docs/27_AI_Support_Agent_Rebuild_Part_07_KB_Build_Pipeline_And_Cleanup_Compatibility.md`
8. `/Users/jeremypeng/Downloads/Workspace/TicketManagement/docs/28_AI_Support_Agent_Rebuild_Part_08_Rollout_Rollback_And_Operations.md`
9. `/Users/jeremypeng/Downloads/Workspace/TicketManagement/docs/29_AI_Support_Agent_Rollout_Operator_Runbook.md`
10. `/Users/jeremypeng/Downloads/Workspace/TicketManagement/docs/30_AI_Support_Agent_Rebuild_Part_09_Historical_KB_Cleanup_And_Decontamination.md`
11. `/Users/jeremypeng/Downloads/Workspace/TicketManagement/docs/superpowers/plans/2026-04-02-ai-support-agent-regression-remediation-plan.md`

Do not start coding until you understand:

- publication-based serving
- single shared DB safety
- build state vs serving state separation
- OpenClaw stage contracts
- evaluation and rollout gate expectations

### 1. Current verified findings you must treat as real until disproven in code

1. `kb_publications` is the intended serving truth, but release/cleanup still consult legacy `kb_serving_versions`, which is not `knowledge_space` aware.
2. Full sync completion still advances checkpoint state even when the build is not published, so incremental sync can move ahead of the currently served publication.
3. The support runtime invokes `support-citation-binder`, but default stage routing does not fully represent that stage.
4. Evaluation currently conflates some `no_results` cases with `kb_unavailable`.
5. DB-backed verification is not yet strong enough to act as a trustworthy rollout signal because some suites skip when the local DB is unavailable and one stronger KB integration suite can fail in setup.

### 2. Your mission

Fix the regressions in this exact order:

1. unify release/cleanup/rollback truth around publication and `knowledge_space`
2. prevent unpublished full builds from advancing incremental sync baselines
3. align runtime stage routing with actual support runtime stages
4. make evaluation and release signals semantically honest
5. strengthen DB-backed verification reporting so rollout readiness is not overstated

### 3. Hard constraints

You must obey all of the following:

1. Do not add new deterministic query regex patches, answer rewrites, path routers, or hardcoded customer-answer branches.
2. Do not use `is_active` rows as runtime serving truth.
3. Do not let any unfinished or unpublished build become production-visible.
4. Do not mix artifacts from multiple `build_version` values in runtime retrieval.
5. Do not implement rerank.
6. Do not implement cleanup apply executor.
7. Do not perform destructive cleanup, data deletion, or manual database edits.
8. Do not claim rollout-ready status unless the verification evidence actually supports it.

### 4. Files most likely to change

Primary code paths:

- `/Users/jeremypeng/Downloads/Workspace/TicketManagement/apps/api/src/modules/github-kb/service.ts`
- `/Users/jeremypeng/Downloads/Workspace/TicketManagement/apps/api/src/modules/github-kb/repository.ts`
- `/Users/jeremypeng/Downloads/Workspace/TicketManagement/apps/api/src/modules/github-kb/release/service.ts`
- `/Users/jeremypeng/Downloads/Workspace/TicketManagement/apps/api/src/modules/github-kb/cleanup/service.ts`
- `/Users/jeremypeng/Downloads/Workspace/TicketManagement/apps/api/src/modules/ai/agent-router.ts`
- `/Users/jeremypeng/Downloads/Workspace/TicketManagement/apps/api/src/modules/ai/support-agent.ts`
- `/Users/jeremypeng/Downloads/Workspace/TicketManagement/apps/api/src/tests/ai-support-agent.business-eval.ts`
- `/Users/jeremypeng/Downloads/Workspace/TicketManagement/apps/api/src/modules/ai/release/service.ts`

Primary test paths:

- `/Users/jeremypeng/Downloads/Workspace/TicketManagement/apps/api/src/modules/github-kb/service.test.ts`
- `/Users/jeremypeng/Downloads/Workspace/TicketManagement/apps/api/src/modules/ai/search-orchestrator.test.ts`
- `/Users/jeremypeng/Downloads/Workspace/TicketManagement/apps/api/src/modules/ai/support-agent.test.ts`
- `/Users/jeremypeng/Downloads/Workspace/TicketManagement/apps/api/src/tests/evals/evaluation-framework.test.ts`
- `/Users/jeremypeng/Downloads/Workspace/TicketManagement/apps/api/src/tests/release.integration.test.ts`
- `/Users/jeremypeng/Downloads/Workspace/TicketManagement/apps/api/src/tests/github-kb-cleanup/dry-run.integration.test.ts`
- `/Users/jeremypeng/Downloads/Workspace/TicketManagement/apps/api/src/tests/github-kb.integration.test.ts`

### 5. Required implementation approach

For each workstream:

1. write or extend a focused test first
2. run the focused test and confirm failure or missing coverage
3. implement the smallest coherent fix
4. re-run the focused test
5. only then move to the next workstream

Do not bundle speculative fixes.

If you find a new issue, classify it as one of:

- blocker for current workstream
- adjacent but safe to defer
- out of scope for this remediation

### 6. Workstream-specific requirements

#### Workstream A: publication truth

Target outcome:

- release status, rollback logic, and cleanup dry-run must treat publication as the canonical serving truth
- any compatibility metadata must be clearly labeled and must not override publication truth

Must verify:

- multi-`knowledge_space` cases do not collapse into one `(repo_id, branch)` serving view
- current publication and rollback candidates remain scoped correctly

#### Workstream B: incremental baseline safety

Target outcome:

- unpublished full builds must not move the incremental base ahead of the published snapshot

Must verify:

- polling derives incremental base from publication-aware state
- build-only full sync leaves runtime-visible baseline unchanged

#### Workstream C: runtime stage alignment

Target outcome:

- every support runtime stage used by the code is represented in stage routing and trace semantics

Must verify:

- `support-citation-binder` is either explicitly bound or explicitly modeled as a stage-level fallback
- no hidden fallback to a generic global default agent for a stage that should be visible in topology

#### Workstream D: evaluation honesty

Target outcome:

- `kb_unavailable` only means the KB could not be read or had no valid publication
- `no_results` means retrieval ran but did not yield usable evidence

Must verify:

- release/readiness reporting does not treat skipped DB-backed suites as equivalent to executed passing suites

#### Workstream E: DB-backed proof

Target outcome:

- DB-required suites consistently surface `ready` vs `blocked` states without weakening the safety guard against non-local databases

Must verify:

- a blocked local DB condition is visible and does not create a false green rollout signal

### 7. Required verification commands

At minimum, run these:

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

If the DB-backed suites cannot run because the local DB is unavailable:

- say so explicitly
- show which suites were blocked
- do not describe the system as rollout-ready

### 8. Output requirements

Your final output must include:

1. what was changed
2. which findings were fixed
3. what verification passed
4. what remains blocked or unverified
5. whether the system is now only:
   - still not rollout-ready
   - ready for another architecture review
   - or ready for rollout-readiness review

Do not say it is ready for cleanup apply or rerank implementation unless you can prove all prerequisites are met.

### 9. Explicitly deferred items

Do not start these:

- rerank
- cleanup apply executor
- new retrieval channels that are not necessary to close the current regressions
- broad support prompt rewrites

### 10. Quality bar

The fix is only acceptable if it improves architectural truthfulness, not just test pass rate.

If a change makes one test pass by adding a narrow hardcoded branch, reject that approach and redesign the shared path instead.

---

## Suggested one-line handoff

Implement the remediation plan at `/Users/jeremypeng/Downloads/Workspace/TicketManagement/docs/superpowers/plans/2026-04-02-ai-support-agent-regression-remediation-plan.md`, fix the publication/runtime/evaluation regressions in order, and do not expand scope into rerank or cleanup apply.
