## Context

The product needs a stable MVP support loop before deepening AI automation. Current capabilities already include ticket lifecycle and AI triage, but operational completeness is still uneven in the admin portal, and workflow behavior is not explicitly governed for an AI-off mode.

The immediate requirement is to guarantee a complete manual support path:
Customer submits ticket -> R&D team manually handles -> customer/agent communication -> resolved/closed.

At the same time, AI should remain optional through an explicit admin control, not a hidden environment-only switch. Customer portal behavior must stay compatible and predictable regardless of AI mode.

Stakeholders: external customers, support/R&D operators, and product operations.

## Goals / Non-Goals

**Goals:**
- Introduce an explicit admin-portal AI Agent toggle with clear on/off state.
- Define deterministic ticket routing when AI is OFF (direct to R&D queue, no AI-first triage).
- Ensure end-to-end manual R&D closure loop is fully operable from management portal.
- Define a minimum complete ticket form and processing interactions for management and customer portals.
- Keep customer-facing status, messaging, and SLA display consistent across AI ON/OFF modes.

**Non-Goals:**
- Building advanced skill orchestration or deep autonomous multi-step AI actions.
- Replacing existing data platform or auth stack.
- Implementing full enterprise workflow customization in this change.
- Integrating ONES issue creation escalation details beyond existing placeholders.

## Decisions

### 1) AI Mode as runtime configuration persisted in system settings
Decision: Add a persisted system setting (`ai_agent_enabled`) exposed through admin API and admin portal settings panel.

Rationale: MVP operations need explicit control at runtime without redeploying. UI-level visibility prevents confusion around current mode.

Alternatives considered:
- Env var only: rejected (not operable for support leads in production).
- Per-ticket toggle only: rejected (adds complexity before baseline governance is stable).

### 2) Workflow routing split at ticket creation
Decision: Evaluate `ai_agent_enabled` at ticket submission workflow entry:
- ON: current AI-first triage path.
- OFF: skip AI triage, assign `RND_TEAM`, set status to `IN_PROGRESS`, add audit event `ai_bypassed_manual_mode`.

Rationale: Single routing decision at entry keeps behavior deterministic and easy to audit.

Alternatives considered:
- Try AI then fallback to R&D when OFF: invalid by product requirement.
- Keep status `OPEN` when OFF: rejected because manual team ownership should be explicit immediately.

### 3) Management portal MVP operation set
Decision: Define a required operation baseline:
- Create ticket (internal/manual)
- View queue (pending/mine/all + AI mode indicator)
- Assign/reassign (Support/R&D)
- Transition states (IN_PROGRESS/WAITING_CUSTOMER/RESOLVED/CLOSED/ESCALATED_RND)
- Reply to customer and internal notes
- View audit timeline

Rationale: These are the minimum controls for a real human handling loop.

Alternatives considered:
- Keep read-only queue with limited actions: rejected (not an operational MVP).

### 4) Customer portal compatibility contract
Decision: Keep customer interactions stable regardless of AI mode:
- Same submission form contract and validation.
- Same status semantics and message timeline.
- If AI is OFF, first response may come from human R&D/support, but no broken UI assumptions.

Rationale: AI mode is an internal operational policy, not a customer workflow fork.

Alternatives considered:
- Separate customer flows by mode: rejected (adds UX/logic divergence prematurely).

### 5) Product completeness-first form design
Decision: Expand required fields in management-side create form and normalize to API contract with strict validation.

Minimum fields:
- title, description, serviceCategory, priority, requester (id/name/email), environment, reproducibility, impact summary.

Rationale: Missing structured info is the largest contributor to handling delays in manual loop.

Alternatives considered:
- Keep minimal title/description: rejected for manual R&D efficiency.

## Risks / Trade-offs

- [Operators forget AI mode state and misinterpret queue behavior] -> Mitigation: persistent UI mode badge + change audit event.
- [Routing logic regression for AI ON path] -> Mitigation: add integration tests for both mode branches and unchanged escalate behavior.
- [Manual mode increases first response time] -> Mitigation: queue defaults to R&D ownership immediately and require SLA visibility in admin queue.
- [Scope creep from "complete portal" requirement] -> Mitigation: lock MVP operation baseline and defer advanced admin tooling to next change.

## Migration Plan

1. Add system setting storage and migration default (`ai_agent_enabled=true`).
2. Add admin API endpoints for reading/updating AI mode.
3. Update submission workflow routing for AI ON/OFF branches.
4. Implement admin portal settings panel and mode indicator.
5. Implement/complete management operation surfaces (create, assign, transition, reply, audit).
6. Update customer portal compatibility handling for mode-independent states/messages.
7. Add integration/E2E tests for both routing branches and manual loop completion.
8. Deploy to staging, validate with synthetic tickets in both modes, then deploy production.

Rollback strategy:
- Revert code and reset setting default to previous behavior (`true`).
- Since settings are additive and default-preserving, rollback is low risk.

## Open Questions

- Should AI toggle be global-only in MVP, or also allow project-level override?
- Should "internal notes" be a separate message type in MVP or deferred?
- Should manual mode default assignment be `RND_TEAM` always, or map by service category?
