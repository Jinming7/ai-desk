# KB Sync Local Mirror Remediation Plan

Date: 2026-03-30

Status: proposed, executable

Scope: recover `docs-com` KB availability in the shared production database, prevent local workers from polluting shared KB state again, and make local-mirror sync opt-in and safe.

## 1. Incident Summary

Current production KB state:

- `kbTotal = 586`
- `kbActive = 0`
- all indexed `docs-com` documents are present in the database but inactive
- latest checkpoint for `BangWork/docs-com:master` is `last_synced_commit_sha = local`
- the last successful jobs include a `polling` `full` sync with `after_commit_sha = local`

Observed via:

- `/api/v1/internal/kb/docs-com/status`
- `kb_sync_jobs`
- `kb_sync_checkpoints`
- `kb_documents`

## 2. Root Cause

The failure chain is:

1. Local worker uses the same shared `DATABASE_URL` as preview/prod.
2. Local `.env` enables `LOCAL_DOCS_COM_PATH=/tmp/docs-com`.
3. `getLocalDocsMirrorState()` treats `LOCAL_DOCS_COM_PATH` as a valid local mirror if the directory exists.
4. The current implementation does not verify that the mirror is usable:
   - no `git rev-parse --is-inside-work-tree` validation
   - no verification that markdown snapshot is non-empty
   - `readGitValue(..., "local")` falls back to the literal string `"local"`
5. Polling therefore enqueued a `full` sync with `after_commit_sha = local`.
6. The local mirror snapshot was effectively empty for KB purposes.
7. `runLocalMirrorSyncBatch()` finished and called `deactivateDocumentsMissingFromSnapshot(...)`.
8. That marked all previously indexed `docs-com` documents inactive.
9. Checkpoint was then updated to `last_synced_commit_sha = local`, making the polluted local state look authoritative.

Relevant code paths:

- `apps/api/src/modules/github-kb/service.ts`
- `apps/api/src/modules/github-kb/repository.ts`
- local env: `.env`

## 3. Design Goals

The fix must:

- restore KB availability without losing valid indexed content
- prevent any local workstation path from overriding the shared production KB unless explicitly enabled
- make local mirror usage safe, validated, and observable
- preserve remote GitHub sync as the default production-safe source of truth

## 4. Non-Goals

This plan does not aim to:

- redesign the whole sync architecture
- replace the current worker model
- change support answer orchestration
- introduce a new external queue system

## 5. Final Target State

After remediation:

- `docs-com` sync defaults to GitHub remote mode
- local mirror mode is disabled unless explicitly turned on
- invalid local mirror directories are ignored, never accepted
- checkpoints for shared production KB use real commit SHAs, never `"local"`
- `kb_documents.is_active` and `kb_chunks.is_active` reflect the latest successful remote snapshot
- portal status shows non-zero `kbActive`

## 6. Implementation Plan

## 6.1 Phase 0: Immediate Containment

Objective: stop further local pollution before changing code.

Actions:

1. Stop the local KB worker.
2. Remove or neutralize `LOCAL_DOCS_COM_PATH` for the worker environment.
3. Ensure no polling path can enqueue another `after_commit_sha = local` job.

Operational steps:

```bash
launchctl unload ~/Library/LaunchAgents/com.nexusflow.kb-worker.plist || true
pkill -f "tsx src/modules/github-kb/worker.ts" || true
```

Update local env:

```bash
# preferred
unset LOCAL_DOCS_COM_PATH

# if env file is used, set to a non-existent path
LOCAL_DOCS_COM_PATH=/tmp/__disabled_docs_com_mirror__
```

Validation:

- no running local KB worker process
- no new `kb_sync_jobs` rows with `after_commit_sha = local`

## 6.2 Phase 1: Code Hardening

Objective: make local mirror mode safe by construction.

### A. Add an explicit feature flag

Add a new env flag in `apps/api/src/config/env.ts`:

- `GITHUB_KB_ENABLE_LOCAL_DOCS_MIRROR=false` by default

Rule:

- even if `LOCAL_DOCS_COM_PATH` exists, local mirror mode is disabled unless this flag is true

Why:

- shared DB deployments must be remote-first
- local override must be deliberate, never implicit

### B. Harden local mirror validation

