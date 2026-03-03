import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import type { AddressInfo } from "node:net";
import { app } from "../app.js";
import { pool } from "../db/client.js";

let baseUrl = "";
let server: ReturnType<typeof app.listen>;

async function resetDb() {
  await pool.query("DELETE FROM ai_search_escalation_events");
  await pool.query("DELETE FROM ai_search_escalations");
  await pool.query("DELETE FROM ai_search_metrics_events");
  await pool.query("DELETE FROM ai_search_references");
  await pool.query("DELETE FROM ai_search_sessions");
  await pool.query("DELETE FROM ai_runs");
  await pool.query("DELETE FROM ticket_audit_logs");
  await pool.query("DELETE FROM ticket_messages");
  await pool.query("DELETE FROM tickets");
  await pool.query("DELETE FROM knowledge_documents");
}

async function waitForEscalationTerminal(escalationId: string) {
  for (let i = 0; i < 30; i += 1) {
    const res = await fetch(`${baseUrl}/api/v1/ai/escalations/${escalationId}`);
    assert.equal(res.status, 200);
    const payload = (await res.json()) as {
      escalation: { status: "ESCALATED" | "DEEP_RETRIEVING" | "RESOLVED_BY_AI" | "TICKET_CREATED" };
    };

    if (payload.escalation.status === "RESOLVED_BY_AI" || payload.escalation.status === "TICKET_CREATED") {
      return payload.escalation.status;
    }

    await new Promise((resolve) => setTimeout(resolve, 120));
  }

  throw new Error("Escalation did not reach terminal state in time");
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

test("SEARCH_MODE returns grounded result contract with references", async () => {
  const response = await fetch(`${baseUrl}/api/v1/ai/search`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query: "reset api token access" })
  });
  assert.equal(response.status, 200);

  const data = (await response.json()) as {
    result: {
      session_id: string;
      references: Array<{ documentId: string }>;
      citations: Array<{ id: string }>;
      suggested_next_step: "self_serve" | "submit_ticket";
    };
  };

  assert.equal(typeof data.result.session_id, "string");
  assert.equal(data.result.references.length > 0, true);
  assert.equal(data.result.citations.length, data.result.references.length);
  assert.equal(data.result.suggested_next_step, "self_serve");
});

test("SEARCH_MODE fallback exposes KB_RETRIEVAL_UNAVAILABLE when OpenClaw retrieval fails", async () => {
  const response = await fetch(`${baseUrl}/api/v1/ai/search`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query: "simulate_openclaw_failure" })
  });
  assert.equal(response.status, 200);

  const data = (await response.json()) as {
    result: {
      suggested_next_step: "self_serve" | "submit_ticket";
      unresolved_reason_code: string | null;
      references: unknown[];
    };
  };

  assert.equal(data.result.suggested_next_step, "submit_ticket");
  assert.equal(data.result.unresolved_reason_code, "KB_RETRIEVAL_UNAVAILABLE");
  assert.equal(data.result.references.length, 0);
});

test("quick ticket escalation is idempotent per unresolved session", async () => {
  const searchRes = await fetch(`${baseUrl}/api/v1/ai/search`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query: "thisquerywillnotmatchkbx" })
  });
  const searchData = (await searchRes.json()) as { result: { session_id: string } };

  const body = {
    sessionId: searchData.result.session_id,
    question: "thisquerywillnotmatchkbx",
    conversation: ["thisquerywillnotmatchkbx"],
    reasonCode: "NO_MATCHING_KB"
  };

  const first = await fetch(`${baseUrl}/api/v1/ai/escalations`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  const second = await fetch(`${baseUrl}/api/v1/ai/escalations`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });

  assert.equal(first.status, 201);
  assert.equal(second.status, 201);

  const firstData = (await first.json()) as { escalation: { id: string } };
  const secondData = (await second.json()) as { escalation: { id: string } };
  assert.equal(firstData.escalation.id, secondData.escalation.id);
});

test("agent deep retrieval can auto-resolve escalation", async () => {
  const searchRes = await fetch(`${baseUrl}/api/v1/ai/search`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query: "query-needs-deep-retrieval" })
  });
  const searchData = (await searchRes.json()) as { result: { session_id: string } };

  const createEsc = await fetch(`${baseUrl}/api/v1/ai/escalations`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      sessionId: searchData.result.session_id,
      question: "resolve_fast token login troubleshooting",
      conversation: ["resolve_fast token login troubleshooting"],
      reasonCode: "LOW_CONFIDENCE"
    })
  });
  assert.equal(createEsc.status, 201);

  const escPayload = (await createEsc.json()) as { escalation: { id: string } };
  const terminal = await waitForEscalationTerminal(escPayload.escalation.id);
  assert.equal(terminal, "RESOLVED_BY_AI");
});

