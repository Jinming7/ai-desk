## Why

Current implementation does not provide a complete customer-to-support flow: the ticket portal is mostly skeleton-level, and admin/agent portal access and responsibilities are not clearly defined. We need a production-ready baseline now so development can proceed with stable product and technical contracts.

## What Changes

- Deliver a complete customer ticket portal journey: self-serve search, guided ticket submission, request list, ticket detail, and reply loop.
- Formalize a separate internal management portal (agent/admin) with explicit access path, queue views, and operational actions.
- Standardize AI behavior into two modes: `SEARCH_MODE` (pre-ticket KB search) and `TICKET_MODE` (post-ticket triage), with non-AI-facing customer messaging.
- Enforce ticket lifecycle rules already agreed by product: `OPEN -> IN_PROGRESS -> WAITING_CUSTOMER -> RESOLVED/CLOSED`, with `ESCALATED_RND` for escalation.
- Add gap-closure requirements for API contracts, UI states, and fallback paths when OpenClaw is unavailable.

## Capabilities

### New Capabilities
- `customer-ticket-portal`: End-to-end customer support portal experience from self-serve to ticket lifecycle participation.
- `internal-agent-portal`: Internal queue and ticket operations portal with role-scoped access and escalation handling.
- `ticket-ai-orchestration`: Dual-mode AI orchestration for knowledge search and ticket triage with evidence-based decisions.

### Modified Capabilities
- None.

## Impact

- Affected frontend code: portal, requests, ticket detail, and agent dashboard pages in `apps/web`.
- Affected backend code: ticket APIs, AI orchestration module, OpenClaw integration boundaries, and status transitions in `apps/api`.
- New/updated database artifacts: knowledge retrieval foundation tables and ticket status/assignee normalization migrations.
- Impacts integration planning for ONES escalation creation (next phase), while preserving current internal escalation placeholder behavior.
