## Context

The ONES integration workstream depends on accurate understanding of ONES OpenAPI contracts, but this understanding is currently transient and thread-local. The codebase has active ONES-related change work, and future integrations will repeatedly need endpoint discovery, scope mapping, request/response contract checks, and ambiguity handling. Without a durable knowledge artifact, teams risk re-discovery cost and inconsistent integration decisions.

Constraints:
- Knowledge must be reusable across threads and contributors.
- The source of truth is the ONES OpenAPI document provided by the team.
- The design must separate stable facts (endpoint contracts) from uncertain facts (document ambiguities).

Stakeholders:
- Engineers implementing ONES integrations
- Reviewers validating API usage and scopes
- Product/ops participants confirming feasibility of integration flows

## Goals / Non-Goals

**Goals:**
- Create a durable, version-controlled ONES OpenAPI knowledge base as OpenSpec artifacts.
- Standardize how future changes reference endpoints, scopes, required parameters, and payload contracts.
- Make ambiguity explicit and actionable through a risk/validation checklist.
- Define a maintenance model for keeping knowledge synchronized with source OpenAPI updates.

**Non-Goals:**
- Implementing runtime ONES integration code in this change.
- Replacing the upstream ONES OpenAPI document.
- Guaranteeing semantic correctness for undocumented ONES server behavior without runtime verification.

## Decisions

### Decision 1: Use OpenSpec as the persistence layer for ONES API knowledge
- Rationale: OpenSpec artifacts are already part of the team workflow and naturally persist in repo history across threads.
- Alternative considered: Store in AGENTS.md.
- Why not: AGENTS.md is instruction-oriented and becomes noisy/fragile when overloaded with large API domain references.

### Decision 2: Organize knowledge by integration domains rather than raw path order
- Rationale: Future requirements are usually domain-driven (issue lifecycle, worklog, wiki, user sync), not file-order-driven.
- Alternative considered: Single flat endpoint list.
- Why not: Harder to navigate and reason about end-to-end flows.

### Decision 3: Include both “normative call guidance” and “contract ambiguity ledger”
- Rationale: Implementers need both happy-path usage and explicit warnings where spec fields are inconsistent.
- Alternative considered: Keep only normative guidance.
- Why not: Hidden inconsistencies tend to become late-cycle integration bugs.

### Decision 4: Define a lightweight update protocol triggered by source OpenAPI revisions
- Rationale: Keeps documentation operationally useful without heavy governance overhead.
- Alternative considered: Ad-hoc updates.
- Why not: Increases risk of stale knowledge and contradictory decisions across changes.

## Risks / Trade-offs

- [Risk] Source OpenAPI and real server behavior may diverge → Mitigation: mark uncertain contracts as “needs runtime validation” before implementation decisions.
- [Risk] Knowledge map goes stale after ONES upgrades → Mitigation: require refresh task in any change that depends on newly changed ONES endpoints/scopes.
- [Risk] Overly detailed docs increase maintenance burden → Mitigation: capture stable integration-critical fields, avoid duplicating every low-value example.
- [Risk] Teams misuse guidance as absolute truth → Mitigation: explicitly separate “spec-derived facts” from “inferred guidance” and “known ambiguities”.

## Migration Plan

1. Create and merge this OpenSpec change with proposal/design/spec/tasks completed.
2. Treat the resulting capability spec as the required reference for new ONES integration proposals.
3. For each future ONES feature change, add a task item that verifies referenced endpoints/scopes against the latest OpenAPI file.
4. If ONES OpenAPI changes materially, open a follow-up change to update the knowledge capability.

Rollback strategy:
- If the knowledge structure proves ineffective, revert usage policy in subsequent OpenSpec change while preserving historical artifacts for traceability.

## Open Questions

- Should the team define a fixed cadence (for example, weekly) for OpenAPI drift checks, or only update on-demand per change?
- Should future work add an automated diff report between old/new ONES OpenAPI versions to pre-fill ambiguity checks?
