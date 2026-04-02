# AI Support Agent Rollout Operator Runbook

Date: 2026-04-01

Status: operator checklist for Part 08 rollout-readiness and live drill

This runbook documents the operator-facing endpoints added for Part 08 rollout, rollback, and diagnostics.

It is intentionally scoped to the current no-rerank baseline:

- publication-based serving remains the only serving truth
- `kb_serving_versions` remains compatibility metadata only
- current rollout units are KB publication, hybrid retrieval flag, and runtime tightening flag
- rerank is not part of the current rollout unit and must be introduced only in a later retrieval-enhancement phase

This runbook is for operator preflight, shadow comparison, promotion readiness, and rollback readiness. It is not a substitute for the Part 06 evaluation report.

## 0. Preflight Requirements

Before using any endpoint in this runbook, confirm all of the following:

- the target build is already validated and remains unpublished for the target production scope
- the latest Part 06 report is recorded and not blocked
- the DB-backed verification suites required for rollout have all executed successfully
- the target runtime still reads by publication, not by `is_active`
- the planned flag state and prior rollback flag state are both known
- the operator knows the target `knowledgeSpace`, `repoId`, `branch`, and candidate `buildId`

Minimum local verification commands before a rollout-readiness review:

```bash
npm run build -w apps/api
NODE_ENV=test npx tsx --test apps/api/src/tests/release.integration.test.ts
NODE_ENV=test npx tsx --test apps/api/src/tests/github-kb-cleanup/dry-run.integration.test.ts
NODE_ENV=test npx tsx --test apps/api/src/tests/github-kb.integration.test.ts
NODE_ENV=test npx tsx --test apps/api/src/tests/ai-support-agent.business-eval.ts
```

Operator note:

- if the business eval report still shows `releaseDecision = blocked`, stop here
- if any required DB-backed suite is `blocked`, `failed`, `skipped`, or `not_run`, stop here

Reference proof in code:

- `apps/api/src/tests/release.integration.test.ts`
  contains endpoint-level coverage for release status, promotion dry run, rollback runbook, AI release decision, shadow compare, and operator preflight drill ordering

## 1. Release Status

Use:

- `GET /api/v1/internal/kb/release/status`

Query parameters:

- `repoId`
- `branch`
- `knowledgeSpace`
- `includeBuildDetails`

This endpoint answers:

- which publication is active
- which build is currently serving
- whether `kb_serving_versions` matches the active publication
- which validated build is the current rollback candidate
- which support-agent rollout flags are active

Operator checks:

- confirm the active publication matches the intended `knowledgeSpace`
- confirm the current publication and rollback candidate are both coherent
- if `serving.comparisonToPublication` is ambiguous, do not proceed to production rollout until the scope is understood
- record the current publication build version and current flag snapshot before any further step

## 2. Promotion Dry Run

Use:

- `POST /api/v1/internal/kb/publications/promote/dry-run`

Body:

```json
{
  "buildId": "BUILD_UUID",
  "actor": "internal_operator",
  "evaluationRecorded": true,
  "shadowValidationStable": true,
  "rollbackReviewed": true
}
```

This endpoint does not mutate publication state.

It verifies:

- the build is already validated
- the caller environment is allowed to publish into the target `knowledgeSpace`
- a rollback build is known
- rollout evidence was explicitly confirmed

Operator checks:

- for `support-prod`, require `eligible = true`
- for `support-local` or `support-preview`, a missing rollback target may be a warning, but it must not be treated as production-ready evidence
- record the returned `action.body.buildId`; this is the exact promotion payload to be used later

## 3. Rollback Runbook

Use:

- `POST /api/v1/internal/kb/release/rollback-runbook`

Body:

```json
{
  "repoId": "REPO_UUID",
  "branch": "main",
  "knowledgeSpace": "support-local",
  "actor": "internal_operator",
  "priorFlagState": {
    "FEATURE_SUPPORT_AGENT_HYBRID_RETRIEVAL": false,
    "FEATURE_SUPPORT_AGENT_RUNTIME_TIGHTENING": false
  }
}
```

