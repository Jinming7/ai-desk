## 1. Routing And Portal IA Refactor

- [x] 1.1 Rename internal portal surface from Agent Portal to Support Portal across routes, labels, and page metadata
- [x] 1.2 Implement canonical `/support` route and add permanent redirect from `/agent` to `/support`
- [x] 1.3 Redesign Support header with menu categories (`Queues`, `Operations`, `Insights`) and remove customer-visible internal links

## 2. Queue Console Rebuild

- [x] 2.1 Build queue-first layout with tabs (`Pending Queue`, `My Tickets`, `All Tickets`) and SLA-first default sort
- [x] 2.2 Implement filter bar (status, assignee, priority, SLA risk, product area, ticket type) with server-side query parameters
- [x] 2.3 Implement queue table row navigation to ticket detail and remove all placeholder-only actions
- [x] 2.4 Add bulk actions (assign, priority update, escalate to R&D) with confirmation and result feedback

## 3. Ticket Detail Lifecycle Closure

- [x] 3.1 Rebuild `/support/tickets/:id` into timeline + action rail + AI/context panel layout
- [x] 3.2 Implement deterministic action APIs for `Ask Customer`, `Resume`, `Escalate to R&D`, `Resolve`, and `Close`
- [x] 3.3 Persist complete timeline events for status, assignment, priority, escalation, and AI/manual action application
- [x] 3.4 Add internal note and public reply handling with status-coupled transitions

## 4. AI First-Line Contract Hardening

- [x] 4.1 Enforce AI action enum to `ask_user | resolve | escalate` and forbid `none` at backend contract level
- [x] 4.2 Implement fallback coercion path to `ask_user` with deterministic reply and `fallback_applied` flag when model output is invalid
- [x] 4.3 Enforce English-only customer-facing AI replies before posting messages
- [x] 4.4 Persist traceability fields (`trace_id`, model, confidence, evidence refs, decision action, raw payload hash)
- [x] 4.5 Add AI recommendation card UI with one-click apply and manual override reason capture

## 5. AI Mode Selector Productization

- [x] 5.1 Replace toggle button with global `AI Mode Selector` (`AI_ON`/`AI_OFF`) in Support Portal controls
- [x] 5.2 Implement AI mode behavior contracts for triage execution (auto-action on ON, manual routing on OFF)
- [x] 5.3 Add mode audit logging with actor, timestamp, old/new mode, and optional reason
- [x] 5.4 Display effective mode badge in queue rows and ticket detail header

## 6. SLA Risk Operations

- [x] 6.1 Implement First Response and Resolution SLA timers with policy-configurable due timestamps
- [x] 6.2 Implement pause/resume logic for `WAITING_CUSTOMER` and customer reply transitions
- [x] 6.3 Add SLA risk computation (`healthy`, `at_risk`, `breached`) and queue ordering by risk then due time
- [x] 6.4 Build ticket detail SLA widgets (countdown, pause reason, and suggested next action chips)

## 7. Customer Portal ONES Ticket Intake

- [x] 7.1 Implement unresolved-search transition to ONES ticket type selector in customer portal
- [x] 7.2 Build schema-driven ticket type form renderer and required-field validation from ONES config
- [x] 7.3 Implement synchronous ONES ticket creation on submit and persist `ones_ticket_key` + sync status
- [x] 7.4 Add robust failure UX for ONES sync errors with retry guidance and no false success state

## 8. Data, Testing, And Rollout

- [x] 8.1 Add migrations for SLA, AI trace/audit, mode snapshot, and ONES linkage fields
- [ ] 8.2 Add integration tests for customer unresolved->ONES submit, queue SLA ordering, and detail lifecycle transitions
- [ ] 8.3 Add AI contract tests validating no-`none` behavior and English output enforcement
- [ ] 8.4 Add redirect and permission tests for `/agent` -> `/support` and customer/internal route isolation
- [x] 8.5 Update docs with IA, lifecycle state machine, SLA policy, AI governance, and ONES integration contract

## 9. ONES Sync Admin Configuration

- [x] 9.1 Build `/support/admin/ones-sync` page with sections for connection, ticket type catalog, and mapping profiles
- [x] 9.2 Implement backend APIs for ONES connection profile CRUD and secure secret storage (masked reads, encrypted at rest)
- [x] 9.3 Implement ticket type and per-type field discovery endpoint with cached snapshot and manual refresh
- [x] 9.4 Implement mapping model for create/update flows per ticket type (source, target, transform, required policy)
- [x] 9.5 Implement mapping validator and dry-run payload preview using sample ticket context
- [x] 9.6 Implement draft->active publish flow with versioning and rollback to previous active mapping
- [x] 9.7 Add audit logs for connection and mapping changes (actor, scope, timestamp, summary)
- [ ] 9.8 Add integration tests for mapping validation, activation gating, rollback, and secure credential handling
