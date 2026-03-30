## ADDED Requirements

### Requirement: AI search MUST return grounded references when answering
The system MUST query OpenClaw knowledge base during AI search and SHALL return answer content with structured reference documents when confidence is above the answer threshold.

#### Scenario: Answer with references
- **WHEN** a user submits a searchable question and OpenClaw returns relevant documents above retrieval threshold
- **THEN** the system returns an AI answer including references with document id, title, snippet, source link, and retrieval timestamp

### Requirement: AI search MUST expose retrieval evidence metadata
The system MUST persist retrieval evidence metadata for each answered request, including query, retrieved document identifiers, ranking scores, and model confidence.

#### Scenario: Persist evidence after successful answer
- **WHEN** the AI search response is generated with at least one reference
- **THEN** the system stores the retrieval evidence metadata in an auditable record linked to the search session

### Requirement: AI search MUST gracefully degrade on OpenClaw retrieval failure
The system MUST return a controlled fallback state when OpenClaw retrieval fails or times out, without returning fabricated references.

#### Scenario: Retrieval failure fallback
- **WHEN** OpenClaw API errors, times out, or returns invalid payload
- **THEN** the system returns a no-answer state with reason code `KB_RETRIEVAL_UNAVAILABLE` and no reference list
