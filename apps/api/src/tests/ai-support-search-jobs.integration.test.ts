import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import type { AddressInfo } from "node:net";
import http from "node:http";
import { app } from "../app.js";
import { env, isSafeTestDatabaseUrl } from "../config/env.js";
import { pool } from "../db/client.js";
import * as aiRepo from "../modules/ai/repository.js";

let baseUrl = "";
let server: ReturnType<typeof app.listen> | null = null;
const originalCronSecret = env.CRON_SECRET;

function assertSafeTestDatabase() {
  const url = process.env.DATABASE_URL ?? env.DATABASE_URL;
  if (!isSafeTestDatabaseUrl(url)) {
    throw new Error("Refusing to run support search job integration tests against a non-local database");
  }
}

async function resetDb() {
  await pool.query("DELETE FROM ai_support_search_jobs");
  await pool.query("DELETE FROM ai_search_handoff_events");
  await pool.query("DELETE FROM ai_search_ticket_drafts");
  await pool.query("DELETE FROM ai_search_dialog_states");
  await pool.query("DELETE FROM ai_search_escalation_events");
  await pool.query("DELETE FROM ai_search_escalations");
  await pool.query("DELETE FROM ai_search_metrics_events");
  await pool.query("DELETE FROM ai_search_references");
  await pool.query("DELETE FROM ai_search_sessions");
}

before(async () => {
  assertSafeTestDatabase();
  env.CRON_SECRET = "test-cron-secret";
  server = app.listen(0);
  await new Promise<void>((resolve) => server?.once("listening", () => resolve()));
  const { port } = server?.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
});

after(async () => {
  env.CRON_SECRET = originalCronSecret;
  await new Promise<void>((resolve) => server?.close(() => resolve()));
});

beforeEach(async () => {
  await resetDb();
});

test("support search jobs submit, run, expose status, and persist final session state", async () => {
  const submitResponse = await fetch(`${baseUrl}/api/v1/ai/search/jobs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      query: "thisquerywillnotmatchkbx",
      conversation: []
    })
  });

  assert.equal(submitResponse.status, 202);
  const submitted = (await submitResponse.json()) as {
    job: { id: string; sessionId: string; status: string };
  };
  assert.equal(submitted.job.status, "queued");

  const runResponse = await fetch(`${baseUrl}/api/v1/internal/ai/search/jobs/run`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      authorization: "Bearer test-cron-secret"
    },
    body: JSON.stringify({ limit: 1 })
  });

  assert.equal(runResponse.status, 200);

  const statusResponse = await fetch(`${baseUrl}/api/v1/ai/search/jobs/${submitted.job.id}`);
  assert.equal(statusResponse.status, 200);
  const statusPayload = (await statusResponse.json()) as {
    job: {
      id: string;
      sessionId: string;
      status: string;
      result: { session_id: string; answer: string } | null;
    };
  };

  assert.equal(statusPayload.job.id, submitted.job.id);
  assert.equal(statusPayload.job.sessionId, submitted.job.sessionId);
  assert.equal(statusPayload.job.status, "completed");
  assert.equal(statusPayload.job.result?.session_id, submitted.job.sessionId);
  assert.equal(typeof statusPayload.job.result?.answer, "string");
  assert.equal((statusPayload.job.result?.answer ?? "").length > 0, true);

  const persistedSession = await aiRepo.getSearchSessionWithReferences(submitted.job.sessionId);
  assert.ok(persistedSession);
  const dialogState = await aiRepo.getDialogState(submitted.job.sessionId);
  assert.ok(dialogState);
});

test("support search job submission dedupes identical requests onto the same queued job", async () => {
  const sessionId = "d7c9d826-594c-4105-95e6-bbf4210f35b8";
  const payload = {
    sessionId,
    query: "thisquerywillnotmatchkbx",
    conversation: []
  };

  const first = await fetch(`${baseUrl}/api/v1/ai/search/jobs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  assert.equal(first.status, 202);
  const firstBody = (await first.json()) as { job: { id: string; status: string } };

  const second = await fetch(`${baseUrl}/api/v1/ai/search/jobs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  assert.equal(second.status, 202);
  const secondBody = (await second.json()) as { job: { id: string; status: string } };

  assert.equal(secondBody.job.id, firstBody.job.id);
  assert.equal(secondBody.job.status, "queued");
});
