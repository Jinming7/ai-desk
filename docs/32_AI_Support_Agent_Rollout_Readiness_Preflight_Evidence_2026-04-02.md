# AI Support Agent Rollout Readiness Preflight Evidence

Date: 2026-04-02

Status: fresh automated preflight evidence for rollout-readiness review

Use this record together with:

- `docs/28_AI_Support_Agent_Rebuild_Part_08_Rollout_Rollback_And_Operations.md`
- `docs/29_AI_Support_Agent_Rollout_Operator_Runbook.md`
- `docs/31_AI_Support_Agent_Rollout_Readiness_Evidence_Template.md`

Current scope:

- publication-based serving only
- single shared DB safety preserved
- no rerank rollout in this phase
- no destructive cleanup
- no manual DB mutation
- no production promotion executed in this record

---

## 1. Purpose And Limits

This document records the fresh automated verification that was actually executed for the current revision before any rollout-readiness review.

It is intentionally narrower than a completed operator evidence record:

- it captures what was verified in code and test automation
- it does not claim that a non-production live drill already happened
- it does not claim that production rollout approval already exists
- it does not invent operator-captured `repoId`, `buildId`, rollback payload, or signoff fields that were not collected from a real target scope

Important limitation:

- `apps/api/src/tests/ai-support-agent.business-eval.ts` runs in `isolated_db` mode and cleans up its ephemeral registration/build/publication rows after completion
- therefore this record can prove the automated gates for the revision under review, but it cannot substitute for the later real-scope operator capture required by the runbook

---

## 2. Revision Under Review

- Git revision: `7672169f3738c33e0bdec42fe97e3d6ae1259b14`
- Branch: `fix/release-cleanup-db-harness-20260402`
- Worktree state after verification: clean
- Review intent: determine whether the codebase is ready to enter `rollout-readiness review`

---

## 3. Commands Actually Run

The following commands were executed against the revision above.

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
NODE_ENV=test npx tsx --test apps/api/src/tests/ai-support-agent.business-eval.ts
```

Results:

- `npm run build -w apps/api`: passed
- `search-orchestrator.test.ts`: `2/2 pass`
- `support-agent.test.ts`: `32/32 pass`
- `hybrid-retrieval.test.ts`: `8/8 pass`
- `github-kb/service.test.ts`: `21/21 pass`
- `evaluation-framework.test.ts`: `11/11 pass`
- `release.integration.test.ts`: `14/14 pass`
- `github-kb-cleanup/dry-run.integration.test.ts`: `2/2 pass`
- `github-kb.integration.test.ts`: `22/22 pass`
- `ai-support-agent.business-eval.ts`: `1/1 pass`

DB-backed proof status from the commands above:

- `release`: green
- `cleanup dry-run`: green
- `github-kb integration`: green

---

## 4. Structured Gate Snapshot

The business evaluation run reported:

- `generated_at`: `2026-04-02T13:58:12.961Z`
- `mode`: `isolated_db`
- `git_revision`: `7672169f3738c33e0bdec42fe97e3d6ae1259b14`
- `knowledge_space`: `support-local`

Feature flags observed in the report:

- `FEATURE_KB_GROUNDED_SEARCH=true`
- `FEATURE_SUPPORT_AGENT_HYBRID_RETRIEVAL=false`
- `FEATURE_AI_MULTI_TURN_HANDOFF=true`

Dataset versions observed in the report:

- `retrieval=2026-04-01`
- `runtime=2026-04-01`
- `answer=2026-04-01`
- `regression=2026-04-01`
- `build=live:5aed20a3b9c03a08a4e69cedb6fbea1a904d8561:715a776f-810c-4567-87ff-03157f4facfc`

Summary outcome:

- build summary `publishable=true`
- retrieval failures: none
- runtime failures: none
- answer failures: none
- `releaseDecision=ready`
- `productionEnablementGate.passed=true`
- top failures: none

Interpretation:

- the current revision cleared the automated acceptance gates needed to enter rollout-readiness review
- this does not by itself authorize production promotion

---

## 5. Architecture-Safety Check

The fresh verification above is consistent with the required rebuild constraints:

- serving truth remains publication-based
- runtime remains scoped to published snapshots
- build state and serving state remain separated
- unfinished or local build artifacts are not treated as production-visible serving truth
- `kb_serving_versions` is not re-elevated to canonical serving truth
- no rerank dependency was introduced into the current rollout unit

No automated blocker was observed in this verification pass for:

- release semantics
- cleanup dry-run protection semantics
- publication isolation
- local promotion guard
- support runtime contract gates

---

## 6. What This Record Does Not Yet Prove

This record does not yet include the operator-captured fields required for a completed rollout-readiness review:

- real target `knowledgeSpace`
- real target `repoId`
- real candidate `buildId`
- current publication build version for the target scope
- rollback publication target build version for the target scope
- promotion dry-run payload captured from the target scope
- rollback payload captured from the target scope
- shadow compare result captured from the target scope
- operator timestamp, actor, reviewer, and signoff

Those items must be captured later using the sequence defined in `docs/29_AI_Support_Agent_Rollout_Operator_Runbook.md`.

---

## 7. Stage Judgment

Current stage judgment for the revision under review:

- `ready for rollout-readiness review`

Not claimed by this record:

- `ready for direct production rollout`
- `production approval already granted`
- `non-production live drill already completed`

---

## 8. Required Next Evidence

Before any real promotion decision, the following still must be executed and recorded against an approved target scope:

1. `GET /api/v1/internal/kb/release/status`
2. `POST /api/v1/internal/kb/publications/promote/dry-run`
3. `POST /api/v1/internal/kb/release/rollback-runbook`
4. `POST /api/v1/internal/ai/release/decision`
5. `POST /api/v1/internal/ai/release/shadow-compare`

The correct evidence format for that later step is:

- `docs/31_AI_Support_Agent_Rollout_Readiness_Evidence_Template.md`

If those records are missing, the correct state remains:

- `blocked for production promotion`