test("agent deep retrieval creates formal ticket when unresolved", async () => {
  const searchRes = await fetch(`${baseUrl}/api/v1/ai/search`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query: "random-problem-needing-ticket" })
  });
  const searchData = (await searchRes.json()) as { result: { session_id: string } };

  const createEsc = await fetch(`${baseUrl}/api/v1/ai/escalations`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      sessionId: searchData.result.session_id,
      question: "unresolvable deep investigation request",
      conversation: ["unresolvable deep investigation request"],
      reasonCode: "NO_MATCHING_KB"
    })
  });
  assert.equal(createEsc.status, 201);

  const escPayload = (await createEsc.json()) as { escalation: { id: string } };
  const terminal = await waitForEscalationTerminal(escPayload.escalation.id);
  assert.equal(terminal, "TICKET_CREATED");
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

test("none action with non-empty reply persists message and transitions to WAITING_CUSTOMER", async () => {
  const created = await fetch(`${baseUrl}/api/v1/tickets`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      title: "none_with_reply fixture",
      description: "none_with_reply verify lifecycle",
      serviceCategory: "technical_support",
      priority: "P3",
      customer: { id: "customer_none_reply", name: "Fixture User" }
    })
  });
  assert.equal(created.status, 201);

  const payload = (await created.json()) as {
    ticket: { id: string; status: string };
    triage: { action: string; reply: string } | null;
    triageError: string | null;
  };
  assert.equal(payload.triageError, null);
  assert.equal(payload.ticket.status, "WAITING_CUSTOMER");
  assert.equal(payload.triage?.reply.length ? true : false, true);

  const detail = await fetch(`${baseUrl}/api/v1/tickets/${payload.ticket.id}`);
  assert.equal(detail.status, 200);
  const detailPayload = (await detail.json()) as {
    messages: Array<{ author_type: string; is_ai_generated: boolean; body: string }>;
  };
  const aiMessage = detailPayload.messages.find((msg) => msg.is_ai_generated);
  assert.equal(Boolean(aiMessage), true);
  assert.equal(aiMessage?.author_type, "AGENT");
});

test("none action with empty reply stays no-op and records ai_triage_no_action audit", async () => {
  const created = await fetch(`${baseUrl}/api/v1/tickets`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      title: "none_noop fixture",
      description: "none_noop verify no-op",
      serviceCategory: "technical_support",
      priority: "P3",
      customer: { id: "customer_none_noop", name: "Fixture User" }
    })
  });
  assert.equal(created.status, 201);

  const payload = (await created.json()) as {
    ticket: { id: string; status: string };
    triage: { action: string; reply: string } | null;
    triageError: string | null;
  };
  assert.equal(payload.triageError, null);
  assert.equal(payload.ticket.status, "IN_PROGRESS");
  assert.equal(payload.triage?.action, "none");
  assert.equal(payload.triage?.reply, "");

  const detail = await fetch(`${baseUrl}/api/v1/tickets/${payload.ticket.id}`);
  assert.equal(detail.status, 200);
  const detailPayload = (await detail.json()) as {
    messages: Array<{ is_ai_generated: boolean }>;
  };
  const aiMessages = detailPayload.messages.filter((msg) => msg.is_ai_generated);
  assert.equal(aiMessages.length, 0);

  const audit = await pool.query<{ event_type: string }>(
    "SELECT event_type FROM ticket_audit_logs WHERE ticket_id = $1 ORDER BY created_at DESC LIMIT 3",
    [payload.ticket.id]
  );
  assert.equal(audit.rows.some((row) => row.event_type === "ai_triage_no_action"), true);
});

test("placeholder-content triage reply is English", async () => {
  const created = await fetch(`${baseUrl}/api/v1/tickets`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      title: "123",
      description: "123456",
      serviceCategory: "technical_support",
      priority: "P3",
      customer: { id: "customer_placeholder", name: "Fixture User" }
    })
  });
  assert.equal(created.status, 201);

  const payload = (await created.json()) as {
    triage: { reply: string } | null;
    triageError: string | null;
  };
  assert.equal(payload.triageError, null);
  const reply = payload.triage?.reply ?? "";
  assert.equal(reply.length > 0, true);
  assert.equal(/[\u4e00-\u9fff]/.test(reply), false);
});
