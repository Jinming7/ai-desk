## ADDED Requirements

### Requirement: Read-Only GitHub Access Enforcement
The system SHALL access the configured GitHub repository using credentials that provide read-only permissions for repository content and metadata, and MUST reject any workflow that attempts repository write operations.

#### Scenario: Read-only credential validation on startup
- **WHEN** the ingestion service starts with GitHub credentials
- **THEN** it validates required read scopes and marks the connector unavailable if write scopes are detected or required read scopes are missing

#### Scenario: Write route blocked by policy
- **WHEN** a sync workflow attempts to call a GitHub write endpoint
- **THEN** the request is blocked by policy and the workflow is failed with a compliance error

### Requirement: Initial Full Repository Snapshot
The system SHALL support first-time full synchronization that scans all eligible files in the configured repository/branch and stores a complete indexed snapshot externally.

#### Scenario: First full sync creates baseline snapshot
- **WHEN** no prior sync state exists for a repository/branch
- **THEN** the system traverses repository tree at head commit and emits indexing events for all eligible documents

#### Scenario: Full sync records snapshot marker
- **WHEN** a full sync succeeds
- **THEN** the system persists the synchronized commit SHA and completion timestamp as the baseline checkpoint

### Requirement: Incremental Change Detection
The system SHALL detect repository updates through webhook events and MUST provide polling fallback to detect missed updates.

#### Scenario: Webhook-triggered incremental sync
- **WHEN** a valid push webhook is received for a tracked branch
- **THEN** the system schedules an incremental sync using the webhook before/after commit range

#### Scenario: Polling fallback catches missed webhook
- **WHEN** no webhook is received but polling detects branch head SHA has changed
- **THEN** the system schedules an incremental sync based on the stored checkpoint and new head SHA
