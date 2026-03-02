## ADDED Requirements

### Requirement: Customer portal SHALL not expose internal portal entry
The system SHALL ensure customer-visible pages do not contain links, buttons, route hints, or copy text that expose internal management portal access.

#### Scenario: Customer navigation rendering
- **WHEN** a customer visits any customer portal page
- **THEN** no UI element exposes `/agent` or internal queue terminology

#### Scenario: Customer route map audit
- **WHEN** route map is generated for customer shell
- **THEN** only customer routes are present (`/`, `/requests`, `/tickets/:id`)

### Requirement: Internal portal SHALL be served through isolated shell
The system SHALL render internal management pages under an isolated internal shell with independent navigation and permissions.

#### Scenario: Internal portal entry
- **WHEN** an internal user opens `/agent`
- **THEN** the system renders internal navigation without customer actions such as `Submit New Request`
