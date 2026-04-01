## Context

The current AI retrieval flow has improved citation-grounded search, but user experience breaks when first retrieval cannot produce valid evidence. Users need a guided multi-turn clarification path and a direct escalation handoff to ticket creation without context loss. Existing backend already has ticket-type configuration and field schema management, which should be reused for automatic prefill.

This change spans search orchestration, conversation state management, answer policy enforcement, and chat-to-ticket integration.

## Goals / Non-Goals

**Goals:**
- Add a deterministic multi-turn clarification flow when initial retrieval has no valid citation.
- Limit clarification to 3 rounds, then expose a clear `Create a ticket now` action.
- Build chat-to-ticket handoff that infers ticket type and prefills configured fields from dialog context.
- Ensure AI final responses are structured and citation-gated (no unsupported final conclusions).
- Keep user in one conversation flow from question to ticket submission.

**Non-Goals:**
- Building a new ticket workflow engine separate from existing ticket module.
- Replacing admin ticket-type/field configuration model.
- Multi-channel escalation (email/phone/chatbot platform) outside current portal flow.

## Decisions

### 1) Conversation State Machine for Ungrounded Retrieval
Add explicit search dialog states:
- `GROUNDABLE_ANSWER_READY`
- `CLARIFICATION_REQUIRED`
- `CLARIFICATION_IN_PROGRESS`
- `TICKET_HANDOFF_RECOMMENDED`
- `TICKET_DRAFT_READY`
- `TICKET_SUBMITTED`

Rationale: Removes ambiguity in frontend behavior and ensures deterministic CTA timing.

### 2) Citation-Gated Answer Policy
Define policy gates:
- If at least one valid citation exists and confidence >= threshold: return structured final answer with citations.
- If no valid citation: return clarifying question, not final conclusion.
- After max rounds reached: show escalation guidance + `Create a ticket now` CTA.

Rationale: Prevents unsupported answers while keeping user progress.

### 3) Clarification Rounds and Prompting
Store per-session `clarification_round` and cap at 3.
Each clarification question must request high-value disambiguators (symptom, environment, expected/actual, error message, reproduction path).

Rationale: improves retrieval quality before escalating.

### 4) Ticket Prefill Inference Pipeline
On CTA click:
1. Aggregate source query + conversation transcript + retrieval traces.
2. Predict ticket type from configured ticket types (project-scoped if enabled).
3. Extract field values using configured schema/mapping.
4. Return editable `draft` with confidence per field and unmapped gaps.

Rationale: maximize automation while retaining human review before submit.

### 5) Submission Contract
The frontend submits edited draft through existing ticket creation workflow.
Persist provenance metadata (`from_chat=true`, session id, transcript digest, retrieval outcome).

Rationale: traceability for support operations and model quality audit.

### 6) UX Behavior Rules
- In chat window, show `Create a ticket now` only when state = `TICKET_HANDOFF_RECOMMENDED`.
- Keep the button sticky for session continuity.
- Ticket draft page shows: inferred ticket type, prefilled fields, confidence hints, and required-missing warnings.

Rationale: clear path to action and reduced abandonment.

## Risks / Trade-offs

- [Over-escalation after 3 rounds] -> Mitigation: tune clarification quality and allow one optional manual extra query before CTA click.
- [Wrong ticket type inference] -> Mitigation: show inferred type with confidence and allow override before submission.
- [Field prefill hallucination] -> Mitigation: confidence per field + required field validation + explicit user confirmation.
- [Long transcripts increase latency] -> Mitigation: transcript summarization window and token budget controls.
- [Policy too strict reduces answer rate] -> Mitigation: profile-specific thresholds and monitored fallback metrics.

## Migration Plan

1. Add DB schema for chat clarification state and ticket handoff metadata.
2. Add backend APIs for clarification loop and ticket draft prefill.
3. Integrate citation-gated response policy into search orchestrator.
4. Update frontend chat UI for round-aware prompts and `Create a ticket now` CTA.
5. Add ticket draft editor entry from chat and submit integration.
6. Roll out behind feature flag and monitor conversion/quality metrics.

Rollback:
- Disable feature flag to revert to current search behavior.
- Keep stored session metadata for diagnostics but bypass new state machine.

## Open Questions

- Should ticket handoff trigger exactly at round=3, or only when user submits one more question after round=3?
- Should ticket type inference use deterministic rules first, then model fallback, or always model-first?
- Do we require citation at paragraph-level granularity, or document-level URL is sufficient for v1?
