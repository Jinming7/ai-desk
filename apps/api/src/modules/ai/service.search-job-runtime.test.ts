import assert from "node:assert/strict";
import { test } from "node:test";
import { runSupportSearchJobWithLease, resolveClaimedSearchModeJobFailureStatus } from "./service.js";
import {
  SUPPORT_SEARCH_JOB_LEASE_INVALID_MESSAGE,
  type SupportSearchJob,
  type SupportSearchJobStatus
} from "./support-search-jobs.js";

function buildSupportSearchJob(overrides: Partial<SupportSearchJob> = {}): SupportSearchJob {
  const now = new Date("2026-04-08T00:00:00.000Z").toISOString();
  return {
    id: "job-1",
    sessionId: "session-1",
    requestKey: "request-1",
    status: "running",
    query: "Which Linux distributions are officially supported?",
    answerLanguage: "en",
    currentRound: 0,
    request: {
      query: "Which Linux distributions are officially supported?",
      conversation: [],
      attachments: []
    },
    stageState: {
      currentStage: "run_search_mode",
      lastCompletedStage: "job_claimed"
    },
    result: null,
    attempts: 0,
    maxAttempts: 3,
    nextRunAt: now,
    leaseKey: "lease-1",
    leaseExpiresAt: now,
    workerId: "worker-1",
    errorMessage: null,
    startedAt: now,
    finishedAt: null,
    createdAt: now,
    updatedAt: now,
    ...overrides
  };
}

test("runSupportSearchJobWithLease renews the lease with the latest stage progress", async () => {
  const observedStages: Array<{ currentStage: string; lastCompletedStage?: string }> = [];

  const result = await runSupportSearchJobWithLease({
    jobId: "job-1",
    leaseKey: "lease-1",
    leaseMs: 60_000,
    timeoutMs: 1_000,
    initialStageState: {
      currentStage: "run_search_mode",
      lastCompletedStage: "job_claimed"
    },
    heartbeat: async (input) => {
      observedStages.push(input.stageState as { currentStage: string; lastCompletedStage?: string });
    },
    keepAliveIntervalMs: 10_000,
    operation: async ({ reportStageProgress }) => {
      await reportStageProgress({
        currentStage: "retrieval_base",
        lastCompletedStage: "planner"
      });
      await reportStageProgress({
        currentStage: "writer",
        lastCompletedStage: "evidence_selection"
      });
      return "completed";
    }
  });

  assert.equal(result, "completed");
  assert.deepEqual(observedStages, [
    { currentStage: "run_search_mode", lastCompletedStage: "job_claimed" },
    { currentStage: "retrieval_base", lastCompletedStage: "planner" },
    { currentStage: "writer", lastCompletedStage: "evidence_selection" }
  ]);
});

test("runSupportSearchJobWithLease fails within the hard timeout while keeping the latest stage alive", async () => {
  const observedStages: Array<{ currentStage: string; lastCompletedStage?: string }> = [];

  await assert.rejects(
    runSupportSearchJobWithLease({
      jobId: "job-2",
      leaseKey: "lease-2",
      leaseMs: 60_000,
      timeoutMs: 50,
      initialStageState: {
        currentStage: "run_search_mode",
        lastCompletedStage: "job_claimed"
      },
      heartbeat: async (input) => {
        observedStages.push(input.stageState as { currentStage: string; lastCompletedStage?: string });
      },
      keepAliveIntervalMs: 10,
      operation: async ({ reportStageProgress }) => {
        await reportStageProgress({
          currentStage: "writer",
          lastCompletedStage: "retrieval_base"
        });
        await new Promise(() => undefined);
        return "unreachable";
      }
    }),
    /timeout/i
  );

  assert.equal(observedStages.length >= 3, true, JSON.stringify(observedStages));
  assert.deepEqual(observedStages[0], {
    currentStage: "run_search_mode",
    lastCompletedStage: "job_claimed"
  });
  assert.deepEqual(observedStages.at(-1), {
    currentStage: "writer",
    lastCompletedStage: "retrieval_base"
  });
});

test("runSupportSearchJobWithLease rejects when keepalive loses the running lease", async () => {
  let heartbeatCalls = 0;

  await assert.rejects(
    runSupportSearchJobWithLease({
      jobId: "job-3",
      leaseKey: "lease-3",
      leaseMs: 60_000,
      timeoutMs: 1_000,
      initialStageState: {
        currentStage: "run_search_mode",
        lastCompletedStage: "job_claimed"
      },
      heartbeat: async () => {
        heartbeatCalls += 1;
        if (heartbeatCalls >= 3) {
          throw new Error(SUPPORT_SEARCH_JOB_LEASE_INVALID_MESSAGE);
        }
      },
      keepAliveIntervalMs: 10,
      operation: async ({ reportStageProgress }) => {
        await reportStageProgress({
          currentStage: "writer",
          lastCompletedStage: "retrieval_base"
        });
        await new Promise((resolve) => setTimeout(resolve, 50));
        return "unreachable";
      }
    }),
    /lease is no longer valid/i
  );

  assert.equal(heartbeatCalls >= 3, true);
});

test("resolveClaimedSearchModeJobFailureStatus returns the persisted job status when lease loss is already known", async () => {
  const job = buildSupportSearchJob();
  let markFailedCalls = 0;

  const status = await resolveClaimedSearchModeJobFailureStatus(
    {
      job,
      error: new Error(SUPPORT_SEARCH_JOB_LEASE_INVALID_MESSAGE),
      retryable: true,
      retryDelaySeconds: 5
    },
    {
      getSupportSearchJob: async () => buildSupportSearchJob({ status: "queued", leaseKey: null }),
      markSupportSearchJobFailed: async () => {
        markFailedCalls += 1;
        return "failed_retryable";
      }
    }
  );

  assert.equal(status, "queued");
  assert.equal(markFailedCalls, 0);
});

test("resolveClaimedSearchModeJobFailureStatus falls back to current job truth when failure persistence loses the lease", async () => {
  const job = buildSupportSearchJob();
  let markFailedCalls = 0;
  const observedStatuses: SupportSearchJobStatus[] = [];

  const status = await resolveClaimedSearchModeJobFailureStatus(
    {
      job,
      error: new Error("planner timeout"),
      retryable: true,
      retryDelaySeconds: 5
    },
    {
      getSupportSearchJob: async () => {
        observedStatuses.push("running");
        return buildSupportSearchJob({
          status: "running",
          leaseKey: "lease-2",
          workerId: "replacement-worker"
        });
      },
      markSupportSearchJobFailed: async () => {
        markFailedCalls += 1;
        throw new Error(SUPPORT_SEARCH_JOB_LEASE_INVALID_MESSAGE);
      }
    }
  );

  assert.equal(status, "running");
  assert.equal(markFailedCalls, 1);
  assert.deepEqual(observedStatuses, ["running"]);
});
