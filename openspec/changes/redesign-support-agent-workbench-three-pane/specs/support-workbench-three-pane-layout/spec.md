## ADDED Requirements

### Requirement: Support Portal SHALL use a three-pane workbench layout
The system SHALL render Support Portal as three coordinated panes: Smart Queues, Ticket List, and Detail & Action.

#### Scenario: Default layout load
- **WHEN** an internal support user opens `/support`
- **THEN** the page renders left queue pane, middle list pane, and right detail pane scaffold

#### Scenario: Responsive fallback
- **WHEN** viewport width is below desktop threshold
- **THEN** the layout collapses gracefully without losing queue selection or ticket context

### Requirement: Pane state SHALL remain synchronized
Queue selection in pane 1 MUST drive list content in pane 2, and ticket selection in pane 2 MUST drive detail state in pane 3.

#### Scenario: Queue to list synchronization
- **WHEN** user selects `SLA_AT_RISK` queue
- **THEN** pane 2 refreshes with only tickets matching queue logic

#### Scenario: List to detail synchronization
- **WHEN** user selects a ticket card in pane 2
- **THEN** pane 3 loads that ticket detail and action context
