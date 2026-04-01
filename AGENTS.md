# AGENTS.md

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
- Before writing or changing code, first analyze the task clearly enough to understand:
  `current flow`, `target behavior`, `constraints`, `data model impact`, `state transitions`, `idempotency/retry behavior when relevant`, `integration boundaries`, `verification plan`, and `main failure risks`.
- If those points are still unclear, stop and analyze further before editing.
- Implement only after the change plan is coherent. Prefer deliberate, minimal, well-scoped changes over speculative patches.
- For any non-trivial task, decide how correctness will be verified before coding. That can include focused tests, static inspection targets, runtime probes, DB checks, or API/status validation depending on the task.
- Do not rely on “write first, debug later” as a normal workflow. Preventing avoidable bugs up front is the expected baseline.

## AI Support Agent Principles (Mandatory)
- Treat the customer-facing support flow as `AI-driven` by default. Do not add new deterministic rule trees, special-case reply builders, or parallel hardcoded customer-answer branches when the same outcome should come from the shared support-agent pipeline.
- Hard prohibition: do not patch answer quality, retrieval quality, or routing quality by stacking query regexes, keyword branches, string-match conditionals, or one-off rewrites over user input / draft answer text unless the user explicitly asks for a deterministic rule.
- For AI support/search quality issues, the default fix order is: `knowledge metadata -> evidence policy -> retrieval/rerank strategy -> agent prompt/stage contract -> orchestration topology`. Do not jump straight to `if/else` patches over specific questions.
- If a change would make one narrow query pass by adding literal phrase checks, route-name special cases, or answer-text rewrite guards, treat that as a design smell and stop to redesign the shared pipeline instead.
- Use `BangWork/docs-com` as the primary knowledge source for support answers whenever grounded documentation is available. Legacy/local fallback logic is only for infrastructure failure, retrieval unavailability, or explicit disaster-recovery paths.
- Preserve multi-turn, role-aware conversation history end to end. Do not flatten assistant turns into `user` text or downgrade conversation payloads back to `string[]`.
- Customer-facing answers must prioritize `direct answer`, `what to do now`, `minimum missing info`, and grounded citations. Avoid exposing internal reasoning labels such as `assessment`, `reasoning_summary`, or other chain-of-thought style fields in the portal UI.
- Customer-facing answer structure must follow `/Users/jeremypeng/Downloads/Workspace/TicketManagement/docs/agents/support-answer-composer.md`. Treat that file as the repository source of truth for support answer formatting across API, how-to, behavior, troubleshooting, clarification, and handoff cases.
- When changing the AI support flow, prefer tightening the shared support-agent contract over adding new legacy paths beside it.

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
