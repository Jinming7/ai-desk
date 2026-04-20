export type SupportSearchJobRecoveryStatus =
  | "queued"
  | "running"
  | "partial_result_ready"
  | "completed"
  | "failed_retryable"
  | "failed_terminal"
  | "cancelled";

export type SupportSearchJobRecoveryView = {
  status: SupportSearchJobRecoveryStatus;
  stageState?: {
    currentStage?: string;
    lastCompletedStage?: string;
  } | null;
};

const RUNNING_RECOVERY_STAGE_POLL_THRESHOLD = 20;
const RUNNING_RECOVERY_MIN_DRIVE_INTERVAL_MS = 10_000;

export function isSupportSearchJobClaimedStage(job: Pick<SupportSearchJobRecoveryView, "stageState">): boolean {
  return (
    String(job.stageState?.currentStage ?? "") === "run_search_mode" &&
    String(job.stageState?.lastCompletedStage ?? "") === "job_claimed"
  );
}

export function shouldProbeRunningSupportSearchRecovery(input: {
  job: SupportSearchJobRecoveryView;
  stagnantStagePolls: number;
  lastDriveAt: number;
  now: number;
  minimumDriveIntervalMs?: number;
  minimumStagePolls?: number;
}): boolean {
  const minimumDriveIntervalMs = input.minimumDriveIntervalMs ?? RUNNING_RECOVERY_MIN_DRIVE_INTERVAL_MS;
  const minimumStagePolls = input.minimumStagePolls ?? RUNNING_RECOVERY_STAGE_POLL_THRESHOLD;
  return (
    (input.job.status === "running" || input.job.status === "partial_result_ready") &&
    isSupportSearchJobClaimedStage(input.job) &&
    input.stagnantStagePolls >= minimumStagePolls &&
    input.now - input.lastDriveAt >= minimumDriveIntervalMs
  );
}
