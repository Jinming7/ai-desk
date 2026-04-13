# AGENTS.md

## Repository Git Governance (Mandatory)
- This Git governance applies to the entire repository. Nested `AGENTS.md` files may add stricter local rules, but they may not weaken this policy.
- Protect existing valid content first: committed history on `main`, `staging`, and active topic branches; the current dirty worktree; canonical contracts and runbooks under `docs/`; CI/workflow files; DB migrations; and release/runtime coordination files.
- Prefer low-risk, incremental governance upgrades. Do not "clean up" the repository by rewriting history, deleting untriaged work, or forcing artificial branch normalization.
- Human-facing collaboration flow is defined in `CONTRIBUTING.md`. Every merge request must follow `.github/PULL_REQUEST_TEMPLATE.md`.

### AI Git Working Model
- It is valid for an AI to commit only the changes within its assigned scope.
- A commit is a local preservation and review unit, not proof that the whole project has been integrated.
- Full project convergence happens later during PR review, dependency resolution, merge into `staging` or `release/*`, and promotion into `main`.
- This model becomes unsafe when the branch role, merge owner, dependency chain, high-conflict review, or "not included" boundary is missing. In that case, "I only committed my part" is not enough.

### Branch Policy
- `main`: released/stable trunk. No direct AI commits and no direct pushes. Merge only from reviewed `staging`, `release/*`, or an explicit emergency `fix/*` with a documented back-merge plan.
- `staging`: integration branch for combining validated topic branches and checking cross-branch convergence before promotion to `main`. No direct AI pushes.
- `feature/*`: net-new product behavior or capability. Branch from the latest `staging` unless the user explicitly requires another base.
- `fix/*`: bug fix branch. Branch from the latest `staging` by default. Production hotfixes may branch from `main`, but the PR must declare the required back-merge or cherry-pick into `staging`.
- `refactor/*`: structural cleanup with no intended behavior change. Do not mix new behavior into this branch type.
- `chore/*`: tooling, docs, configuration, automation, or non-product housekeeping.
- `release/*`: release convergence branch cut from `staging`. Only stabilization, release notes, migration validation, rollback-safe fixes, and release gating changes are allowed.
- Existing `codex/*` branches are legacy topic branches. Do not rename them just for governance. Instead, map them to the normalized branch role in the PR or change note.

### Commit Policy
- AI may commit only owned, reviewed changes that match the branch purpose.
- Stage files deliberately. In a dirty worktree, do not accidentally include other AI/user changes, temp files, local backups, or generated noise.
- Use conventional commit subjects: `feat`, `fix`, `refactor`, `chore`, `docs`, `test`, `release`. `checkpoint:` is allowed only on topic branches to preserve a validated intermediate state and must never be used as the final merge title.
- One commit or PR must not mix unrelated feature work, refactor work, migration changes, workflow changes, and ops changes without explicit user approval.

### Required Handoff Before Merge Or Review
- State what the branch or commit includes.
- State what it intentionally does not include.
- List the exact files or directories changed.
- Name the target branch.
- Declare whether shared or high-conflict files were touched.
- Declare dependency branches, commits, or prerequisite PRs.
- State what verification was run and what was not run.
- State the merge risk.
- State whether the branch is safe to merge directly.
- If prerequisites exist, explicitly write `Depends on: <branch/commit/PR>`.
- If the change is not independently mergeable, explicitly write `Do not merge directly` and name the blocker.

### Integration Ownership
- The branch author owns local scope correctness, staged diff hygiene, and handoff clarity.
- The integrator owns merge order, dependency resolution, conflict resolution, and final convergence verification on the target branch.
- The default integrator is the human repository owner unless another integrator is explicitly named in the PR or change note.
- AI authors must not claim or imply that a scoped local commit equals full-project integration.

### High-Conflict Areas
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
- Any branch touching these areas must sync the latest target branch before final verification.
- Any PR touching these areas must explain why the shared surface changed, what downstream areas need re-verification, and whether the merge must be serialized after another branch.
- AI must not self-merge high-conflict changes.

### Shared File Rules
- Shared files include manifests, workflows, env examples, migrations, root contracts/runbooks, entrypoints, and cross-cutting modules.
- Keep shared-file diffs minimal and explain why the shared surface had to change.
- Do not perform repo-wide renames, reformatting, or sorting passes in the same branch as behavioral changes.
- Do not delete or rewrite still-valid existing content purely to make the history look cleaner.

