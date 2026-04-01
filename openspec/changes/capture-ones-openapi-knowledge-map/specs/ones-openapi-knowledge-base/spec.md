## ADDED Requirements

### Requirement: Durable ONES OpenAPI Knowledge Base
The project SHALL maintain a version-controlled ONES OpenAPI knowledge base under OpenSpec so that endpoint contracts, OAuth scopes, and integration usage guidance are reusable across threads.

#### Scenario: Knowledge is available to new thread planning
- **WHEN** a contributor starts a new ONES integration change
- **THEN** the contributor SHALL be able to locate ONES API guidance in OpenSpec artifacts without relying on prior chat context

### Requirement: Domain-Oriented API Indexing
The knowledge base SHALL organize ONES APIs by functional domain (for example OAuth, Issue, Worklog, Wiki, User, Project, Resource, Webhook) and SHALL provide endpoint method/path mappings for each domain.

#### Scenario: Engineer needs issue lifecycle endpoints
- **WHEN** an engineer needs to design issue create/update/workflow/comment flows
- **THEN** the knowledge base SHALL provide a domain section listing the required ONES endpoints and their required scopes

### Requirement: Webhook Delivery and Acknowledgment Contract
The knowledge base SHALL describe ONES Webhook delivery semantics, including notification and heartbeat message types, acknowledgment protocol, retry policy, and disable/re-enable behavior.

#### Scenario: Service receives webhook notification
- **WHEN** an integration service receives an ONES webhook payload
- **THEN** the service contract guidance SHALL require returning the payload `id` as plain response body acknowledgment

#### Scenario: Delivery failure handling
- **WHEN** acknowledgments are not received by ONES within the documented retry window
- **THEN** the knowledge base SHALL specify that ONES retries (5-second timeout, up to 3 retries) and may disable delivery after prolonged acknowledgment failure, requiring manual re-enable

### Requirement: Normative Call Contract Guidance
For integration-critical endpoints, the knowledge base SHALL document required request location and shapes, including path/query parameters, request body media type, and expected response envelope conventions.

#### Scenario: Engineer prepares API client call
- **WHEN** an engineer prepares a call to a documented endpoint
- **THEN** the engineer SHALL be able to identify required parameters and media type constraints from the knowledge base before implementation

### Requirement: Ambiguity and Risk Ledger
The knowledge base SHALL explicitly record known OpenAPI contract ambiguities and SHALL include a required validation note for each ambiguity before production implementation.

#### Scenario: Spec inconsistency is discovered
- **WHEN** a field contract is inconsistent (for example required field name does not match declared property)
- **THEN** the knowledge base SHALL record the inconsistency and SHALL attach a validation action needed before implementation

### Requirement: Update Protocol for Source OpenAPI Drift
Any change that depends on ONES endpoints SHALL verify relevant contracts against the currently referenced ONES OpenAPI source and SHALL update the knowledge base when material differences are identified.

#### Scenario: ONES OpenAPI document is updated
- **WHEN** a new ONES OpenAPI version introduces endpoint/scope/contract differences used by planned work
- **THEN** the change SHALL include updates to the ONES knowledge base before implementation tasks are finalized
