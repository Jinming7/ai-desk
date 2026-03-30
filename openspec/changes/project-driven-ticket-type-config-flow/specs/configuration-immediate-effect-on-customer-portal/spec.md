## ADDED Requirements

### Requirement: Configuration Save MUST Take Immediate Runtime Effect
The system SHALL apply saved exposure, form schema, and status mapping immediately to customer portal runtime behavior.

#### Scenario: Save then create
- **WHEN** admin saves issue type exposure and field schema
- **THEN** customer portal MUST immediately show the new creatable type and configured fields without additional publish step

### Requirement: Runtime Validation MUST Use Active Configuration
The system SHALL validate customer create/update actions against active saved configuration for selected issue type.

#### Scenario: Reject invalid payload by config
- **WHEN** customer submits form missing configured required field
- **THEN** API MUST reject request with field-level validation errors derived from active config
