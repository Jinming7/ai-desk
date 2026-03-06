## ADDED Requirements

### Requirement: AI search MUST provide quick ticket action on unresolved queries
The system MUST display a quick ticket action when AI search cannot provide a valid answer or returns confidence below escalation threshold.

#### Scenario: Show quick ticket button on unresolved result
- **WHEN** AI search result is unresolved due to no answer or low confidence
- **THEN** the UI presents a quick ticket button with unresolved reason context

### Requirement: Quick ticket submission MUST preserve complete query context
The system MUST capture and persist search context for escalation, including user question, conversation history, retrieval attempts, and unresolved reason.

#### Scenario: Submit escalation context
- **WHEN** the user clicks quick ticket and confirms escalation
- **THEN** the system creates an escalation record containing search session id, user input, unresolved reason code, and retrieval evidence snapshot

### Requirement: Escalation request MUST be idempotent per unresolved session
The system MUST prevent duplicate escalation records for the same unresolved search session unless a prior escalation is terminally failed.

#### Scenario: Repeated quick ticket clicks
- **WHEN** the user clicks quick ticket multiple times for the same unresolved session
- **THEN** the system returns the existing active escalation record instead of creating duplicates
