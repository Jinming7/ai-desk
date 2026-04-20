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
const SUPPORT_SEARCH_TEST_LOCK_KEY = 46080401;

function parseSse(text: string): Array<{ event: string; data: string }> {
  return text
    .trim()
    .split("\n\n")
    .map((block) => {
      const event = block
        .split("\n")
        .find((line) => line.startsWith("event:"))
        ?.slice("event:".length)
        .trim();
      const data = block
        .split("\n")
        .find((line) => line.startsWith("data:"))
        ?.slice("data:".length)
        .trim();
      return {
        event: event ?? "",
        data: data ?? ""
      };
    })
    .filter((event) => event.event.length > 0);
}

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
  await pool.query("SELECT pg_advisory_lock($1)", [SUPPORT_SEARCH_TEST_LOCK_KEY]);
  env.CRON_SECRET = "test-cron-secret";
  server = app.listen(0);
  await new Promise<void>((resolve) => server?.once("listening", () => resolve()));
  const { port } = server?.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
});

after(async () => {
  env.CRON_SECRET = originalCronSecret;
  await new Promise<void>((resolve) => server?.close(() => resolve()));
  await pool.query("SELECT pg_advisory_unlock($1)", [SUPPORT_SEARCH_TEST_LOCK_KEY]);
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

test("support search job SSE stream drives a queued job to completion and emits ordered snapshots", async () => {
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

  const streamResponse = await fetch(`${baseUrl}/api/v1/ai/search/jobs/${submitted.job.id}/events`, {
    headers: {
      Accept: "text/event-stream"
    }
  });

  assert.equal(streamResponse.status, 200);
  assert.equal(streamResponse.headers.get("content-type"), "text/event-stream; charset=utf-8");

  const body = await streamResponse.text();
  const events = parseSse(body);
  const snapshots = events
    .filter((event) => event.event === "job_snapshot")
    .map((event) => JSON.parse(event.data) as { job: { status: string; result: { answer?: string } | null } });

  assert.equal(snapshots.length >= 2, true);
  assert.equal(snapshots[0]?.job.status, "queued");
  assert.equal(snapshots.at(-1)?.job.status, "completed");
  assert.equal(typeof snapshots.at(-1)?.job.result?.answer, "string");
  assert.equal(events.at(-1)?.event, "job_completed");
});

test("support search polling fallback can drive a queued job and read the same completed job truth", async () => {
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

  const driveResponse = await fetch(`${baseUrl}/api/v1/ai/search/jobs/${submitted.job.id}/drive`, {
    method: "POST"
  });
  assert.equal(driveResponse.status, 202);
  const driven = (await driveResponse.json()) as {
    job: { id: string; status: string; result: { session_id?: string; answer?: string } | null };
  };

  const statusResponse = await fetch(`${baseUrl}/api/v1/ai/search/jobs/${submitted.job.id}`);
  assert.equal(statusResponse.status, 200);
  const statusPayload = (await statusResponse.json()) as {
    job: {
      id: string;
      sessionId: string;
      status: string;
      result: { session_id?: string; answer?: string } | null;
    };
  };

  assert.equal(driven.job.id, submitted.job.id);
  assert.equal(statusPayload.job.id, submitted.job.id);
  assert.equal(statusPayload.job.status, "completed");
  assert.equal(statusPayload.job.result?.session_id, submitted.job.sessionId);
  assert.equal(driven.job.result?.session_id, statusPayload.job.result?.session_id);
  assert.equal(driven.job.result?.answer, statusPayload.job.result?.answer);
});

test("support search drive endpoint can recover a stale running job and complete it", async () => {
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

  await pool.query(
    `UPDATE ai_support_search_jobs
     SET status = 'running',
         lease_key = 'expired-lease',
         lease_expires_at = NOW() - INTERVAL '2 minutes',
         worker_id = 'dead-worker',
         updated_at = NOW() - INTERVAL '2 minutes'
     WHERE id = $1`,
    [submitted.job.id]
  );

  const driveResponse = await fetch(`${baseUrl}/api/v1/ai/search/jobs/${submitted.job.id}/drive`, {
    method: "POST"
  });
  assert.equal(driveResponse.status, 202);

  const driven = (await driveResponse.json()) as {
    job: { id: string; sessionId: string; status: string; result: { session_id?: string; answer?: string } | null };
  };

  assert.equal(driven.job.id, submitted.job.id);
  assert.equal(driven.job.status, "completed");
  assert.equal(driven.job.result?.session_id, submitted.job.sessionId);
  assert.equal(typeof driven.job.result?.answer, "string");
  assert.equal((driven.job.result?.answer ?? "").length > 0, true);
});

test("support search drive endpoint can recover a running job stuck at job_claimed even when the lease is still active", async () => {
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

  await pool.query(
    `UPDATE ai_support_search_jobs
     SET status = 'running',
         lease_key = 'live-lease',
         lease_expires_at = NOW() + INTERVAL '2 minutes',
         worker_id = 'stuck-worker',
         started_at = NOW() - INTERVAL '2 minutes',
         updated_at = NOW(),
         stage_state_json = $2::jsonb
     WHERE id = $1`,
    [
      submitted.job.id,
      JSON.stringify({
        currentStage: "run_search_mode",
        lastCompletedStage: "job_claimed"
      })
    ]
  );

  const driveResponse = await fetch(`${baseUrl}/api/v1/ai/search/jobs/${submitted.job.id}/drive`, {
    method: "POST"
  });
  assert.equal(driveResponse.status, 202);

  const driven = (await driveResponse.json()) as {
    job: { id: string; sessionId: string; status: string; result: { session_id?: string; answer?: string } | null };
  };

  assert.equal(driven.job.id, submitted.job.id);
  assert.equal(driven.job.status, "completed");
  assert.equal(driven.job.result?.session_id, submitted.job.sessionId);
  assert.equal(typeof driven.job.result?.answer, "string");
  assert.equal((driven.job.result?.answer ?? "").length > 0, true);
});
