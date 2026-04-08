import assert from "node:assert/strict";
import crypto from "node:crypto";
import { afterEach, before, test } from "node:test";
import { env, isSafeTestDatabaseUrl } from "../../config/env.js";
import { pool } from "../../db/client.js";
import {
  SUPPORT_SEARCH_JOB_LEASE_INVALID_MESSAGE,
  claimDueSupportSearchJobs,
  enqueueSupportSearchJob,
  getSupportSearchJob,
  heartbeatSupportSearchJob,
  markSupportSearchJobFailed,
  markSupportSearchJobSucceeded,
  requeueStaleRunningSupportSearchJobs
} from "./support-search-jobs.js";

function assertSafeTestDatabase() {
  const url = process.env.DATABASE_URL ?? env.DATABASE_URL;
  if (!isSafeTestDatabaseUrl(url)) {
    throw new Error("Refusing to run support search job tests against a non-local database");
  }
}

async function resetSupportSearchJobs() {
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

before(() => {
  assertSafeTestDatabase();
});

afterEach(async () => {
  await resetSupportSearchJobs();
});

function buildRequestKey(sessionId: string, suffix: string) {
  return `support-search:${sessionId}:${suffix}`;
}

function buildJobInput(sessionId = crypto.randomUUID(), suffix = "round-1") {
  return {
    sessionId,
    requestKey: buildRequestKey(sessionId, suffix),
    query: "Which Linux distributions are officially supported?",
    answerLanguage: "en" as const,
    currentRound: 0,
    conversation: [] as Array<{ role: "user" | "assistant"; content: string }>,
    attachments: [] as string[],
    maxAttempts: 3
  };
}

test("enqueueSupportSearchJob dedupes identical requests and rejects concurrent active jobs for the same session", async () => {
  const input = buildJobInput();
  const queued = await enqueueSupportSearchJob(input);
  const deduped = await enqueueSupportSearchJob(input);

  assert.equal(deduped.id, queued.id);
  assert.equal(deduped.status, "queued");

  await assert.rejects(
    enqueueSupportSearchJob({
      ...input,
      requestKey: buildRequestKey(input.sessionId, "round-2"),
      query: "A different pending question"
    }),
    /active support search job/i
  );
});

test("support search jobs can be claimed, heartbeated, retried, and completed durably", async () => {
  const queued = await enqueueSupportSearchJob(buildJobInput());
  const claimed = await claimDueSupportSearchJobs({
    limit: 1,
    leaseMs: 60_000,
    workerId: "test-worker"
  });

  assert.equal(claimed.length, 1);
  assert.equal(claimed[0].id, queued.id);
  assert.equal(claimed[0].status, "running");
  assert.ok(claimed[0].leaseKey);
  const claimedLeaseKey = claimed[0].leaseKey;

  await heartbeatSupportSearchJob({
    jobId: claimed[0].id,
    leaseKey: claimedLeaseKey,
    stageState: {
      currentStage: "planner",
      lastCompletedStage: "route"
    }
  });

  const heartbeated = await getSupportSearchJob(claimed[0].id);
  assert.equal(heartbeated?.status, "running");
  assert.deepEqual(heartbeated?.stageState, {
    currentStage: "planner",
    lastCompletedStage: "route"
  });

  await markSupportSearchJobFailed({
    jobId: claimed[0].id,
    leaseKey: claimedLeaseKey,
    errorMessage: "planner timeout",
    retryable: true,
    retryDelaySeconds: 0
  });

  const failed = await getSupportSearchJob(claimed[0].id);
  assert.equal(failed?.status, "failed_retryable");
  assert.equal(failed?.attempts, 1);

  const reclaimed = await claimDueSupportSearchJobs({
    limit: 1,
    leaseMs: 60_000,
    workerId: "test-worker"
  });
  assert.equal(reclaimed.length, 1);
  assert.equal(reclaimed[0].id, claimed[0].id);
  assert.ok(reclaimed[0].leaseKey);
  const reclaimedLeaseKey = reclaimed[0].leaseKey;

  await markSupportSearchJobSucceeded({
    jobId: reclaimed[0].id,
    leaseKey: reclaimedLeaseKey,
    result: {
      session_id: queued.sessionId,
      answer: "Supported Linux distributions are documented in the deployment requirements guide."
    },
    stageState: {
      currentStage: "completed",
      lastCompletedStage: "answer_composition"
    }
  });

  const completed = await getSupportSearchJob(reclaimed[0].id);
  assert.equal(completed?.status, "completed");
  assert.equal(completed?.result?.answer, "Supported Linux distributions are documented in the deployment requirements guide.");
});

test("heartbeatSupportSearchJob rejects once the running lease is no longer owned by the worker", async () => {
  const queued = await enqueueSupportSearchJob(buildJobInput());
  const claimed = await claimDueSupportSearchJobs({
    limit: 1,
    leaseMs: 60_000,
    workerId: "test-worker"
  });

  assert.equal(claimed.length, 1);
  assert.ok(claimed[0].leaseKey);

  await pool.query(
    `UPDATE ai_support_search_jobs
     SET lease_key = $2,
         updated_at = NOW()
     WHERE id = $1`,
    [queued.id, "replacement-lease"]
  );

  await assert.rejects(
    heartbeatSupportSearchJob({
      jobId: claimed[0].id,
      leaseKey: claimed[0].leaseKey!,
      stageState: {
        currentStage: "planner",
        lastCompletedStage: "route"
      }
    }),
    new RegExp(SUPPORT_SEARCH_JOB_LEASE_INVALID_MESSAGE, "i")
  );
});

test("requeueStaleRunningSupportSearchJobs returns expired running jobs back to queued state", async () => {
  const queued = await enqueueSupportSearchJob(buildJobInput());
  const claimed = await claimDueSupportSearchJobs({
    limit: 1,
    leaseMs: 1_000,
    workerId: "test-worker"
  });

  assert.equal(claimed.length, 1);
  await pool.query(
    `UPDATE ai_support_search_jobs
     SET lease_expires_at = NOW() - INTERVAL '5 minutes',
         updated_at = NOW() - INTERVAL '5 minutes'
     WHERE id = $1`,
    [queued.id]
  );

  const requeued = await requeueStaleRunningSupportSearchJobs(1);
  assert.equal(requeued, 1);

  const repaired = await getSupportSearchJob(queued.id);
  assert.equal(repaired?.status, "queued");
  assert.equal(repaired?.leaseKey, null);
});