If `priorFlagState` is omitted, the helper falls back to the safe flag target:

- `FEATURE_SUPPORT_AGENT_HYBRID_RETRIEVAL=false`
- `FEATURE_SUPPORT_AGENT_RUNTIME_TIGHTENING=false`

The response includes:

- current publication
- prior validated publication candidate
- target flag state
- publication repoint payload
- expected post-rollback health checks

Operator checks:

- confirm the rollback publication target is the last known-good publication candidate, not the new candidate build
- confirm the recommended rollback flag state matches the prior safe state
- record the rollback publication payload and rollback flag state before any promotion

## 4. AI Release Decision

Use:

- `POST /api/v1/internal/ai/release/decision`

This endpoint wraps the Part 06 acceptance gates and returns:

- gate-by-gate blocking reasons
- overall release decision
- current rollout flag snapshot

Operator checks:

- `releaseDecision` must be `ready` before production rollout
- `verificationEvidence.dbBacked.ready` must be `true`
- `featureFlags` must match the status endpoint snapshot and the intended rollout plan
- if `requireBaselineForBehaviorChanges` is left at the default `true`, baseline summaries must be supplied for production gating

## 5. Shadow Comparison

Use:

- `POST /api/v1/internal/ai/release/shadow-compare`

Provide matched baseline and candidate observations keyed by `requestId`.

The reporter highlights:

- `kb_unavailable` false positive spikes
- citation disappearance
- answer-mode divergence
- clarification increase
- stage-failure increase

Rollback classes:

- `none`
- `fast`
- `immediate`

Operator checks:

- `immediate` means do not proceed and prepare rollback immediately
- `fast` means rollout is not stable enough for broadening traffic
- only `none` is acceptable for promotion-readiness signoff
- capture the exact `reasonCodes` and keep them with the evaluation record

## 6. Operational Notes

- These helpers do not publish or roll back automatically.
- They do not delete KB rows.
- They do not change feature flags at runtime.
- Flag changes still go through the deployment configuration channel.
- Publication rollback still uses the existing `POST /api/v1/internal/kb/publications/promote` endpoint with the prior build id.

## 7. Operator Sequence

The fixed operator sequence is:

1. `GET /api/v1/internal/kb/release/status`
2. `POST /api/v1/internal/kb/publications/promote/dry-run`
3. `POST /api/v1/internal/kb/release/rollback-runbook`
4. `POST /api/v1/internal/ai/release/decision`
5. `POST /api/v1/internal/ai/release/shadow-compare`
6. only then consider `POST /api/v1/internal/kb/publications/promote`

Do not invert this order.

Do not promote first and ask rollback questions later.

## 8. Evidence Record

For each rollout-readiness review or live drill, capture:

- git revision under review
- target `knowledgeSpace`
- `repoId`
- `branch`
- candidate `buildId`
- current publication build version
- rollback publication target build version
- current feature flag snapshot
- intended feature flag snapshot
- AI release decision
- shadow compare rollback class and reason codes
- operator timestamp and actor

Minimum signoff statement:

- current publication is known
- rollback publication target is known
- DB-backed verification evidence is ready
- AI release decision is ready
- shadow comparison is `none`
- promotion payload and rollback payload are both recorded

## 9. Live Drill Notes

For non-production live drill:

- prefer `support-preview` or `support-local`
- use a validated candidate build that is not the current active publication
- confirm the rollback payload before testing promotion

For production rollout-readiness review:

- use the real production scope inputs
- do not treat non-production bootstrap warnings as production-safe
- do not treat a green dry-run as permission to skip shadow comparison

## 10. Out Of Scope

This runbook does not authorize:

- rerank rollout
- cleanup apply execution
- destructive cleanup
- manual DB row mutation
- reintroducing `kb_serving_versions` as serving truth
