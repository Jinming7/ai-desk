## ADDED Requirements

### Requirement: Support Portal route and navigation SHALL be queue-first
The system SHALL expose internal support operations on `/support` as the canonical route and SHALL provide a categorized header menu for queue-driven work. The system MUST redirect `/agent` to `/support` and MUST NOT expose internal portal links inside customer portal navigation.

#### Scenario: Canonical support route
- **WHEN** an authenticated internal support user visits `/support`
- **THEN** the system displays the Support Portal with categorized navigation and queue as the default view

#### Scenario: Legacy route redirect
- **WHEN** an internal user visits `/agent`
- **THEN** the system redirects to `/support` with no loss of session context

#### Scenario: Customer portal isolation
- **WHEN** a customer user navigates customer portal pages
- **THEN** the header does not include any internal support route entry

### Requirement: Queue Console SHALL provide high-density operational listing
The Queue Console SHALL render a tabbed queue workspace with at minimum `Pending Queue`, `My Tickets`, and `All Tickets`, and SHALL support list density suitable for triage throughput.

#### Scenario: Default queue view
- **WHEN** a support user opens Support Portal
- **THEN** the `Pending Queue` tab is active and ticket rows are ordered by SLA risk priority

#### Scenario: Queue tab switching
- **WHEN** a user switches between `Pending Queue`, `My Tickets`, and `All Tickets`
- **THEN** the list data is re-queried using tab-specific filters and pagination is preserved per tab

### Requirement: Queue Console SHALL support actionable filters and sorting
The Queue Console SHALL provide filters for queue, status, assignee, priority, SLA risk, product area, and ticket type. The system SHALL allow sorting by SLA due time, risk, priority, created time, and updated time, with default SLA-risk-first ordering.

#### Scenario: SLA-first default sort
- **WHEN** queue data is loaded without user-selected sort
- **THEN** records are sorted by risk level and nearest due SLA first

#### Scenario: Multi-filter application
- **WHEN** a support user applies filters `status=IN_PROGRESS`, `priority=P1`, and `product=runtime`
- **THEN** only matching tickets are listed and filter chips remain visible and removable

### Requirement: Queue Console SHALL support bulk actions for MVP
The Queue Console SHALL allow multi-select rows and SHALL support bulk assign, bulk priority update, and bulk escalate to R&D with confirmation.

#### Scenario: Bulk assign
- **WHEN** a user selects multiple tickets and executes `Bulk Assign`
- **THEN** all selected tickets are reassigned and timeline events are created per ticket

#### Scenario: Bulk escalate
- **WHEN** a user selects multiple tickets and executes `Bulk Escalate to R&D`
- **THEN** each ticket transitions to `ESCALATED_RND` and receives an escalation event with operator identity

### Requirement: Queue rows SHALL support direct entry to detail processing
Each queue row SHALL include a non-placeholder open action and row-click behavior that navigates to the Ticket Detail page.

#### Scenario: Open ticket detail from row
- **WHEN** a support user clicks row title or `Open`
- **THEN** the system navigates to `/support/tickets/{id}` and loads full ticket detail data
