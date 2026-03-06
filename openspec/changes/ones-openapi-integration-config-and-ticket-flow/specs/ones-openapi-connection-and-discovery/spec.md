## ADDED Requirements

### Requirement: Configuration MUST Use ONES OpenAPI Base Connection Inputs
The system SHALL require `baseUrl`, `token`, and `teamID` as minimum connection inputs before any ONES resource discovery.

#### Scenario: Block discovery when connection inputs are incomplete
- **WHEN** user attempts to fetch projects without one of `baseUrl`, `token`, `teamID`
- **THEN** system MUST block the request and show which required input is missing

### Requirement: Project Discovery MUST Use ONES Project List API
The system SHALL fetch projects using ONES OpenAPI `GET /project/projects` with `teamID` and cursor pagination support.

#### Scenario: Fetch first page of projects
- **WHEN** user opens project selector and no cache exists
- **THEN** system MUST call `GET /project/projects` with `teamID` and load the first page

#### Scenario: Fetch next page of projects
- **WHEN** user clicks load-more after first page returns next cursor
- **THEN** system MUST call the same endpoint with returned `cursor` and append project options

### Requirement: Endpoint Test MUST Validate API Response Type
The system SHALL mark test as success only when HTTP succeeds and response is valid JSON for API usage.

#### Scenario: Reject HTML fallback page
- **WHEN** endpoint returns `200` with HTML content
- **THEN** system MUST mark test as failed and show “non-API response” error

#### Scenario: Distinguish auth and scope failures
- **WHEN** endpoint test returns `401` or `403`
- **THEN** system MUST display auth failure for `401` and scope/permission failure for `403`
