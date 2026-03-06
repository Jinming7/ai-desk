## Context

The current implementation mixes customer and internal operations concerns in one visible navigation model. This causes product boundary leaks, including customer discoverability of internal routes. In parallel, post-submit workflow is incomplete: several transitions, customer-facing messages, and support handoff events are not consistently enforced by contract.

This change is a corrective architecture/specification pass to lock down boundaries and define a deterministic workflow after `Submit Ticket`.

## Goals / Non-Goals

**Goals:**
- Enforce complete separation between customer portal and internal management portal.
- Define a complete ticket post-submit process with explicit state transitions and owner responsibilities.
- Define user-visible and internal-visible events for each stage so behavior is testable.
- Prevent future regressions via route policy, API contract checks, and acceptance tests.

**Non-Goals:**
- Replacing current monorepo with physically separate frontend apps in this change.
- Implementing ONES external escalation sync in this change.
- Changing SLA commercial policy terms.

## Decisions

### Decision 1: Route-level hard isolation with role-aware shells
- Decision: Keep single codebase but split route trees and nav shells:
  - Customer shell: only `/`, `/requests`, `/tickets/:id`
  - Internal shell: `/agent/**`
- Rationale: achieves immediate hard separation with minimal migration risk.
- Alternatives:
  - Separate deployable apps now: stronger isolation but higher immediate complexity.
  - Keep shared nav with conditional links: rejected due to repeated leakage risk.

### Decision 2: No customer-discoverable internal entry
- Decision: customer UI SHALL not render links, buttons, or text leading to internal portal.
- Rationale: product/security boundary and UX correctness.
- Alternatives:
  - Hide with CSS/feature flag only: rejected as fragile and prone to accidental exposure.

### Decision 3: Post-submit workflow contract as finite-state lifecycle
- Decision: after submit, system executes fixed phases:
  1. Ticket created (`OPEN`)
  2. AI/Support triage (`IN_PROGRESS`)
  3. Customer follow-up waiting (`WAITING_CUSTOMER`) or escalation (`ESCALATED_RND`)
  4. Resolution (`RESOLVED`) and closure (`CLOSED`)
- Rationale: deterministic and auditable workflow.
- Alternatives:
  - ad-hoc status updates per handler: rejected for inconsistency.

### Decision 4: Stage-level event obligations
- Decision: each phase emits required artifacts:
  - customer message policy
  - internal audit event
  - assignment result
  - SLA timer effect
- Rationale: makes behavior inspectable and testable.
- Alternatives:
  - only status updates: rejected because insufficient observability.

### Decision 5: Escalation and fallback governance
- Decision: escalation may be triggered by triage decision or integration failure; both must carry reason codes.
- Rationale: prevents silent failures and supports internal accountability.
- Alternatives:
  - escalate without reason: rejected.

## Risks / Trade-offs

- [Risk] Single codebase still allows accidental cross-imports of components → Mitigation: enforce route-shell lint rules and review checklist.
- [Risk] Stricter lifecycle may expose hidden edge cases in legacy tickets → Mitigation: include legacy status mapping and fallback transitions.
- [Risk] Additional event requirements increase implementation effort → Mitigation: standardize event helper utilities and payload schema.

## Migration Plan

1. Remove customer-facing links/entry points to internal routes.
2. Split navigation/layout into customer shell vs internal shell.
3. Implement post-submit workflow handler and state transition guards.
4. Add required audit/event payloads for every stage.
5. Add regression tests (customer cannot discover internal portal; submit-flow happy/edge paths).
6. Rollback: restore previous web bundle and API image if regressions occur; preserve forward-compatible DB changes.

## Open Questions

- Should direct URL access to `/agent` from non-internal context return `403` or a neutral login page?
- Should `WAITING_CUSTOMER` auto-remind and auto-close policies be in this change or next SLA change?
- Should escalation reason codes be fixed enum in DB now or remain flexible JSON in MVP?
