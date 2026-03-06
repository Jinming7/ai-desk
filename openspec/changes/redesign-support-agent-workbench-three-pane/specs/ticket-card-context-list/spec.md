## ADDED Requirements

### Requirement: Ticket list SHALL render context-first cards instead of dense table rows
The middle pane SHALL show ticket cards with summary context optimized for rapid triage.

#### Scenario: Card structure rendering
- **WHEN** list data is returned
- **THEN** each card shows customer + title, AI summary line, and status metadata line

### Requirement: AI summary SHALL be visible on every card
Each card MUST include an AI summary line; if unavailable, system MUST render fallback summary text.

#### Scenario: AI summary available
- **WHEN** ticket has AI reasoning summary
- **THEN** card line 2 displays AI summary text

#### Scenario: AI summary unavailable
- **WHEN** ticket has no AI summary
- **THEN** card line 2 displays fallback placeholder summary

### Requirement: Card status line SHALL include SLA visual urgency
Card line 3 MUST include ticket id, assignee, status, and SLA urgency visualization (pill or progress state).

#### Scenario: SLA visual state
- **WHEN** SLA remaining transitions across thresholds
- **THEN** SLA pill/progress visual changes severity color accordingly
