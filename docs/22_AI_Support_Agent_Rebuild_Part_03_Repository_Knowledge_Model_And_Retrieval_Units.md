# AI Support Agent Rebuild Plan Part 03

Date: 2026-04-01

Status: implementation-ready design

Required pre-read:

1. `/Users/jeremypeng/Downloads/Workspace/TicketManagement/AGENTS.md`
2. `/Users/jeremypeng/Downloads/Workspace/TicketManagement/docs/20_AI_Support_Agent_Rebuild_Part_01_System_Model_And_Single_DB_Publishing.md`
3. `/Users/jeremypeng/Downloads/Workspace/TicketManagement/docs/21_AI_Support_Agent_Rebuild_Part_02_Single_DB_Build_Sync_Publish_And_Repair.md`

This part must be implemented together with the constraints defined in `AGENTS.md`, Part 01, and Part 02.

If this document appears to conflict with Part 01 or Part 02, the earlier part wins unless explicitly revised first.

Scope:

- define the repository-native knowledge model
- define retrieval units vs citation units precisely
- define code-aware ingestion objects
- define chunking and symbol extraction strategy
- define the memory-entry generation substrate
- define embedding placement in the knowledge model
- define module boundaries for implementation

This document is intentionally detailed because later AI developers will use it directly for implementation.

---

## 1. Pre-Implementation Confirmation

Before implementing anything in this part, the developer must confirm all of the following.

### 1.1 Hard constraints still hold

Confirm:

- the project still uses a single shared DB
- runtime serving is being rebuilt around publication-based visibility
- `is_active` is not being treated as final serving truth in new code

If any of the above is false or unknown, stop and re-check Part 02 implementation status before writing code.

### 1.2 This part is not allowed to define serving visibility

This part defines:

- what knowledge objects exist
- how repository data becomes structured knowledge
- how retrieval units are built

This part does **not** define:

- publication pointer logic
- serving snapshot resolution
- environment promotion policy

Those belong to Part 02.

### 1.3 Safe parallel-development rule

This part may be developed partly in parallel with Part 02 only if the implementation is limited to:

- parsers
- extractors
- chunkers
- schema/type definitions
- artifact builders
- offline validation helpers

This part may **not** be connected to production runtime retrieval until Part 02 serving isolation is complete.

---

## 2. What This Part Delivers

This part answers one question:

> What exactly is the repository knowledge that the AI support engineer agent should reason over?

The answer is:

- not only markdown pages
- not only text chunks
- not only vectorized snippets

The repository must be transformed into a structured knowledge graph made of:

- source objects
- normalized artifacts
- retrieval units
- citation units
- structural relations
- support-oriented memory entries

This is the layer that later retrieval, reranking, and support reasoning will consume.

---

## 3. Why The Repository Cannot Be Treated As “Markdown Only”

Your target system is a support engineer agent.

Support questions often rely on facts that are not written as one clean doc paragraph.

Real support answers often depend on combining:

- docs wording
- actual API schema
- config key names
- code behavior
- SQL constraints
- tests proving behavior
- deployment runbooks
- error strings or callback semantics

If we ingest only markdown and slice it into text chunks, we systematically lose:

1. code-level meaning
2. symbol boundaries
3. config surfaces
4. schema constraints
5. behavior evidence from tests
6. precise API contract facts

This is one of the main reasons a “document chunk KB” becomes weak for support and troubleshooting.

Therefore this part adopts a repository-native knowledge model.

---

## 4. Repository-Native Knowledge Layers

The repository-derived knowledge build should produce four nested layers.

## Layer A. Source Objects

These are raw objects collected directly from the repository.

Examples:

- markdown file
- mdx file
- openapi file
- source code file
- config file
- sql migration file
- test file

## Layer B. Canonical Build Artifacts

These are normalized representations of source objects.

Examples:

- normalized document
- normalized OpenAPI operation
- parsed symbol
- normalized config surface
- parsed schema object
- extracted test behavior artifact

