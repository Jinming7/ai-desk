# Dev Thread Kickoff Checklist

Use this as the first message in the new development thread.

## 1. Build Order (Recommended)
1. Scaffold monorepo structure (`portal-web`, `agent-web`, `ticket-core`, `ai-gateway`).
2. Implement ticket domain model + migrations.
3. Implement ticket state machine and audit log.
4. Implement OpenClaw adapter (connect + basic analyze call wrapper).
5. Wire AI decision -> ticket transitions (`WAITING_CUSTOMER` default after AI reply).
6. Add SLA timer basics.
7. Add API endpoints for portal and console.

## 1.1 Design Baseline (Mandatory)
- All frontend implementation must follow:
  - `docs/03_Frontend_Design_Standards_Figma.md`
- If any UI decision conflicts with existing pages, follow the Figma standards doc and note migration impact.

## 2. Mandatory Acceptance Criteria
- Creating a ticket triggers AI pipeline asynchronously.
- AI output can move ticket to one of: `WAITING_CUSTOMER`, `ESCALATED`, `RESOLVED`.
- Every status transition is audited.
- OpenClaw adapter errors do not break ticket creation path.
- Health endpoints exist for app services.

## 3. Data Model Minimum
- `tickets`
- `ticket_messages`
- `ticket_status_history`
- `ai_runs`
- `ai_decisions`
- `sla_timers`

## 4. API Minimum
- `POST /api/v1/portal/tickets`
- `GET /api/v1/portal/tickets/{id}`
- `POST /api/v1/portal/tickets/{id}/messages`
- `GET /api/v1/agent/tickets`
- `POST /api/v1/agent/tickets/{id}/takeover`

## 5. Non-Goals for First Dev Thread
- ONES issue creation and state sync (deferred)
- Full compensation claim UI flow
- Advanced analytics and dashboards

## 6. Suggested First Thread Prompt
"Read docs/00_Project_Charter.md and docs/01_OpenClaw_Integration_Spec.md, then implement milestone M1+M2 skeleton with migrations, API contracts, OpenClaw adapter interface, and a runnable local dev setup. Keep secrets in env only."
