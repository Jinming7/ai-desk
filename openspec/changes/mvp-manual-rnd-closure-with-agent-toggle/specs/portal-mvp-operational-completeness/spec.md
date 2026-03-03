## ADDED Requirements

### Requirement: Management Portal Must Support MVP Operational Actions
Management portal MUST provide minimum complete actions for ticket operations: create, assign/reassign, transition state, reply, and view audit trail.

#### Scenario: Management-side ticket creation
- **WHEN** an operator creates a ticket in management portal
- **THEN** the form SHALL require title, description, service category, priority, and requester identity fields
- **THEN** created ticket SHALL be visible in queue and detail views immediately

#### Scenario: Assignment and transition operations
- **WHEN** an operator assigns/reassigns or transitions a ticket
- **THEN** the system SHALL validate allowed transitions and assignee types
- **THEN** action results SHALL update queue and detail pages without status mismatch

### Requirement: Customer Portal Must Stay Mode-Compatible
Customer portal behavior MUST remain coherent regardless of AI mode state.

#### Scenario: Customer views ticket in manual mode
- **WHEN** customer opens a ticket created while AI mode is disabled
- **THEN** status, SLA, and message timeline SHALL render with the same contract as AI mode
- **THEN** no broken or empty AI-only placeholders SHALL appear

### Requirement: MVP Form And Timeline Details Must Be Complete Enough For Handling
Ticket submission and conversation experiences MUST include required context and actionability for manual teams.

#### Scenario: Submission form captures actionable context
- **WHEN** customer submits a ticket
- **THEN** form validation SHALL prevent empty/insufficient core context from being submitted silently
- **THEN** captured context SHALL be available to handlers in management portal detail view

#### Scenario: Timeline supports customer-handler loop
- **WHEN** either side posts a reply
- **THEN** timeline SHALL show sender identity, timestamp, and content in chronological handling context
- **THEN** lifecycle state changes SHALL stay aligned with communication events
