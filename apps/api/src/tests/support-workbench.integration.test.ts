import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import type { AddressInfo } from "node:net";
import { app } from "../app.js";
import { pool } from "../db/client.js";

let baseUrl = "";
let server: ReturnType<typeof app.listen>;

async function resetDb() {
  await pool.query("DELETE FROM support_ux_events");
  await pool.query("DELETE FROM ai_runs");
  await pool.query("DELETE FROM ticket_audit_logs");
  await pool.query("DELETE FROM ticket_messages");
  await pool.query("DELETE FROM tickets");
}

before(async () => {
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
});

beforeEach(async () => {
  await resetDb();
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

test("smart queue returns SLA at risk subset", async () => {
  const create = async (title: string, desc: string) =>
    fetch(`${baseUrl}/api/v1/tickets`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title,
        description: desc,
        priority: "P3",
        customer: { id: `c-${title}`, name: "Fixture User" }
      })
    });

  await create("ticket-a", "desc-a");
  await create("ticket-b", "desc-b");
  await pool.query("UPDATE tickets SET resolution_due_at = NOW() + INTERVAL '30 minutes'");

  const res = await fetch(`${baseUrl}/api/v1/support/tickets?queue=sla_at_risk&sort=sla_risk`, {
    headers: { "x-portal-surface": "internal" }
  });
  assert.equal(res.status, 200);
  const payload = (await res.json()) as { tickets: Array<{ sla_risk: string }> };
  assert.equal(payload.tickets.length >= 1, true);
  assert.equal(payload.tickets.every((t) => t.sla_risk === "at_risk" || t.sla_risk === "breached"), true);
});

test("queue counts endpoint exposes smart queue badges", async () => {
  await fetch(`${baseUrl}/api/v1/tickets`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      title: "queue-count",
      description: "queue-count-desc",
      priority: "P3",
      customer: { id: "queue-count", name: "Fixture User" }
    })
  });

  const res = await fetch(`${baseUrl}/api/v1/support/queue-counts`, {
    headers: { "x-portal-surface": "internal" }
  });
  assert.equal(res.status, 200);
  const payload = (await res.json()) as { counts: Record<string, number> };
  assert.equal(typeof payload.counts.sla_at_risk, "number");
  assert.equal(typeof payload.counts.my_all, "number");
});

test("support ux events are accepted and metrics endpoint returns summary", async () => {
  const ev = await fetch(`${baseUrl}/api/v1/internal/support/ux-events`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-portal-surface": "internal" },
    body: JSON.stringify({
      actor: "support_user",
      eventType: "ai_suggestion_applied",
      queueKey: "ai_suggested"
    })
  });
  assert.equal(ev.status, 204);

  const metrics = await fetch(`${baseUrl}/api/v1/internal/support/ux-metrics`, {
    headers: { "x-portal-surface": "internal" }
  });
  assert.equal(metrics.status, 200);
  const payload = (await metrics.json()) as { metrics: Record<string, number> };
  assert.equal(typeof payload.metrics.aiSuggestionAdoptionRate, "number");
});
