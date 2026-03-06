## ADDED Requirements

### Requirement: Work Item Configuration MUST Be Bound to Documented ONES Endpoints
The system SHALL allow configuration and test of ONES work-item operations only using documented routes: `GET /project/issues`, `POST /project/issues`, `GET/PATCH/DELETE /project/issues/{issueID}`.

#### Scenario: Configure work-item list endpoint
- **WHEN** support configures “获取工作项列表”
- **THEN** system MUST bind it to list semantics compatible with `GET /project/issues` and cursor pagination

#### Scenario: Configure work-item detail endpoint
- **WHEN** support configures “获取工作项详情”
- **THEN** system MUST require an `issueID` placeholder and reject test if unresolved

### Requirement: Issue Type and Field Discovery MUST Use ONES Metadata APIs
The system SHALL support configuration and test for metadata routes `GET /project/issueTypes`, `GET /project/issueFields`, and `GET /project/issueStatuses`.

#### Scenario: Load issue types for selected project
- **WHEN** project is selected in configuration
- **THEN** system MUST load issue types and present selectable options for support policy setup

#### Scenario: Load issue fields for form rendering
- **WHEN** support tests issue field endpoint
- **THEN** system MUST parse fields schema and expose field keys/types for mapping UI

### Requirement: Comment Operations MUST Cover Full CRUD
The system SHALL support configuration and runtime execution for comments with ONES routes `GET/POST /project/issues/{issueID}/comments` and `GET/PATCH/DELETE /project/issues/{issueID}/comments/{commentsID}`.

#### Scenario: Configure comment update and delete
- **WHEN** support saves comment API paths
- **THEN** system MUST require both `issueID` and `commentsID` placeholders for update/delete paths

#### Scenario: Runtime comment operation parameter injection
- **WHEN** customer or support triggers comment API operation
- **THEN** system MUST inject `issueID/commentsID` from upstream business context instead of manual input
