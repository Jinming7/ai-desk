## ADDED Requirements

### Requirement: Project-Scoped Issue Type Discovery MUST Be Derived from Work Items
The system SHALL discover issue types for selected project using project work item list data, and SHALL normalize and deduplicate issue type results.

#### Scenario: Discover issue types
- **WHEN** admin enters issue type selection step after selecting project
- **THEN** system MUST call configured work item list endpoint for that project and derive unique issue types

### Requirement: Support Admin MUST Control Customer-Creatable Type Exposure
The system SHALL allow support admin to toggle whether each discovered issue type is exposed in customer portal as a creatable ticket type.

#### Scenario: Toggle exposure
- **WHEN** admin enables or disables an issue type
- **THEN** system MUST persist exposure state per project and issue type

#### Scenario: Customer portal type list scope
- **WHEN** customer opens new ticket form
- **THEN** only exposed issue types for configured project MUST be visible as selectable ticket types
