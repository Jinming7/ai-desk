## 1. OpenClaw Integration Foundation

- [x] 1.1 Add OpenClaw connection configuration (endpoint, credentials, index identifiers, timeout, retry policy) and secure secret loading.
- [x] 1.2 Implement `SearchOrchestrator` skeleton to handle query normalization, OpenClaw retrieval invocation, and response envelope composition.
- [x] 1.3 Define and implement reference metadata schema (document id/title/snippet/source/timestamp/score) returned by AI search.
- [x] 1.4 Add retrieval failure fallback handling with reason code `KB_RETRIEVAL_UNAVAILABLE` and ensure no fabricated references are returned.

## 2. AI Search Grounded Response Flow

- [x] 2.1 Integrate AI answer generation with OpenClaw retrieval results and confidence threshold gating.
- [x] 2.2 Persist retrieval evidence records (query, doc ids, ranking, confidence, session id) for each answered request.
- [x] 2.3 Add API contract updates for grounded answer payload while keeping backward compatibility for existing clients.
- [x] 2.4 Implement telemetry for retrieval quality (hit rate, citation coverage, fallback rate).

## 3. Quick Ticket Escalation Experience

- [x] 3.1 Add unresolved-state UI behavior to show quick ticket action when no-answer/low-confidence conditions are met.
- [x] 3.2 Implement quick ticket submission endpoint to store escalation context (question, conversation, retrieval snapshot, reason code).
- [x] 3.3 Add idempotency control for quick ticket requests per unresolved session.
- [x] 3.4 Implement escalation status query API so frontend can show “Agent processing” and final outcomes.

## 4. Agent Deep Retrieval Orchestration

- [x] 4.1 Implement escalation state machine (`SEARCHED -> ESCALATED -> DEEP_RETRIEVING -> RESOLVED_BY_AI|TICKET_CREATED`) with transition events.
- [x] 4.2 Build agent deep retrieval workflow (multi-round retrieval, evidence rerank, max attempts, timeout).
- [x] 4.3 Implement auto-resolution branch to generate AI solution with supporting references when threshold is met.
- [x] 4.4 Implement formal ticket creation branch with mapped required fields and attached escalation evidence when unresolved.
- [x] 4.5 Add deduplication safeguards for formal ticket creation and correlation-id based auditing.

## 5. Validation, Rollout, and Operations

- [x] 5.1 Create tests for grounded answer, fallback behavior, quick ticket idempotency, and agent branch decisions.
- [x] 5.2 Add integration tests covering end-to-end escalation flow from unresolved AI search to resolved-by-AI or ticket-created outcome.
- [x] 5.3 Add dashboards/alerts for escalation volume, auto-resolve rate, ticket creation rate, and agent failure causes.
- [x] 5.4 Implement feature flags and staged rollout plan for KB grounding, quick ticket, and deep retrieval orchestration.
- [x] 5.5 Prepare rollback runbook to disable new paths and revert to legacy AI search handling if needed.