## Layer C. Retrieval Units

These are normalized support-facing knowledge units optimized for matching user intent.

Examples:

- troubleshooting pattern
- API operation unit
- permission rule
- behavior rule
- config/setup unit
- symbol responsibility unit

## Layer D. Citation Units

These are fine-grained evidence objects used in final answers.

Examples:

- doc chunk
- openapi operation span
- code symbol span
- config snippet
- sql snippet
- test assertion snippet

---

## 5. Frozen Distinction: Retrieval Unit vs Citation Unit

This distinction is mandatory and must be preserved in implementation.

## 5.1 Retrieval Unit

Purpose:

- maximize intent match quality
- bridge phrasing mismatch between user language and repository language
- expose support-relevant structured meaning

A retrieval unit may aggregate multiple source facts.

It may summarize.

It may normalize terminology.

It may connect related sources.

It must never be treated as the final answer evidence by itself.

## 5.2 Citation Unit

Purpose:

- provide grounded, traceable evidence for final customer answers

A citation unit must:

- map back to a concrete repository source
- preserve path and location
- preserve exact evidence span
- be stable under one published build

## 5.3 Mandatory retrieval flow

Later runtime must follow:

1. user query
2. case-frame understanding
3. retrieval unit recall
4. retrieval-unit rerank
5. grounding to citation units
6. citation validation
7. answer composition

Any design that jumps directly from query to final answer from retrieval units alone is forbidden.

---

## 6. Source Object Families

The build pipeline must classify repository content into these source families.

Each family has different parsing, chunking, and retrieval semantics.

## 6.1 `doc_page`

Sources:

- `.md`
- `.mdx`
- doc-oriented repo pages
- FAQ pages
- deployment docs
- product docs

Use cases:

- how-to
- troubleshooting
- behavior explanations
- constraints and notes

## 6.2 `openapi_spec`

Sources:

- OpenAPI YAML
- OpenAPI JSON
- API blobs embedded in docs if canonical

Use cases:

- endpoint lookup
- field lookup
- request/response schema
- auth scope
- operation-specific troubleshooting

## 6.3 `code_file`

Sources:

- source code files in supported languages

Use cases:

- actual behavior
- symbol responsibilities
- fallback logic
- callback handling
- exception logic

## 6.4 `config_file`

Sources:

- `.env.example`
- YAML
- JSON
- TOML
- Helm values
- deployment config

Use cases:

- setup
- environment troubleshooting
- configuration mismatch diagnosis

## 6.5 `schema_file`

Sources:

- SQL migrations
- schema definitions
- ORM models where canonical

Use cases:

- persistence constraints
- table/field existence
- unique-key behavior
- state machine persistence semantics

## 6.6 `test_file`

Sources:

- integration tests
- behavior tests
- fixtures

Use cases:

- proving intended behavior
- confirming error handling
- identifying expected request shape or state transitions

## 6.7 `runbook_file`

Sources:

- deployment procedures
- repair scripts
- operator docs

Use cases:

- support handoff
- operational guidance
- environment diagnosis

---

## 7. Canonical Artifact Families

These are the normalized artifact families that the build pipeline must generate.

## 7.1 `kb_documents`

Canonical normalized document artifacts derived from `doc_page`.

Still useful, but no longer the only knowledge representation.

## 7.2 `kb_chunks`

Chunk-level evidence units derived from documents and optionally other text-bearing sources.

They remain citation units, not primary retrieval truth.

## 7.3 `kb_openapi_operations`

New required artifact family.

Purpose:

- represent one canonical API operation

Required fields:

- `id`
- `knowledge_space`
- `repo_id`
- `branch`
- `build_version`
- `source_doc_id`
- `path`
- `method`
- `route_path`
- `operation_id`
- `summary`
- `description`
- `request_schema_json`
- `response_schema_json`
- `auth_scopes`
- `tags`
- `error_shapes_json`
- `source_location_json`
- `metadata_json`

