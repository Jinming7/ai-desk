# Frontend E2E Smoke Flow

## Scope
- Customer portal self-serve and ticket loop
- Internal agent queue processing

## Steps
1. Open `http://localhost:5173/`.
2. Verify top navigation has no `Agent Queue` link and no `/agent` hint on customer pages.
3. Search for a known KB phrase and verify answer + citations are rendered.
4. Click `Submit Ticket`, fill required fields, and submit.
5. Verify redirect to `/tickets/:id` and that ticket status is `WAITING_CUSTOMER` or `ESCALATED_RND`.
6. Send a customer reply and verify status becomes `IN_PROGRESS`.
7. Open `http://localhost:5173/agent`.
8. Verify queue loads from API (not static rows), including triage summary/evidence and handoff reason code.
9. Execute one action (`Resolve`, `Ask Customer`, or `Escalate R&D`) and verify status refresh.

## Expected Result
- End-to-end flow is functional without exposing AI identity to customer-facing pages.
