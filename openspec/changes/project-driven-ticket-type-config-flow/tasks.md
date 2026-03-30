## 1. Configuration Flow Restructure

- [x] 1.1 Refactor `OnesSyncConfigPage` step-1 into unified "Setup & Project" layout (connection + auth + token + project in dependency order)
- [x] 1.2 Disable project selector until base URL, team ID, and token are validly present, with prerequisite helper messages
- [x] 1.3 Make selected project the progression gate for step-1 -> step-2 (remove endpoint test hard dependency)
- [x] 1.4 Keep endpoint test as optional diagnostics with non-blocking UX copy and status hints

## 2. Project-Scoped Issue Type Discovery

- [x] 2.1 Add backend service method to fetch project work items and derive normalized unique issue types
- [x] 2.2 Add/adjust internal API endpoint to return discovered issue types for selected project
- [x] 2.3 Add support UI list of discovered issue types with per-type exposure toggle for customer portal
- [x] 2.4 Persist exposure toggles by project + issueType and return active exposure contract to runtime APIs

## 3. Per-Issue-Type Configure Workspace

- [x] 3.1 Add issue-type configure entry from list (drawer/page) with tabs: Field Mapping, Status Mapping
- [x] 3.2 Build field mapping editor with required/optional grouping based on ONES metadata and configurable form visibility/default/options
- [x] 3.3 Add save validation to block missing required mappings with explicit field-level errors
- [x] 3.4 Persist per-type form schema mapping model in ones-sync config storage contract

## 4. Status Mapping and Presentation Contract

- [x] 4.1 Build per-issue-type status mapping editor (internal lifecycle -> customer-visible mapped status)
- [x] 4.2 Persist status mapping per project + issueType in backend config contract
- [x] 4.3 Update support/customer ticket read APIs to resolve customer-visible status via saved mapping
- [x] 4.4 Add fallback behavior when mapping missing (safe default + warning audit)

## 5. Customer Portal Runtime Integration

- [x] 5.1 Update customer ticket type source API to return only support-enabled issue types for active project
- [x] 5.2 Render dynamic customer create form from per-type field schema config
- [x] 5.3 Enforce server-side payload validation against active type schema on create/update
- [x] 5.4 Ensure successful save in configuration immediately affects customer portal create and detail/list status display

## 6. Quality, Migration, and Safety

- [x] 6.1 Add DB/config compatibility handling for existing rows and backward-compatible reads
- [ ] 6.2 Add integration tests for full flow: setup -> select project -> discover types -> enable type -> configure fields/status -> customer create
- [ ] 6.3 Add error classification coverage for auth/permission/network/parameter failures in project discovery and config save
- [ ] 6.4 Add migration/rollback notes in change docs and verify no regression for existing support portal routes
