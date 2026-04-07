import type express from "express";
import { env } from "../../config/env.js";
import type { OpenClawAdapter } from "../../infrastructure/openclaw/types.js";
import { driveSearchModeJob, getSearchModeJob } from "./service.js";

type StreamEventName = "job_snapshot" | "job_completed" | "job_failed" | "job_timeout";

function isTerminalStatus(status: string): boolean {
  return status === "completed" || status === "failed_terminal" || status === "cancelled";
}

function eventFingerprint(job: NonNullable<Awaited<ReturnType<typeof getSearchModeJob>>>): string {
  return JSON.stringify({
    status: job.status,
    updatedAt: job.updatedAt,
    errorMessage: job.errorMessage,
    stageState: job.stageState,
    result: job.result
  });
}

function writeEvent(res: express.Response, event: StreamEventName, payload: Record<string, unknown>) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function streamSearchModeJob(input: {
  req: express.Request;
  res: express.Response;
  jobId: string;
  adapter: OpenClawAdapter;
}): Promise<void> {
  input.res.status(200);
  input.res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  input.res.setHeader("Cache-Control", "no-cache, no-transform");
  input.res.setHeader("Connection", "keep-alive");
  input.res.setHeader("X-Accel-Buffering", "no");
  input.res.flushHeaders?.();

  let closed = false;
  input.req.on("close", () => {
    closed = true;
  });

  let current = await getSearchModeJob(input.jobId);
  if (!current) {
    writeEvent(input.res, "job_failed", {
      error: "Search job not found"
    });
    input.res.end();
    return;
  }

  let lastFingerprint = "";
  const emitSnapshot = (job: typeof current) => {
    if (!job) return;
    const fingerprint = eventFingerprint(job);
    if (fingerprint === lastFingerprint) return;
    lastFingerprint = fingerprint;
    writeEvent(input.res, "job_snapshot", { job });
  };

  emitSnapshot(current);

  const shouldDrive = current.status === "queued" || current.status === "failed_retryable";
  const drivePromise = shouldDrive ? driveSearchModeJob(input.jobId, input.adapter) : Promise.resolve(current);
  void drivePromise.catch(() => undefined);

  const startedAt = Date.now();
  while (!closed) {
    current = await getSearchModeJob(input.jobId);
    if (!current) {
      writeEvent(input.res, "job_failed", {
        error: "Search job not found"
      });
      break;
    }

    emitSnapshot(current);

    if (isTerminalStatus(current.status)) {
      writeEvent(input.res, current.status === "completed" ? "job_completed" : "job_failed", { job: current });
      break;
    }

    if (Date.now() - startedAt >= env.AI_SUPPORT_JOB_STREAM_MAX_WAIT_MS) {
      writeEvent(input.res, "job_timeout", { job: current });
      break;
    }

    await sleep(env.AI_SUPPORT_JOB_STREAM_POLL_INTERVAL_MS);
  }

  input.res.end();
}
