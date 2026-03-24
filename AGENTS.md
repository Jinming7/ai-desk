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

## AI Support Agent Principles (Mandatory)
- Treat the customer-facing support flow as `AI-driven` by default. Do not add new deterministic rule trees, special-case reply builders, or parallel hardcoded customer-answer branches when the same outcome should come from the shared support-agent pipeline.
- Do not patch answer quality or routing gaps by stacking query regexes, keyword branches, or one-off conditional rewrites in application code unless the user explicitly asks for a deterministic rule. Fix the shared agent prompts, stage contracts, evidence selection, or orchestration policy first.
- Use `BangWork/docs-com` as the primary knowledge source for support answers whenever grounded documentation is available. Legacy/local fallback logic is only for infrastructure failure, retrieval unavailability, or explicit disaster-recovery paths.
- Preserve multi-turn, role-aware conversation history end to end. Do not flatten assistant turns into `user` text or downgrade conversation payloads back to `string[]`.
- Customer-facing answers must prioritize `direct answer`, `what to do now`, `minimum missing info`, and grounded citations. Avoid exposing internal reasoning labels such as `assessment`, `reasoning_summary`, or other chain-of-thought style fields in the portal UI.
- When changing the AI support flow, prefer tightening the shared support-agent contract over adding new legacy paths beside it.

## OpenClaw Runtime Source Of Truth (Mandatory)
- The OpenClaw runtime used by this repository is the deployed Alibaba Cloud gateway, not the local `~/.openclaw` directory.
- Treat `.env` `OPENCLAW_*` values plus live gateway probing as the source of truth for support-agent topology.
- Do not assume agent IDs under local `~/.openclaw/openclaw.json`, `workspace-*`, or `agents/*` are the live support agents for this project. Those local files may describe other OpenClaw workspaces/teams only.
- Before changing support-agent mapping, verify the live gateway against `wss://47.250.122.37/` with the project credentials and confirm the real registered agent IDs.
- Current live cloud support/search topology on `47.250.122.37` includes:
  `search-retrieval`, `search-clarify`, `ticket-agent`, `support-router`, `support-evidence-planner`, `support-planner`, `support-evidence-selector`, `support-api-specialist`, `support-howto-specialist`, `support-behavior-specialist`, `support-troubleshooting-specialist`, `support-evidence-judge`, `support-citation-curator`, `support-citation-selector`, `support-answer-composer`.
- Current locally discoverable `ones-*` / `teammate-ones-marketplace-*` agents are Marketplace delivery roles, not evidence that the support flow already has matching `search-*` / `support-*` agents.