### Multi-AI Parallel Development
- One branch, one clearly defined scope, one responsible author.
- Prefer disjoint write sets. If two AIs need the same shared file or module, serialize the work or assign an integrator before editing.
- Stacked branches are allowed only when explicit. Every dependent branch must declare its prerequisite branch/commit and blocked merge condition.
- If unexpected unrelated changes are present, preserve them. Work around them when safe. If safe isolation is not possible, stop and escalate instead of overwriting.

### Prohibited Git Operations
- `git reset --hard`
- `git checkout -- <path>` or `git restore` that discards unreviewed work
- `git clean -fd` on a dirty workspace
- direct push to `main` or `staging`
- force-pushing shared or reviewed branches
- rebasing or rewriting someone else's open branch
- resolving conflicts via `ours`/`theirs` strategy without content review
- deleting branches or reverting someone else's unmerged work without explicit approval

## Default Frontend Rule (Mandatory)
- For all frontend design and implementation tasks in this workspace, always follow:
  - `/Users/jeremypeng/Downloads/Workspace/TicketManagement/docs/03_Frontend_Design_Standards_Figma.md`
- Treat this file as the primary UI design standard unless the user explicitly overrides it.
- If there is a conflict between existing page styles and the standard, follow the standard for new pages and document migration impact for existing pages.

## Design/Implementation Checklist
- Reuse approved color, typography, layout, and logo rules from the standard file.
- Run a brief "brand consistency check" in each frontend PR/change note.
- Do not introduce ad-hoc visual styles that conflict with the standard.

## General Development Discipline (Mandatory)
- This applies to all development tasks in this workspace, not only KB/sync or one specific subsystem.
- Do not code by trial-and-error. Do not use the codebase or shared environments as a place to discover the design through repeated failed attempts.
- For customer-facing or operator-facing flows, `business usability` is the primary acceptance gate. `Code compiles`, `a stage returns richer fields`, `a prompt looks better`, or `a component test passes` do not count as success if the end-to-end workflow is still unavailable, degraded, regressed, or timing out.
- When the user names or implies a known-good commit/checkpoint for a customer-facing flow, freeze that commit as the baseline first. Before editing, inspect the exact diff from that baseline to the current branch in the affected files/modules and identify the first regression commit or the smallest regression diff set. Do not start a new redesign until that regression source is named concretely.
- Before writing or changing code, first analyze the task clearly enough to understand:
  `current flow`, `target behavior`, `constraints`, `data model impact`, `state transitions`, `idempotency/retry behavior when relevant`, `integration boundaries`, `verification plan`, and `main failure risks`.
- If those points are still unclear, stop and analyze further before editing.
- Before editing a customer-facing workflow, freeze one explicit business acceptance target first: a representative user question, operator action, or end-to-end scenario plus the exact expected usable outcome. If that target is not yet passing, do not expand scope into extra architecture, optimization, or intelligence work.
- Implement only after the change plan is coherent. Prefer deliberate, minimal, well-scoped changes over speculative patches.
- For any non-trivial task, decide how correctness will be verified before coding. That can include focused tests, static inspection targets, runtime probes, DB checks, or API/status validation depending on the task.
- In multi-stage systems, verification must include the final customer-visible or operator-visible output boundary. Intermediate planner, router, specialist, verifier, or adapter outputs are evidence only; they are not the acceptance result.
- When a usable baseline already exists, preserve it first. Only one complexity axis may change at a time: `retrieval`, `routing`, `prompt/stage contract`, `orchestration topology`, or `fallback/recovery behavior`. If the business gate regresses, stop and return to the last validated checkpoint before further changes.
- Do not rely on “write first, debug later” as a normal workflow. Preventing avoidable bugs up front is the expected baseline.

