## Context

The current ticket triage pipeline stores AI run outputs and transitions ticket status based on `action`, but it allows a corner case where the model emits a customer-facing `reply` with `action=none`. In that branch, the workflow only writes an audit event and returns without posting a ticket message or moving to `WAITING_CUSTOMER`.

This creates two product issues:
- Customer-visible silence despite AI-generated guidance existing in run output.
- Lifecycle inconsistency where a ticket can remain `IN_PROGRESS` without an explicit next actor.

The platform also needs strict language consistency for customer-facing AI output. Existing prompting does not guarantee English-only responses.

Stakeholders: customer portal users, support operations, and product governance for deterministic AI behavior.

## Goals / Non-Goals

**Goals:**
- Make triage outcomes deterministic: any customer-facing AI reply MUST be posted to ticket messages and MUST transition to `WAITING_CUSTOMER`.
- Restrict `action=none` semantics to true no-response/no-op cases.
- Enforce English-only customer-facing triage text.
- Preserve existing escalation behavior (`escalate` -> `ESCALATED_RND`) and explicit support assignment semantics.
- Improve observability to detect silent `IN_PROGRESS` regressions.

**Non-Goals:**
- Changing SLA policy definitions or timers outside existing transitions.
- Introducing multilingual response support.
- Replacing OpenClaw model/provider routing.
- Redesigning portal UI flows beyond current message/status rendering.

## Decisions

### 1) Reply-first lifecycle rule in orchestration
Decision: In `runTicketTriage`, compute `shouldReplyToCustomer = reply.trim().length > 0` after escalation branch handling. If true, persist AGENT message (`is_ai_generated=true`), transition to `WAITING_CUSTOMER`, assign `SUPPORT_TEAM`, and log `ai_triage_replied`.

Rationale: The real contract for customer progression is whether a customer-facing message exists, not action label alone.

Alternatives considered:
- Keep action-driven only and force model never to emit `none` with reply: rejected because model outputs are probabilistic and require runtime guardrails.
- Map all `none` to `ask_user` at parser level: rejected because no-op triage cases still exist and should remain representable.

### 2) Prompt governance for action semantics + language policy
Decision: Strengthen OpenClaw triage prompt with explicit rules:
- All output text MUST be English.
- If more info is needed, action MUST be `ask_user`.
- `none` is only valid when no customer-facing reply is required.

Rationale: Policy must be encoded close to generation boundary to reduce inconsistent outputs and lower remediation burden in orchestration.

Alternatives considered:
- Post-process translation layer: rejected due to added latency/complexity and potential meaning drift.
- Pure backend normalization without prompt update: rejected because it would treat symptoms but not reduce malformed outputs at source.

### 3) Regression-focused observability and tests
Decision: Add/adjust tests to assert:
- no `reply` + `none` => remains no-op and auditable.
- any non-empty `reply` (including `none`) => customer-visible message + `WAITING_CUSTOMER`.
- triage reply language is English for placeholder-content cases.

Rationale: Behavior depends on dynamic model output, so invariant tests must validate orchestration safety net, not only prompt intent.

Alternatives considered:
- Rely on manual QA in OpenClaw chat logs: rejected as insufficient and non-deterministic.

## Risks / Trade-offs

- [Model still emits non-English text] -> Mitigation: keep backend guardrails and add alerting/test fixtures for language regressions.
- [Potential over-transition to `WAITING_CUSTOMER` when reply is low quality] -> Mitigation: preserve confidence/evidence in audit log and improve prompt constraints iteratively.
- [Behavior change for existing dashboards that inferred progress from `action`] -> Mitigation: document updated contract: customer-facing reply now governs waiting state.
- [Integration tests may remain flaky due to external dependency variability] -> Mitigation: focus deterministic assertions on workflow orchestration and retain mock adapter fixtures.

## Migration Plan

1. Implement prompt-policy updates in WebSocket OpenClaw adapter.
2. Implement reply-first guardrail in triage service.
3. Run API build and regression tests.
4. Deploy to staging and production.
5. Verify with synthetic tickets (`123/123456` and real issue text) that messages and status transitions are deterministic.
6. Monitor `ai_triage_no_action` rate and confirm no silent `IN_PROGRESS` tickets with non-empty AI reply.

Rollback strategy:
- Revert triage orchestration/prompt changes via git rollback if unexpected lifecycle side effects appear.
- Since no schema migration is introduced, rollback is code-only and immediate.

## Open Questions

- Should we add hard validation to reject non-English reply text server-side (strict block) versus current prompt-level enforcement?
- Should `action=none` be fully deprecated from contract in next version to simplify downstream logic?
- Do we want a dedicated audit event for "reply_with_none_action_normalized" for analytics transparency?
