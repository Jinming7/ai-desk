## ADDED Requirements

### Requirement: Ticket Detail SHALL be the primary processing workspace
The system SHALL provide `/support/tickets/{id}` as the full handling page with three logical regions: conversation timeline, action rail, and AI/context panel.

#### Scenario: Ticket detail layout
- **WHEN** a support user opens a ticket detail page
- **THEN** the page shows timeline history, public reply editor, internal note editor, and actionable controls for assignee, status, priority, escalation, and resolution

### Requirement: Ticket actions SHALL execute deterministic lifecycle transitions
All visible actions in Ticket Detail SHALL trigger persisted transitions and timeline events; placeholder actions are not allowed.

#### Scenario: Ask customer transition
- **WHEN** a support user sends a clarification reply using `Ask Customer`
- **THEN** the ticket transitions to `WAITING_CUSTOMER`, a public message is recorded, and SLA pause reason is updated

#### Scenario: Resume after customer reply
- **WHEN** a customer posts a new reply on a ticket in `WAITING_CUSTOMER`
- **THEN** the ticket transitions to `IN_PROGRESS` and SLA resolution clock resumes

#### Scenario: Escalate to R&D
- **WHEN** a support user executes `Escalate to R&D`
- **THEN** the ticket transitions to `ESCALATED_RND`, an internal escalation record is created, and linked internal ticket metadata is attached

#### Scenario: Resolve and close
- **WHEN** a support user resolves the issue
- **THEN** the ticket transitions to `RESOLVED` with resolution summary and can subsequently transition to `CLOSED`

### Requirement: Ticket timeline SHALL be complete and auditable
The timeline SHALL include customer messages, support replies, AI suggestions and applied actions, state transitions, assignment changes, and escalation events in chronological order.

#### Scenario: Timeline records support action
- **WHEN** a support user changes priority from `P3` to `P1`
- **THEN** a timeline event captures previous value, new value, actor, and timestamp

#### Scenario: Timeline includes AI events
- **WHEN** AI proposes or applies an action
- **THEN** a timeline event includes trace ID, confidence, selected action, and operator override flag if applicable
