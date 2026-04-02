# AI Support Agent Rollout Readiness Evidence Template

Date: 2026-04-02

Status: reusable operator evidence template for rollout-readiness review and live drill

Use this document together with:

- `docs/28_AI_Support_Agent_Rebuild_Part_08_Rollout_Rollback_And_Operations.md`
- `docs/29_AI_Support_Agent_Rollout_Operator_Runbook.md`

Current scope:

- publication-based serving only
- no rerank rollout in this phase
- no destructive cleanup
- no manual DB mutation

---

## 1. Usage Notes

Use this template for either:

- rollout-readiness review
- non-production live drill

Do not use this template as proof of production rollout by itself.

Do not mark a review as passed if any required DB-backed suite is missing, blocked, skipped, or failed.

---

## 2. Review Header

Copy and fill:

```md
# AI Support Agent Rollout Evidence Record

- Review type: `rollout-readiness review` | `non-production live drill`
- Date:
- Operator:
- Reviewer:
- Git revision:
- Branch:
- Target knowledgeSpace:
- Repo ID:
- Branch name:
- Candidate build ID:
- Candidate build version:
- Current publication build version:
- Expected rollback publication target:
- Current feature flags:
- Intended feature flags:
- Evaluation report path or attachment:
- Notes:
```

---

## 3. Preflight Verification

Copy and fill:

```md
## Preflight Verification

- `npm run build -w apps/api`
  Result:

- `NODE_ENV=test npx tsx --test apps/api/src/tests/release.integration.test.ts`
  Result:

- `NODE_ENV=test npx tsx --test apps/api/src/tests/github-kb-cleanup/dry-run.integration.test.ts`
  Result:

- `NODE_ENV=test npx tsx --test apps/api/src/tests/github-kb.integration.test.ts`
  Result:

- `NODE_ENV=test npx tsx --test apps/api/src/tests/ai-support-agent.business-eval.ts`
  Result:
  Report `releaseDecision`:
  Report `productionEnablementGate.passed`:

- Required DB-backed suites all passed:
- Publication-based serving still confirmed:
- Runtime still does not read unpublished snapshot:
```

Stop conditions:

- business eval report shows `releaseDecision = blocked`
- any required DB-backed suite is not green
- publication truth is ambiguous for the target scope

---

## 4. Operator Sequence Capture

### 4.1 Release Status

```md
## Release Status

- Endpoint: `GET /api/v1/internal/kb/release/status`
- Input:
- Current publication build version:
- Current rollback candidate:
- Serving/publication comparison:
- Feature flag snapshot:
- Proceed: `yes` | `no`
- Notes:
```

### 4.2 Promotion Dry Run

```md
## Promotion Dry Run

- Endpoint: `POST /api/v1/internal/kb/publications/promote/dry-run`
- Input:
- Eligible:
- Returned rollback target:
- Promotion payload:
- Blocking checks:
- Proceed: `yes` | `no`
- Notes:
```

### 4.3 Rollback Runbook

```md
## Rollback Runbook

- Endpoint: `POST /api/v1/internal/kb/release/rollback-runbook`
- Input:
- Current publication:
- Rollback publication target:
- Recommended rollback flag state:
- Rollback publication payload:
- Expected post-rollback health signals:
- Proceed: `yes` | `no`
- Notes:
```

### 4.4 AI Release Decision

```md
## AI Release Decision

- Endpoint: `POST /api/v1/internal/ai/release/decision`
- Input includes baseline summaries: `yes` | `no`
- `releaseDecision`:
- `verificationEvidence.dbBacked.ready`:
- Gate summary:
- Blocking reasons:
- Recommendation:
- Proceed: `yes` | `no`
- Notes:
```

### 4.5 Shadow Compare

```md
## Shadow Compare

- Endpoint: `POST /api/v1/internal/ai/release/shadow-compare`
- Baseline sample set:
- Candidate sample set:
- Rollback class:
- Reason codes:
- Citation disappearance rate:
- KB unavailable false positive rate:
- Proceed: `yes` | `no`
- Notes:
```

---

## 5. Signoff Checklist

Copy and fill:

```md
## Signoff Checklist

- Current publication is known: `yes` | `no`
- Rollback publication target is known: `yes` | `no`
- DB-backed verification evidence is ready: `yes` | `no`
- AI release decision is ready: `yes` | `no`
- Shadow comparison rollback class is `none`: `yes` | `no`
- Promotion payload is recorded: `yes` | `no`
- Rollback payload is recorded: `yes` | `no`
- Feature flag plan is recorded: `yes` | `no`
- Final signoff: `approved` | `blocked`
- Blocking reasons:
```

---

## 6. Non-Production Live Drill Addendum

Use this section only for `support-local` or `support-preview`.

```md
## Non-Production Live Drill

- Drill scope:
- Candidate build differs from current publication: `yes` | `no`
- Promotion executed: `yes` | `no`
- Post-promotion release status captured: `yes` | `no`
- Rollback executed: `yes` | `no`
- Post-rollback release status captured: `yes` | `no`
- Observed issues:
- Follow-up actions:
```

Rules:

- do not treat a successful non-production drill as production approval by itself
- do not skip the AI release decision or shadow comparison because the drill was green

---

## 7. Production Review Guard

Before any production promotion, all of the following must remain true:

- target scope is the real production `knowledgeSpace`
- promotion dry run is eligible
- rollback runbook is fully recorded
- AI release decision is `ready`
- shadow compare result is `none`
- operator and reviewer both sign off

If any one item is missing, the correct state is still `blocked`.
