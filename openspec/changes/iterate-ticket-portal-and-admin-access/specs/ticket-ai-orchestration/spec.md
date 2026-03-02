## ADDED Requirements

### Requirement: AI orchestration SHALL enforce dual-mode behavior
The system SHALL implement `SEARCH_MODE` for pre-ticket self-serve and `TICKET_MODE` for post-ticket triage with different data and action permissions.

#### Scenario: SEARCH_MODE data scope
- **WHEN** AI processes a customer search query
- **THEN** AI uses only `public_kb` documents with `visibility=customer` and `quality=verified`

#### Scenario: TICKET_MODE data scope
- **WHEN** AI triages an existing ticket
- **THEN** AI may use internal knowledge and tools according to policy and return a structured action decision

### Requirement: Triage decisions SHALL map to deterministic workflow outcomes
The system SHALL support triage actions `resolve`, `ask_user`, `escalate`, and `none` with fixed status/assignment outcomes.

#### Scenario: Resolve or ask-user
- **WHEN** triage action is `resolve` or `ask_user`
- **THEN** the system posts a support-team reply and sets ticket status to `WAITING_CUSTOMER`

#### Scenario: Escalation to R&D
- **WHEN** triage action is `escalate`
- **THEN** the system sets ticket status to `ESCALATED_RND` and assigns `R&D Team`

### Requirement: Customer-facing messaging SHALL not expose AI identity
The system SHALL present all AI-generated customer-visible replies as messages from `Support Team`.

#### Scenario: Customer reads triage-generated reply
- **WHEN** a triage-generated response is displayed in customer ticket detail
- **THEN** author identity appears as `Support Team` with no AI badge or wording
