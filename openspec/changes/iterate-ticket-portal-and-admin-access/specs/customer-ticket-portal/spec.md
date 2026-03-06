## ADDED Requirements

### Requirement: Customer portal SHALL provide search-first self-service
The system SHALL provide a knowledge search input as the primary action on the customer portal landing page and SHALL return customer-safe results from verified public knowledge only.

#### Scenario: Search returns relevant guidance
- **WHEN** a customer submits a query with at least 2 characters
- **THEN** the system returns a readable answer and at least one citation when matching public knowledge exists

#### Scenario: Search has no confident result
- **WHEN** the system finds no verified public knowledge for the query
- **THEN** the system returns a fallback answer instructing the customer to submit a ticket

### Requirement: Customer portal SHALL support seamless fallback to ticket creation
The system SHALL allow customers to submit a ticket directly from the search experience without losing their entered context.

#### Scenario: Submit after unsuccessful self-serve
- **WHEN** a customer clicks submit ticket from search results
- **THEN** the system opens ticket submission with title or description prefilled from the query context

### Requirement: Customer portal SHALL support request tracking and customer reply loop
The system SHALL provide a request list and ticket detail view where customers can monitor status and post replies.

#### Scenario: View own requests
- **WHEN** a customer opens the requests page
- **THEN** the system shows only tickets associated with that customer identity

#### Scenario: Reply after support response
- **WHEN** a customer sends a reply on a ticket in `WAITING_CUSTOMER`
- **THEN** the ticket transitions to `IN_PROGRESS`
