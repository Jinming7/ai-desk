## ADDED Requirements

### Requirement: Answers SHALL be presented in an actionable structure
The system SHALL present retrieval answers in a fixed, user-friendly order so users can execute next steps immediately.

#### Scenario: Structured answer available
- **WHEN** the response includes structured answer fields
- **THEN** the UI SHALL render sections in order: quick answer summary, execution steps, validation checklist, and sources

#### Scenario: Structured answer unavailable
- **WHEN** structured answer fields are missing
- **THEN** the UI SHALL fall back to plain answer text while preserving source and citation sections

### Requirement: Source evidence MUST remain explicit and navigable
The system MUST provide source evidence with repository metadata and direct links so users can verify answer grounding.

#### Scenario: Primary source rendering
- **WHEN** references are present
- **THEN** the UI SHALL show one primary source with title, repo/path/commit metadata, and open-link action

#### Scenario: Additional evidence rendering
- **WHEN** citations are present
- **THEN** the UI SHALL list additional citations with source links and provenance metadata

### Requirement: Language output SHALL match user query language
The system SHALL keep answer and UX copy consistent with the detected or selected user language.

#### Scenario: Chinese user query
- **WHEN** the user asks in Chinese
- **THEN** answer content and interaction copy SHALL be shown in Chinese

#### Scenario: English user query
- **WHEN** the user asks in English
- **THEN** answer content and interaction copy SHALL be shown in English