## AI Support Agent Principles (Mandatory)
- Treat the customer-facing support flow as `AI-driven` by default. Do not add new deterministic rule trees, special-case reply builders, or parallel hardcoded customer-answer branches when the same outcome should come from the shared support-agent pipeline.
- Hard prohibition: do not patch answer quality, retrieval quality, or routing quality by stacking query regexes, keyword branches, string-match conditionals, or one-off rewrites over user input / draft answer text unless the user explicitly asks for a deterministic rule.
- For AI support/search quality issues, the default fix order is: `knowledge metadata -> evidence policy -> retrieval/rerank strategy -> agent prompt/stage contract -> orchestration topology`. Do not jump straight to `if/else` patches over specific questions.
- If a change would make one narrow query pass by adding literal phrase checks, route-name special cases, or answer-text rewrite guards, treat that as a design smell and stop to redesign the shared pipeline instead.
- Hard prohibition: do not introduce extra agents, extra stages, broader orchestration, or “smarter” routing while the current customer-facing support path is still failing its explicit business acceptance target.
- A support-flow improvement is real only when the final customer-facing answer on the intended runtime path remains usable, timely, and non-regressed. Better intermediate drafts, richer specialist JSON, or cleaner internal traces do not qualify on their own.
- When a support question is known to have worked in a specific checkpoint, freeze that question as a mandatory regression case before changing routing, retrieval, prompt/stage contract, fallback, or orchestration. The regression case must validate the final answer on the real intended runtime path, not only internal route/stage diagnostics.
- If a support-flow change regresses a previously passing business question, stop further optimization immediately. Restore the last validated baseline behavior first, then continue with only one complexity axis changed at a time.
- Use `BangWork/docs-com` as the primary knowledge source for support answers whenever grounded documentation is available. Legacy/local fallback logic is only for infrastructure failure, retrieval unavailability, or explicit disaster-recovery paths.
- Preserve multi-turn, role-aware conversation history end to end. Do not flatten assistant turns into `user` text or downgrade conversation payloads back to `string[]`.
- Customer-facing answers must prioritize `direct answer`, `what to do now`, `minimum missing info`, and grounded citations. Avoid exposing internal reasoning labels such as `assessment`, `reasoning_summary`, or other chain-of-thought style fields in the portal UI.
- Customer-facing answer structure must follow `/Users/jeremypeng/Downloads/Workspace/TicketManagement/docs/agents/support-answer-composer.md`. Treat that file as the repository source of truth for support answer formatting across API, how-to, behavior, troubleshooting, clarification, and handoff cases.
- When changing the AI support flow, prefer tightening the shared support-agent contract over adding new legacy paths beside it.
- Mandatory execution order for support-flow work: `freeze business baseline -> add/confirm final-answer regression check -> change one layer only -> re-verify the same business baseline`. Do not continue to the next layer until the current baseline remains green.

## AI Support Agent Rebuild Constraints (Mandatory)
- The target system is an `AI-driven support engineer agent`, not a search box, not a rule tree, and not a path/regex router. Retrieval is only a subsystem inside the shared support-agent pipeline.
- The canonical architecture contract for the rebuild is `/Users/jeremypeng/Downloads/Workspace/TicketManagement/docs/20_AI_Support_Agent_Rebuild_Part_01_System_Model_And_Single_DB_Publishing.md`. When implementing later parts, do not violate that document's system model unless it is explicitly revised first.
- This workspace currently uses a single shared database. Treat `local`, `preview`, and `prod` as sharing the same DB unless proven otherwise. Any KB/sync, rebuild, reindex, or repair work must be safe under that constraint.
- Hard prohibition: do not let unfinished, failed, partial, local, or preview knowledge builds become runtime-visible to the production support flow.
- Hard prohibition: do not use row-level `is_active` as the serving source of truth for runtime retrieval. Serving visibility must be publication-based and snapshot-based, not “whatever rows are active”.
- If no explicit published serving snapshot exists for the requested knowledge space, the correct behavior is `KB unavailable`. Do not fall back to reading all active KB rows.
- Build state and serving state must remain separate. Writing documents, chunks, memory rows, embeddings, or other artifacts for a build must not by itself publish that build.
- Do not mix artifacts from different `build_version` values inside the same runtime retrieval path. Retrieval, grounding, memory lookup, and citation binding must resolve through one coherent published snapshot.
- `BangWork/docs-com` remains the canonical support knowledge source when grounded docs are available, but repository-derived knowledge is not limited to markdown pages. Later implementation must support repository-aware knowledge objects such as docs, OpenAPI operations, config surfaces, code symbols, schemas, tests, and troubleshooting patterns.
- `memory` in this repository must be treated as a retrieval abstraction layer over repository-derived knowledge, not as a direct customer-answer source and not as a replacement for grounded citations.

## OpenClaw Runtime Source Of Truth (Mandatory)
- The OpenClaw runtime used by this repository is the deployed Alibaba Cloud gateway, not the local `~/.openclaw` directory.
- Treat `.env` `OPENCLAW_*` values plus live gateway probing as the source of truth for support-agent topology.
- Do not assume agent IDs under local `~/.openclaw/openclaw.json`, `workspace-*`, or `agents/*` are the live support agents for this project. Those local files may describe other OpenClaw workspaces/teams only.
- Before changing support-agent mapping, verify the live gateway against `wss://47.250.122.37/` with the project credentials and confirm the real registered agent IDs.
- Current live cloud support/search topology on `47.250.122.37` includes:
  `search-retrieval`, `search-clarify`, `ticket-agent`, `support-router`, `support-evidence-planner`, `support-planner`, `support-evidence-selector`, `support-api-specialist`, `support-howto-specialist`, `support-behavior-specialist`, `support-troubleshooting-specialist`, `support-evidence-judge`, `support-citation-curator`, `support-citation-selector`, `support-answer-composer`.
