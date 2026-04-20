import assert from "node:assert/strict";
import test from "node:test";
import { shouldAttemptRunningSearchJobRecovery } from "./support-search-stream.js";

function buildJob(overrides: Record<string, unknown> = {}) {
  return {
    id: "job-1",
    sessionId: "session-1",
    status: "running",
    query: "query",
    answerLanguage: "en",
    currentRound: 0,
    request: {},
    stageState: {
      currentStage: "run_search_mode",
      lastCompletedStage: "job_claimed"
    },
    result: null,
    attempts: 0,
    maxAttempts: 3,
    nextRunAt: "2026-04-09T00:00:00.000Z",
    leaseKey: "lease-1",
    leaseExpiresAt: "2026-04-09T00:01:00.000Z",
    workerId: "support-search-worker",
    errorMessage: null,
    startedAt: "2026-04-09T00:00:00.000Z",
    finishedAt: null,
    createdAt: "2026-04-09T00:00:00.000Z",
    updatedAt: "2026-04-09T00:00:09.000Z",
    ...overrides
  };
}

test("shouldAttemptRunningSearchJobRecovery probes claimed-stage jobs after the minimum interval", () => {
  assert.equal(
    shouldAttemptRunningSearchJobRecovery({
      job: buildJob(),
      lastDriveAt: 0,
      now: 15_000,
      minimumIntervalMs: 10_000
    }),
    true
  );
});

test("shouldAttemptRunningSearchJobRecovery skips jobs that already progressed past job_claimed", () => {
  assert.equal(
    shouldAttemptRunningSearchJobRecovery({
      job: buildJob({
        stageState: {
          currentStage: "planner",
          lastCompletedStage: "route"
        }
      }),
      lastDriveAt: 0,
      now: 15_000,
      minimumIntervalMs: 10_000
    }),
    false
  );
});
