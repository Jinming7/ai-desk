## ADDED Requirements

### Requirement: System SHALL expose a global AI Mode Selector for MVP
The Support Portal SHALL provide a global selector with modes `AI_ON` and `AI_OFF` that is visible in queue context and enforceable by policy.

#### Scenario: Global mode switch to AI_ON
- **WHEN** an authorized support lead switches mode to `AI_ON`
- **THEN** new ticket triage runs execute AI first-line behavior and the queue header displays `AI Mode: ON`

#### Scenario: Global mode switch to AI_OFF
- **WHEN** an authorized support lead switches mode to `AI_OFF`
- **THEN** new tickets bypass auto-reply and route directly to manual support handling

### Requirement: AI mode behavior SHALL differ by explicit policy contract
The system MUST apply the following behavior:
- `AI_ON`: AI may auto-reply, update status, and escalate on low confidence.
- `AI_OFF`: AI auto-actions are disabled; optional summary/classification assistance may be shown as non-executing insights.

#### Scenario: AI_ON low confidence path
- **WHEN** AI mode is `AI_ON` and confidence is below escalation threshold
- **THEN** the system executes escalation or ask-user path according to configured policy and records the decision reason

#### Scenario: AI_OFF triage path
- **WHEN** AI mode is `AI_OFF`
- **THEN** ticket is queued for manual support and no automated customer reply is posted

### Requirement: AI mode changes SHALL be auditable
Each mode switch SHALL capture operator, timestamp, previous mode, new mode, and optional reason in audit logs and timeline views.

#### Scenario: Mode switch audit event
- **WHEN** mode changes from `AI_ON` to `AI_OFF`
- **THEN** an audit entry is created with actor identity, change reason, and exact timestamp

### Requirement: Effective AI mode SHALL be visible at queue and ticket level
The system SHALL display effective mode tags in queue rows and ticket detail header to explain processing behavior for each ticket.

#### Scenario: Queue mode visibility
- **WHEN** a support user views queue rows
- **THEN** each row shows whether it was triaged under AI_ON or AI_OFF context

#### Scenario: Ticket mode snapshot visibility
- **WHEN** a support user opens ticket detail
- **THEN** the page shows current global mode and the mode snapshot used at last AI/manual triage
