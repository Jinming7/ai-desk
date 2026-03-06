## ADDED Requirements

### Requirement: System SHALL provide ONES Sync Configuration admin page
The system SHALL provide an internal admin page for ONES integration configuration at `/support/admin/ones-sync`, accessible only to authorized internal operators.

#### Scenario: Authorized admin access
- **WHEN** an authorized internal operator opens `/support/admin/ones-sync`
- **THEN** the system shows ONES sync configuration workspace with connection, ticket type, and mapping sections

#### Scenario: Unauthorized access blocked
- **WHEN** a customer or unauthorized user attempts to open `/support/admin/ones-sync`
- **THEN** the system returns forbidden response and does not expose configuration data

### Requirement: System SHALL support ONES ticket type and field discovery
The system SHALL fetch ONES ticket types and fields per type, and SHALL persist a cached catalog for mapping configuration.

#### Scenario: Refresh ticket type catalog
- **WHEN** an operator clicks `Refresh from ONES`
- **THEN** the system fetches latest ticket types and per-type fields, then updates catalog snapshot with timestamp

#### Scenario: View fields by ticket type
- **WHEN** an operator selects a ticket type in configuration UI
- **THEN** the system displays ONES fields including key, label, type, required flag, and option values if available

### Requirement: System SHALL support flexible create and update field mappings
The system SHALL allow per-ticket-type mapping definitions for `create` and `update` flows, including transforms and default/fallback policies.

#### Scenario: Configure create mapping
- **WHEN** an operator configures mapping for create flow
- **THEN** each mapping row stores source field path, target ONES field key, optional transform, and required policy

#### Scenario: Configure update mapping
- **WHEN** an operator configures mapping for update flow
- **THEN** the system stores update mapping separately from create mapping for the same ticket type

### Requirement: System SHALL validate mapping before activation
Mapping changes SHALL remain in draft until validation passes. Validation MUST include schema checks and payload dry-run preview.

#### Scenario: Validation failure blocks publish
- **WHEN** mapping has missing required target fields or transform errors
- **THEN** validation fails and mapping cannot be activated

#### Scenario: Dry-run preview success
- **WHEN** operator runs dry-run with sample ticket data
- **THEN** system renders outbound ONES payload preview and reports validation success

### Requirement: System SHALL support mapping versioning and rollback
For each ticket type and flow, the system SHALL support draft and active versions and allow rollback to a prior active version.

#### Scenario: Activate new mapping version
- **WHEN** operator publishes a validated draft mapping
- **THEN** the draft becomes active with new version number and audit entry

#### Scenario: Rollback mapping version
- **WHEN** operator executes rollback to previous active version
- **THEN** previous version is restored as active and future sync requests use restored mapping

### Requirement: ONES connection credentials SHALL be secured and auditable
The system SHALL store ONES connection secrets encrypted server-side, mask secret values in UI, and audit configuration changes.

#### Scenario: Save token securely
- **WHEN** operator updates ONES auth token
- **THEN** token is encrypted at rest, masked in subsequent reads, and never returned in plaintext to client

#### Scenario: Audit configuration change
- **WHEN** operator updates endpoint, headers, or mapping configuration
- **THEN** system creates audit record with actor, time, changed scope, and change summary
