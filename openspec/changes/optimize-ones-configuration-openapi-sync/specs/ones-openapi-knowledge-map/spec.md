## ADDED Requirements

### Requirement: System MUST Maintain ONES OpenAPI Knowledge Map
The system SHALL maintain a machine-readable knowledge map of ONES OpenAPI capabilities including endpoint purpose, required auth, supported issue operations, and field schema sources.

#### Scenario: Load knowledge map in configuration
- **WHEN** Configuration Catalog module is opened
- **THEN** the system MUST display available ONES capability nodes (issue types, fields, transitions, comments, webhooks)

#### Scenario: Detect schema drift
- **WHEN** ONES OpenAPI schema hash differs from last synced hash
- **THEN** the system MUST flag drift and require mapping re-validation before publish

### Requirement: Field Mapping MUST Be Schema-Aware
The system SHALL validate mapping definitions against ONES field schema from the knowledge map before allowing publish.

#### Scenario: Publish valid mapping
- **WHEN** all mapped targets exist and required fields are satisfied
- **THEN** the mapping version MUST be published successfully

#### Scenario: Reject invalid mapping
- **WHEN** a mapping references missing field key or incompatible type
- **THEN** publish MUST fail with actionable validation errors
