## ADDED Requirements

### Requirement: Agent MUST run deep retrieval after quick ticket escalation
The system MUST trigger an agent workflow for each new escalation record to execute deep retrieval against OpenClaw before deciding final resolution path.

#### Scenario: Start deep retrieval workflow
- **WHEN** an escalation record is created from quick ticket action
- **THEN** the system enqueues an agent job and transitions escalation status to `DEEP_RETRIEVING`

### Requirement: Agent MUST auto-resolve when evidence meets resolution threshold
The system MUST produce an AI resolution response when deep retrieval returns sufficient evidence and confidence at or above configured threshold.

#### Scenario: Auto-resolve with deep evidence
- **WHEN** the agent deep retrieval produces evidence satisfying resolution threshold
- **THEN** the system transitions escalation status to `RESOLVED_BY_AI` and stores the generated resolution with supporting references

### Requirement: Agent MUST create formal ticket when unresolved after deep retrieval
The system MUST create a formal external ticket when deep retrieval cannot reach resolution threshold within configured attempts or timeout.

#### Scenario: Create formal ticket after failed deep retrieval
- **WHEN** the agent exhausts deep retrieval attempts without sufficient evidence
- **THEN** the system creates a formal ticket including escalation context, retrieval evidence, and failure rationale, then transitions status to `TICKET_CREATED`

### Requirement: Agent workflow MUST record lifecycle events for observability
The system MUST emit and persist lifecycle events for each escalation transition to support auditability and operational monitoring.

#### Scenario: Persist lifecycle transitions
- **WHEN** escalation status changes during agent workflow
- **THEN** the system records event timestamp, from-status, to-status, actor type, and correlation id
