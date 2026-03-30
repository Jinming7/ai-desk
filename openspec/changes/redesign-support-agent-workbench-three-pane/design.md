## Context

Current support experience is still list-centric and action-fragmented. Agents need to scan too many controls before knowing priority, context, and next action. This redesign introduces a guidance-first three-pane operating model so the UI works like an intelligent copilot rather than a generic admin table.

Constraints:
- Keep existing AI-first + manual takeover architecture.
- Keep Support Portal as internal-only surface.
- Reuse current ticket, AI, and SLA backend where possible and extend minimal contracts for smart queue and card summary.
- Conform to workspace design standards in `docs/03_Frontend_Design_Standards_Figma.md`.

Stakeholders:
- Support agents, support leads, R&D handoff owners, operations owners tracking SLA health.

## Goals / Non-Goals

**Goals:**
- Deliver a true three-pane workbench that answers in sequence: priority -> context -> action.
- Make smart queues the primary navigation for agent attention management.
- Show AI digest and suggestion directly inside list/detail to reduce context switching.
- Keep detail handling immersive and complete: timeline, AI insight, quick actions, response composer in one place.
- Add behavior telemetry for adoption and operational quality.

**Non-Goals:**
- No full redesign of customer portal in this change.
- No replacement of backend ticket state machine semantics.
- No expansion into non-support ITSM domains (problem/change/release).

## Decisions

### 1) Three-pane shell as default support information architecture
Decision:
- Introduce persistent left pane (Smart Queues), middle pane (Ticket Cards), right pane (Detail & Action).
- Right pane loads selected ticket inline instead of route navigation for primary flow; route deep-link remains supported.

Rationale:
- Reduces page-jump cost and preserves triage context while acting on tickets.

Alternatives considered:
- Keep two-step list -> full-page detail navigation: rejected due to slower handling loops.
- Keep full-width table: rejected as anti-guidance and high cognitive load.

### 2) Smart queues as first-class work planner
Decision:
- Queue set is fixed in MVP with explicit derived filters:
- `SLA_AT_RISK` (<2h)
- `AI_SUGGESTED`
- `NEW_ASSIGNED`
- `WAITING_MY_REPLY`
- `MY_ALL`
- `RESOLVED`
- Queue badges are server-provided counts for real-time workload awareness.

Rationale:
- Agents decide what to do from meaningful work buckets, not raw status lists.

Alternatives considered:
- User-defined arbitrary queues in MVP: rejected due to higher complexity; can be V1.5 extension.

### 3) Ticket list cards replace dense table rows
Decision:
- Middle pane uses card summaries:
- line 1: customer + title
- line 2: AI summary (mandatory fallback text when unavailable)
- line 3: ticket id, assignee, SLA pill/progress, status chip
- Sorting defaults to SLA urgency then update recency.

Rationale:
- Fast scanning and triage confidence improve when context is summarized, not spread across columns.

Alternatives considered:
- Keep tabular format with added columns: rejected because readability drops under high volume.

### 4) AI insight panel is a dedicated detail module
Decision:
- Right pane includes a highlighted AI Insight panel with:
- root-cause summary
- referenced KB article links
- suggestion template with one-click apply
- trace id and confidence
- Apply action requires explicit operator click and logs an audit event.

Rationale:
- AI guidance must be visible, explainable, and actionable while preserving human accountability.

Alternatives considered:
- Place AI hints inside generic timeline only: rejected because low discoverability and adoption.

### 5) Action-centric detail workflow
Decision:
- Action rail remains fixed and contains status transitions, assignment, escalation, and close/resolve controls.
- Reply composer at bottom supports customer response workflow with context retention.
- Internal note and public reply are separate channels.

Rationale:
- Agent handling should not require modal hopping or route hopping.

### 6) Telemetry and quality feedback loop
Decision:
- Add events: queue_selected, card_opened, ai_suggestion_viewed, ai_suggestion_applied, action_executed, response_sent.
- Compute derived KPI inputs: first-action latency, AI suggestion adoption rate, SLA-at-risk drain rate.

Rationale:
- Product quality for agent tooling must be measured by handling behavior, not only backend uptime.

## Risks / Trade-offs

- [Risk] Three-pane density may reduce readability on smaller screens -> Mitigation: responsive collapse to two-pane on tablet and stack on mobile.
- [Risk] AI summary quality inconsistency may reduce trust -> Mitigation: mandatory evidence links + fallback copy + one-click override.
- [Risk] Queue counts may drift under high write load -> Mitigation: compute from consistent query path and refresh interval.
- [Risk] More UI state in one screen increases complexity -> Mitigation: centralized store for selected queue/ticket and deterministic state transitions.

## Migration Plan

1. Build new three-pane support shell behind feature flag.
2. Implement smart queue API aggregation and queue badge counts.
3. Replace existing list UI with ticket cards while reusing selection and transition endpoints.
4. Add detail AI insight panel and action integration.
5. Roll out telemetry hooks and validate KPI collection.
6. Enable new shell by default and keep temporary fallback to legacy route for rollback window.

Rollback:
- Toggle feature flag back to legacy support list/detail pages.

## Open Questions

- Should `AI_SUGGESTED` queue include only high-confidence suggestions or all pending suggestions with confidence badge?
- Whether to add keyboard triage shortcuts in MVP or defer to next iteration.
- Final visual treatment for SLA pill (color thresholds + progress behavior) pending design QA pass.
