## ADDED Requirements

### Requirement: Per-Issue-Type Field Configuration MUST Be Editable
The system SHALL provide a per-issue-type configuration page where admin can configure which fields are shown in customer form and how they map to ONES payload.

#### Scenario: Open type configure
- **WHEN** admin clicks configure on one issue type
- **THEN** system MUST show field configuration scoped to that issue type

### Requirement: Required and Optional Fields MUST Be Distinguished from ONES Metadata
The system SHALL classify fields as required/optional based on ONES metadata and enforce required constraints in save validation.

#### Scenario: Required field enforcement
- **WHEN** admin tries to save form schema without required field mapping
- **THEN** save MUST be blocked with explicit missing-required-field messages

### Requirement: Customer Form MUST Render from Saved Type Schema
The system SHALL render customer ticket creation form from saved issue-type schema including field type, options, defaults, and required rules.

#### Scenario: Dynamic form rendering
- **WHEN** customer selects an issue type in portal
- **THEN** form fields MUST update to configured schema for that issue type
