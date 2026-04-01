## Why

The current Support Portal is a feature pile that does not guide agents toward the next best action, so response quality and SLA execution are inconsistent. We need a queue-guided, AI-assisted agent console now to make daily handling faster, clearer, and operationally reliable.

## What Changes

- Rebuild Support Portal into a three-pane `Guidance, not a List` operating model:
- Pane 1: Smart Queues (priority-oriented work buckets)
- Pane 2: Ticket List Cards (context-first summaries with AI digest)
- Pane 3: Detail + Actions (single-workspace handling with AI insight panel)
- Replace table-centric UX with workflow-centric UX that answers:
- What should I do now?
- What context do I need?
- What is the fastest safe action?
- Introduce mandatory smart queue categories:
- `SLA at Risk (<2h)`
- `AI Suggested`
- `Newly Assigned`
- `Waiting My Reply`
- `My All Tickets`
- `Resolved`
- Add card-style ticket list with AI summary snippet and SLA risk pill/progress visualization.
- Add immersive detail workspace with:
- AI insight panel (root-cause, KB links, suggested reply template, one-click adopt)
- conversation timeline
- action rail and reply composer
- Maintain AI-first line policy and manual takeover/escalation path to R&D.
- **BREAKING**: Deprecate legacy support table layout and old queue interaction patterns.

## Capabilities

### New Capabilities
- `support-workbench-three-pane-layout`: Three-pane information architecture and responsive shell for Support Portal.
- `smart-queue-priority-guidance`: Queue derivation logic and UX for SLA risk, AI suggested, new assigned, waiting reply, all, and resolved views.
- `ticket-card-context-list`: Context-first ticket list cards with AI summary and SLA visual indicators.
- `ticket-detail-action-workspace-v2`: Detail page with AI insight module, timeline, action rail, and reply composer in one surface.
- `ai-insight-adoption-flow`: One-click apply for AI suggestions with traceability and operator confirmation.
- `support-portal-guidance-ux-metrics`: Product telemetry for queue usage, action latency, and AI suggestion adoption.

### Modified Capabilities
- None.

## Impact

- Frontend portal layout architecture, navigation, and route-level page composition for `/support`.
- Queue/list/detail components and interaction model across Support Portal.
- API query shape to support smart queues and card summaries (SLA risk + AI suggestion state).
- AI response presentation contract (summary, recommendation template, KB linkage).
- Telemetry and operational analytics for support workflow behavior.
