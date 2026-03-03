## 1. Configuration IA and Routing

- [x] 1.1 Rename support admin nav label from `ONES Sync` to `Configuration` and route canonical page to `/support/admin/configuration`
- [x] 1.2 Implement Configuration page module tabs: Connection, Catalog, Mapping, Workflow, Webhook, Operations
- [x] 1.3 Add persistent display for `data_source_mode`, last updated operator, and updated timestamp in Configuration header

## 2. ONES OpenAPI Catalog and Knowledge Map

- [x] 2.1 Implement backend service to fetch ONES issue types and field schemas for configured project
- [x] 2.2 Add schema hash generation and drift detection endpoint for Configuration Catalog
- [x] 2.3 Build frontend Catalog UI to visualize issue type, fields, transitions, and webhook capability nodes from knowledge map

## 3. Mapping and Workflow Configuration

- [x] 3.1 Implement mapping DSL storage for create/update/transition/comment flows with versioning (draft/published)
- [x] 3.2 Implement dry-run validation API against ONES field schema and required fields
- [x] 3.3 Build Workflow mapping UI for local status to ONES transition ID mapping and validation hints
- [x] 3.4 Add publish/rollback actions with audit logs for mapping versions

## 4. ONES-Primary Ticket Lifecycle Integration

- [x] 4.1 Update customer portal ticket type and form rendering to use ONES issue type/field metadata
- [x] 4.2 Refactor ticket create API to create ONES issue first, then persist local minimal context record
- [x] 4.3 Refactor ticket action APIs (transition, comment, resolve, escalation) to execute ONES-first writes under `ones_primary`
- [x] 4.4 Implement `data_source_mode` switch behavior for `ones_primary` and `local_mirror` write/read paths

## 5. Webhook Ingestion and Reconciliation

- [x] 5.1 Add webhook endpoint with signature verification and idempotency key persistence
- [x] 5.2 Implement webhook processing pipeline for status, assignee, comment, and close events into local read model
- [x] 5.3 Add dead-letter queue storage and replay API in Configuration Operations module
- [x] 5.4 Add periodic reconcile job to compare local read model with ONES and heal drift

## 6. Observability, Reliability, and Rollout

- [x] 6.1 Add sync health metrics (success rate, latency, failure reasons) and expose in Configuration Operations UI
- [x] 6.2 Add retry/backoff and connection guardrails (pool limits, rate-limit handling) for ONES API calls
- [x] 6.3 Add integration tests for ONES-primary create/transition/webhook flows and mapping validation failures
- [x] 6.4 Prepare migration and rollback runbook for project-by-project rollout from `local_mirror` to `ones_primary`
