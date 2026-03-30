## Context

The current internal page behaves as a mixed demo surface: queue, create form, and partial action buttons are co-located, which blocks support teams from operating tickets at scale. It does not satisfy queue-first service management patterns used by Jira Service Management/ServiceNow/Zendesk, and critical lifecycle actions do not reliably complete end-to-end.

Business and product constraints for this change:
- Internal portal must be renamed and reachable as `Support Portal` on `/support`.
- Support Portal must not include internal ticket creation; customer ticket intake is sourced from ONES ticket types and synced to ONES.
- AI is first-line when enabled, but manual R&D path must remain fully operable when AI is disabled.
- SLA must be operational (first response + resolution), visible, sortable, and actionable.
- AI outputs must be traceable, reviewable, and never silently no-op.

Stakeholders:
- Support agent (queue owner), support lead (mode and policy owner), R&D assignee (internal escalation), customer requester.

## Goals / Non-Goals

**Goals:**
- Deliver a queue-first, action-complete internal support console with two primary pages:
- Queue Console (triage + prioritization + bulk actions)
- Ticket Detail (handling + communication + escalation + closure)
- Enforce strict lifecycle closure behavior: every visible action mutates state and is auditable.
- Make AI-first line trustworthy with enforced action contract, English reply policy, and traceability.
- Implement customer unresolved flow from AI search to ONES ticket type selection and ticket creation sync.
- Make SLA the default operating axis in both list and detail views.

**Non-Goals:**
- Full ITSM suite (problem/change/release management) is out of scope.
- Full knowledge authoring workflow (KB editor approval) is out of scope; only references and draft hooks are in scope.
- Multi-tenant role model redesign is out of scope; existing auth model is reused with route and permission adjustments.

## Decisions

### 1) Portal IA and Route Contract
Decision:
- Replace `/agent` with `/support` as canonical internal route.
- Introduce explicit support navigation categories:
- `Queues` (Pending Queue, My Tickets, All Tickets)
- `Operations` (Escalations, SLA Risk)
- `Insights` (AI performance, queue throughput)
- Customer portal has no internal entry links.

Rationale:
- Removes customer/internal surface leakage and aligns with queue-first operating mode.

Alternatives considered:
- Keep `/agent` and only rename labels: rejected because route semantics and access policy remain confusing.
- Keep single-page mixed layout: rejected due to low action density and weak process closure.

### 2) Two-page Processing Model (Queue Console + Ticket Detail)
Decision:
- Queue Console is a dense list with server-side filters/sorting/grouping and bulk actions.
- Ticket Detail is the single processing workspace with timeline, public/internal notes, action rail, and AI panel.

Rationale:
- Matches high-frequency path: pick ticket -> decide -> act -> verify SLA.
- Prevents placeholder actions by centralizing all state transitions in detail action APIs.

Alternatives considered:
- Inline full detail inside list row only: rejected for poor readability and weak audit/history visibility.
- Modal-based detail only: rejected due to limited space for timeline and AI evidence.

### 3) Lifecycle State Machine and Action Completeness
Decision:
- External ticket statuses (MVP): `NEW`, `IN_PROGRESS`, `WAITING_CUSTOMER`, `ESCALATED_RND`, `RESOLVED`, `CLOSED`.
- Every support action maps to one deterministic transition:
- `Ask Customer` -> `WAITING_CUSTOMER`
- `Resume` (customer replied) -> `IN_PROGRESS`
- `Escalate to R&D` -> `ESCALATED_RND` (+ internal ticket linkage)
- `Resolve` -> `RESOLVED`
- `Close` -> `CLOSED`
- No UI action remains placeholder; each must return updated ticket payload and appended timeline event.

Rationale:
- Ensures no silent workflow holes and supports SLA pause/resume logic.

Alternatives considered:
- Free-form status edits: rejected for audit and SLA integrity risks.

### 4) AI First Line Execution Contract
Decision:
- AI action enum is constrained to `ask_user | resolve | escalate`; `none` is forbidden at API contract level.
- If model output is missing/invalid action, backend coerces to `ask_user` with fallback English reply and marks `fallback_applied=true`.
- AI reply content must be English-only for customer-facing messages.
- Each AI run stores trace fields: `trace_id`, `model`, `prompt_hash`, `confidence`, `evidence_refs`, `decision_action`, `raw_response`.

Rationale:
- Eliminates silent in-progress stagnation and enables operator trust and debugging.

Alternatives considered:
- Allow `none` for uncertainty: rejected because it creates blocked tickets and hidden failure.

### 5) AI Mode Selector Productization
Decision:
- MVP scope uses **global mode** (`AI_ON`/`AI_OFF`) controlled by support leads.
- Queue and detail both display effective mode badge; detail also shows mode snapshot at last triage.
- Mode switch requires optional reason, actor identity, and timestamp stored in audit events.
- Behavior contract:
- `AI_ON`: AI may auto-reply and update status; low confidence auto-escalates or asks user.
- `AI_OFF`: AI triage execution disabled; optional summary/classification still available as manual assist.

Rationale:
- Global scope minimizes ambiguity and is fastest path to operational control.

