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
  await pool.query("DELETE FROM ones_webhook_events");
  await pool.query("DELETE FROM ones_sync_jobs");
  await pool.query("DELETE FROM ones_field_mappings");
  await pool.query("DELETE FROM ones_ticket_type_cache");
  await pool.query("DELETE FROM ones_sync_config");
  await pool.query("DELETE FROM ones_sync_audit_logs");
  await pool.query("DELETE FROM ticket_audit_logs");
  await pool.query("DELETE FROM ticket_messages");
  await pool.query("DELETE FROM tickets");
  await pool.query("DELETE FROM system_settings");
  await pool.query(
    "INSERT INTO system_settings(key, value_json, updated_by) VALUES ('ai_agent_enabled', '{\"enabled\":true}'::jsonb, 'test') ON CONFLICT (key) DO UPDATE SET value_json=EXCLUDED.value_json, updated_by=EXCLUDED.updated_by, updated_at=NOW()"
  );
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

test("AI mode OFF routes new ticket directly to R&D manual flow", async () => {
  const switchMode = await fetch(`${baseUrl}/api/v1/internal/settings/ai-agent`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", "x-portal-surface": "internal" },
    body: JSON.stringify({ enabled: false, actor: "integration_test" })
  });
  assert.equal(switchMode.status, 200);

  const created = await fetch(`${baseUrl}/api/v1/tickets`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      title: "manual route check",
      description: "create in ai-off mode",
      serviceCategory: "technical_support",
      priority: "P2",
      customer: { id: "customer_manual_1", name: "Manual User", email: "manual@example.com" },
      environment: "production",
      reproducibility: "always",
      impactSummary: "Cannot use core function"
    })
  });
  assert.equal(created.status, 201);
  const payload = (await created.json()) as { ticket: { status: string; assignee_name: string }; triage: unknown };
  assert.equal(payload.ticket.status, "IN_PROGRESS");
  assert.equal(payload.ticket.assignee_name, "R&D Team");
  assert.equal(payload.triage, null);
});

test("ONES mapping dry-run rejects missing required fields from schema cache", async () => {
  await pool.query(
    `INSERT INTO ones_ticket_type_cache (id, type_key, type_name, fields_json, source_json)
     VALUES ('11111111-1111-4111-8111-111111111111', 'incident', 'Incident', $1::jsonb, '{}'::jsonb)`,
    [JSON.stringify([{ key: "title", required: true }, { key: "details", required: true }])]
  );

  const res = await fetch(`${baseUrl}/api/v1/internal/ones-sync/mappings/validate`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-portal-surface": "internal" },
    body: JSON.stringify({
      ticketTypeKey: "incident",
      flow: "create",
      mappings: [{ source: "title", target: "title", transform: "none", transformConfig: {}, requiredPolicy: "hard_fail" }],
      sampleContext: { title: "hello" }
    })
  });
  assert.equal(res.status, 200);
  const payload = (await res.json()) as { validation: { valid: boolean; errors: string[] } };
  assert.equal(payload.validation.valid, false);
  assert.equal(payload.validation.errors.some((e) => e.includes("Required ONES field is not mapped: details")), true);
});

test("ONES webhook ingestion is idempotent and updates local read model", async () => {
  await pool.query(
    `INSERT INTO tickets (
      id, ticket_no, title, description, service_category, priority, status, customer_id, customer_name, assignee_type, assignee_name,
      ones_ticket_key, ones_ticket_type_key
    ) VALUES (
      '22222222-2222-4222-8222-222222222222', 'T-TEST-ONES', 'x', 'y', 'technical_support', 'P3', 'OPEN', 'c1', 'C1', 'SUPPORT_TEAM', 'Support Team',
      'ONES-123', 'incident'
    )`
  );

  const body = {
    eventId: "evt-1",
    eventType: "issue.updated",
    ticketKey: "ONES-123",
    payload: { status: "IN_PROGRESS", assigneeName: "R&D Team", commentBody: "synced from webhook" }
  };

  const r1 = await fetch(`${baseUrl}/api/v1/internal/configuration/webhook/ingest`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  const r2 = await fetch(`${baseUrl}/api/v1/internal/configuration/webhook/ingest`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  assert.equal(r1.status, 202);
  assert.equal(r2.status, 202);

  const ticket = await pool.query<{ status: string; assignee_name: string }>("SELECT status, assignee_name FROM tickets WHERE ones_ticket_key = 'ONES-123'");
  assert.equal(ticket.rows[0].status, "IN_PROGRESS");
  assert.equal(ticket.rows[0].assignee_name, "R&D Team");

  const events = await pool.query<{ count: string }>(
    "SELECT COUNT(*)::text AS count FROM ones_webhook_events WHERE external_event_id = 'evt-1' AND event_type = 'issue.updated' AND ones_ticket_key = 'ONES-123'"
  );
  assert.equal(events.rows[0].count, "1");
});

test("manual R&D closure loop supports handler waiting, customer resume, resolve and close", async () => {
  const switchMode = await fetch(`${baseUrl}/api/v1/internal/settings/ai-agent`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", "x-portal-surface": "internal" },
    body: JSON.stringify({ enabled: false, actor: "integration_test" })
  });
  assert.equal(switchMode.status, 200);

  const created = await fetch(`${baseUrl}/api/v1/tickets`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      title: "manual closure loop",
      description: "Need manual R&D handling",
      serviceCategory: "technical_support",
      priority: "P3",
      customer: { id: "customer_manual_2", name: "Manual User 2" }
    })
  });
  const payload = (await created.json()) as { ticket: { id: string } };
  const ticketId = payload.ticket.id;

  const handlerReply = await fetch(`${baseUrl}/api/v1/tickets/${ticketId}/replies`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-portal-surface": "internal" },
    body: JSON.stringify({
      body: "Please provide logs and exact timestamps.",
      authorType: "AGENT",
      authorName: "R&D Team",
      attachments: []
    })
  });
  assert.equal(handlerReply.status, 204);

  const waitingDetail = await fetch(`${baseUrl}/api/v1/tickets/${ticketId}`);
  const waitingPayload = (await waitingDetail.json()) as { ticket: { status: string } };
  assert.equal(waitingPayload.ticket.status, "WAITING_CUSTOMER");

  const customerReply = await fetch(`${baseUrl}/api/v1/tickets/${ticketId}/replies`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      body: "Providing requested logs and screenshot.",
      authorType: "CUSTOMER",
      authorName: "Manual User 2",
      attachments: []
    })
  });
  assert.equal(customerReply.status, 204);

  const detail = await fetch(`${baseUrl}/api/v1/tickets/${ticketId}`);
  assert.equal(detail.status, 200);
  const detailPayload = (await detail.json()) as { ticket: { status: string } };
  assert.equal(detailPayload.ticket.status, "IN_PROGRESS");

  const resolveRes = await fetch(`${baseUrl}/api/v1/tickets/${ticketId}/transition`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-portal-surface": "internal" },
    body: JSON.stringify({ to: "RESOLVED", reasonCode: "manual_resolution" })
  });
  assert.equal(resolveRes.status, 204);

  const closeRes = await fetch(`${baseUrl}/api/v1/tickets/${ticketId}/close`, { method: "POST" });
  assert.equal(closeRes.status, 204);

  const closedDetail = await fetch(`${baseUrl}/api/v1/tickets/${ticketId}`);
  const closedPayload = (await closedDetail.json()) as { ticket: { status: string } };
  assert.equal(closedPayload.ticket.status, "CLOSED");
});
