import assert from "node:assert/strict";
import test from "node:test";
import {
  isSupportSearchJobClaimedStage,
  shouldProbeRunningSupportSearchRecovery,
  type SupportSearchJobRecoveryView
} from "../src/lib/support-search-job-recovery.ts";

function buildJob(overrides: Partial<SupportSearchJobRecoveryView> = {}): SupportSearchJobRecoveryView {
  return {
    id: "job-1",
    sessionId: "session-1",
    status: "running",
    result: null,
    errorMessage: null,
    updatedAt: "2026-04-09T00:00:00.000Z",
    stageState: {
      currentStage: "run_search_mode",
      lastCompletedStage: "job_claimed"
    },
    startedAt: "2026-04-09T00:00:00.000Z",
    workerId: "support-search-worker",
    ...overrides
  };
}

test("isSupportSearchJobClaimedStage detects the initial job_claimed stage", () => {
  assert.equal(isSupportSearchJobClaimedStage(buildJob()), true);
  assert.equal(
    isSupportSearchJobClaimedStage(
      buildJob({
        stageState: {
          currentStage: "planner",
          lastCompletedStage: "route"
        }
      })
    ),
    false
  );
});

test("shouldProbeRunningSupportSearchRecovery ignores heartbeat-only updatedAt changes when stage is still job_claimed", () => {
  const job = buildJob({
    updatedAt: "2026-04-09T00:00:09.000Z"
  });

  assert.equal(
    shouldProbeRunningSupportSearchRecovery({
      job,
      stagnantStagePolls: 20,
      lastDriveAt: 0,
      now: 15_000
    }),
    true
  );
});

test("shouldProbeRunningSupportSearchRecovery does not probe once the stage has progressed", () => {
  const job = buildJob({
    stageState: {
      currentStage: "planner",
      lastCompletedStage: "route"
    },
    updatedAt: "2026-04-09T00:00:09.000Z"
  });

  assert.equal(
    shouldProbeRunningSupportSearchRecovery({
      job,
      stagnantStagePolls: 20,
      lastDriveAt: 0,
      now: 15_000
    }),
    false
  );
});
