## ADDED Requirements

### Requirement: Setup and Project Selection MUST Be a Unified Primary Stage
The system SHALL provide a single primary configuration stage that captures base URL, auth configuration, token, team ID, and project selection in one flow.

#### Scenario: Project control placement
- **WHEN** support admin opens configuration step 1
- **THEN** project selector MUST appear after auth/token inputs and MUST depend on those inputs

#### Scenario: Project selector gating
- **WHEN** base URL, token, or team ID is missing
- **THEN** project selector MUST be disabled and UI MUST show clear prerequisite guidance

### Requirement: Project Selection MUST Be Connectivity Proof for Progression
The system SHALL treat successful project list retrieval and project selection as the required condition to continue to next step.

#### Scenario: Can proceed after selecting project
- **WHEN** admin selects a project from fetched list
- **THEN** step progression MUST be enabled without requiring endpoint-by-endpoint testing

#### Scenario: Friendly failure on project discovery
- **WHEN** project discovery request fails
- **THEN** system MUST present user-friendly error text with actionable cause categories (auth, permission, parameter, network)
