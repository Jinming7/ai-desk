## ADDED Requirements

### Requirement: AI triage SHALL always return an actionable decision
The AI orchestration contract SHALL only allow actions `ask_user`, `resolve`, or `escalate`. The system MUST reject or coerce invalid/missing actions, and MUST never leave tickets in silent in-progress due to `none` decisions.

#### Scenario: Invalid action fallback
- **WHEN** AI provider response contains missing or unsupported action
- **THEN** the backend converts the outcome to `ask_user`, records `fallback_applied=true`, and posts a deterministic customer-safe reply

### Requirement: AI customer-facing replies SHALL be English-only
All AI-generated customer-facing replies MUST be rendered in English regardless of input language, unless localization is explicitly enabled by policy in future versions.

#### Scenario: Non-English model output normalization
- **WHEN** the model returns non-English customer reply text
- **THEN** the system regenerates or translates the reply to English before posting to ticket conversation

### Requirement: AI recommendations SHALL be transparent and actionable in UI
Ticket Detail and queue preview SHALL show AI recommendation cards containing confidence, evidence references, suggested action, and one-click apply controls.

#### Scenario: Recommendation card rendering
- **WHEN** an AI triage run completes
- **THEN** the detail page shows action recommendation, confidence score, and cited evidence references

#### Scenario: One-click apply
- **WHEN** a support user clicks `Apply AI Suggestion`
- **THEN** the suggested action is executed and the timeline logs operator identity and applied trace ID

### Requirement: AI operations SHALL be fully traceable and reversible
Every AI run SHALL persist trace metadata and SHALL support human override with explicit reason.

#### Scenario: Trace persistence
- **WHEN** AI run completes for a ticket
- **THEN** the system stores trace ID, model, confidence, evidence refs, raw payload hash, and action decision

#### Scenario: Human override
- **WHEN** a support user overrides an AI suggested escalation
- **THEN** the system applies the manual decision and records override reason linked to the same trace ID
