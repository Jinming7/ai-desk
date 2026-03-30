## ADDED Requirements

### Requirement: Customer-Facing Reply Must Be Persisted And Transition Workflow
The system MUST treat any non-empty AI triage reply as a customer-facing response and SHALL persist it to the ticket message timeline as an agent-generated message. After persisting such a reply, the system MUST transition the ticket to `WAITING_CUSTOMER` when the transition is valid.

#### Scenario: Reply exists with ask_user action
- **WHEN** triage returns `action=ask_user` and `reply` is non-empty
- **THEN** the system SHALL create an AGENT message with `is_ai_generated=true`
- **THEN** the system SHALL transition ticket status to `WAITING_CUSTOMER`

#### Scenario: Reply exists with none action
- **WHEN** triage returns `action=none` and `reply` is non-empty
- **THEN** the system SHALL still create an AGENT message with the reply
- **THEN** the system SHALL transition ticket status to `WAITING_CUSTOMER`
- **THEN** the system SHALL record an audit event indicating reply-based lifecycle progression

### Requirement: None Action Shall Mean No Customer-Facing Output
`action=none` MUST represent a true no-op outcome for customer communication. If `reply` is empty, the system SHALL keep the ticket in active processing state (subject to existing transition rules) and SHALL emit an auditable no-action event.

#### Scenario: None with empty reply
- **WHEN** triage returns `action=none` and `reply` is empty
- **THEN** the system SHALL NOT create a customer-facing AGENT message
- **THEN** the system SHALL emit `ai_triage_no_action` audit record with evidence/confidence

### Requirement: Triage Customer Output Must Be English
Customer-facing triage output text MUST be English for consistency across portal interactions.

#### Scenario: Placeholder-content ticket receives clarification response
- **WHEN** a low-information ticket (e.g., numeric placeholder content) is triaged
- **THEN** the returned reply text SHALL be in English asking for actionable details
- **THEN** the persisted ticket message SHALL match the English reply

### Requirement: Escalation Path Must Remain Deterministic
Escalation behavior SHALL remain unchanged by reply-governance hardening.

#### Scenario: Escalation action
- **WHEN** triage returns `action=escalate`
- **THEN** the system SHALL transition to `ESCALATED_RND` when valid
- **THEN** the system SHALL assign `RND_TEAM`
- **THEN** the system SHALL NOT post a customer-facing clarification message in the escalation branch by default
