## ADDED Requirements

### Requirement: Detail pane SHALL provide full handling context
Detail pane SHALL include ticket header context, communication timeline, and action rail in one handling surface.

#### Scenario: Detail pane content
- **WHEN** agent opens a ticket card
- **THEN** pane 3 shows ticket core info, timeline history, and executable actions

### Requirement: Action rail SHALL support complete ticket handling lifecycle
Action rail MUST expose assign, status transition, escalation, resolve, and close operations with immediate state refresh.

#### Scenario: Execute lifecycle action
- **WHEN** agent triggers `Escalate to R&D`
- **THEN** ticket state and assignee update and timeline reflects escalation event

### Requirement: Reply workflow SHALL support public response and internal note separation
The detail workspace MUST separate customer-facing reply flow from internal-note flow.

#### Scenario: Public reply send
- **WHEN** agent sends public reply
- **THEN** customer-visible timeline entry is created and related status workflow applies

#### Scenario: Internal note add
- **WHEN** agent adds internal note
- **THEN** note is stored in internal handling history without customer exposure
