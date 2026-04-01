## ADDED Requirements

### Requirement: Status Mapping MUST Be Configurable and Versioned
The system SHALL provide status mapping between internal ticket states and ONES issue statuses from `GET /project/issueStatuses`.

#### Scenario: Build status mapping table
- **WHEN** external statuses are fetched successfully
- **THEN** system MUST render each internal status with a required dropdown mapped to an external status ID

#### Scenario: Save and audit mapping changes
- **WHEN** support publishes mapping updates
- **THEN** system MUST store versioned mapping with actor and timestamp audit metadata

### Requirement: Workflow Execution MUST Be Validated Against ONES Workflow Data
The system SHALL fetch available workflows for target issue and execute status transition using documented issue workflow action API.

#### Scenario: Validate workflow before execution
- **WHEN** user configures transition execution path
- **THEN** system MUST require both `issueID` and workflow identifier placeholders and reject unresolved templates

#### Scenario: Execute mapped transition
- **WHEN** business action requests a status change
- **THEN** system MUST resolve mapped workflow ID and call the configured transition API with action payload

### Requirement: Field Mapping MUST Drive Create and Update Payload Construction
The system SHALL transform internal fields to ONES issue payload according to mapping rules and issue field metadata.

#### Scenario: Validate required mapped fields before create
- **WHEN** customer submits ticket
- **THEN** system MUST block create if required mapped target fields are missing

#### Scenario: Use mapping in update flow
- **WHEN** support updates ticket attributes
- **THEN** system MUST build update payload using same mapping contract and log transformed result trace
