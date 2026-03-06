## 1. Product Contract And Data Baseline

- [x] 1.1 Define and document MVP manual loop status/state contract for both portals (OPEN/IN_PROGRESS/WAITING_CUSTOMER/RESOLVED/CLOSED/ESCALATED_RND).
- [x] 1.2 Add persisted system setting for `ai_agent_enabled` with default `true` and audit metadata.
- [x] 1.3 Define minimum required ticket form fields for customer and management portal submission contracts.

## 2. Backend Routing And Workflow

- [x] 2.1 Add admin API to read/update AI Agent toggle state with auth checks and audit logging.
- [x] 2.2 Implement submit-workflow branch: AI enabled -> existing AI-first path; AI disabled -> direct `RND_TEAM` + `IN_PROGRESS` + bypass audit event.
- [x] 2.3 Ensure manual communication loop transitions are deterministic (`WAITING_CUSTOMER` on handler clarification, `IN_PROGRESS` on customer reply).
- [x] 2.4 Preserve and validate existing escalation branch behavior while adding AI-off routing.

## 3. Management Portal MVP Completeness

- [x] 3.1 Implement AI Agent ON/OFF control panel with current mode badge and last-updated info.
- [x] 3.2 Implement/complete management-side create-ticket form (required fields + validation + submission success state).
- [x] 3.3 Implement/complete queue and detail operations: assign/reassign, transition, reply, resolve/close, audit timeline visibility.
- [x] 3.4 Add UX safeguards for manual mode so operators clearly see tickets are routed directly to R&D.

## 4. Customer Portal Compatibility

- [x] 4.1 Ensure customer submission flow remains stable under both AI modes with consistent API payload/validation behavior.
- [x] 4.2 Ensure customer timeline/status/SLA views render consistently for manually handled tickets (no AI-only assumptions).
- [x] 4.3 Ensure customer replies correctly move ticket back into active manual handling loop.

## 5. Quality, Release, And Runbook

- [x] 5.1 Add integration tests for AI ON/OFF routing branch behavior at ticket creation.
- [x] 5.2 Add integration tests for full manual R&D closure loop (submit -> in-progress -> waiting customer -> resolved -> closed).
- [x] 5.3 Add portal-level route/interaction tests for management operations and customer compatibility.
- [x] 5.4 Publish runbook updates for AI toggle operations, manual mode handling, and troubleshooting checks.
- [x] 5.5 Deploy to staging/production and complete end-to-end verification with at least one AI ON and one AI OFF ticket flow.
