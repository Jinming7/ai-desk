# KB Async Embedding Gated Publish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Introduce asynchronous embedding execution for KB build artifacts without weakening publication-based serving truth or snapshot coherence.

**Architecture:** Artifact persistence and embedding execution are decoupled, but publication remains gated on build-scoped embedding task terminality. Required families must be ready before validation passes; best-effort families may fail, but they may not remain pending at publish time.

**Tech Stack:** TypeScript, Node.js, PostgreSQL, KB build services in `apps/api/src/modules/github-kb`, test suites under `apps/api/src/tests`.

---

### Task 1: Persist Build-Scoped Embedding Task State

**Files:**
- Modify: `apps/api/src/modules/github-kb/repository.ts`
- Modify: `apps/api/src/modules/github-kb/service.ts`
- Modify: `apps/api/src/db/migrations/*.sql`
- Test: `apps/api/src/tests/github-kb.integration.test.ts`

- [ ] **Step 1: Write the failing integration test**
Add a test that creates a build-scoped chunk or memory retrieval unit and asserts embedding work is represented as a separate pending task rather than inline-only behavior.

- [ ] **Step 2: Run the focused test to verify RED**
Run: `DATABASE_URL=postgresql://postgres:postgres@localhost:5432/nexusflow NODE_ENV=test fnm exec --using=20.20.1 bash -lc 'npx tsx --test apps/api/src/tests/github-kb.integration.test.ts'`
Expected: FAIL because no embedding task ledger exists yet.

- [ ] **Step 3: Add the smallest schema and repository support**
Introduce a build-scoped embedding task table or equivalent ledger with idempotent upsert/claim/update APIs keyed by `knowledge_space + repo_id + branch + build_version + target_family + target_row_id + embedding_version`.

- [ ] **Step 4: Re-run the focused test to verify GREEN**
Run: `DATABASE_URL=postgresql://postgres:postgres@localhost:5432/nexusflow NODE_ENV=test fnm exec --using=20.20.1 bash -lc 'npx tsx --test apps/api/src/tests/github-kb.integration.test.ts'`
Expected: PASS for the new task-ledger assertion.

- [ ] **Step 5: Commit**
Run:
```bash
git add apps/api/src/modules/github-kb/repository.ts apps/api/src/modules/github-kb/service.ts apps/api/src/db/migrations apps/api/src/tests/github-kb.integration.test.ts
git commit -m "feat: persist kb embedding task ledger"
```

### Task 2: Switch Build Ingest from Inline Embedding to Task Enqueue

**Files:**
- Modify: `apps/api/src/modules/github-kb/service.ts`
- Modify: `apps/api/src/modules/github-kb/repository.ts`
- Test: `apps/api/src/modules/github-kb/service.test.ts`
- Test: `apps/api/src/tests/github-kb.integration.test.ts`

- [ ] **Step 1: Write failing tests for policy-aware enqueue**
Add tests that prove:
  - `required` and `best_effort` families enqueue tasks
  - `disabled` families do not
  - citation rows remain opt-in and selected-only

- [ ] **Step 2: Run the focused tests to verify RED**
Run:
```bash
fnm exec --using=20.20.1 npx tsx --test apps/api/src/modules/github-kb/service.test.ts
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/nexusflow NODE_ENV=test fnm exec --using=20.20.1 bash -lc 'npx tsx --test apps/api/src/tests/github-kb.integration.test.ts'
```
Expected: FAIL on missing enqueue behavior.

- [ ] **Step 3: Implement the minimal enqueue flow**
Replace inline embedding on the target families with:
  - row persistence
  - metadata that records intended embedding policy/state
  - embedding task creation

- [ ] **Step 4: Re-run the focused tests to verify GREEN**
Run the same commands from Step 2.
Expected: PASS.

- [ ] **Step 5: Commit**
Run:
```bash
git add apps/api/src/modules/github-kb/service.ts apps/api/src/modules/github-kb/repository.ts apps/api/src/modules/github-kb/service.test.ts apps/api/src/tests/github-kb.integration.test.ts
git commit -m "feat: enqueue kb embedding work by policy"
```

### Task 3: Add Async Worker Execution and Retry Semantics

**Files:**
- Modify: `apps/api/src/modules/github-kb/service.ts`
- Modify: `apps/api/src/modules/github-kb/repository.ts`
- Test: `apps/api/src/tests/github-kb.integration.test.ts`

- [ ] **Step 1: Write failing retry/resume tests**
Add coverage proving transient embedding failures:
  - release the task back to queued state
  - do not duplicate task rows
  - do not cross over into another build version

- [ ] **Step 2: Run the focused test to verify RED**
Run: `DATABASE_URL=postgresql://postgres:postgres@localhost:5432/nexusflow NODE_ENV=test fnm exec --using=20.20.1 bash -lc 'npx tsx --test apps/api/src/tests/github-kb.integration.test.ts'`
Expected: FAIL on missing worker semantics.

- [ ] **Step 3: Implement claim/run/finalize logic**
Add task claiming, lease-safe execution, transient retry behavior, and terminal failure recording.

- [ ] **Step 4: Re-run the focused test to verify GREEN**
Run the same command from Step 2.
Expected: PASS.

