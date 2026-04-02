# Contributing

## Collaboration Goal
- Protect valid existing content before optimizing process.
- Let humans and AI contributors work in small, scoped branches without pretending that a local commit equals full-project integration.
- Make convergence explicit: topic branches preserve partial work, PR review decides readiness, `staging` validates integration, and `main` carries released/stable history.
- Improve governance without rewriting history or discarding current in-flight work.

## Current Repository Reality
- This repository already contains valid code, docs, migrations, runbooks, and active in-flight work.
- Existing dirty worktree changes and legacy topic branches are treated as protected assets until they are explicitly triaged.
- Existing `codex/*` branches are grandfathered in. Do not rename them purely for governance. When opening a PR from a legacy branch, declare the normalized branch role (`feature`, `fix`, `refactor`, `chore`, or `release`) in the PR body.

## Core Working Model
- AI or human contributors may commit only the changes within their assigned scope.
- A commit is a local preservation unit and review unit. It is not the project-wide convergence point.
- Project-wide integration happens later during PR review, dependency resolution, conflict resolution, merge into `staging` or `release/*`, and promotion into `main`.
- The repository becomes confusing only when this boundary is not documented. Therefore every PR must explicitly state what it includes, what it excludes, and whether it depends on another branch.

## Branch Strategy

| Branch | Role | Base Branch | Normal Target | Notes |
| --- | --- | --- | --- | --- |
| `main` | Released/stable trunk | n/a | n/a | No direct AI pushes or direct commits. |
| `staging` | Integration branch for cross-branch convergence | `main` when created/reset by integrator | `main` | No direct AI pushes. |
| `feature/*` | Net-new product behavior or capability | latest `staging` | `staging` | One branch per coherent feature slice. |
| `fix/*` | Bug fix | latest `staging` | `staging` | Production hotfixes may branch from `main`; they need a documented back-merge into `staging`. |
| `refactor/*` | Structural cleanup with no intended behavior change | latest `staging` | `staging` | Must not hide new behavior or unrelated cleanup. |
| `chore/*` | Tooling, docs, config, automation, housekeeping | latest `staging` | `staging` | Use for non-product behavior changes. |
| `release/*` | Release convergence and stabilization | `staging` | `main` | Only stabilization, release notes, release gating, migration validation, and rollback-safe fixes. |

## Integration Ownership
- The branch author is responsible for:
  - understanding current flow, target behavior, constraints, data model impact, state transitions, integration boundaries, verification plan, and failure risks before editing
  - staging only scoped, reviewed changes
  - stating exactly what is included and excluded
  - running the relevant verification for the scoped change or stating what remains unverified
- The integrator is responsible for:
  - deciding merge order
  - resolving branch dependencies
  - reviewing conflicts in shared files
  - deciding whether the branch is independently mergeable
  - promoting converged code from `staging` to `main`
- The default integrator is the human repository owner unless another integrator is explicitly named in the PR.

## Commit Rules
- Use conventional commit subjects: `feat`, `fix`, `refactor`, `chore`, `docs`, `test`, `release`.
- `checkpoint:` commits are allowed only on topic branches to preserve a validated intermediate state. They are not a substitute for a clear PR summary and should not be used as the final merge title.
- Commit only what you own and reviewed.
- Do not mix unrelated feature work, refactor work, migration work, workflow changes, and documentation changes in one commit or one PR unless the dependency is inseparable and explicitly explained.
- On a dirty worktree, inspect staged content carefully before committing. Never assume unstaged or nearby changes are disposable.
- Non-trivial progress must not exist only as uncommitted local changes once you reach a validated milestone, pause work, hand off work, or prepare any risky Git action.
- Mandatory preservation points:
  - after each validated milestone that you may need to roll back to or resume from
  - before branch switch, worktree switch, rebase, cherry-pick, merge, conflict resolution, or local cleanup
  - before handing the branch to another AI/human or ending a session with meaningful unfinished work
  - before any action that could discard, overwrite, or make current work hard to recover
- Use a normal typed commit or `checkpoint:` for validated milestones.
- If a state must be preserved before it is mergeable or fully verified, preserve it with a local snapshot commit on the topic branch or a `backup/*` branch. Do not rely on stash as the only durable copy.
- Professional default: fewer, coherent, recoverable commits. Do not commit every trivial keystroke; do commit every recoverable milestone and every risky transition point.

