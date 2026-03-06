## 1. Connection & Discovery

- [x] 1.1 Refactor Configuration step-1 form to require baseUrl/token/teamID before discovery actions
- [x] 1.2 Implement project discovery using `GET /project/projects` semantics with cursor pagination
- [x] 1.3 Enforce endpoint-test success criteria: HTTP success + JSON response + parseable response path
- [x] 1.4 Add clear error classification for 401 vs 403 in UI and API responses

## 2. Endpoint Configuration Contracts

- [x] 2.1 Build endpoint form groups for work item list/detail/create/update/delete using ONES issue routes
- [x] 2.2 Build endpoint form groups for comment list/create/detail/update/delete using ONES comment routes
- [x] 2.3 Implement placeholder validation for required runtime IDs (`issueID`, `commentsID`, `workflowID`)
- [x] 2.4 Add per-endpoint test runner with request preview and structured response preview

## 3. Mapping & Workflow

- [x] 3.1 Implement issue type/field/status metadata loaders from ONES OpenAPI configured endpoints
- [x] 3.2 Build status mapping table (internal status -> external status ID)
- [x] 3.3 Build workflow transition mapping (business action -> workflow ID)
- [x] 3.4 Add mapping validation rules for required target fields before publish

## 4. Customer Portal Integration

- [x] 4.1 Add support-side whitelist selector based on ONES issue types for selected project
- [x] 4.2 Update customer new-ticket form to load only whitelisted issue types
- [x] 4.3 Reject customer create requests containing non-whitelisted issue type IDs
- [x] 4.4 Wire create ticket flow to ONES create issue endpoint with mapped field payload

## 5. Config Versioning, Audit, and Release Safety

- [x] 5.1 Store configuration as versioned snapshots with actor/timestamp/audit reason
- [x] 5.2 Implement publish workflow with preflight checks (connection, required endpoints, mapping completeness)
- [x] 5.3 Add rollback entrypoint to switch to previous active configuration version
- [ ] 5.4 Add integration tests for end-to-end chain: project discovery -> whitelist -> customer create -> comment update
