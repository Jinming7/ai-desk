## ADDED Requirements

### Requirement: Manual R&D Closure Loop Must Be End-to-End Operable
The system MUST support a complete manual lifecycle from customer submission through R&D handling, customer communication, resolution, and closure without requiring AI triage.

#### Scenario: Manual R&D path from submission to closure
- **WHEN** a customer submits a ticket while manual handling mode is active
- **THEN** the ticket SHALL be assigned to `RND_TEAM` and enter `IN_PROGRESS`
- **THEN** R&D SHALL be able to reply, request clarification, resolve, and close the ticket through management portal actions

### Requirement: Manual Path Must Preserve Customer Communication Continuity
Customer communication MUST remain bi-directional and visible in a single timeline during manual handling.

#### Scenario: R&D asks customer for more information
- **WHEN** R&D sends a clarification reply on an `IN_PROGRESS` ticket
- **THEN** the customer SHALL see the reply in the portal timeline
- **THEN** the ticket SHALL transition to `WAITING_CUSTOMER`

#### Scenario: Customer responds after waiting state
- **WHEN** customer replies to a `WAITING_CUSTOMER` ticket
- **THEN** the ticket SHALL transition back to `IN_PROGRESS`
- **THEN** the ticket SHALL return to the assigned manual queue owner

### Requirement: Manual Resolution And Closure Must Be Explicitly Audited
The system MUST log auditable lifecycle transitions for manual resolution and closure operations.

#### Scenario: R&D resolves and closes
- **WHEN** R&D marks a ticket as `RESOLVED` and then `CLOSED`
- **THEN** transition audit logs SHALL include actor, from_status, to_status, and timestamp
- **THEN** customer portal SHALL reflect the final resolved/closed state consistently
