## ADDED Requirements

### Requirement: Clarification Flow on Ungrounded First Retrieval
The system SHALL enter clarification mode when first retrieval does not produce a valid citation-grounded answer.

#### Scenario: First retrieval has no valid citation
- **WHEN** user submits a question and retrieval returns zero valid citations
- **THEN** the system returns a clarification question instead of a final conclusion

### Requirement: Round Counting and Escalation Threshold
The system SHALL track clarification rounds per session and MUST recommend ticket handoff after 3 rounds without grounded resolution.

#### Scenario: Clarification rounds below threshold
- **WHEN** clarification round count is 1 or 2 and no valid citation answer is found
- **THEN** the system continues asking targeted clarification questions

#### Scenario: Clarification threshold reached
- **WHEN** clarification round count reaches 3 and no valid citation answer is found
- **THEN** the system transitions session state to `TICKET_HANDOFF_RECOMMENDED` and returns CTA metadata

### Requirement: Explicit CTA Exposure in Conversation
The system SHALL provide `Create a ticket now` action metadata only after escalation threshold is reached.

#### Scenario: CTA appears after threshold
- **WHEN** session state is `TICKET_HANDOFF_RECOMMENDED`
- **THEN** response payload includes `showCreateTicketNow=true`

#### Scenario: CTA hidden before threshold
- **WHEN** session state is clarification-in-progress before round 3
- **THEN** response payload includes `showCreateTicketNow=false`
