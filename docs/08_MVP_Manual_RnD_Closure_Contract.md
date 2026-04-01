# MVP Manual R&D Closure Contract

## Scope

This MVP defines a reliable baseline workflow:
- Customer submits ticket
- R&D team handles manually
- Customer and handler communicate
- Ticket reaches resolved/closed state

AI-first triage is optional and controlled by internal setting `ai_agent_enabled`.

## Status Contract

- `OPEN`: newly created before handling starts.
- `IN_PROGRESS`: actively handled by support/R&D.
- `WAITING_CUSTOMER`: handler requested customer information, SLA active timer paused.
- `ESCALATED_RND`: escalated to R&D ownership.
- `RESOLVED`: issue handled, awaiting closure/reopen decision.
- `CLOSED`: final terminal state.

## Routing Contract At Submission

- AI mode ON:
  - Run AI-first triage path.
  - Status/assignee follows triage action policy.
- AI mode OFF:
  - Skip AI triage on initial routing.
  - Route directly to `RND_TEAM`.
  - Transition `OPEN -> IN_PROGRESS`.
  - Emit audit event `ai_bypassed_manual_mode`.

## Communication Contract

- Customer reply while ticket is `WAITING_CUSTOMER`:
  - Transition to `IN_PROGRESS`.
  - Resume handling loop.
- Handler reply while ticket is `IN_PROGRESS` or `ESCALATED_RND`:
  - Transition to `WAITING_CUSTOMER`.
  - Keep timeline as single source of truth for both portals.

## Minimum Required Ticket Submission Fields

Both customer and management submission flows should capture:
- `title`
- `description`
- `serviceCategory`
- `priority`
- requester identity (`customer.id`, `customer.name`)

Management-side recommended structured context:
- requester email
- environment (`production/staging/test/unknown`)
- reproducibility (`always/sometimes/once/unknown`)
- impact summary

## Management Portal MVP Operations

- View queue (`pending/mine/all`)
- Toggle AI mode ON/OFF
- Create ticket
- Assign/reassign ticket owner
- Transition ticket state
- Reply as handler
- Resolve/close ticket
- View status, SLA, and conversation timeline

## Customer Portal Compatibility

- Ticket form and detail view remain usable regardless of AI mode.
- Status and timeline semantics are consistent for manual and AI-assisted tickets.
- No AI-only UI dependencies for manually handled tickets.
