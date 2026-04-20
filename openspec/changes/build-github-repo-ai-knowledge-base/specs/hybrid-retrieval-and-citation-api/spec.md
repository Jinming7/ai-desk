## ADDED Requirements

### Requirement: Unified Retrieval API with Profiles
The system SHALL provide a single retrieval API that supports at least `search` and `agent` retrieval profiles with profile-specific defaults.

#### Scenario: Search profile applies precision defaults
- **WHEN** a request is submitted with profile `search`
- **THEN** retrieval executes with lower top-k and stricter confidence thresholds than profile `agent`

#### Scenario: Agent profile applies recall defaults
- **WHEN** a request is submitted with profile `agent`
- **THEN** retrieval executes with broader candidate expansion and higher context budget than profile `search`

### Requirement: Hybrid Retrieval Execution
The system SHALL combine vector retrieval and keyword retrieval, and MUST produce a merged ranked result set for response.

#### Scenario: Hybrid merge returns ranked candidates
- **WHEN** both vector and keyword candidate sets are available
- **THEN** the system fuses and ranks them into a single ordered list of retrieval hits

### Requirement: Source Citation in Every Hit
The system SHALL include source citation metadata for each returned hit, including repository, path, canonical URL, and commit SHA.

#### Scenario: Retrieval response contains traceable citation
- **WHEN** the API returns retrieval hits
- **THEN** each hit includes `repo`, `path`, `source_url`, and `commit_sha` fields

### Requirement: Low-Confidence Read-Through Fallback
The system SHALL trigger read-only GitHub source fetch when retrieval confidence is below threshold and MUST label fallback results explicitly.

#### Scenario: Low confidence triggers fallback fetch
- **WHEN** confidence score is below configured profile threshold
- **THEN** the system performs read-only source fetch for candidate paths and augments response context

#### Scenario: Fallback usage is explicitly returned
- **WHEN** fallback content is included in response
- **THEN** the API sets a fallback indicator and includes citations for fallback-derived snippets