This family is both:

- a high-value retrieval substrate
- a grounding source for API answers

## 7.4 `kb_code_symbols`

New required artifact family.

Purpose:

- represent one code symbol or code responsibility unit

Supported symbol kinds initially:

- module
- class
- function
- method
- interface
- type
- enum
- constant
- exported utility

Required fields:

- `id`
- `knowledge_space`
- `repo_id`
- `branch`
- `build_version`
- `path`
- `language`
- `symbol_kind`
- `symbol_name`
- `qualified_name`
- `parent_symbol`
- `start_line`
- `end_line`
- `signature_text`
- `doc_comment`
- `body_summary`
- `dependency_refs_json`
- `metadata_json`

## 7.5 `kb_config_surfaces`

New required artifact family.

Purpose:

- represent one config key or config surface

Examples:

- env var
- yaml path
- json path
- helm value
- feature flag

Required fields:

- `id`
- `knowledge_space`
- `repo_id`
- `branch`
- `build_version`
- `path`
- `config_kind`
- `config_key`
- `normalized_key`
- `default_value`
- `description`
- `required_for_json`
- `related_components_json`
- `source_location_json`
- `metadata_json`

## 7.6 `kb_schema_objects`

New required artifact family.

Purpose:

- represent database or schema-level constraints

Examples:

- table
- column
- index
- unique constraint
- foreign key

Required fields:

- `id`
- `knowledge_space`
- `repo_id`
- `branch`
- `build_version`
- `path`
- `object_kind`
- `schema_name`
- `object_name`
- `normalized_name`
- `definition_summary`
- `related_tables_json`
- `source_location_json`
- `metadata_json`

## 7.7 `kb_test_behaviors`

New required artifact family.

Purpose:

- represent behavior evidence extracted from tests

Examples:

- tested endpoint behavior
- expected error
- expected status transition
- fixture-backed setup requirements

This artifact family is lower-authority than docs or canonical API schema, but still useful for behavior confirmation and troubleshooting.

## 7.8 `kb_memory_entries`

This remains the support-oriented retrieval abstraction layer.

In the rebuilt model, memory entries are derived from the above canonical artifact families, not only from doc chunks.

---

## 8. Code-Aware Parsing Strategy

This section defines what parser strategy later implementation must use.

## 8.1 General rule

Do not use one universal plain-text parser for all repository content.

Each source family must use the most structure-aware parser available.

## 8.2 Markdown / MDX

Use a markdown-aware structural parser that preserves:

- headings
- nested sections
- code fences
- list steps
- admonitions
- tables where possible

Do not flatten everything to plain text before artifact generation.

## 8.3 OpenAPI

Parse as structured OpenAPI object.

Do not treat canonical OpenAPI as plain text first.

The operation object must be extracted before any text chunking happens.

## 8.4 Code files

Use language-aware parsing.

Preferred strategy:

- AST or tree-sitter style parser where feasible

Fallback:

- signature-aware regex extractor only for unsupported languages

But fallback extractors must be marked as degraded quality in metadata.

## 8.5 Config files

Parse with format-aware parser:

- dotenv-style key-value
- YAML
- JSON
- TOML

Do not chunk raw config files as plain text first.

## 8.6 SQL / schema files

Use SQL-aware parsing where possible.

At minimum extract:

- create table
- alter table
- add constraint
- create index

---

## 9. Chunking Strategy

Chunking must be family-specific.

One universal token chunker is not acceptable.

## 9.1 Doc chunking

Use section-aware chunking.

Chunk boundaries should prefer:

- heading boundaries
- step list boundaries
- API subsection boundaries
- troubleshooting subsection boundaries

Required metadata:

- heading path
- section title
- doc kind
- product area
- evidence kind
- procedure markers

## 9.2 OpenAPI chunking

Do not chunk OpenAPI first.

Primary object is the operation.

