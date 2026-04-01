# AI Search Escalation Rollback Runbook

## Trigger Conditions
- OpenClaw retrieval unavailable for > 15 minutes.
- Escalation jobs stuck in `DEEP_RETRIEVING` > 10%.
- Ticket creation errors sustained > 5% for 15 minutes.

## Rollback Steps
1. Disable `FEATURE_DEEP_RETRIEVAL` to stop agent deep retrieval and auto-branching.
2. Disable `FEATURE_QUICK_TICKET` if escalation endpoint is degraded.
3. Disable `FEATURE_KB_GROUNDED_SEARCH` to return to legacy non-grounded search behavior.
4. Keep API up and preserve historical `ai_search_*` records for audit.

## Verification
- `/api/v1/health` returns 200.
- `/api/v1/ai/search` returns deterministic fallback without references.
- No new `ai_search_escalation_events` rows after deep retrieval flag disabled.

## Recovery
- Re-enable feature flags in reverse order after OpenClaw and queue health is restored.
- Start with 10% traffic and monitor fallback rate for 30 minutes.
