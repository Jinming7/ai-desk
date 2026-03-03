## Why

The team needs ONES OpenAPI knowledge to persist across threads and contributors, but the current understanding lives only in transient chat context. Capturing a structured, versioned knowledge map now reduces integration mistakes and accelerates future ONES feature delivery.

## What Changes

- Add a durable ONES OpenAPI knowledge map artifact in OpenSpec with domain-based API indexing.
- Define normative guidance for how future ONES integration tasks should reference endpoints, scopes, request contracts, and known document inconsistencies.
- Record high-risk contract ambiguities (for example, schema required/property mismatches) and required validation steps before implementation.
- Establish a maintenance workflow so the knowledge map can be updated when ONES OpenAPI changes.

## Capabilities

### New Capabilities
- `ones-openapi-knowledge-base`: Provides a reusable, structured ONES OpenAPI reference for integration planning, including endpoint taxonomy, auth/scope mapping, payload expectations, and risk notes.

### Modified Capabilities
- None.

## Impact

- Affects OpenSpec artifacts and planning workflow, not runtime application behavior.
- Reduces re-discovery effort in future ONES integration changes.
- Introduces a documentation maintenance responsibility whenever the ONES OpenAPI source document changes.
