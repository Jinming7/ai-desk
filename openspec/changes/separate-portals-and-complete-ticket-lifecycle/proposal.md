## Why

Current UX violates product boundary: customer ticket portal still exposes an entry to internal management portal. Also, the workflow after ticket submission is under-specified and partially implemented, causing inconsistent behavior and operational gaps.

## What Changes

- **BREAKING**: Remove all customer-facing entry points and navigation links to internal management portal.
- Introduce strict portal isolation rules across routes, navigation, and session context.
- Define complete post-submit lifecycle from ticket creation through AI triage, customer follow-up, escalation, resolution, and closure.
- Add deterministic customer notifications and internal operational checkpoints for each lifecycle step.
- Add acceptance criteria for queue movement, assignee behavior, and SLA timer pause/resume around `WAITING_CUSTOMER`.

## Capabilities

### New Capabilities
- `portal-isolation`: Enforce hard separation between customer ticket portal and internal management portal.
- `ticket-post-submit-lifecycle`: Define and implement end-to-end behavior after customer submits a ticket.
- `internal-handoff-governance`: Define internal takeover/escalation controls and visibility for support and R&D.

### Modified Capabilities
- None.

## Impact

- Frontend impact: top-level navigation, route guards, and entry points in `apps/web`.
- Backend impact: ticket workflow orchestration, transition/assignment rules, audit events, and queue behavior in `apps/api`.
- API impact: explicit workflow endpoints and response contracts for customer and internal use.
- Operational impact: clearer support SOP and reduced accidental customer access to internal tools.
