## Why

The current implementation over-focuses on AI-first handling and still misses critical MVP operations needed by support and R&D teams for reliable day-to-day ticket execution. We need a controllable baseline workflow first: customer submits ticket, R&D handles manually, both sides communicate, then resolution/closure.

## What Changes

- Add an admin-portal AI Agent toggle (global and visible state) to enable/disable AI-first triage.
- Define deterministic routing when AI is disabled: newly created tickets go directly to R&D manual queue instead of AI-first processing.
- Expand admin portal operational functionality for MVP handling (create/edit/assign/transition/reply/resolve/close with audit visibility).
- Add customer-portal compatibility rules so customer experience remains coherent regardless of AI toggle state.
- Fill key product/UX gaps for MVP by specifying required form fields, status transitions, queue semantics, and communication expectations for both portals.

## Capabilities

### New Capabilities
- `manual-rnd-ticket-closure-loop`: Defines the baseline ticket lifecycle from customer submission to R&D manual handling, customer communication, resolution, and closure.
- `admin-portal-ai-agent-toggle`: Defines admin-side AI enable/disable controls and routing behavior changes when AI is off.
- `portal-mvp-operational-completeness`: Defines minimum required management portal operations and customer portal compatibility behaviors for MVP.

### Modified Capabilities
- None.

## Impact

- Backend modules: workflow orchestration, ticket routing logic, state machine transitions, assignment defaults, audit events.
- API surface: ticket creation behavior, admin configuration endpoint(s), queue filtering, portal data contracts.
- Frontend: admin portal settings + operational pages/forms; customer portal status/messaging compatibility and submission form completion.
- Ops/governance: runbook updates for AI toggle operation and fallback/manual mode playbook.
