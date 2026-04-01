import assert from "node:assert/strict";
import http from "node:http";
import { app } from "../app.js";
import { env, isSafeTestDatabaseUrl } from "../config/env.js";
import { pool } from "../db/client.js";

async function resetForSmoke() {
  for (const sql of [
    "DELETE FROM ai_search_handoff_events",
    "DELETE FROM ai_search_ticket_drafts",
    "DELETE FROM ai_search_dialog_states",
    "DELETE FROM ai_search_escalation_events",
    "DELETE FROM ai_search_escalations",
    "DELETE FROM ai_search_metrics_events",
    "DELETE FROM ai_search_references",
    "DELETE FROM ai_search_sessions",
    "DELETE FROM ai_runs",
    "DELETE FROM ticket_audit_logs",
    "DELETE FROM ticket_messages",
    "DELETE FROM tickets",
    "DELETE FROM kb_metrics_events",
    "DELETE FROM kb_github_webhook_events",
    "DELETE FROM kb_chunks",
    "DELETE FROM kb_documents",
    "DELETE FROM kb_sync_jobs",
    "DELETE FROM kb_sync_checkpoints",
    "DELETE FROM kb_repo_registrations",
    "DELETE FROM system_settings",
    "INSERT INTO system_settings(key, value_json, updated_by) VALUES ('ai_agent_enabled', '{\"enabled\":true}'::jsonb, 'test')"
  ]) {
    await pool.query(sql);
  }
}

async function main() {
  if (!isSafeTestDatabaseUrl(process.env.DATABASE_URL ?? env.DATABASE_URL)) {
    throw new Error("Refusing to run smoke test against a non-local database");
  }
  await resetForSmoke();

  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to resolve smoke test server address");
  }
  const port = address.port;

  const request = (method: "GET" | "POST", path: string, body?: unknown) =>
    new Promise<{ status: number; json: any }>((resolve, reject) => {
      const req = http.request(
        {
          hostname: "127.0.0.1",
          port,
          path,
          method,
          headers: { "Content-Type": "application/json" }
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
          res.on("end", () => {
            const text = Buffer.concat(chunks).toString("utf8");
            resolve({ status: res.statusCode ?? 500, json: text ? JSON.parse(text) : null });
          });
        }
      );
      req.on("error", reject);
      if (body !== undefined) req.write(JSON.stringify(body));
      req.end();
    });

  try {
    const grounded = await request("POST", "/api/v1/ai/search", { query: "reset api token access" });
    assert.equal(grounded.status, 200);
    assert.equal(grounded.json.result.support_answer.mode, "grounded");
    assert.equal(grounded.json.result.verification.verdict, "verified");
    assert.equal(grounded.json.result.suggested_next_step, "self_serve");
    assert.equal(grounded.json.result.citations.length >= 1, true);

    const partial = await request("POST", "/api/v1/ai/search", { query: "billing admin role denied checkout" });
    assert.equal(partial.status, 200);
    assert.equal(partial.json.result.support_answer.mode, "partial");
    assert.equal(partial.json.result.verification.verdict, "partial");

    const round1 = await request("POST", "/api/v1/ai/search", { query: "thisquerywillnotmatchkbx" });

    assert.equal(round1.json.result.clarification_round, 0);
    assert.equal(round1.json.result.support_answer.mode, "handoff");
    assert.equal(round1.json.result.state, "TICKET_HANDOFF_RECOMMENDED");
    assert.equal(round1.json.result.show_create_ticket_now, true);

    const infrastructureHandoff = await request("POST", "/api/v1/ai/search", { query: "simulate_support_agent_failure" });
    assert.equal(infrastructureHandoff.status, 200);
    assert.equal(infrastructureHandoff.json.result.support_answer.mode, "handoff");
    assert.equal(infrastructureHandoff.json.result.verification.verdict, "unsupported");
    assert.equal(infrastructureHandoff.json.result.retrieval_status, "kb_unavailable");
    assert.equal(infrastructureHandoff.json.result.show_create_ticket_now, true);

    const draft = await request("POST", "/api/v1/ai/handoff/draft", {
      sessionId: round1.json.result.session_id,
      question: "Cannot complete deployment",
      conversation: ["Cannot complete deployment", "Asked for logs", "Pod crashlooping"],
      retrievalTraces: round1.json.result.citations
    });

    assert.equal(draft.status, 201);
    assert.equal(Boolean(draft.json.draft.provenance?.retrieval_outcome?.case_frame), true);
    assert.equal(Boolean(draft.json.draft.provenance?.retrieval_outcome?.verification_summary), true);
    assert.equal(typeof draft.json.draft.provenance?.retrieval_outcome?.evidence_bundle_digest === "string", true);

    const created = await request("POST", "/api/v1/tickets", {
      title: "Production API token issue",
      description: "Customer cannot use API token in production. 401 returned repeatedly.",
      priority: "P3",
      serviceCategory: "technical_support",
      customer: { id: "customer_demo", name: "Acme User" },
      attachments: [],
      environment: "production",
      reproducibility: "always",
      impactSummary: "API integration blocked"
    });

    assert.equal(created.status, 201);
    assert.equal(typeof created.json.triage?.action, "string");

    const detail = await request("GET", `/api/v1/tickets/${created.json.ticket.id}`);
    assert.equal(detail.status, 200);
    assert.equal(typeof detail.json.ticket.triage_support_insight?.recommended_action, "string");
    assert.equal(typeof detail.json.ticket.triage_support_insight?.verifier_verdict, "string");

    const failedSupportAgentTicket = await request("POST", "/api/v1/tickets", {
      title: "simulate_support_agent_failure",
      description: "Customer reports a production issue but KB retrieval is unavailable for the support agent.",
      priority: "P2",
      serviceCategory: "technical_support",
      customer: { id: "customer_demo", name: "Acme User" },
      attachments: [],
      environment: "production",
      reproducibility: "always",
      impactSummary: "Support agent retrieval failed"
    });
    assert.equal(failedSupportAgentTicket.status, 201);
    assert.equal(failedSupportAgentTicket.json.triage?.action, "escalate");
    assert.equal(failedSupportAgentTicket.json.triage?.support_insight?.verifier_verdict, "unsupported");

    console.log(
      JSON.stringify(
        {
          grounded: grounded.json.result.support_answer.mode,
          partial: partial.json.result.support_answer.mode,
          handoff: round1.json.result.support_answer.mode,
          infrastructureHandoff: infrastructureHandoff.json.result.support_answer.mode,
          draft: draft.json.draft.id,
          triage: detail.json.ticket.triage_support_insight?.recommended_action,
          triageInfrastructureFallback: failedSupportAgentTicket.json.triage?.action
        },
        null,
        2
      )
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
