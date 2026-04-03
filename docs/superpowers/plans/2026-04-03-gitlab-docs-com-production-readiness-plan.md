# GitLab Docs-Com KB Production Readiness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Migrate the canonical docs-com knowledge source to self-hosted GitLab, re-establish a validated and published non-prod snapshot, and carry the KB through production-readiness gates without violating shared-DB publication semantics.

**Architecture:** Keep the existing build/validate/publish model and runtime publication-scoped retrieval intact. Replace the GitHub-only read path with a provider abstraction, add a GitLab provider for `git.ones.pro/docs/docs-com`, pin docs-com to that source, then drive the non-prod snapshot and gate-verification workflow to completion.

**Tech Stack:** TypeScript, Node.js, PostgreSQL, `tsx`, repository-local KB services under `apps/api/src/modules/github-kb`, integration tests under `apps/api/src/tests`, runbook/docs under `docs/`.

---

## Locked Facts

- Canonical source target:
  - repo URL: `https://git.ones.pro/docs/docs-com`
  - API base: `https://git.ones.pro/api/v4`
  - project path: `docs/docs-com`
  - branch: `master`
  - public base URL: `https://docs.ones.com`
- Verified PAT scopes:
  - `read_api`
  - `read_repository`
- Phase-1 ingest corpus:
  - `docs/**`
  - `open-docs/**`
  - `deploy-docs/**`
- Phase-1 denominator:
  - `661` markdown/mdx files

## Task 1: Add provider abstraction without changing runtime semantics

**Files:**
- Create: `apps/api/src/modules/github-kb/repo-provider.ts`
- Modify: `apps/api/src/modules/github-kb/service.ts`
- Test: `apps/api/src/modules/github-kb/service.test.ts`

- [ ] **Step 1: Write failing tests for provider selection and docs-com GitLab canonical constants**

Add tests covering:
- `git.ones.pro/docs/docs-com` resolves to GitLab provider
- `github.com/BangWork/docs-com` still resolves to GitHub provider
- docs-com canonical URL is GitLab, not GitHub

- [ ] **Step 2: Run the focused test and confirm RED**

Run:
```bash
fnm exec --using=20.20.1 npm run test --workspace apps/api -- src/modules/github-kb/service.test.ts
```

Expected:
- the new tests fail because provider selection does not exist yet

- [ ] **Step 3: Implement the minimal provider boundary**

Create a provider module exposing the existing read operations through one interface and route `service.ts` through it.

- [ ] **Step 4: Re-run focused tests and confirm GREEN**

Run:
```bash
fnm exec --using=20.20.1 npm run test --workspace apps/api -- src/modules/github-kb/service.test.ts
```

## Task 2: Implement GitLab read-only provider

**Files:**
- Create: `apps/api/src/modules/github-kb/gitlab-client.ts`
- Modify: `apps/api/src/modules/github-kb/repo-provider.ts`
- Modify: `apps/api/src/config/env.ts`
- Modify: `.env.example`
- Test: `apps/api/src/modules/github-kb/service.test.ts`

- [ ] **Step 1: Write failing tests for GitLab PAT validation and GitLab source URL generation**

Add tests covering:
- PAT self metadata with `read_api/read_repository` passes
- write-capable GitLab scopes fail
- GitLab repo source URL is generated from `https://git.ones.pro/docs/docs-com`

- [ ] **Step 2: Run the focused test and confirm RED**

Run:
```bash
fnm exec --using=20.20.1 npm run test --workspace apps/api -- src/modules/github-kb/service.test.ts
```

- [ ] **Step 3: Implement GitLab provider**

Implement:
- project metadata lookup
- branch head
- default branch
- paginated tree listing
- file raw content fetch
- compare endpoint mapping
- PAT self scope validation

- [ ] **Step 4: Add GitLab env schema**

Add:
- `GITLAB_API_BASE_URL`
- `GITLAB_TOKEN_READONLY`

- [ ] **Step 5: Re-run focused tests and confirm GREEN**

Run:
```bash
fnm exec --using=20.20.1 npm run test --workspace apps/api -- src/modules/github-kb/service.test.ts
```

## Task 3: Pin docs-com to canonical GitLab source

**Files:**
- Modify: `apps/api/src/modules/github-kb/service.ts`
- Modify: `apps/api/src/tests/github-kb.integration.test.ts`
- Modify: `apps/api/src/tests/ai-support-agent.business-eval.ts`

- [ ] **Step 1: Write failing tests for docs-com registration correction**