Optional secondary citation chunks may be derived from:

- request schema section
- response schema section
- auth section
- example block

## 9.3 Code chunking

Primary unit is the symbol span, not arbitrary token windows.

Required code citation unit types:

- whole symbol span
- signature span
- doc-comment span
- selected logic span for long bodies

Long methods may be split into logic sub-spans only after symbol extraction.

## 9.4 Config chunking

Primary unit is one config surface or one cohesive config block.

## 9.5 SQL chunking

Primary unit is one schema object or one migration operation block.

---

## 10. Retrieval Unit Families

The following retrieval-unit families are required.

They are the primary retrieval substrate for the support agent.

## 10.1 `api_operation_unit`

Represents one support-facing API operation object.

Derived from:

- `kb_openapi_operations`
- docs references
- optional code and test evidence

Required fields:

- `memory_kind = api_operation`
- canonical operation name
- method
- route path
- auth scopes
- request object terms
- response object terms
- product area
- aliases
- signals
- citation source mappings

## 10.2 `troubleshooting_pattern_unit`

Represents one symptom-oriented troubleshooting object.

Derived from:

- docs troubleshooting sections
- config surfaces
- error behaviors
- tests
- code error paths

Required fields:

- symptom phrases
- likely causes
- required checks
- candidate fixes
- exact signals
- citation mappings

## 10.3 `procedure_unit`

Represents one actionable procedure.

Derived from:

- step-based docs
- operator runbooks
- configuration guides

Required fields:

- prerequisites
- steps
- scope
- objects involved
- environments involved
- citation mappings

## 10.4 `behavior_rule_unit`

Represents one product or system behavior explanation.

Derived from:

- docs
- tests
- code behavior

Required fields:

- behavior statement
- conditions
- exclusions
- related objects
- citation mappings

## 10.5 `permission_rule_unit`

Represents auth/scope/permission requirements.

Derived from:

- OpenAPI
- docs
- config

## 10.6 `config_surface_unit`

Represents setup and configuration knowledge.

Derived from:

- config artifacts
- deploy docs
- troubleshooting docs

## 10.7 `symbol_responsibility_unit`

Represents a support-meaningful code symbol responsibility.

Derived from:

- `kb_code_symbols`
- nearby docs
- related tests

Use cases:

- where a callback is handled
- where a retry policy is enforced
- where a feature flag is checked
- where a specific error is produced

## 10.8 `schema_constraint_unit`

Represents DB or schema constraint behavior.

Derived from:

- schema objects
- migrations
- tests

---

## 11. Citation Unit Families

Citation units are used during final grounding.

Initial required citation-unit families:

- `doc_chunk`
- `openapi_operation_span`
- `code_symbol_span`
- `config_snippet`
- `sql_snippet`
- `test_snippet`

Each citation unit must include:

- `knowledge_space`
- `repo_id`
- `branch`
- `build_version`
- source path
- source location
- snippet text
- authority metadata
- source family

---

## 12. Memory Entry Generation Model

The memory layer is retained, but rebuilt on top of structured artifact families.

## 12.1 Required rule

Memory entries must be generated from canonical artifact families, not only from raw doc chunks.

## 12.2 Generation inputs

A memory entry generator may consume:

- document artifact
- openapi operation artifact
- code symbol artifact
- config surface artifact
- schema object artifact
- test behavior artifact

## 12.3 Required memory entry shape

Each memory entry must contain:

- stable id
- `knowledge_space`
- `repo_id`
- `branch`
- `build_version`
- `memory_kind`
- `title`
- `canonical_claim`
- `summary`
- `product_area`
- `object_type`
- `action_type`
- `doc_kind`
- `search_text`
- aliases
- exact signals
- source mappings
- relation candidates

## 12.4 Source mappings

Each memory entry must map to one or more citation units.

It is valid for one memory entry to ground to:

- one doc chunk and one config snippet
- one API operation and one test snippet
- one troubleshooting chunk and one code symbol

