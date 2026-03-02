## 1. Portal Isolation Refactor

- [x] 1.1 Split `apps/web` route tree into customer shell and internal shell components
- [x] 1.2 Remove all customer-facing links/actions that expose `/agent` or internal queue wording
- [x] 1.3 Add regression test to verify customer shell route map excludes internal routes
- [x] 1.4 Enforce unauthorized direct access behavior for `/agent` (403 or gated access page)

## 2. Post-Submit Lifecycle Completion

- [x] 2.1 Implement centralized submit orchestration handler for `OPEN -> IN_PROGRESS -> WAITING_CUSTOMER/ESCALATED_RND`
- [x] 2.2 Add deterministic stage outputs: status, assignee, customer message policy, audit event, SLA effect
- [x] 2.3 Ensure customer reply on `WAITING_CUSTOMER` resumes workflow to `IN_PROGRESS`
- [x] 2.4 Add submit success UX: confirmation + redirect to `/tickets/:id` with lifecycle context
- [x] 2.5 Add failure-path UX when triage/orchestration fails while preserving ticket traceability

## 3. Internal Handoff Governance

- [x] 3.1 Add reason-code payload contract for assignment/handoff events
- [x] 3.2 Implement internal action APIs to enforce reasoned transitions and assignments
- [x] 3.3 Surface handoff context (triage summary/confidence/evidence/reason code) in internal queue row details
- [x] 3.4 Add safeguards to prevent customer-side APIs from mutating internal-only handoff fields

## 4. Verification and Acceptance

- [x] 4.1 Add API integration tests for submit lifecycle happy path and escalation/fallback path
- [x] 4.2 Add frontend smoke tests for portal isolation and post-submit lifecycle visibility
- [x] 4.3 Update README and runbook with strict portal boundary and lifecycle sequence diagram
- [x] 4.4 Validate CI includes migration, build, and lifecycle-related test gates
