## ADDED Requirements

### Requirement: Admin Portal Must Expose AI Agent Toggle State
The management portal MUST provide an explicit control and current-state indicator for AI Agent mode (`enabled`/`disabled`).

#### Scenario: Admin views current mode
- **WHEN** an admin opens management settings
- **THEN** the UI SHALL display current AI mode state and last updated timestamp

#### Scenario: Admin toggles AI mode
- **WHEN** an admin changes AI mode from enabled to disabled (or reverse)
- **THEN** the system SHALL persist the new state
- **THEN** the system SHALL emit an audit event recording previous and new mode values

### Requirement: Disabled AI Mode Must Bypass AI-First Triage
When AI mode is disabled, ticket submission workflow MUST skip AI triage and route directly to manual R&D processing.

#### Scenario: Submit ticket while AI mode is disabled
- **WHEN** a new ticket is created and AI mode is disabled
- **THEN** no AI triage run SHALL be executed for initial routing
- **THEN** the ticket SHALL be assigned to `RND_TEAM` with `IN_PROGRESS`
- **THEN** an audit event SHALL record AI bypass reason as manual mode

### Requirement: Enabled AI Mode Must Preserve Existing AI-First Behavior
When AI mode is enabled, existing AI-first triage path MUST remain available.

#### Scenario: Submit ticket while AI mode is enabled
- **WHEN** a new ticket is created and AI mode is enabled
- **THEN** workflow SHALL execute AI triage branch per current policy
- **THEN** resulting status/assignment SHALL follow triage outcome contract
