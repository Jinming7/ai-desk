# Triage Output Governance Runbook

## Policy Summary

- Customer-facing AI triage output MUST be English.
- Any non-empty triage `reply` MUST be persisted into ticket messages as an AI-generated AGENT message.
- Any non-empty triage `reply` MUST move ticket status to `WAITING_CUSTOMER` when transition is valid.
- `action=none` is reserved for true no-op outcomes only (no customer-facing reply).
- Escalation behavior remains unchanged (`escalate` -> `ESCALATED_RND` + `RND_TEAM`).

## Expected Runtime Outcomes

### Case A: `action=ask_user` with reply
- Message persisted (`is_ai_generated=true`)
- Status transitions to `WAITING_CUSTOMER`
- Audit event `ai_triage_replied`

### Case B: `action=none` with reply
- Normalized to customer-facing path
- Message persisted
- Status transitions to `WAITING_CUSTOMER`
- Audit event `ai_triage_replied`

### Case C: `action=none` with empty reply
- No AI message persisted
- Ticket remains in active processing state (`IN_PROGRESS` unless changed elsewhere)
- Audit event `ai_triage_no_action`

## Operational Validation Checklist

1. Check API connectivity:
   - `GET /api/v1/integrations/openclaw/health` returns `ok=true` and `mode=ws`.
2. Submit synthetic placeholder ticket (`title=123`, `description=123456`):
   - Response triage reply is English.
   - Ticket detail includes AI AGENT message.
   - Ticket status is `WAITING_CUSTOMER`.
3. Submit no-op fixture ticket (`none_noop` keyword in test env):
   - No AI AGENT message.
   - Audit contains `ai_triage_no_action`.

## Regression Query (Silent IN_PROGRESS)

Use this query to detect tickets that still have customer-facing AI reply but no persisted AI message:

```sql
SELECT t.ticket_no, t.status, ar.id AS ai_run_id, ar.created_at
FROM tickets t
JOIN ai_runs ar ON ar.ticket_id = t.id
LEFT JOIN ticket_messages tm
  ON tm.ticket_id = t.id
 AND tm.is_ai_generated = true
WHERE t.status = 'IN_PROGRESS'
  AND ar.status = 'completed'
  AND COALESCE(ar.response_json->>'reply', '') <> ''
  AND tm.id IS NULL
ORDER BY ar.created_at DESC
LIMIT 50;
```

Expected result: zero rows.

## Troubleshooting

- Symptom: ticket stuck in `IN_PROGRESS` with no AI message.
  - Check `ai_runs.response_json.reply`.
  - If reply is non-empty, verify triage service version includes reply-first guardrail.
- Symptom: AI response appears in Chinese/non-English.
  - Verify OpenClaw triage prompt includes English-only policy.
  - Re-run ticket and inspect latest `ai_runs.response_json.reply`.
- Symptom: Triages fail and tickets escalate unexpectedly.
  - Check `triageError` payload and `ticket_audit_logs` for `integration_failure`.
  - Confirm OpenClaw token/agent/session env vars are consistent in deployment environment.
