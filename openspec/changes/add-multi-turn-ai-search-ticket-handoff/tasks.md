## 1. Conversation State and Clarification Loop

- [x] 1.1 Add session state model and persistence for clarification rounds and handoff state transitions
- [x] 1.2 Implement retrieval outcome gate that routes no-citation queries into clarification mode
- [x] 1.3 Implement targeted clarification question generator and context accumulation per round
- [x] 1.4 Enforce 3-round threshold and return `showCreateTicketNow=true` when unresolved

## 2. Citation-Gated Structured Answering

- [x] 2.1 Define response schema for structured answer sections (`summary`, `steps`, `validation`, `citations`)
- [x] 2.2 Enforce policy: no final factual conclusion when no valid citation is present
- [x] 2.3 Implement language detection and response rendering that matches query language (zh/en)
- [x] 2.4 Add citation payload validation (`repo`, `path`, `source_url`, `commit_sha`) before returning grounded answers

## 3. Chat-to-Ticket Prefill Handoff

- [x] 3.1 Add `Create a ticket now` handoff endpoint that consumes question + transcript + retrieval traces
- [x] 3.2 Implement ticket type inference using configured ticket type catalog with confidence output
- [x] 3.3 Implement field extraction and prefill generation from configured form schema and transcript evidence
- [x] 3.4 Return editable draft payload with missing-required-field indicators and per-field confidence

## 4. Ticket Submission Integration

- [x] 4.1 Integrate prefilled draft submission with existing ticket creation workflow
- [x] 4.2 Persist handoff provenance metadata (`from_chat`, session id, transcript digest, retrieval outcome)
- [x] 4.3 Validate required fields server-side before final submit and return actionable errors
- [x] 4.4 Add audit events for `handoff_triggered`, `draft_generated`, and `ticket_submitted`

## 5. Frontend UX and Interaction Flow

- [x] 5.1 Update chat window to show clarification rounds and escalation messaging
- [x] 5.2 Display and enable `Create a ticket now` CTA only in recommended handoff state
- [x] 5.3 Implement ticket draft editor view with prefilled values, confidence hints, and user override
- [x] 5.4 Wire draft submit action back to ticket workflow and show submit result inline

## 6. Quality, Metrics, and Safeguards

- [x] 6.1 Add integration tests for 0-citation -> multi-turn -> CTA -> draft -> submit flow
- [x] 6.2 Add test cases for citation-gated answer policy and language-matched response output
- [x] 6.3 Add metrics for no-citation rate, clarification resolution rate, and chat-to-ticket conversion
- [x] 6.4 Add rollback flag to disable new handoff flow and fall back to current retrieval behavior
