## Why

The current internal portal behaves like a feature stack instead of a service management console: queue operations are weak, ticket actions are placeholders, and ticket lifecycle closure is unreliable. We need to redesign now so support can execute a real queue-first workflow and synchronize customer-created tickets to ONES as the system of record.

## What Changes

- Rename internal route and product surface from `Agent Portal` (`/agent`) to `Support Portal` (`/support`) with explicit menu categories and queue-first IA.
- Remove internal `Create Ticket` from Support Portal; ticket creation comes from customer portal via ONES-configured ticket types.
- Redesign Support Portal into two core pages:
- `Queue Console`: high-density list, queue filters, SLA-first sorting, bulk actions.
- `Ticket Detail`: full processing workspace with timeline, reply composer, escalation to R&D, status transitions, assignee and priority controls.
- Replace placeholder actions with executable lifecycle actions and required state transitions.
- Enforce non-silent processing: no `action=none`, every AI run must produce a traceable actionable outcome (`ask_user`, `resolve`, `escalate`) or deterministic fallback.
- Add AI First Line UX and governance: confidence, evidence/citations, recommendation cards, one-click apply, trace ID, audit trail, manual override.
- Productize AI Mode Selector (MVP scope recommendation: global support mode), with clear ON/OFF behavior, operator and reason audit, and visible mode tags in queue/detail.
- Build SLA operational UX for First Response and Resolution with pause/resume rules, risk bands, countdown and suggested next actions.
- Add an admin-facing ONES Sync Config page for integration setup:
- fetch ONES ticket types and per-type fields
- configure create/update API endpoints and auth settings
- define flexible field mappings between local ticket model and ONES fields
- validate mappings and support per-ticket-type mapping versioning
- Establish customer flow closed loop:
- Customer AI Search first.
- If unresolved, show ONES-configured ticket types in customer portal.
- User submits ticket.
- Ticket is created/synced to ONES and reflected in support queue.

## Capabilities

### New Capabilities
- `support-portal-queue-console`: Queue-first support workbench with categorized navigation, filters, sorting, and bulk actions.
- `support-ticket-detail-lifecycle`: Action-complete ticket processing page with timeline, replies, status transitions, assignment, and escalation.
- `ai-first-line-operations`: AI recommendation, traceability, action enforcement, and human override within support workflows.
- `ai-mode-governance`: Global AI Mode Selector with behavior contracts, audit logs, and per-ticket mode visibility.
- `sla-risk-operations`: SLA clocks, pause/resume policy, risk classification, and SLA-driven prioritization UI.
- `customer-ones-ticket-intake`: Customer unresolved flow using ONES ticket types and direct ONES ticket synchronization.
- `ones-sync-admin-config`: Admin configuration surface for ONES ticket type discovery, API integration setup, and flexible field mapping for create/update sync.

### Modified Capabilities
- None.

## Impact

- Frontend routing and navigation (`/agent` to `/support`; header/menu IA redesign).
- Support portal page architecture and shared components (queue table, ticket detail panes, action rail, AI panel, SLA widgets).
- Backend workflow/state machine for ticket transitions and action APIs (including bulk ops and escalation).
- AI orchestration contract and guardrails (no `none`, English output, trace ID persistence, audit events).
- ONES integration surface for ticket type fetch and ticket creation sync.
- ONES integration admin module for endpoint/auth configuration, mapping rules, and validation lifecycle.
- Data model and migrations for SLA fields, AI trace/audit fields, and ticket lifecycle metadata.