- Current locally discoverable `ones-*` / `teammate-ones-marketplace-*` agents are Marketplace delivery roles, not evidence that the support flow already has matching `search-*` / `support-*` agents.

## KB Sync Runtime Hygiene (Mandatory)
- Treat shell-exported env, launchd env, IDE run configs, and inherited parent-process env as untrusted until compared against the repository `.env` and the intended runtime source.
- Before starting any KB worker, direct sync script, or one-off repair job, explicitly verify the effective values for critical env vars instead of assuming dotenv will win. Minimum check set:
  `GITHUB_TOKEN_READONLY`, `GITHUB_KB_BOOTSTRAP_INCLUDE_PATHS`, `GITHUB_KB_ENABLE_LOCAL_DOCS_MIRROR`, `LOCAL_DOCS_COM_PATH`, `DATABASE_URL`, internal automation/auth vars used by the task.
- If a shell-exported or service-inherited value conflicts with repository `.env`, fix or unset the inherited value first. Do not continue with a mixed runtime.
- For docs-com sync, keep `sourceSnapshot.mode = remote` unless the user explicitly asks for an approved disaster-recovery path. Do not enable local mirror as a convenience workaround.
- Before writing to the shared DB, verify the active docs-com registration shape and ensure include paths only cover intended docs-com content roots. Do not let broad repo-level patterns pollute shared KB data.
- After any runtime fix, re-verify with a live authenticated probe before re-running sync. Do not infer auth success from config presence alone.

## KB Sync Change Discipline (Mandatory)
- For KB/sync development, correctness analysis must happen before coding. Do not start by writing code and discovering the design through trial-and-error.
- Schema-first is a hard prerequisite for KB/sync, publication, promotion, release-status, cleanup, and runtime data-path changes. Before changing code or writing SQL, inspect the real schema and live state first:
  `actual columns`, `primary/unique keys`, `foreign keys`, `knowledge_space/build_version identity`, and the current rows involved in the workflow.
- Do not assume table shape, column names, or uniqueness semantics from memory, from stale SQL snippets, or from design docs alone. Design docs define the target contract; schema-first inspection defines the safe implementation surface.
- Before implementing sync logic or sync-efficiency changes, explicitly do the following:
  1. map the target workflow end-to-end
  2. identify invariants, idempotency requirements, restart/retry behavior, and shared-DB safety constraints
  3. identify likely failure points and uniqueness/conflict risks up front
  4. decide the smallest safe implementation plan
  5. decide the test and verification plan before editing
- When improving sync correctness or efficiency, prefer small, isolated changes and verify each step before moving to the next. Do not bundle multiple speculative fixes into one jump.
- Default execution order for KB/sync work:
  1. confirm current runtime and DB state
  2. analyze the full change and lock the invariants before coding
  3. implement the smallest planned change
  4. add or update a focused test that would have caught the bug before runtime
  5. run the focused test
  6. re-run the workflow and inspect live DB/status signals
  7. only then move to the next planned change
- For sync efficiency work, do not trade correctness for throughput. Any batching, concurrency, retry, idempotency, or shard-flow change must be validated against:
  `kb_sync_runs`, `kb_sync_run_shards`, `kb_sync_manifest_items`, `kb_serving_versions`, `kb_sync_checkpoints`, and live `docs-com/status`.
- Efficiency-oriented development must include pre-code review of data model assumptions, uniqueness constraints, partial-progress behavior, and re-entry behavior. If those are not clear yet, stop and analyze first instead of coding.
- When a sync run fails, capture the exact failed invariant first and fix that invariant directly. Do not paper over sync issues by adding unrelated retries, ad-hoc manual DB edits, or broad logic changes.
- Any repair that touches shared sync state must preserve idempotency and restart safety. If a write path can hit unique constraints during retries or partial reruns, treat that as a correctness bug and fix the write path before continuing.
- Do not assume a successful API response means the new full-sync pipeline actually ran. Confirm the expected run/shard/version/checkpoint rows exist in the shared DB.