- [ ] **Step 5: Commit**
Run:
```bash
git add apps/api/src/modules/github-kb/service.ts apps/api/src/modules/github-kb/repository.ts apps/api/src/tests/github-kb.integration.test.ts
git commit -m "feat: add async kb embedding worker semantics"
```

### Task 4: Gate Validation and Publication on Embedding Terminality

**Files:**
- Modify: `apps/api/src/modules/github-kb/service.ts`
- Modify: `apps/api/src/modules/github-kb/release/service.ts`
- Modify: `apps/api/src/modules/github-kb/repository.ts`
- Test: `apps/api/src/tests/github-kb.integration.test.ts`
- Test: `apps/api/src/tests/release.integration.test.ts`

- [ ] **Step 1: Write failing validation/promotion tests**
Add tests proving:
  - pending required embedding work blocks validation/publication
  - best-effort failures are visible but publishable only after all tasks are terminal
  - a published build rejects late embedding mutation

- [ ] **Step 2: Run the focused tests to verify RED**
Run:
```bash
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/nexusflow NODE_ENV=test fnm exec --using=20.20.1 bash -lc 'npx tsx --test apps/api/src/tests/github-kb.integration.test.ts'
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/nexusflow NODE_ENV=test fnm exec --using=20.20.1 bash -lc 'npx tsx --test apps/api/src/tests/release.integration.test.ts'
```
Expected: FAIL on missing gates.

- [ ] **Step 3: Implement the minimal gate changes**
Extend build validation summaries, release checks, and publication guards so pending embedding work cannot leak into serving.

- [ ] **Step 4: Re-run the focused tests to verify GREEN**
Run the same commands from Step 2.
Expected: PASS.

- [ ] **Step 5: Commit**
Run:
```bash
git add apps/api/src/modules/github-kb/service.ts apps/api/src/modules/github-kb/release/service.ts apps/api/src/modules/github-kb/repository.ts apps/api/src/tests/github-kb.integration.test.ts apps/api/src/tests/release.integration.test.ts
git commit -m "feat: gate kb publication on embedding readiness"
```

### Task 5: Surface Operator and Cleanup Visibility

**Files:**
- Modify: `apps/api/src/modules/github-kb/cleanup/service.ts`
- Modify: `apps/api/src/modules/github-kb/cleanup/repository.ts`
- Modify: `apps/api/src/modules/github-kb/release/service.ts`
- Test: `apps/api/src/tests/github-kb-cleanup/dry-run.integration.test.ts`
- Test: `apps/api/src/tests/release.integration.test.ts`

- [ ] **Step 1: Write failing operator-surface tests**
Add tests proving cleanup dry-run and release status expose embedding readiness, blocking reasons, and rollback completeness.

- [ ] **Step 2: Run the focused tests to verify RED**
Run:
```bash
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/nexusflow NODE_ENV=test fnm exec --using=20.20.1 bash -lc 'npx tsx --test apps/api/src/tests/release.integration.test.ts'
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/nexusflow NODE_ENV=test fnm exec --using=20.20.1 bash -lc 'npx tsx --test apps/api/src/tests/github-kb-cleanup/dry-run.integration.test.ts'
```
Expected: FAIL on missing visibility.

- [ ] **Step 3: Implement the smallest reporting additions**
Expose build embedding readiness in operator surfaces without changing publication truth.

- [ ] **Step 4: Re-run the focused tests to verify GREEN**
Run the same commands from Step 2.
Expected: PASS.

- [ ] **Step 5: Commit**
Run:
```bash
git add apps/api/src/modules/github-kb/cleanup/service.ts apps/api/src/modules/github-kb/cleanup/repository.ts apps/api/src/modules/github-kb/release/service.ts apps/api/src/tests/github-kb-cleanup/dry-run.integration.test.ts apps/api/src/tests/release.integration.test.ts
git commit -m "feat: report kb embedding readiness in operator flows"
```

### Task 6: Full Verification Before Rollout

**Files:**
- Verify: `apps/api/src/modules/github-kb/*`
- Verify: `apps/api/src/tests/*`

- [ ] **Step 1: Run build and KB suites**
Run:
```bash
fnm exec --using=20.20.1 npm run build -w apps/api
set -a; source .env >/dev/null 2>&1; fnm exec --using=20.20.1 npm run test:github-kb -w apps/api
```
Expected: exit `0`.

- [ ] **Step 2: Run DB-backed release and cleanup suites sequentially**
Run:
```bash
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/nexusflow NODE_ENV=test fnm exec --using=20.20.1 bash -lc 'npx tsx --test apps/api/src/tests/release.integration.test.ts'
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/nexusflow NODE_ENV=test fnm exec --using=20.20.1 bash -lc 'npx tsx --test apps/api/src/tests/github-kb-cleanup/dry-run.integration.test.ts'
```
Expected: both exit `0`.

- [ ] **Step 3: Run one isolated non-prod build -> validate -> publish rehearsal**
Use a safe non-prod knowledge space and direct execution. Do not use shared queue draining as the first verification path.

- [ ] **Step 4: Confirm final invariants**
Verify:
  - published build has no pending embedding work
  - runtime reads only the publication snapshot
  - rollback target exists with stable embedding readiness metadata

- [ ] **Step 5: Commit**
Run:
```bash
git commit --allow-empty -m "chore: verify async kb embedding rollout gate"
```
