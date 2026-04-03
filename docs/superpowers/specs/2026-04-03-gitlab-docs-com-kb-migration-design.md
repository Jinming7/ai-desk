# GitLab Docs-Com KB Migration Design

**Date:** 2026-04-03

**Goal:** Migrate the canonical support KB source from GitHub `BangWork/docs-com` to self-hosted GitLab `docs/docs-com`, while preserving the shared-DB publication model, preventing wrong-source contamination, and carrying the KB to production readiness.

## Current Facts

1. The current KB implementation is GitHub-only.
   - `github-client.ts` rejects non-`github.com` hosts.
   - read-only auth is currently modeled around `GITHUB_TOKEN_READONLY`.
   - source URLs are hard-coded to GitHub blob URLs.

2. The support KB currently has no published docs-com snapshot.
   - `kb_publications` for docs-com: `0`
   - `kb_serving_versions` for docs-com: `0`
   - one historical docs-com build remains in `building`

3. The previously observed wrong-source `ai-desk` data has been removed from the shared DB.
   - the cleanup was repo-scoped
   - docs-com rows were preserved
   - runtime truth remained unchanged because the wrong repo never had publications or serving rows

4. The target GitLab source is reachable with read-only API access.
   - project: `docs/docs-com`
   - API base: `https://git.ones.pro/api/v4`
   - web URL: `https://git.ones.pro/docs/docs-com`
   - default branch: `master`
   - token scopes verified through `/personal_access_tokens/self`: `read_repository`, `read_api`

5. The target repository corpus is broader than the production-safe KB seed.
   - total markdown/mdx files: `1742`
   - `docs/ + open-docs/ + deploy-docs/`: `661`
   - non-primary markdown/mdx files outside those roots: `1081`
   - `i18n/` alone contributes `1049` markdown/mdx files

## Design Decisions

### 1. Provider abstraction, not a GitLab-only rewrite

We will not directly mutate the existing GitHub client into GitLab-only behavior. That would create unnecessary risk and break existing tests. Instead:

- keep GitHub support available during migration
- add a provider abstraction layer for repository read operations
- implement a GitLab provider for `git.ones.pro`
- route docs-com through the GitLab provider

This keeps the change small enough to verify while avoiding a second wrong-source incident.

### 2. Canonical source pinning for support docs-com

The support KB docs-com path must be pinned to exactly:

- host: `git.ones.pro`
- project: `docs/docs-com`
- branch: `master`
- public docs base: `https://docs.ones.com`

The generic repository registration API may remain for non-docs-com use cases, but the docs-com-specific ensure/status/build path must refuse any source identity drift.

### 3. Phase-1 corpus restriction

The first production-worthy GitLab rollout will include only:

- `docs/**/*.md`
- `docs/**/*.mdx`
- `open-docs/**/*.md`
- `open-docs/**/*.mdx`
- `deploy-docs/**/*.md`
- `deploy-docs/**/*.mdx`

Initial exclusions:

- `i18n/**`
- `blog/**`
- `.claude/**`
- `.codex/**`
- `.github/**`
- `scripts/**`
- `jenkins/**`
- `src/**`

Rationale:

- these extra directories are large and would distort retrieval before source-quality validation is re-established
- the user asked for production readiness, not broad but noisy ingestion
- the first valid progress denominator will therefore be `661`, not `1742`

### 4. Runtime and publication model remain unchanged

The migration does not change any of the rebuild invariants:

- build state and serving state stay separate
- runtime reads only publication snapshots
- `is_active` is not serving truth
- unfinished and failed builds remain invisible to runtime
- no mixed-build retrieval path is allowed

### 5. Environment contract

Repository code will be updated to understand these new variables:

- `GITLAB_API_BASE_URL`
- `GITLAB_TOKEN_READONLY`

Runtime environments that serve or build the KB must provide them:

- local `.env`
- local `docker-compose`
- deployed API runtime
- deployed KB worker runtime, if used

GitHub Actions `kb-docs-com-ensure` does not need the GitLab PAT directly if it only calls the internal API and the API runtime already has the GitLab env configured.

## Architecture

### Provider interface

The read-only provider boundary will cover:

- `validateReadOnlyAccess`
- `getBranchHead`
- `getRepositoryDefaultBranch`
- `listFilesAtCommit`
- `getFileContentBufferAtCommit`
- `getFileContentAtCommit`
- `compareCommits`
- `buildSourceUrl`
- `getRepoFullName`
- `assertReadOnlyMethod`

Provider selection will be based on `repo_url`:

- `mock://` -> mock provider
- `github.com` -> GitHub provider
- `git.ones.pro` -> GitLab provider

### GitLab implementation

The GitLab provider will use:

- `/projects/:id`
- `/projects/:id/repository/branches/:branch`
- `/projects/:id/repository/tree`
- `/projects/:id/repository/files/:file_path/raw`
- `/projects/:id/repository/compare`
- `/personal_access_tokens/self`

The provider must support:

- paginated tree listing
- transient network retry for safe GET requests
- PAT scope validation against disallowed write scopes

### Docs-com pinning

The docs-com-specific service path will update its canonical constants from GitHub to GitLab and will enforce:

- owner/group identity
- project name
- branch
- public base URL

For docs-com ensure/status/full-build, any repo URL mismatch must be corrected or rejected explicitly rather than silently accepted.

## Verification Strategy

### Code-level

- add provider unit tests for GitLab URL parsing and provider selection
- add GitLab read validation tests from PAT self metadata payloads
- add docs-com pinning regression tests
- keep all existing GitHub docs-com and generic repo tests passing

### Integration-level

- `npm run build -w apps/api`
- `npm run test:github-kb -w apps/api`
- `release.integration.test.ts`
- `github-kb-cleanup/dry-run.integration.test.ts`

### Live non-prod

After code changes are stable:

1. register or repair canonical GitLab docs-com registration
2. run a non-prod docs-com full build in `support-local`
3. verify build validation results persist
4. verify artifact counts are coherent for the selected build
5. publish only after validation passes
6. verify `kb_publications` and `kb_serving_versions` alignment
7. verify runtime retrieval is publication-scoped

## Milestones

1. Design and plan committed
2. Provider abstraction and GitLab adapter committed
3. Docs-com pinning and env contract committed
4. Non-prod validated build committed
5. Non-prod published snapshot committed
6. Gate verification and rollout/runbook updates committed

## Risks

1. GitLab self-hosted API may reset long-running tree requests.
   - mitigation: explicit retries and paginated listing

2. `i18n/` can flood retrieval if ingested too early.
   - mitigation: exclude it from phase-1 corpus

3. Existing GitHub tests may regress during abstraction.
   - mitigation: preserve the GitHub provider and run current suites unchanged

4. Deployment environments may miss the new GitLab env vars.
   - mitigation: code-level env schema, `.env.example`, runbook, and environment matrix updates

## Non-Goals For The First Migration Slice

- production publication on day one
- full multilingual KB ingestion
- broad repo-native families outside the selected docs corpus
- deleting GitHub support from the codebase immediately
