## ADDED Requirements

### Requirement: Internal management portal SHALL be separately accessible
The system SHALL expose the internal management portal through a distinct route and SHALL not merge customer and internal workflow pages in the same navigation context.

#### Scenario: Access agent portal route
- **WHEN** an internal user opens `/agent`
- **THEN** the system renders agent queue views and actions for internal processing

### Requirement: Internal queue SHALL prioritize active and escalated work
The system SHALL provide a pending queue that surfaces `IN_PROGRESS` and `ESCALATED_RND` tickets in descending updated time order.

#### Scenario: Load pending queue
- **WHEN** an internal user opens the pending queue
- **THEN** the queue includes only tickets in `IN_PROGRESS` or `ESCALATED_RND`

### Requirement: Internal portal SHALL display triage context for manual takeover
The system SHALL expose AI triage summary, confidence, and evidence metadata to internal users.

#### Scenario: Review triage evidence in queue
- **WHEN** an internal user inspects a queued ticket
- **THEN** the system displays triage reasoning summary and evidence references if available
