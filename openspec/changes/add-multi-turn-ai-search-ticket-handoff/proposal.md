## Why

Current AI search can return citations, but when first retrieval has no valid evidence it does not reliably guide the user toward resolution or structured escalation. We need a deterministic multi-turn fallback and one-click ticket handoff now so users can continue in one flow instead of restarting in another system.

## What Changes

- Add a multi-turn conversational fallback when first retrieval has no valid citation, allowing AI to ask clarifying questions and collect additional context.
- Add turn-limit governance: after 3 clarification rounds without valid grounded answer, show a clear CTA button `Create a ticket now`.
- Add ticket handoff orchestration from chat: on CTA click, analyze the original question plus dialog context to infer ticket type and prefill form fields.
- Reuse backend-configured ticket type catalog and field schema for prefill, and allow user edits before submit.
- Add final submission path from prefilled draft to ticket creation, preserving full conversation context for downstream support.
- Add response policy requirement: AI final answer must be well-structured and must include explicit citations; if no valid citation exists, AI must not present unsupported final conclusions.

## Capabilities

### New Capabilities
- `multi-turn-grounding-fallback`: Clarification dialog flow when first retrieval is ungrounded, including round counting and escalation threshold.
- `chat-to-ticket-prefill-handoff`: Convert dialog context into ticket draft with inferred ticket type and field prefill from admin configuration.
- `citation-gated-structured-answering`: Enforce structured answer format and citation-gating for both search and fallback responses.

### Modified Capabilities
- None.

## Impact

- API: new chat session state endpoints, clarification turn APIs, and ticket-prefill handoff endpoint.
- AI orchestration: retrieval result policy, follow-up question generation, ticket-type inference, field prefill mapping.
- Data: session turn state, clarification transcript, handoff payload, confidence and citation metadata.
- UI: conversation window action state, `Create a ticket now` CTA, prefilled ticket form with editable fields.
- Operations: new metrics for no-citation rate, clarification-to-resolution rate, and chat-to-ticket conversion.