## PR Rules
- Open a PR to `staging` by default.
- Open a PR to `main` only for:
  - an approved `release/*`
  - an approved production hotfix from `fix/*`
  - an explicit repository-owner instruction
- Every PR must complete `.github/PULL_REQUEST_TEMPLATE.md`.
- Every PR must state:
  - what is included
  - what is not included
  - exact files or directories changed
  - whether shared/high-conflict files were touched
  - whether the branch depends on another branch, commit, or PR
  - whether the branch is safe to merge directly
  - the main merge risks
- If the branch depends on unmerged work, the PR must include `Depends on: <branch/commit/PR>`.
- If the branch is not independently mergeable, the PR must include `Do not merge directly` and explain the blocker.
- Stacked PRs are allowed only when the dependency chain is explicit.

## Merge Rules
- `feature/*`, `fix/*`, `refactor/*`, and `chore/*` should be squash-merged by default so that branch-local checkpoint history does not get confused with integration history.
- `release/*` may use a merge commit when the integrator wants to preserve release-freeze context and auditability.
- Do not use rebase-merge on shared branches unless the integrator explicitly approves the history rewrite risk.
- A PR may be merged only when:
  - the template is fully filled out
  - required verification has passed or the remaining gap is explicitly accepted by the integrator
  - dependency branches are already merged or the merge order is documented
  - conflicts in shared/high-conflict files are reviewed against the latest target branch
  - the integrator has accepted the merge risk
- A PR must not be merged when:
  - it includes unknown or unrelated changes
  - it depends on unmerged prerequisites that are not declared
  - it touches a high-conflict area but does not explain downstream impact
  - it modifies shared files from a stale target branch without resync and re-verification
  - it mixes multiple responsibilities that should have been split

## When You Must Sync The Latest Target Branch
- Before final verification if the target branch has moved since you branched.
- Before asking for merge if you touched any high-conflict or shared file.
- Before asking for merge if another open branch or PR overlaps the same subsystem.
- Before asking for merge if your change includes migrations, workflows, package manifests, env examples, release logic, or root governance docs.
- Once a branch is shared or under review, prefer merging the latest target branch into it instead of rebasing and force-pushing.

## High-Conflict Areas
- `apps/api/src/modules/ai/**`
- `apps/api/src/modules/github-kb/**`
- `apps/api/src/contracts/**`
- `apps/api/src/db/migrations/**`
- `apps/api/src/app.ts`
- `package.json`
- `apps/api/package.json`
- `.env.example`
- `.github/workflows/**`
- `AGENTS.md`
- `docs/agents/support-answer-composer.md`
- `docs/20_AI_Support_Agent_Rebuild_Part_01_System_Model_And_Single_DB_Publishing.md`
- `docs/2*_AI_Support_Agent_Rebuild_Part_*.md`
- `sla-desk/**` when plugin routing, runtime, or platform callback behavior is involved

## Review Rules For High-Conflict Areas
- Explain why the shared surface had to change.
- List downstream areas that must be re-verified.
- State whether the change must merge before or after another branch.
- Do not self-merge.
- Do not combine shared-surface edits with unrelated cleanup.

## When Work Must Be Split Into Smaller Tasks
- When the branch changes more than one subsystem with different risk profiles.
- When the PR cannot clearly explain "included" and "not included" in a few bullets.
- When the branch mixes product behavior change with broad refactor or formatting.
- When the branch touches both DB schema/release surfaces and unrelated UI or docs polish.
- When a second contributor would struggle to review ownership and dependency boundaries.

## Prohibited Git Behavior
- Direct push to `main` or `staging`
- `git reset --hard` against untriaged work
- `git checkout -- <path>` or `git restore` that discards someone else's unreviewed changes
- `git clean -fd` on a dirty workspace
- Force-pushing a shared or reviewed branch
- Rewriting another contributor's open branch
- Auto-resolving merge conflicts with `ours`/`theirs` without reading the content
- Deleting valid existing files only to make the branch look cleaner

## Minimal Handoff Required After Every Commit Or Before Every Merge Request
- Branch purpose
- Commit/PR purpose
- Exact files changed
- Explicitly excluded scope
- Target branch
- Dependency branches or prerequisite commits
- Verification performed
- Remaining verification gap
- Merge risk
- Whether the change is safe to merge directly
- Latest validated checkpoint commit
- Backup branch or snapshot commit, if recovery depends on one
