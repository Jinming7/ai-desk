import assert from "node:assert/strict";
import test from "node:test";
import { reduceWorkbenchState } from "../src/pages/supportWorkbenchState";

test("queue selection resets selected ticket", () => {
  const next = reduceWorkbenchState(
    { queue: "my_all", selectedTicketId: "ticket-1" },
    { type: "queue_selected", queue: "sla_at_risk" }
  );
  assert.equal(next.queue, "sla_at_risk");
  assert.equal(next.selectedTicketId, null);
});

test("ticket selection keeps active queue", () => {
  const next = reduceWorkbenchState(
    { queue: "ai_suggested", selectedTicketId: null },
    { type: "ticket_selected", ticketId: "ticket-2" }
  );
  assert.equal(next.queue, "ai_suggested");
  assert.equal(next.selectedTicketId, "ticket-2");
});
