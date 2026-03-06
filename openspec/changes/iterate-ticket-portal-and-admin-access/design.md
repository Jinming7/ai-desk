## Context

The repository already contains `apps/web` and `apps/api`, with early implementations of ticket pages, status transitions, and OpenClaw integration. However, customer portal flows are incomplete (search and submit are not fully connected to operational outcomes), and internal portal access is not documented as a product-level contract. The team also requires strict behavior rules: customer-facing communication must present as support team responses, while AI remains internal orchestration.

Primary stakeholders are customer support operations, R&D escalation owners, and product engineering implementing the MVP.

## Goals / Non-Goals

**Goals:**
- Define a complete customer-facing ticket portal flow: search-first self-serve, then structured submission, then request tracking and replies.
- Define internal portal access and required queue behavior for support/agent operations.
- Define AI orchestration behavior for `SEARCH_MODE` and `TICKET_MODE` as deterministic system behavior with fallback rules.
- Keep status semantics aligned with current agreed lifecycle: `OPEN`, `IN_PROGRESS`, `WAITING_CUSTOMER`, `ESCALATED_RND`, `RESOLVED`, `CLOSED`.

**Non-Goals:**
- ONES ticket creation integration for escalation (deferred to next change).
- SLA policy engine completion beyond current status-aware timing placeholders.
- Full RBAC/SSO enterprise authentication rollout.

## Decisions

### Decision 1: Separate customer and internal portal by route boundary first
- Decision: Keep one web app for now, but enforce explicit route boundary:
  - Customer portal: `/`, `/requests`, `/tickets/:id`
  - Internal portal: `/agent`
- Rationale: fastest iteration with minimal repo churn while preserving clear UX and domain separation.
- Alternatives considered:
  - Split into separate frontend apps now (`apps/customer-portal`, `apps/agent-console`): cleaner long-term, but slows immediate iteration and deployment.
  - Keep mixed navigation with no explicit boundaries: rejected due to confusion and product requirement drift.

### Decision 2: Search-first flow is mandatory before ticket submission
- Decision: customer portal SHALL expose KB search as first action and SHALL allow immediate fallback to ticket submission.
- Rationale: aligns with cost and responsiveness goals; mirrors Jira Service Management self-serve pattern.
- Alternatives considered:
  - Always submit ticket first: rejected due to avoidable ticket volume.
  - Force search completion before submit: rejected to avoid blocking urgent users.

### Decision 3: AI internalization rule
- Decision: AI outputs are internally generated but customer-visible author is always `Support Team`; no UI string should indicate AI handling.
- Rationale: matches product requirement for phase-1 customer experience and trust posture.
- Alternatives considered:
  - Expose AI badge in customer UI: rejected by product policy.

### Decision 4: Triage action mapping and state effects
- Decision: map triage actions to state changes:
  - `resolve` -> support reply + `WAITING_CUSTOMER`
  - `ask_user` -> support reply + `WAITING_CUSTOMER`
  - `escalate` -> `ESCALATED_RND` + assignee `R&D Team`
  - `none` -> no reply; remain `IN_PROGRESS` for manual handling
- Rationale: keeps status transitions simple while preserving escalation clarity.
- Alternatives considered:
  - dedicated `AI_RESOLVED` state: rejected by current requirements.

### Decision 5: Knowledge foundation as unified store with metadata filtering
- Decision: use one knowledge table/index with domain metadata (`public_kb`, `support_runbook`, `engineering_doc`, `case_memory`) and mode-specific filters.
- Rationale: easy operations and consistent retrieval strategy.
- Alternatives considered:
  - separate physical stores per mode: stronger isolation, but higher complexity now.

## Risks / Trade-offs

- [Risk] Search relevance may be weak with simple FTS ranking in early stage -> Mitigation: define retrieval quality metrics and move to embedding-based ranking in next iteration.
- [Risk] Single-app route separation can drift without policy checks -> Mitigation: add navigation guard tests and PR checklist item for portal boundary.
- [Risk] OpenClaw instability can interrupt triage path -> Mitigation: fallback to internal escalation queue and log triage error reason.
- [Risk] Hidden AI may reduce transparency in regulated accounts -> Mitigation: preserve full audit logs internally and add tenant-level transparency policy in later phase.

## Migration Plan

1. Apply database migrations for knowledge documents and status/assignee backfill.
2. Deploy API changes for search and triage endpoints.
3. Deploy web changes for search-first customer experience and internal route access clarity.
4. Validate with smoke tests:
   - customer: search -> submit -> WAITING_CUSTOMER
   - internal: access `/agent` queue and view triaged tickets
5. Rollback strategy:
   - rollback web deployment first if UI regressions happen
   - revert API deployment to previous image; keep migrations backward compatible by preserving old endpoint alias

## Open Questions

- Should internal portal route `/agent` be guarded by a temporary passcode in MVP before full auth lands?
- Should `none` action auto-create an internal note explaining why no customer reply was sent?
- What minimum citation format is required for future external compliance exports?