Update `getLocalDocsMirrorState()` in `apps/api/src/modules/github-kb/service.ts`.

Required checks:

1. `GITHUB_KB_ENABLE_LOCAL_DOCS_MIRROR === true`
2. path exists
3. path is a valid git worktree:
   - `git rev-parse --is-inside-work-tree`
4. `HEAD` resolves successfully
5. markdown snapshot count for included paths is greater than `0`

If any check fails:

- log a warning
- return `null`
- continue with remote GitHub mode

Important:

- remove the dangerous `"local"` fallback for `HEAD`
- branch fallback is acceptable
- commit SHA fallback is not acceptable

### C. Guard polling against invalid local state

In `pollAndEnqueueIncremental()`:

- never enqueue local jobs when `getLocalDocsMirrorState()` returns `null`
- never enqueue a job if the resolved local head is falsy or `"local"`

### D. Guard status probe and ensure path

In status/summary code:

- surface whether the source snapshot is `remote` or `local_mirror`
- if local mirror is invalid, report it as diagnostic metadata
- do not silently let invalid local mirror affect status semantics

### E. Guard checkpoint writes

Before `upsertCheckpoint()` for local mirror mode:

- assert that `head` looks like a real SHA
- refuse to checkpoint `local`, empty string, or invalid git output

Minimum validation:

```ts
/^[0-9a-f]{7,40}$/i
```

If invalid:

- throw a recoverable sync error
- mark the job failed/dead-letter
- do not mutate checkpoint

## 6.3 Phase 2: Data Recovery

Objective: restore production KB availability safely.

Recommended recovery path:

1. contain local mirror source
2. deploy code hardening
3. reset polluted checkpoint
4. run an explicit remote full sync
5. verify active docs restored

### A. Reset polluted checkpoint

Current polluted value:

- `last_synced_commit_sha = local`
- `last_full_synced_commit_sha = local`

Reset it before rerunning full sync:

```sql
UPDATE kb_sync_checkpoints
SET last_synced_commit_sha = NULL,
    last_full_synced_commit_sha = NULL,
    updated_at = NOW()
WHERE repo_id = 'ba9854da-2076-4144-874c-efe82b4ef335'
  AND branch = 'master';
```

### B. Recovery option 1: preferred

Run a fresh remote full sync after code hardening.

This is preferred because:

- reindexes current remote snapshot
- reactivates documents through normal upsert path
- keeps checkpoint and active state consistent

Trigger:

```bash
curl 'https://nexus-flow-desk.vercel.app/api/v1/internal/kb/docs-com/ensure' \
  -H 'content-type: application/json' \
  -H 'x-portal-surface: internal' \
  --data '{"mode":"full","actor":"internal_operator","runLimit":0}'
```

Then drain jobs:

```bash
curl 'https://nexus-flow-desk.vercel.app/api/v1/internal/kb/sync/run' \
  -H 'content-type: application/json' \
  -H 'x-portal-surface: internal' \
  --data '{"limit":4}'
```

Repeat until:

- no queued/running `docs-com` sync jobs remain
- checkpoint is a real remote SHA
- `kbActive > 0`

### C. Recovery option 2: emergency restore

Use only if portal must recover before full sync finishes.

Temporarily reactivate the last known remote snapshot:

```sql
UPDATE kb_documents
SET is_active = true,
    updated_at = NOW()
WHERE repo_id = 'ba9854da-2076-4144-874c-efe82b4ef335'
  AND branch = 'master'
  AND commit_sha = '47a873debcde934bfd318d680eab197f5248a3b2';

UPDATE kb_chunks
SET is_active = true,
    updated_at = NOW()
WHERE repo_id = 'ba9854da-2076-4144-874c-efe82b4ef335'
  AND branch = 'master'
  AND doc_id IN (
    SELECT id
    FROM kb_documents
    WHERE repo_id = 'ba9854da-2076-4144-874c-efe82b4ef335'
      AND branch = 'master'
      AND commit_sha = '47a873debcde934bfd318d680eab197f5248a3b2'
  );
```

Then still perform recovery option 1.

## 6.4 Phase 3: Worker Configuration Cleanup

Objective: make local worker behavior match intended ownership.

Changes:

- local worker must not point at shared production DB when local mirror mode is enabled
- if local worker must use shared DB, local mirror mode must be off

Recommended policy:

- shared production DB + remote sync only
- local mirror only against isolated development DB

Update:

- launchd plist template
- local worker startup scripts
- deployment/runbook docs

Files likely touched:

- `ops/com.nexusflow.kb-worker.plist.template`
- `scripts/run-kb-worker-launchd.sh`
- `scripts/install-kb-worker-launchd.sh`
- `.env`

## 7. Exact Code Changes

## 7.1 `apps/api/src/config/env.ts`

Add:

```ts
GITHUB_KB_ENABLE_LOCAL_DOCS_MIRROR: z.coerce.boolean().default(false)
```

## 7.2 `apps/api/src/modules/github-kb/service.ts`

Change `getLocalDocsMirrorState()` to:

- short-circuit when local mirror flag is off
- verify git repo health
- resolve real SHA only
- require non-empty markdown snapshot

Add helper:

```ts
function isValidGitSha(value: string | null | undefined): boolean
```

Add helper:

```ts
async function validateLocalDocsMirror(...)
```

## 7.3 `apps/api/src/modules/github-kb/service.ts`

In:

- `pollAndEnqueueIncremental()`
- `runFullSync()`
- `runIncrementalSync()`
- docs-com status probe helpers

Require validated local mirror state only.

## 7.4 `apps/api/src/modules/github-kb/repository.ts`

No schema change required.

Optional hardening:

- reject checkpoint writes where commit SHA is not a real SHA

This can stay in service layer if preferred.

## 7.5 Worker scripts and local env

Update scripts so production/shared worker startup does not export local mirror mode by default.

## 8. Validation Checklist

After code deploy and recovery run:

1. `/api/v1/internal/kb/docs-com/status` shows:
   - `kbActive > 0`
   - `activeCoverageRate > 0`
   - `checkpoint.lastSyncedCommitSha != "local"`
2. `kb_sync_checkpoints.last_synced_commit_sha` is a real SHA
3. no new `kb_sync_jobs.after_commit_sha = 'local'`
4. support queries can return citations again
5. `docs/`, `deploy-docs/`, `open-docs/` active counts move toward source totals

Recommended SQL validation:

```sql
SELECT is_active, COUNT(*)
FROM kb_documents
WHERE repo_id = 'ba9854da-2076-4144-874c-efe82b4ef335'
GROUP BY is_active;
```

```sql
SELECT last_synced_commit_sha, last_full_synced_commit_sha, updated_at
FROM kb_sync_checkpoints
WHERE repo_id = 'ba9854da-2076-4144-874c-efe82b4ef335'
  AND branch = 'master';
```

```sql
SELECT id, sync_mode, source, status, after_commit_sha, created_at
FROM kb_sync_jobs
WHERE repo_id = 'ba9854da-2076-4144-874c-efe82b4ef335'
ORDER BY created_at DESC
LIMIT 20;
```

## 9. Rollback Plan

If the hardening deploy causes unexpected sync regression:

1. stop worker polling
2. restore previous deployment
3. keep local mirror disabled
4. run remote full sync from manual endpoint

Important:

- do not re-enable shared DB local mirror mode during rollback
- rollback of code must not rollback to implicit local mirror activation

## 10. Risks

- if recovery full sync is triggered before containment, local worker can re-pollute state
- if emergency SQL reactivation is used without a follow-up full sync, active docs may diverge from latest remote snapshot
- if launchd worker still reads old `.env`, the issue can recur after reboot

## 11. Recommended Execution Order

1. Stop local worker.
2. Disable `LOCAL_DOCS_COM_PATH` for shared DB worker environment.
3. Implement code hardening.
4. Deploy hardened build.
5. Reset polluted checkpoint.
6. Run remote full sync.
7. Verify `kbActive` and real SHA checkpoint.
8. Re-enable worker only after validation.

## 12. Acceptance Criteria

This incident is resolved only when all are true:

- production KB status is healthy or at least partially healthy with `kbActive > 0`
- no checkpoint contains `"local"`
- no polling job uses `after_commit_sha = local`
- local mirror requires explicit opt-in and passes validation
- rerunning the worker with an invalid local path no longer mutates shared KB state