This is one of the main reasons the memory layer improves support retrieval.

## 12.5 Forbidden memory generation behaviors

Do not:

- generate customer-ready final answers as memory rows
- generate unsupported claims not grounded in repository artifacts
- use memory entries as ungrounded response cache

---

## 13. Alias And Signal Policy

Alias and signal quality is a major determinant of support retrieval quality.

## 13.1 Aliases

Aliases exist to bridge user phrasing and repository phrasing.

Required alias categories:

- UI wording
- old name / new name
- Chinese phrase
- English phrase
- operation variant
- troubleshooting symptom phrase
- acronym / abbreviation
- path-like developer phrase where valid

## 13.2 Signals

Signals exist for exact or near-exact handles.

Required signal categories:

- http method
- api path
- scope
- error code
- error text
- callback
- redirect uri
- base url
- config key
- env var
- table name
- column name
- symbol name
- event name

## 13.3 Policy

Aliases and signals should be mostly derived from structured source artifacts, not handwritten per case.

Allowed:

- family-specific extraction heuristics

Forbidden:

- piling on one-off hardcoded symptom phrases for individual failed customer queries as the main strategy

---

## 14. Embedding Placement In The Knowledge Model

Embeddings are now treated as allowed and useful.

This part defines where embeddings belong.

## 14.1 Embedding target objects

Embeddings should be computed for:

- retrieval units
- selected citation units
- possibly symbol summaries

Embeddings should not be the only representation.

## 14.2 Primary recommendation

Primary embedding targets:

1. `kb_memory_entries.search_text`
2. `kb_openapi_operations` semantic text
3. `kb_code_symbols` summary text
4. `kb_chunks` for citation recall assist

## 14.3 Build rule

Embeddings are build-scoped artifacts.

They must include:

- `knowledge_space`
- `build_version`
- `embedding_model`
- `embedding_dim`
- `embedding_version`

## 14.4 Why embedding is useful here

For your target system, embeddings are useful for:

- symptom paraphrase matching
- Chinese/English mixed phrase matching
- behavior-level similarity
- query-to-API semantic bridging
- code-summary semantic matching

But embeddings cannot replace:

- symbol extraction
- metadata filters
- exact signals
- publication isolation

---

## 15. Required Module Boundaries In Implementation

To reduce conflict and support parallel work, implementation should be split into bounded modules.

## 15.1 Parser layer

Suggested files/modules:

- `github-kb/parsers/docs-parser.ts`
- `github-kb/parsers/openapi-parser.ts`
- `github-kb/parsers/code-parser.ts`
- `github-kb/parsers/config-parser.ts`
- `github-kb/parsers/schema-parser.ts`
- `github-kb/parsers/test-parser.ts`

## 15.2 Canonical artifact builders

Suggested files/modules:

- `github-kb/builders/document-builder.ts`
- `github-kb/builders/openapi-builder.ts`
- `github-kb/builders/symbol-builder.ts`
- `github-kb/builders/config-builder.ts`
- `github-kb/builders/schema-builder.ts`
- `github-kb/builders/test-behavior-builder.ts`

## 15.3 Chunking layer

Suggested files/modules:

- `github-kb/chunkers/doc-chunker.ts`
- `github-kb/chunkers/code-span-builder.ts`
- `github-kb/chunkers/config-snippet-builder.ts`
- `github-kb/chunkers/schema-snippet-builder.ts`

## 15.4 Retrieval-unit layer

Suggested files/modules:

- `github-kb/retrieval-units/api-operation-unit-builder.ts`
- `github-kb/retrieval-units/troubleshooting-unit-builder.ts`
- `github-kb/retrieval-units/procedure-unit-builder.ts`
- `github-kb/retrieval-units/behavior-unit-builder.ts`
- `github-kb/retrieval-units/config-unit-builder.ts`
- `github-kb/retrieval-units/symbol-unit-builder.ts`

