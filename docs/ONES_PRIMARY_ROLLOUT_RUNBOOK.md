# ONES Primary Rollout Runbook

## Scope
Project-by-project rollout from `local_mirror` to `ones_primary`.

## Preconditions
- Configuration connection test passes.
- Ticket type catalog is refreshed and drift is `NO`.
- Mapping versions for `create/update/transition/comment` are published.
- Webhook endpoint is reachable and replay tested with one sample event.

## Rollout Steps
1. In `/support/admin/configuration` set `data_source_mode=local_mirror` and confirm baseline traffic.
2. Refresh catalog and validate mappings against target ONES project.
3. Enable `ones_primary` for one project and one ticket type.
4. Submit canary tickets from customer portal and verify ONES issue keys are returned.
5. Execute support actions (reply, ask customer, resolve, escalate) and confirm ONES transition/comment updates.
6. Monitor operations panel for failed webhook count and sync errors for 24h.
7. Expand to remaining ticket types, then remaining projects.

## Rollback
1. Switch `data_source_mode` back to `local_mirror`.
2. Pause webhook ingestion worker/replay jobs.
3. Export failed events and sync jobs for postmortem.
4. Reconcile affected ONES tickets manually or via replay after fixes.

## Verification Checklist
- Customer portal ticket types match ONES issue types.
- Ticket creation success path always returns `ones_ticket_key`.
- No silent local-only writes under `ones_primary`.
- Failed webhook events are replayable.
- Drift status is monitored after ONES workflow changes.
