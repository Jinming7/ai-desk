import type { OpenClawRuntimeContext } from "../../infrastructure/openclaw/types.js";

export type RuntimeBudgetMode = "full" | "tight" | "minimal";

export function runtimeDeadlineAtMs(runtime?: OpenClawRuntimeContext): number | null {
  const startedAt = Number(runtime?.requestStartedAtMs);
  const overallTimeoutMs = Number(runtime?.overallTimeoutMs);
  if (!Number.isFinite(startedAt) || startedAt <= 0 || !Number.isFinite(overallTimeoutMs) || overallTimeoutMs <= 0) {
    return null;
  }
  return Math.round(startedAt + overallTimeoutMs);
}

export function remainingRuntimeBudgetMs(runtime?: OpenClawRuntimeContext): number | null {
  const deadlineAtMs = runtimeDeadlineAtMs(runtime);
  if (deadlineAtMs === null) return null;
  return Math.max(0, deadlineAtMs - Date.now());
}

export function resolveRuntimeBudgetMode(runtime?: OpenClawRuntimeContext): RuntimeBudgetMode {
  if (runtime?.deliveryMode === "async_job") {
    return "full";
  }
  const remaining = remainingRuntimeBudgetMs(runtime);
  if (remaining === null) return "full";
  if (remaining <= 2_500) return "minimal";
  if (remaining <= 7_000) return "tight";
  return "full";
}

export function capRuntimeTimeoutMs(input: {
  requestedTimeoutMs?: number | null;
  runtime?: OpenClawRuntimeContext;
  defaultTimeoutMs: number;
  maximumTimeoutMs?: number;
  minimumTimeoutMs?: number;
}): number {
  const minimumTimeoutMs = Math.max(0, Math.round(input.minimumTimeoutMs ?? 1));
  const maximumTimeoutMs =
    Number.isFinite(input.maximumTimeoutMs) && Number(input.maximumTimeoutMs) >= 0
      ? Math.round(Number(input.maximumTimeoutMs))
      : null;
  const requested =
    Number.isFinite(input.requestedTimeoutMs) && Number(input.requestedTimeoutMs) > 0
      ? Math.round(Number(input.requestedTimeoutMs))
      : Math.max(0, Math.round(input.defaultTimeoutMs));
  const cappedRequested = maximumTimeoutMs === null ? requested : Math.min(requested, maximumTimeoutMs);
  const remaining = remainingRuntimeBudgetMs(input.runtime);
  if (remaining === null) {
    return Math.max(minimumTimeoutMs, cappedRequested);
  }
  if (remaining <= 0) {
    return 0;
  }
  return Math.max(minimumTimeoutMs, Math.min(cappedRequested, remaining));
}

export function assertRuntimeBudgetAvailable(runtime: OpenClawRuntimeContext | undefined, label: string): void {
  const remaining = remainingRuntimeBudgetMs(runtime);
  if (remaining !== null && remaining <= 0) {
    throw new Error(`${label} budget exhausted`);
  }
}

export async function runWithRuntimeDeadline<T>(input: {
  label: string;
  runtime?: OpenClawRuntimeContext;
  operation: () => Promise<T>;
  requestedTimeoutMs?: number;
  defaultTimeoutMs?: number;
  minimumTimeoutMs?: number;
}): Promise<T> {
  assertRuntimeBudgetAvailable(input.runtime, input.label);
  const timeoutMs = capRuntimeTimeoutMs({
    requestedTimeoutMs: input.requestedTimeoutMs,
    runtime: input.runtime,
    defaultTimeoutMs: input.defaultTimeoutMs ?? input.requestedTimeoutMs ?? 30_000,
    minimumTimeoutMs: input.minimumTimeoutMs ?? 1
  });
  if (timeoutMs <= 0) {
    throw new Error(`${input.label} budget exhausted`);
  }

  let timeoutHandle: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      input.operation(),
      new Promise<T>((_resolve, reject) => {
        timeoutHandle = setTimeout(() => {
          reject(new Error(`${input.label} timeout after ${timeoutMs}ms`));
        }, timeoutMs);
      })
    ]);
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
  }
}
