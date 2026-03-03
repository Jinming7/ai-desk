## Why

Current triage behavior can return `action=none` with a customer-facing reply, which leads to inconsistent lifecycle handling and can leave tickets in `IN_PROGRESS` without an explicit support response in the portal. This breaks user expectation and reduces trust in automated support.

## What Changes

- Enforce a strict triage response contract: if a customer-facing reply exists, ticket workflow must publish the reply to the ticket thread and move status to `WAITING_CUSTOMER`.
- Disallow silent outcomes for actionable triage: `action=none` must only be used when no customer-facing reply is needed.
- Add a policy rule to prefer `ask_user` over `none` when information is insufficient.
- Enforce English-only customer-facing AI output from triage for consistency across portal experience.
- Add observability and safeguards to detect and prevent regressions where tickets stay in `IN_PROGRESS` without AI/customer-facing output.

## Capabilities

### New Capabilities
- `triage-output-governance`: Defines deterministic triage action/reply constraints, language policy, and lifecycle transition behavior for ticket-first AI processing.

### Modified Capabilities
- None.

## Impact

- Affected backend modules: OpenClaw adapter prompt contract, triage workflow orchestration, ticket state transition logic, audit logs.
- Affected API behavior: ticket creation/triage response consistency, status transitions, AI message persistence.
- Affected UX: customer portal message timeline and status visibility become deterministic and English-only for AI responses.
- Test impact: integration coverage for none/reply combinations, language output checks, and no-silent-IN_PROGRESS assertions.