## 15.5 Memory generation layer

Suggested files/modules:

- `github-kb/memory/generate-memory-entries.ts`
- `github-kb/memory/generate-aliases.ts`
- `github-kb/memory/generate-signals.ts`
- `github-kb/memory/generate-relations.ts`

This split is intentional so multiple AI workers can contribute without editing the same files heavily.

---

## 16. Validation Requirements For This Part

This part must ship with artifact-quality validation, not only parser output.

Required validations:

1. source files are classified into the right source family
2. symbol extraction boundaries are stable
3. one OpenAPI operation maps to one normalized operation artifact
4. citation units preserve source location
5. retrieval units always have at least one citation mapping
6. no retrieval unit is published without a grounded source chain
7. embedding targets are consistent per build

---

## 17. Initial Implementation Priority Inside This Part

This is the recommended internal order.

### Priority 1

- docs parser stabilization
- OpenAPI parser and operation artifact
- code symbol parser for the main language(s)

### Priority 2

- doc chunker
- code symbol span builder
- config surface extraction

### Priority 3

- retrieval unit builders
- memory entry generation from structured artifacts

### Priority 4

- test behavior extraction
- schema object extraction
- richer cross-artifact relations

---

## 18. Explicit Prohibitions During Implementation

While implementing this part, the following are forbidden:

1. treating all repository files as plain text first
2. treating all retrieval units as document chunks
3. generating ungrounded memory entries
4. skipping source-location preservation for citation units
5. depending on path heuristics as the primary semantic model
6. wiring new artifacts into production runtime retrieval before Part 02 publication isolation is in place

---

## 19. Development Dependency Summary

This section is mandatory and should be consulted before assigning work to another AI.

### 19.1 Can start immediately in parallel

The following can be developed immediately, in parallel with Part 02:

- parser modules
- canonical artifact schemas and types
- docs chunker
- OpenAPI operation extractor
- code symbol extractor
- config surface extractor
- schema extractor
- retrieval unit builders
- memory-entry generation logic
- embedding target builders
- offline validation helpers

These tasks are safe because they can operate as build-artifact generation work without changing production runtime visibility.

### 19.2 Can start now but must not be connected to main runtime yet

The following can be implemented now, but must remain offline or feature-flagged until Part 02 is complete:

- new retrieval-unit persistence
- new memory-entry persistence
- embedding generation for new artifact families
- citation-unit persistence beyond existing chunk model

### 19.3 Must wait for Part 02 completion before execution or integration

The following must not begin runtime integration until Part 02 publication-based serving is complete:

- switching runtime retrieval from old chunk logic to new retrieval units
- switching support-agent to depend on new artifact families
- enabling new memory retrieval in production runtime
- enabling embedding-backed retrieval in production runtime
- running rebuilds that publish these new artifacts into production knowledge space

### 19.4 Required front-of-task confirmation for later AI developers

Before starting implementation from this part, the developer must explicitly confirm:

1. Part 02 publication isolation exists or this work will remain offline-only
2. the write scope does not conflict with another in-progress artifact-builder task
3. the task will not connect to production runtime prematurely

---

## 20. Acceptance Criteria For Part 03

Part 03 is accepted only when all of the following are true.

1. repository knowledge is modeled beyond markdown chunks
2. retrieval units and citation units are clearly separated in code and schema
3. source-family-aware parsing exists
4. symbol-aware and OpenAPI-aware artifact generation exists
5. memory entry generation is grounded in structured repository artifacts
6. later runtime retrieval can consume these artifacts without reintroducing path-heavy hacks

---

## 21. What Later Parts Will Assume

Part 04 and later will assume:

- repository-native artifact families exist
- retrieval units exist
- citation units exist
- memory entry generation is grounded and structured
- embeddings have clear target objects

Part 04 will define:

- hybrid retrieval architecture
- dense + sparse + exact-signal retrieval
- rerank stack
- retrieval orchestration against these new artifact families

