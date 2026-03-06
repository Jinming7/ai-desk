## ADDED Requirements

### Requirement: Detail pane SHALL show dedicated AI insight panel
The system SHALL display a highlighted AI insight panel containing root-cause analysis, related KB links, confidence, and trace id.

#### Scenario: AI insight panel load
- **WHEN** ticket detail is rendered
- **THEN** AI insight panel is visible with current suggestion context

### Requirement: AI suggestion SHALL support one-click apply
AI recommendation MUST provide one-click apply behavior to accelerate handling actions.

#### Scenario: Apply suggested reply
- **WHEN** agent clicks one-click apply on suggested reply template
- **THEN** composer is populated or action is executed according to suggestion type

### Requirement: AI application and overrides SHALL be auditable
All AI suggestion applications and manual overrides MUST create audit events with operator identity and trace linkage.

#### Scenario: Suggestion adopted
- **WHEN** agent accepts AI suggested action
- **THEN** audit event records action type, operator, timestamp, and trace id

#### Scenario: Suggestion overridden
- **WHEN** agent rejects or overrides AI suggestion
- **THEN** audit event records override reason and operator identity
