## ADDED Requirements

### Requirement: Ticket Draft Creation from Conversation Context
The system SHALL build a ticket draft from original user question plus clarification transcript when user clicks `Create a ticket now`.

#### Scenario: Draft payload built from chat context
- **WHEN** user triggers ticket handoff action in recommended state
- **THEN** system aggregates question, transcript, and retrieval traces into a draft-generation input

### Requirement: Ticket Type Inference from Configured Catalog
The system SHALL infer ticket type using backend-configured ticket type catalog and MUST return candidate confidence.

#### Scenario: Ticket type inferred successfully
- **WHEN** configured ticket types are available for target project/scope
- **THEN** draft response contains inferred `ticketTypeKey` and `ticketTypeConfidence`

#### Scenario: Inference uncertain
- **WHEN** no candidate exceeds configured confidence threshold
- **THEN** draft response includes fallback candidate list and requires user selection

### Requirement: Field Prefill from Configured Schema
The system SHALL prefill ticket form fields based on configured field schema and extracted conversation evidence.

#### Scenario: Required fields prefilled and editable
- **WHEN** extraction finds values for required configured fields
- **THEN** draft response returns prefilled values and marks them editable before submit

#### Scenario: Missing required fields identified
- **WHEN** one or more required fields cannot be inferred
- **THEN** draft response includes missing field list and blocks submit until user completes values

### Requirement: Ticket Submission with Context Provenance
The system SHALL submit final ticket using edited draft and MUST attach conversation provenance metadata for traceability.

#### Scenario: User edits and submits draft
- **WHEN** user modifies draft and clicks submit
- **THEN** system creates ticket and records provenance fields including session id and transcript digest
