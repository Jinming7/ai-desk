## ADDED Requirements

### Requirement: System SHALL provide fixed smart queue categories
The system SHALL provide queue categories: `SLA_AT_RISK`, `AI_SUGGESTED`, `NEW_ASSIGNED`, `WAITING_MY_REPLY`, `MY_ALL`, and `RESOLVED`.

#### Scenario: Smart queue menu visible
- **WHEN** user opens Support Portal
- **THEN** all required smart queue items are visible in queue pane

### Requirement: Queue logic SHALL be deterministic and auditable
Each queue MUST map to explicit backend filter logic and return reproducible results.

#### Scenario: SLA at risk queue filter
- **WHEN** queue `SLA_AT_RISK` is selected
- **THEN** only tickets with SLA remaining below 2 hours are listed

#### Scenario: AI suggested queue filter
- **WHEN** queue `AI_SUGGESTED` is selected
- **THEN** only tickets with pending AI recommendation requiring human confirmation are listed

### Requirement: Queue badges SHALL show current workload counts
Each queue item SHALL display ticket count badge from backend query aggregation.

#### Scenario: Queue count updates
- **WHEN** ticket status or SLA urgency changes
- **THEN** affected queue badges update on next refresh interval or explicit refresh
