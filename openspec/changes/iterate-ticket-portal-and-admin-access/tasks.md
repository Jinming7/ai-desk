## 1. Portal Boundary and Access

- [x] 1.1 Add explicit customer vs internal portal route map and guards in `apps/web` navigation
- [x] 1.2 Document management portal access in README (`npm run dev` + open `/agent`)
- [x] 1.3 Add a lightweight internal-access gate for `/agent` (env flag or temporary passcode) for MVP safety

## 2. Customer Ticket Portal Completion

- [x] 2.1 Complete search-first UX: loading/empty/error/result states and citation rendering
- [x] 2.2 Complete ticket submission form validation (required fields, category, attachments placeholder behavior)
- [x] 2.3 Implement post-submit UX: success state and redirect to newly created ticket detail
- [x] 2.4 Complete requests page filters and status labels for new lifecycle states
- [x] 2.5 Complete ticket detail reply flow with optimistic update and failure recovery

## 3. AI Orchestration and Backend Contracts

- [x] 3.1 Finalize `POST /api/v1/ai/search` contract for SEARCH_MODE with strict public knowledge filter
- [x] 3.2 Finalize `POST /api/v1/tickets/:id/ai/triage` contract for TICKET_MODE action mapping (`resolve|ask_user|escalate|none`)
- [x] 3.3 Ensure triage-generated customer-visible reply author is always `Support Team`
- [x] 3.4 Persist triage metadata (action/confidence/evidence) to audit logs for internal visibility
- [x] 3.5 Add OpenClaw failure fallback path: transition to `ESCALATED_RND` with reason logging

## 4. Internal Agent Portal Completion

- [x] 4.1 Replace static dashboard rows with real queue API data
- [x] 4.2 Implement pending/mine/all queue tabs with server-backed filters
- [x] 4.3 Add ticket action controls (transition, assign, escalate marker) for internal workflow
- [x] 4.4 Display triage summary/evidence panel for manual takeover context

## 5. Verification and Release Readiness

- [x] 5.1 Add API integration tests for search and triage endpoints including failure cases
- [x] 5.2 Add frontend E2E smoke flow: search -> submit -> triage -> waiting customer -> customer reply
- [x] 5.3 Run migration + build validation in CI and update release checklist
