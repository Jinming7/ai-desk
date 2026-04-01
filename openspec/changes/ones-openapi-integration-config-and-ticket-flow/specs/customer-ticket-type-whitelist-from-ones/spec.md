## ADDED Requirements

### Requirement: Customer Creatable Ticket Types MUST Be Controlled by Support Whitelist
The system SHALL restrict customer portal ticket creation types to the intersection of ONES issue types and support-selected whitelist.

#### Scenario: Render customer ticket type options
- **WHEN** customer opens new-ticket form
- **THEN** system MUST show only whitelisted issue types from the selected ONES project

#### Scenario: Prevent non-whitelisted type submission
- **WHEN** request payload contains type not in current whitelist
- **THEN** API MUST reject creation with validation error

### Requirement: Support MUST Configure Whitelist from ONES Issue Types
The system SHALL provide support portal capability to pick allowed customer ticket types from `GET /project/issueTypes` result set.

#### Scenario: Refresh issue type source list
- **WHEN** support clicks refresh in configuration
- **THEN** system MUST fetch latest issue types for selected project and update selectable whitelist candidates

#### Scenario: Keep whitelist stable on source drift
- **WHEN** ONES issue type source changes and mapped type is missing
- **THEN** system MUST mark configuration drift and require support to re-confirm whitelist before publish
