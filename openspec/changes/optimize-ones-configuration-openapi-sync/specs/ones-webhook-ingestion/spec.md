## ADDED Requirements

### Requirement: System MUST Support ONES Webhook Ingestion with Idempotency
The system SHALL accept ONES webhook events for issue updates and process them with idempotency guarantees.

#### Scenario: Process unique webhook event
- **WHEN** a valid ONES webhook event is received first time
- **THEN** system MUST update local read model and mark event as processed

#### Scenario: Ignore duplicate webhook event
- **WHEN** the same webhook idempotency key is received again
- **THEN** system MUST skip duplicate business update and return success

### Requirement: Webhook Failures MUST Be Recoverable
The system SHALL persist failed webhook events into dead-letter storage and provide replay operation.

#### Scenario: Move failed event to dead-letter
- **WHEN** webhook processing throws non-transient error
- **THEN** event payload, error, retry count, and trace id MUST be saved for replay

#### Scenario: Replay dead-letter event
- **WHEN** operator triggers replay in Configuration Operations module
- **THEN** system MUST reprocess the event and update status to succeeded or failed with new diagnostics
