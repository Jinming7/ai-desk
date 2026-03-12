## ADDED Requirements

### Requirement: Per-Issue-Type Status Mapping MUST Be Configurable
The system SHALL allow admin to configure status mapping for each issue type from internal lifecycle states to external/customer-facing status semantics.

#### Scenario: Configure mapping
- **WHEN** admin opens status mapping for an issue type
- **THEN** system MUST load available statuses and allow mapping edits per internal state

### Requirement: Customer Status Display MUST Follow Saved Mapping
The system SHALL display customer-visible ticket status using saved mapping contract for that ticket's issue type.

#### Scenario: Render mapped status
- **WHEN** customer views ticket list or detail
- **THEN** displayed status label MUST reflect configured mapped status for issue type
