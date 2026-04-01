## ADDED Requirements

### Requirement: SLA framework SHALL include First Response and Resolution timers
The system SHALL compute and persist SLA deadlines for first response and resolution per ticket from creation time and configured policy.

#### Scenario: SLA initialization
- **WHEN** a new ticket is created
- **THEN** first response and resolution due timestamps are initialized and available in queue and detail APIs

### Requirement: Resolution SLA SHALL support pause and resume states
Resolution SLA MUST pause while ticket status is `WAITING_CUSTOMER` and MUST resume when customer replies.

#### Scenario: Pause on waiting customer
- **WHEN** ticket transitions to `WAITING_CUSTOMER`
- **THEN** resolution SLA countdown pauses and pause reason is recorded

#### Scenario: Resume on customer reply
- **WHEN** customer replies to a paused ticket
- **THEN** ticket transitions to `IN_PROGRESS` and resolution SLA countdown resumes

### Requirement: SLA stopping rules SHALL be explicit
First Response SLA stops at first public support/AI reply. Resolution SLA stops at `RESOLVED`. `CLOSED` SHALL not restart SLA timers.

#### Scenario: First response stop
- **WHEN** first public reply is posted by AI or human support
- **THEN** first response SLA is marked achieved with actual response timestamp

#### Scenario: Resolution stop
- **WHEN** ticket transitions to `RESOLVED`
- **THEN** resolution SLA timer stops and final SLA outcome is recorded

### Requirement: Queue SHALL be SLA-risk-driven
Queue list MUST display SLA due and risk level (`healthy`, `at_risk`, `breached`) and default to risk-first ordering.

#### Scenario: Risk-first queue ordering
- **WHEN** queue is loaded
- **THEN** breached tickets are listed first, followed by at-risk and healthy tickets

#### Scenario: SLA visualization in list
- **WHEN** a support user scans queue rows
- **THEN** each row shows due time, remaining time, and risk color band

### Requirement: Ticket detail SHALL provide SLA guidance actions
Ticket Detail MUST display active countdown, pause state, and recommended next actions based on SLA risk and status.

#### Scenario: At-risk guidance
- **WHEN** ticket enters `at_risk` band
- **THEN** detail page presents recommended action chips such as `Ask Customer`, `Escalate`, or `Resolve`
