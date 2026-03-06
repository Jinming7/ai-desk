## ADDED Requirements

### Requirement: System SHALL capture guidance-flow interaction telemetry
The system SHALL emit telemetry events for queue selection, ticket opening, action execution, and AI suggestion interactions.

#### Scenario: Queue selection event
- **WHEN** agent selects a smart queue
- **THEN** telemetry event is recorded with queue key and timestamp

#### Scenario: AI suggestion interaction event
- **WHEN** agent views or applies an AI recommendation
- **THEN** telemetry events capture view/apply action with trace id and operator id

### Requirement: System SHALL expose guidance effectiveness metrics inputs
The system MUST provide aggregatable data points for first-action latency, AI suggestion adoption rate, and SLA at-risk drain rate.

#### Scenario: First-action latency source data
- **WHEN** ticket is first opened and first handling action is executed
- **THEN** timestamps are recorded for first-action latency computation

#### Scenario: SLA queue drain data
- **WHEN** ticket leaves `SLA_AT_RISK` queue due to action
- **THEN** transition event contains prior risk bucket and new risk bucket
