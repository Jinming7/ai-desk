## ADDED Requirements

### Requirement: Customer unresolved flow SHALL offer ONES-configured ticket types
When AI self-service search fails to provide effective resolution, the customer portal SHALL show request types fetched from ONES configuration.

#### Scenario: Show ticket types after unresolved search
- **WHEN** customer indicates search result did not solve the issue
- **THEN** portal displays selectable ONES ticket types with title, description, and required fields

#### Scenario: ONES type fetch failure
- **WHEN** ONES ticket type API is unavailable
- **THEN** the portal shows retriable error and does not present stale ticket type options

### Requirement: Ticket submission SHALL synchronize to ONES as system of record
Customer-created tickets MUST be created through a synchronized flow that writes to ONES and stores ONES ticket identity in local records.

#### Scenario: Successful ONES sync on submit
- **WHEN** customer submits a valid request type form
- **THEN** system creates ticket in ONES, stores `ones_ticket_key`, and returns confirmation with synced status

#### Scenario: Sync failure prevents false submission success
- **WHEN** local create succeeds but ONES create fails
- **THEN** submission is treated as failed, customer sees actionable retry guidance, and no final submitted ticket confirmation is shown

### Requirement: Customer and support views SHALL share a consistent external ticket identity
The system SHALL expose customer-facing ticket ID and linked ONES ticket key in customer timeline and support detail to ensure cross-system traceability.

#### Scenario: Cross-system identity visibility
- **WHEN** support opens ticket detail for a customer-submitted ticket
- **THEN** detail header includes local ticket ID and ONES ticket key with sync status

### Requirement: Ticket type form contract SHALL be schema-driven
Customer portal MUST render fields dynamically from ONES ticket type definition, including required field validation and type-safe submission payload.

#### Scenario: Required field validation
- **WHEN** customer omits a required field from selected ONES ticket type
- **THEN** form blocks submission and highlights missing required field with inline error message
