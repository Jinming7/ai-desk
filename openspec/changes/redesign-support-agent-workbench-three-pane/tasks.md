## 1. Three-Pane Shell Foundation

- [x] 1.1 Implement new `/support` workbench shell with persistent three-pane layout containers
- [x] 1.2 Add responsive behavior rules for desktop/tablet/mobile pane collapse without losing selection state
- [x] 1.3 Replace legacy support page composition with new shell behind feature flag

## 2. Smart Queue Navigation

- [x] 2.1 Implement left pane smart queue menu with fixed categories and priority styling for SLA-at-risk
- [x] 2.2 Implement backend queue derivation logic for `SLA_AT_RISK`, `AI_SUGGESTED`, `NEW_ASSIGNED`, `WAITING_MY_REPLY`, `MY_ALL`, `RESOLVED`
- [x] 2.3 Add queue badge count API and periodic refresh behavior
- [x] 2.4 Add queue selection telemetry event instrumentation

## 3. Ticket Card List Experience

- [x] 3.1 Replace table rows with card list items in middle pane
- [x] 3.2 Render card line 1 with customer and title emphasis
- [x] 3.3 Render card line 2 with AI summary and fallback text when summary is missing
- [x] 3.4 Render card line 3 with ticket id, assignee, status, and SLA urgency pill/progress
- [x] 3.5 Implement default list sorting by SLA urgency and recent updates

## 4. Detail & Action Workspace

- [x] 4.1 Rebuild right pane detail view with core header, timeline, and action rail
- [x] 4.2 Keep full lifecycle actions executable in-pane (assign, ask customer, escalate, resolve, close)
- [x] 4.3 Add reply composer for customer-facing messages and internal note composer separation
- [x] 4.4 Ensure detail pane updates list card state after action completion without full page reload

## 5. AI Insight Panel And Adoption Flow

- [x] 5.1 Build dedicated AI insight panel module in detail pane with root-cause summary and confidence
- [x] 5.2 Display KB references with clickable links in AI insight panel
- [x] 5.3 Add one-click apply for AI suggestion template/action
- [x] 5.4 Add manual override action with required reason capture
- [x] 5.5 Persist and display trace id for AI suggestion events

## 6. API And Data Contract Enhancements

- [x] 6.1 Extend support queue API payload for smart queue state, AI summary fields, and SLA visualization fields
- [x] 6.2 Add backend mapping for AI suggested queue eligibility and pending-confirmation state
- [x] 6.3 Add or update data fields needed for queue categorization timestamps (newly assigned, waiting my reply)
- [x] 6.4 Ensure API contract remains backward compatible during migration window

## 7. Guidance UX Metrics

- [x] 7.1 Emit telemetry events for queue selection, card open, action execution, and response send
- [x] 7.2 Emit telemetry events for AI suggestion viewed, applied, and overridden
- [x] 7.3 Add metrics aggregation hooks for first-action latency, AI adoption rate, and SLA-at-risk drain rate

## 8. QA, Docs, And Rollout

- [x] 8.1 Add frontend tests for pane synchronization (queue -> list -> detail)
- [x] 8.2 Add integration tests for smart queue filtering and SLA-at-risk behavior
- [x] 8.3 Add integration tests for AI suggestion apply/override audit events
- [x] 8.4 Update product/engineering docs with three-pane IA and guidance-first interaction principles
- [x] 8.5 Run brand consistency check against `docs/03_Frontend_Design_Standards_Figma.md` and record result
