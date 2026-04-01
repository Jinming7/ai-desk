## ADDED Requirements

### Requirement: Submit ticket SHALL trigger deterministic lifecycle orchestration
The system SHALL execute a defined orchestration immediately after ticket creation, including triage, assignment, and first response policy.

#### Scenario: Standard triage path
- **WHEN** customer submits a ticket and triage returns `resolve` or `ask_user`
- **THEN** status transitions to `WAITING_CUSTOMER` with a customer-visible support response

#### Scenario: Escalation path
- **WHEN** triage returns `escalate`
- **THEN** status transitions to `ESCALATED_RND` and assignee becomes `R&D Team`

### Requirement: Post-submit stages SHALL define visible and internal outputs
Each stage SHALL define required outputs: status, assignee, customer message policy, audit log event, and SLA timer behavior.

#### Scenario: Waiting customer stage
- **WHEN** ticket enters `WAITING_CUSTOMER`
- **THEN** SLA active handling timer is paused and an audit event is stored with transition reason

#### Scenario: Customer reply stage
- **WHEN** customer replies while status is `WAITING_CUSTOMER`
- **THEN** ticket returns to `IN_PROGRESS` and handling timer resumes

### Requirement: Submit success UX SHALL confirm ticket progression
The customer UI SHALL provide immediate post-submit confirmation and entry into ticket detail where first triage outcome is visible via status and messages.

#### Scenario: Submit success redirect
- **WHEN** ticket submission succeeds
- **THEN** user is redirected to `/tickets/:id` and sees current status and thread
