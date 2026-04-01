# Support Workbench Three-Pane Guide

## Guidance-First IA

The support workspace is designed as:

- Pane 1: Smart Queues
- Pane 2: Ticket Cards
- Pane 3: Detail + Actions

Primary operating question sequence:

1. What should I work on now?
2. What context do I need?
3. What is the fastest safe action?

## Smart Queue Definitions

- `SLA At Risk`: resolution SLA less than 2 hours or breached
- `AI Suggested`: AI suggestion pending human confirmation
- `Newly Assigned`: assigned within recent handling window
- `Waiting My Reply`: latest customer message has no later agent reply
- `My All Tickets`: assignee-bound full queue
- `Resolved`: resolved/closed tickets

## Ticket Card Contract

Each card includes:

- Line 1: customer + title (emphasis)
- Line 2: AI summary (fallback summary when missing)
- Line 3: ticket id, assignee, status chip, SLA urgency pill

## Detail & Action Contract

Detail pane includes:

- Core header (ticket + customer + SLA)
- AI insight panel (summary, confidence, trace id, evidence links)
- Timeline
- Action rail (assign, ask customer, escalate, resolve, close)
- Public reply composer
- Internal note composer

## Telemetry Events

Tracked events:

- queue_selected
- ticket_opened
- ai_suggestion_viewed
- ai_suggestion_applied
- ai_suggestion_overridden
- action_executed
- response_sent

## Brand Consistency Check

Checked against `docs/03_Frontend_Design_Standards_Figma.md`.

Result:

- Brand header structure retained: ONES logo + divider + product name.
- Primary action color remains brand blue token usage.
- Status and urgency colors use semantic palettes without introducing ad-hoc brand conflicts.
- Layout typography and spacing follow existing support portal token scale.
