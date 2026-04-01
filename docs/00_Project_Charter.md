# AI Ticket Platform - Project Charter (MVP)

Date: 2026-03-02
Status: Ready for Development

## 1. Product Goal
Build an AI-first Ticket Management platform:
- External customer submits ticket via Ticket Portal.
- OpenClaw acts as L1 agent for analysis/KB retrieval/response.
- If unresolved, escalate to R&D (ONES integration details deferred to later phase).
- Full SLA framework (availability + claim/credit workflow).

## 2. Confirmed Decisions
- AI reply default status: `WAITING_CUSTOMER`.
- OpenClaw endpoint: `https://47.250.122.37/`.
- ONES escalation implementation details: deferred; will finalize in a later integration thread.
- SLA legal posture: availability + service credits; resolution time is internal operation metric, not legal SLA commitment.

## 3. MVP Scope (Execution)
- Ticket Portal: submit/view/reply/close.
- Agent Console: queue, ticket detail, AI trace, takeover.
- Ticket Core: state machine, audit, SLA timer.
- AI Gateway: OpenClaw RPC adapter (retries, timeout, idempotency).
- SLA: monthly uptime logic + claim workflow (incident + credit request).

## 4. Key States
External ticket lifecycle:
`NEW -> AI_REVIEWING -> WAITING_CUSTOMER | ESCALATED -> RESOLVED -> CLOSED`

## 5. Risks to Track
- OpenClaw control-ui security mode currently includes temporary insecure toggle (see security section in integration doc).
- ONES escalation mapping not finalized yet; keep schema extensible.

## 6. Delivery Milestones
- M1: Ticket Core + Portal + status machine + basic SLA timer.
- M2: OpenClaw integration + AI decision flow.
- M3: SLA claim center + analytics baseline.
- M4: ONES escalation integration.
