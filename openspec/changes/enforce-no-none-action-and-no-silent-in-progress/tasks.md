## 1. Triage Policy Enforcement

- [x] 1.1 Update OpenClaw triage prompt contract to enforce English-only customer output and `ask_user` preference for information gaps.
- [x] 1.2 Add/adjust adapter-level normalization rules so `none` is only used for true no-op outcomes.

## 2. Workflow Orchestration Hardening

- [x] 2.1 Refactor ticket triage orchestration to treat non-empty `reply` as customer-facing and persist it as AGENT message.
- [x] 2.2 Ensure reply-driven transitions move ticket to `WAITING_CUSTOMER`, set support assignee, and emit `ai_triage_replied` audit event.
- [x] 2.3 Preserve existing escalation behavior and ensure no regression in `ESCALATED_RND`/R&D assignment path.
- [x] 2.4 Keep explicit `ai_triage_no_action` path for empty-reply no-op outcomes only.

## 3. Regression Tests And Verification

- [x] 3.1 Add/adjust integration tests for (`action=none`, non-empty reply) => message persisted + `WAITING_CUSTOMER`.
- [x] 3.2 Add/adjust integration tests for (`action=none`, empty reply) => no message + `ai_triage_no_action` audit.
- [x] 3.3 Add verification coverage for English clarification output on placeholder-content tickets.
- [x] 3.4 Run API build/tests and execute production-like E2E check to confirm no silent `IN_PROGRESS` with hidden AI output.

## 4. Deployment And Operational Review

- [x] 4.1 Deploy to staging/production and validate ticket lifecycle behavior from portal submission to triage result visibility.
- [x] 4.2 Review telemetry/audit logs to confirm no new silent triage regressions.
- [x] 4.3 Update change notes/runbook with finalized response policy and troubleshooting guidance.