Alternatives considered:
- Per-queue mode in MVP: rejected due to complexity in explainability and run-time policy checks.
- Per-ticket mode only: rejected because it fails to provide operational guardrail at scale.

### 6) SLA Operational Design
Decision:
- SLA timers:
- First Response SLA starts on `created_at`, stops on first public agent/AI reply.
- Resolution SLA starts on `created_at`, pauses in `WAITING_CUSTOMER`, resumes on customer reply, stops on `RESOLVED` (close policy separate).
- Queue default sort: `sla_risk desc`, then `resolution_due_at asc`, then `priority desc`, then `updated_at asc`.
- SLA risk bands:
- `healthy` (green)
- `at_risk` (amber, within threshold)
- `breached` (red)
- Detail page shows countdown, paused reason, and recommended next step action chips.

Rationale:
- Moves team operation from FIFO to SLA-risk-first.

Alternatives considered:
- Stop SLA on `CLOSED`: rejected for slower resolution accountability.

### 7) ONES Ticket Intake Integration
Decision:
- Customer unresolved flow calls ONES-backed ticket type API and renders available request types.
- Submission creates ticket in local platform and synchronizes to ONES with `ones_ticket_key` + sync status fields.
- If ONES creation fails, customer sees retriable failure state; ticket is not considered submitted until ONES sync success.

Rationale:
- ONES remains system of record and removes duplicate form ownership.

Alternatives considered:
- Local-first create then async sync: rejected for reconciliation complexity in MVP.

### 8) ONES Sync Admin Configuration Page
Decision:
- Add internal admin page at `/support/admin/ones-sync` for integration configuration and validation.
- Configuration scope:
- connection/auth profile (base URL, token/header strategy, timeout, retries)
- ticket type discovery job (manual refresh + cached snapshot)
- per-ticket-type field catalog (`type`, `required`, `enum/options`, `editable`, `system/custom`)
- mapping profiles for `create` and `update` flows
- Mapping model:
- source: local field path (`ticket.title`, `ticket.description`, `customer.id`, `meta.*`)
- target: ONES field key
- transform: optional function (`concat`, `enumMap`, `dateFormat`, `constant`, `fallback`)
- required policy: `hard_fail` or `default_value`
- Validation model:
- schema validation before save
- dry-run payload preview for selected ticket type
- API connectivity check and permission check
- versioned mapping publish (draft -> active) with rollback to previous active version

Rationale:
- ONES integration cannot stay hardcoded if ticket types and fields evolve.
- Product operations need self-service control to avoid code deploy for every field change.

Alternatives considered:
- Static code mapping in environment variables: rejected due to low maintainability and no per-type flexibility.
- One global mapping for all types: rejected because ONES request types often have divergent required fields and workflows.

## Risks / Trade-offs

- [Risk] ONES API latency or outage delays customer submission confirmation -> Mitigation: synchronous retry envelope + clear user error + observability alerts.
- [Risk] AI service instability causes response lag -> Mitigation: strict timeout, fallback `ask_user`, and immediate human queue visibility.
- [Risk] Route migration from `/agent` may break bookmarks -> Mitigation: permanent redirect `/agent` -> `/support` with deprecation notice.
- [Risk] SLA rules misunderstood by agents -> Mitigation: inline policy hints and timeline events indicating pause/resume triggers.
- [Risk] Bulk actions can cause accidental mass updates -> Mitigation: confirmation modal with affected count and undo window for safe fields.
- [Risk] Misconfigured mapping breaks ticket sync -> Mitigation: draft/active versioning, dry-run payload preview, and pre-publish validation checks.
- [Risk] Sensitive credentials exposed in UI logs -> Mitigation: store tokens encrypted server-side, mask values in UI, and block client-side raw secret access.

## Migration Plan

1. Introduce new support routes/components while keeping legacy route redirect.
2. Migrate header/nav IA to support categories and remove create-ticket entry from internal portal.
3. Deploy lifecycle action APIs and enforce non-placeholder behavior.
4. Deploy AI contract hardening (`none` forbidden, English output, trace persistence).
5. Deploy SLA field/migration updates and risk sorting query.
6. Integrate ONES ticket-type fetch and submit sync on customer unresolved flow.
7. Deliver ONES Sync Admin configuration page with mapping CRUD, validation, and version activation.
8. Run smoke tests:
- customer unresolved -> select ONES type -> submit -> ONES key visible
- support queue sorting by SLA risk
- detail actions transition states and append timeline
- AI run always returns actionable decision
- ONES mapping draft can be validated and promoted to active without redeploy.

Rollback strategy:
- Feature-flag support portal navigation and AI contract hardening.
- Rollback to legacy route and disable ONES sync entry if integration incidents occur.

## Open Questions

- Final ONES ticket type schema and field mapping (including required custom fields) still depends on integration payload confirmation.
- Multi-environment ONES profiles (staging/prod) can be added later; MVP starts with single active profile.
- Whether `CLOSED` should be auto-transitioned from `RESOLVED` after timeout in MVP or remain manual.
- Exact confidence thresholds for auto-escalate vs ask-user in AI_ON mode require operational tuning after first production data.
