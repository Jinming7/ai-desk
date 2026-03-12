## ADDED Requirements

### Requirement: Structured Final Answer Contract
The system SHALL format grounded final answers with explicit sections and citations.

#### Scenario: Grounded answer format
- **WHEN** valid citations are available and confidence is above threshold
- **THEN** response includes structured sections: summary, steps, validation, and citations

### Requirement: Citation Gate for Final Conclusions
The system MUST NOT output final factual conclusions when no valid citation exists.

#### Scenario: No citation blocks final conclusion
- **WHEN** retrieval result has no valid citation
- **THEN** response mode is clarification or ticket handoff guidance, not final answer

### Requirement: Response Language Matches User Query Language
The system SHALL match answer language to detected query language for Chinese and English requests.

#### Scenario: Chinese query returns Chinese answer
- **WHEN** query language is detected as Chinese
- **THEN** structured response sections are returned in Chinese while preserving citations

#### Scenario: English query returns English answer
- **WHEN** query language is detected as English
- **THEN** structured response sections are returned in English while preserving citations

### Requirement: Explicit Citation Payload
The system SHALL include explicit citation fields for each cited source.

#### Scenario: Citation payload completeness
- **WHEN** system returns a grounded answer or fallback snippet
- **THEN** each citation includes repo, path, source_url, and commit_sha
