## ADDED Requirements

### Requirement: Customer Ticket Creation MUST Be ONES-Backed
The system SHALL fetch customer-creatable ticket types from configured ONES project issue types and SHALL create ticket in ONES first.

#### Scenario: Render ticket types in customer portal
- **WHEN** customer opens ticket creation entry after AI search miss
- **THEN** ticket type options MUST come from ONES issue type catalog for the configured project

#### Scenario: Create ticket through ONES
- **WHEN** customer submits ticket form
- **THEN** system MUST call ONES create issue API first and persist local record only after successful ONES response

### Requirement: Lifecycle Transitions MUST Be Mapped to ONES Workflow
The system SHALL execute local lifecycle actions using configured ONES transition mapping.

#### Scenario: Move ticket to waiting customer
- **WHEN** support performs `ask_customer` action
- **THEN** system MUST call mapped ONES transition and reflect resulting state in local view

#### Scenario: Resolve ticket
- **WHEN** support performs `resolve` action
- **THEN** system MUST call mapped ONES transition and update SLA stop state based on successful ONES result

### Requirement: Data Source Mode MUST Be Enforced
The system SHALL enforce read/write behavior according to configured mode (`ones_primary` or `local_mirror`).

#### Scenario: ones_primary mode write path
- **WHEN** mode is `ones_primary`
- **THEN** ticket write operations MUST fail fast if ONES call fails and MUST NOT silently commit local business state

#### Scenario: local_mirror fallback mode
- **WHEN** mode is `local_mirror`
- **THEN** local update MAY proceed with sync pending status and retry job creation
