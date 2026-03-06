# Support Portal IA + AI/SLA + ONES Sync Contract

## 1. Internal Portal IA (MVP)

- Canonical internal route: `/support`
- Legacy compatibility:
- `/agent` -> redirect `/support`
- `/agent/tickets/:id` -> redirect `/support/tickets/:id`

### Header Categories

- `Queues` -> `/support`
- `Operations` -> `/support?menu=operations`
- `Insights` -> `/support?menu=insights`
- `ONES Sync` -> `/support/admin/ones-sync`

Customer portal MUST NOT include internal route links.

## 2. Queue Console Contract

Route: `/support`

Required capabilities:

- Queue tabs: `pending`, `mine`, `all`
- Filters: status, assignee, priority, SLA risk, ticket type
- Default sort: SLA risk first, then due time
- Row actions: claim, ask customer, resolve, escalate, open detail
- Bulk actions: assign, priority update, escalate

API:

- `GET /api/v1/support/tickets`
- `POST /api/v1/internal/tickets/bulk-actions`

## 3. Ticket Detail Contract

Route: `/support/tickets/:id`

Three-pane layout:

- Timeline + public/internal communication pane
- Action rail (status transition + assignment)
- AI panel (mode/action/confidence/trace)

Status transitions:

- `Ask Customer` -> `WAITING_CUSTOMER`
- `Customer Reply` -> `IN_PROGRESS`
- `Escalate` -> `ESCALATED_RND`
- `Resolve` -> `RESOLVED`
- `Close` -> `CLOSED`

## 4. AI Governance Contract

### Action contract

- Allowed actions: `ask_user | resolve | escalate`
- Forbidden: `none`
- Invalid/missing action MUST coerce to `ask_user`
- Customer-facing reply MUST be English

### Traceability

Persist:

- `trace_id`
- `model_name`
- `decision_action`
- `confidence`
- `evidence_json`
- `fallback_applied`
- `prompt_hash`

Expose ticket snapshot fields for UI:

- `ai_mode_snapshot`
- `ai_last_trace_id`
- `ai_last_action`
- `ai_last_confidence`
- `ai_last_model`
- `ai_last_fallback_applied`

## 5. SLA Contract (MVP)

- First Response SLA: due at `created_at + 1h`
- Resolution SLA: due at `created_at + 24h`
- Pause rule: entering `WAITING_CUSTOMER` pauses resolution SLA
- Resume rule: customer reply from `WAITING_CUSTOMER` resumes
- Stop rule: resolution timer stops at `RESOLVED`

UI requirements:

- Queue shows risk band: `healthy | at_risk | breached`
- Detail shows countdown + pause reason + next action hint

## 6. Customer -> ONES Intake Contract

Flow:

1. Customer performs AI search
2. If unresolved, show ONES ticket types
3. Customer selects type and fills dynamic fields
4. Submit synchronously to ONES (system of record)
5. Persist local linkage:
- `ones_ticket_type_key`
- `ones_ticket_key`
- `ones_sync_status`
- `ones_sync_error`

Error policy:

- ONES sync failure MUST return error and no false success state

## 7. ONES Sync Admin Contract

Route: `/support/admin/ones-sync`

Capabilities:

- Configure ONES connection/auth paths
- Discover ticket types and fields
- Create/update mapping drafts
- Dry-run payload validation
- Publish active mapping
- Rollback mapping version

Security:

- Secret stored encrypted server-side
- UI returns masked secret only
- All config/mapping/mode changes audited
