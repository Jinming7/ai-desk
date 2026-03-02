## 1. Portal Isolation Refactor

- [ ] 1.1 Split `apps/web` route tree into customer shell and internal shell components
- [ ] 1.2 Remove all customer-facing links/actions that expose `/agent` or internal queue wording
- [ ] 1.3 Add regression test to verify customer shell route map excludes internal routes
- [ ] 1.4 Enforce unauthorized direct access behavior for `/agent` (403 or gated access page)

## 2. Post-Submit Lifecycle Completion

- [ ] 2.1 Implement centralized submit orchestration handler for `OPEN -> IN_PROGRESS -> WAITING_CUSTOMER/ESCALATED_RND`
- [ ] 2.2 Add deterministic stage outputs: status, assignee, customer message policy, audit event, SLA effect
- [ ] 2.3 Ensure customer reply on `WAITING_CUSTOMER` resumes workflow to `IN_PROGRESS`
- [ ] 2.4 Add submit success UX: confirmation + redirect to `/tickets/:id` with lifecycle context
- [ ] 2.5 Add failure-path UX when triage/orchestration fails while preserving ticket traceability

## 3. Internal Handoff Governance

- [ ] 3.1 Add reason-code payload contract for assignment/handoff events
- [ ] 3.2 Implement internal action APIs to enforce reasoned transitions and assignments
- [ ] 3.3 Surface handoff context (triage summary/confidence/evidence/reason code) in internal queue row details
- [ ] 3.4 Add safeguards to prevent customer-side APIs from mutating internal-only handoff fields

## 4. Verification and Acceptance

- [ ] 4.1 Add API integration tests for submit lifecycle happy path and escalation/fallback path
- [ ] 4.2 Add frontend smoke tests for portal isolation and post-submit lifecycle visibility
- [ ] 4.3 Update README and runbook with strict portal boundary and lifecycle sequence diagram
- [ ] 4.4 Validate CI includes migration, build, and lifecycle-related test gates
