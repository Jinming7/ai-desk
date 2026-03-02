## ADDED Requirements

### Requirement: Internal handoff SHALL capture reasoned ownership changes
When ownership changes between Support and R&D, the system SHALL record actor, reason code, and timestamp.

#### Scenario: Manual escalation by internal user
- **WHEN** internal user escalates a ticket to R&D
- **THEN** assignment updates to `R&D Team` and audit event includes reason code

#### Scenario: Integration-failure fallback escalation
- **WHEN** triage integration fails
- **THEN** ticket escalates to `ESCALATED_RND` with failure reason and error summary in audit

### Requirement: Internal queue SHALL surface handoff context
The internal queue SHALL display latest triage summary and evidence to support takeover decisions.

#### Scenario: Internal takeover review
- **WHEN** internal user opens a queued ticket row
- **THEN** user can inspect latest triage summary, confidence, and evidence references
