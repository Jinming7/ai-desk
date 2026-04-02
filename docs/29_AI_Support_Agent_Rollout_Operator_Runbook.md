# AI Support Agent Rollout Operator Runbook

Date: 2026-04-01

Status: draft for Part 08 operational scaffolding

This runbook documents the operator-facing endpoints added for Part 08 rollout, rollback, and diagnostics.

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

## 4. AI Release Decision

Use:

- `POST /api/v1/internal/ai/release/decision`

This endpoint wraps the Part 06 acceptance gates and returns:

- gate-by-gate blocking reasons
- overall release decision
- current rollout flag snapshot

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

## 6. Operational Notes

- These helpers do not publish or roll back automatically.
- They do not delete KB rows.
- They do not change feature flags at runtime.
- Flag changes still go through the deployment configuration channel.
- Publication rollback still uses the existing `POST /api/v1/internal/kb/publications/promote` endpoint with the prior build id.
