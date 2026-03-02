import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import type { AddressInfo } from "node:net";
import { app } from "../app.js";
import { pool } from "../db/client.js";

let baseUrl = "";
let server: ReturnType<typeof app.listen>;

async function resetDb() {
  await pool.query("DELETE FROM ai_runs");
  await pool.query("DELETE FROM ticket_audit_logs");
  await pool.query("DELETE FROM ticket_messages");
  await pool.query("DELETE FROM tickets");
  await pool.query("DELETE FROM knowledge_documents");
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
  await pool.end();
});

test("SEARCH_MODE returns only verified public knowledge", async () => {
  await pool.query(
    `INSERT INTO knowledge_documents
      (id, title, content, domain, visibility, quality, actionability, product_area, version_range, risk_level)
     VALUES
      ('00000000-0000-0000-0000-000000000001', 'Public Auth Doc', 'reset token for login issue', 'public_kb', 'customer', 'verified', 'howto', 'auth', 'all', 'low'),
      ('00000000-0000-0000-0000-000000000002', 'Internal Runbook', 'reset token for login issue', 'support_runbook', 'internal', 'verified', 'troubleshooting', 'auth', 'all', 'medium')`
  );

  const response = await fetch(`${baseUrl}/api/v1/ai/search`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query: "reset token login issue" })
  });
  assert.equal(response.status, 200);
  const data = (await response.json()) as {
    result: { citations: Array<{ id: string; domain: string }> };
  };

  assert.equal(data.result.citations.length > 0, true);
  assert.deepEqual(
    data.result.citations.map((c) => c.id),
    ["00000000-0000-0000-0000-000000000001"]
  );
});

test("TICKET_MODE escalation transitions ticket to ESCALATED_RND", async () => {
  const created = await fetch(`${baseUrl}/api/v1/tickets`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      title: "Production failed urgently",
      description: "urgent production error failed after deploy",
      serviceCategory: "technical_support",
      priority: "P1",
      customer: { id: "customer_test", name: "Test User" }
    })
  });

  assert.equal(created.status, 201);
  const payload = (await created.json()) as { ticket: { id: string; status: string } };
  const detailRes = await fetch(`${baseUrl}/api/v1/tickets/${payload.ticket.id}`);
  const detail = (await detailRes.json()) as { ticket: { status: string; assignee_name: string } };

  assert.equal(detail.ticket.status, "ESCALATED_RND");
  assert.equal(detail.ticket.assignee_name, "R&D Team");
});

test("customer reply moves WAITING_CUSTOMER ticket back to IN_PROGRESS", async () => {
  const created = await fetch(`${baseUrl}/api/v1/tickets`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      title: "Permission setup help",
      description: "Need help to setup permission for billing role",
      serviceCategory: "account_issue",
      priority: "P3",
      customer: { id: "customer_test_2", name: "Test User" }
    })
  });
  const payload = (await created.json()) as { ticket: { id: string } };

  const reply = await fetch(`${baseUrl}/api/v1/tickets/${payload.ticket.id}/replies`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      body: "Additional logs attached in text.",
      authorType: "CUSTOMER",
      authorName: "Test User"
    })
  });
  assert.equal(reply.status, 204);

  const detailRes = await fetch(`${baseUrl}/api/v1/tickets/${payload.ticket.id}`);
  const detail = (await detailRes.json()) as { ticket: { status: string } };
  assert.equal(detail.ticket.status, "IN_PROGRESS");
});

test("submit lifecycle fallback escalates ticket when triage integration fails", async () => {
  const created = await fetch(`${baseUrl}/api/v1/tickets`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      title: "simulate_openclaw_failure",
      description: "simulate_openclaw_failure while creating ticket",
      serviceCategory: "technical_support",
      priority: "P2",
      customer: { id: "customer_test_3", name: "Test User" }
    })
  });
  assert.equal(created.status, 201);
  const payload = (await created.json()) as { ticket: { id: string }; triageError: string | null };
  assert.equal(Boolean(payload.triageError), true);

  const detailRes = await fetch(`${baseUrl}/api/v1/tickets/${payload.ticket.id}`);
  const detail = (await detailRes.json()) as { ticket: { status: string; assignee_name: string } };
  assert.equal(detail.ticket.status, "ESCALATED_RND");
  assert.equal(detail.ticket.assignee_name, "R&D Team");
});

test("internal-only endpoints reject requests without internal surface header", async () => {
  const created = await fetch(`${baseUrl}/api/v1/tickets`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      title: "Need billing setup",
      description: "Need help to setup permission for billing role",
      serviceCategory: "account_issue",
      priority: "P3",
      customer: { id: "customer_test_4", name: "Test User" }
    })
  });
  const payload = (await created.json()) as { ticket: { id: string } };

  const transitionRes = await fetch(`${baseUrl}/api/v1/tickets/${payload.ticket.id}/transition`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ to: "RESOLVED", reasonCode: "manual_resolution" })
  });
  assert.equal(transitionRes.status, 403);
});
