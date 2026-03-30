## ADDED Requirements

### Requirement: Configuration Portal MUST Be the Single Integration Control Plane
The system SHALL provide `/support/admin/configuration` as the canonical admin surface for ONES integration and SHALL replace legacy `ONES Sync` naming in navigation and page headers.

#### Scenario: Navigate to configuration portal
- **WHEN** an internal user opens the support admin area
- **THEN** the navigation item MUST display `Configuration` and route to `/support/admin/configuration`

#### Scenario: Show current integration mode and ownership
- **WHEN** the configuration page loads
- **THEN** the page MUST display current `data_source_mode`, last updated time, and operator identity

### Requirement: Configuration Portal MUST Expose Modular Sections
The system SHALL expose at least Connection, Catalog, Mapping, Workflow, Webhook, and Operations sections in the configuration portal.

#### Scenario: View module sections
- **WHEN** an internal user enters configuration portal
- **THEN** the user MUST be able to switch among all six modules without leaving the page context

#### Scenario: Persist module-level settings
- **WHEN** a user saves settings in one module
- **THEN** unrelated module settings MUST remain unchanged

### Requirement: Configuration Changes MUST Be Audited
The system SHALL record who changed what, when, and why for all configuration updates.

#### Scenario: Save configuration with reason
- **WHEN** a user updates connection or mapping settings
- **THEN** an audit log entry MUST store actor, changed fields, before/after summary, reason, and timestamp
