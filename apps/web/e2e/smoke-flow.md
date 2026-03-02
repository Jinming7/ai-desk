# Frontend E2E Smoke Flow

## Scope
- Customer portal self-serve and ticket loop
- Internal agent queue processing

## Steps
1. Open `http://localhost:5173/`.
2. Search for a known KB phrase and verify answer + citations are rendered.
3. Click `Submit Ticket`, fill required fields, and submit.
4. Verify redirect to `/tickets/:id` and that ticket status is `WAITING_CUSTOMER` or `ESCALATED_RND`.
5. Send a customer reply and verify status becomes `IN_PROGRESS`.
6. Open `http://localhost:5173/agent`.
7. Verify queue loads from API (not static rows), including triage summary/evidence block.
8. Execute one action (`Resolve`, `Ask Customer`, or `Escalate R&D`) and verify status refresh.

## Expected Result
- End-to-end flow is functional without exposing AI identity to customer-facing pages.
