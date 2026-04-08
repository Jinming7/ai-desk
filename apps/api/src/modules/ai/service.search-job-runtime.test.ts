import assert from "node:assert/strict";
import { test } from "node:test";
import { runSupportSearchJobWithLease } from "./service.js";

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