Add tests covering:
- docs-com ensure repairs registration to GitLab canonical URL
- docs-com ensure rejects or corrects non-canonical docs-com source identity
- docs-com include paths remain restricted to `docs/open-docs/deploy-docs`

- [ ] **Step 2: Run focused tests and confirm RED**

Run:
```bash
fnm exec --using=20.20.1 npm run test:github-kb -w apps/api
```

- [ ] **Step 3: Implement canonical pinning**

Update docs-com constants and registration repair logic so the docs-com path always resolves to:
- `https://git.ones.pro/docs/docs-com`
- branch `master`
- public base `https://docs.ones.com`

- [ ] **Step 4: Re-run focused tests and confirm GREEN**

Run:
```bash
fnm exec --using=20.20.1 npm run test:github-kb -w apps/api
```

## Task 4: Update environment and operations contract

**Files:**
- Modify: `.env.example`
- Modify: `.github/workflows/kb-docs-com-ensure.yml`
- Modify: `docs/29_AI_Support_Agent_Rollout_Operator_Runbook.md`
- Modify: `AGENTS.md`
- Modify: `docs/20_AI_Support_Agent_Rebuild_Part_01_System_Model_And_Single_DB_Publishing.md`

- [ ] **Step 1: Document the new GitLab env contract**

Add GitLab variables to `.env.example` and operator docs.

- [ ] **Step 2: Update canonical-source documentation**

Revise the docs-com source identity from GitHub to GitLab without changing the publication model.

- [ ] **Step 3: Verify the workflow contract remains valid**

Confirm `kb-docs-com-ensure.yml` still only calls internal APIs and therefore does not require direct PAT injection unless the workflow later reads GitLab directly.

## Task 5: Run full code verification before live non-prod execution

**Files:**
- Verify only

- [ ] **Step 1: Build API**

Run:
```bash
fnm exec --using=20.20.1 npm run build -w apps/api
```

- [ ] **Step 2: Run KB integration suite**

Run:
```bash
fnm exec --using=20.20.1 npm run test:github-kb -w apps/api
```

- [ ] **Step 3: Run release and cleanup suites serially**

Run:
```bash
fnm exec --using=20.20.1 bash -lc 'DATABASE_URL=postgresql://postgres:postgres@localhost:5432/nexusflow NODE_ENV=test npx tsx --test apps/api/src/tests/release.integration.test.ts'
fnm exec --using=20.20.1 bash -lc 'DATABASE_URL=postgresql://postgres:postgres@localhost:5432/nexusflow NODE_ENV=test npx tsx --test apps/api/src/tests/github-kb-cleanup/dry-run.integration.test.ts'
```

## Task 6: Execute real GitLab docs-com non-prod build

**Files:**
- No code change expected if prior tasks are correct

- [ ] **Step 1: Confirm shared DB docs-com registration state**

Run a DB inspection for:
- `kb_repo_registrations`
- `kb_builds`
- `kb_publications`
- `kb_serving_versions`

- [ ] **Step 2: Run one non-prod docs-com build in `support-local`**

Use the docs-com canonical path only. Do not touch `support-prod`.

- [ ] **Step 3: Verify build validation persistence**

Confirm:
- `kb_build_validation_results` rows exist
- build status is not stuck in `building`
- artifact counts align with the selected build

## Task 7: Publish one validated non-prod snapshot

**Files:**
- No code change expected if prior tasks are correct

- [ ] **Step 1: Promote the validated build through the official path**

Use publication, not `is_active`.

- [ ] **Step 2: Verify publication/serving alignment**

Confirm:
- `kb_publications` matches the published build
- `kb_serving_versions` points to the same build
- runtime retrieval resolves through publication joins only

## Task 8: Production-readiness gates

**Files:**
- Modify only if a real failing invariant is found

- [ ] **Step 1: Run retrieval/eval smoke checks**

Confirm the runtime reads the published GitLab docs-com snapshot and grounded citations resolve to `docs.ones.com`.

- [ ] **Step 2: Run release and cleanup dry-run checks against the new scope**

Confirm the new publication is visible to release status and cleanup dry-run keeps the published build protected.

- [ ] **Step 3: Verify rollback target story**

If first bootstrap has no rollback target, document that explicitly for non-prod. Before production, a prior published target must exist.

## Task 9: Milestone preservation

**Files:**
- Commit only the files changed in each milestone

- [ ] **Step 1: Commit design/plan milestone**
- [ ] **Step 2: Commit provider abstraction milestone**
- [ ] **Step 3: Commit GitLab adapter and docs-com pinning milestone**
- [ ] **Step 4: Commit docs/runbook contract milestone**
- [ ] **Step 5: Commit final verified readiness milestone**
