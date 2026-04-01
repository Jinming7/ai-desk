## ADDED Requirements

### Requirement: Markdown Document Parsing
The system SHALL parse Markdown documents into structured sections while preserving heading hierarchy and code/table boundaries relevant for retrieval.

#### Scenario: Markdown file parsed into structured sections
- **WHEN** an eligible `.md` file is ingested
- **THEN** the parser outputs ordered sections with heading path metadata and normalized plain text content

### Requirement: Deterministic Chunk Construction
The system SHALL generate chunks using structural chunking rules and MUST assign stable chunk identifiers from deterministic inputs.

#### Scenario: Reprocessing unchanged document yields same chunk IDs
- **WHEN** a document with identical content is processed in a later sync
- **THEN** all generated chunk IDs match previously stored chunk IDs

#### Scenario: Updated section creates localized chunk changes
- **WHEN** only one section in a document changes
- **THEN** only chunks derived from the changed section receive new identifiers and embeddings

### Requirement: Embedding Generation and Versioning
The system SHALL generate embeddings for chunk text through an OpenAI-compatible API and MUST persist embedding model/version metadata for each chunk.

#### Scenario: Embeddings stored with model metadata
- **WHEN** chunk embedding generation succeeds
- **THEN** the system stores vector data and embedding model/version attributes with the chunk record

#### Scenario: Embedding retry on transient failure
- **WHEN** embedding API returns a retryable error
- **THEN** the system retries the chunk embedding job with backoff and preserves idempotency

### Requirement: Hybrid Index Maintenance
The system SHALL maintain both vector and keyword indexes for each active chunk to support hybrid retrieval.

#### Scenario: Chunk upsert updates both indexes
- **WHEN** a chunk is inserted or updated
- **THEN** its vector representation and full-text searchable representation are both updated in the index store

### Requirement: Idempotent Sync and Source Deletion Handling
The system SHALL perform idempotent upsert operations for documents/chunks and MUST mark removed source documents as inactive in the external index.

#### Scenario: Duplicate sync event does not create duplicate chunks
- **WHEN** the same sync event is processed more than once
- **THEN** document and chunk records are upserted without duplication

#### Scenario: Source file deletion is reflected in index
- **WHEN** a tracked source file is deleted in repository history
- **THEN** corresponding document/chunk records are marked inactive or removed from active retrieval sets
