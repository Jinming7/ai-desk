import crypto from "node:crypto";
import { pool } from "../../db/client.js";

export type SupportSearchJobStatus =
  | "queued"
  | "running"
  | "partial_result_ready"
  | "completed"
  | "failed_retryable"
  | "failed_terminal"
  | "cancelled";

type SupportSearchJobRow = {
  id: string;
  session_id: string;
  request_key: string;
  status: SupportSearchJobStatus;
  query: string;
  answer_language: "zh" | "en";
  current_round: number;
  request_json: Record<string, unknown>;
  stage_state_json: Record<string, unknown>;
  result_json: Record<string, unknown> | null;
  attempts: number;
  max_attempts: number;
  next_run_at: Date | string;
  lease_key: string | null;
  lease_expires_at: Date | string | null;
  worker_id: string | null;
  error_message: string | null;
  started_at: Date | string | null;
  finished_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
};

export interface SupportSearchJob {
  id: string;
  sessionId: string;
  requestKey: string;
  status: SupportSearchJobStatus;
  query: string;
  answerLanguage: "zh" | "en";
  currentRound: number;
  request: Record<string, unknown>;
  stageState: Record<string, unknown>;
  result: Record<string, unknown> | null;
  attempts: number;
  maxAttempts: number;
  nextRunAt: string;
  leaseKey: string | null;
  leaseExpiresAt: string | null;
  workerId: string | null;
  errorMessage: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

const ACTIVE_JOB_STATUSES: SupportSearchJobStatus[] = ["queued", "running", "partial_result_ready", "failed_retryable"];
export const SUPPORT_SEARCH_JOB_LEASE_INVALID_MESSAGE = "Support search job lease is no longer valid";

export function isSupportSearchJobLeaseInvalidError(error: unknown): boolean {
  return error instanceof Error && error.message === SUPPORT_SEARCH_JOB_LEASE_INVALID_MESSAGE;
}

function normalizeTimestamp(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toISOString();
}

function mapJobRow(row: SupportSearchJobRow): SupportSearchJob {
  return {
    id: row.id,
    sessionId: row.session_id,
    requestKey: row.request_key,
    status: row.status,
    query: row.query,
    answerLanguage: row.answer_language,
    currentRound: row.current_round,
    request: row.request_json ?? {},
    stageState: row.stage_state_json ?? {},
    result: row.result_json ?? null,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    nextRunAt: normalizeTimestamp(row.next_run_at) ?? new Date(0).toISOString(),
    leaseKey: row.lease_key,
    leaseExpiresAt: normalizeTimestamp(row.lease_expires_at),
    workerId: row.worker_id,
    errorMessage: row.error_message,
    startedAt: normalizeTimestamp(row.started_at),
    finishedAt: normalizeTimestamp(row.finished_at),
    createdAt: normalizeTimestamp(row.created_at) ?? new Date(0).toISOString(),
    updatedAt: normalizeTimestamp(row.updated_at) ?? new Date(0).toISOString()
  };
}

function isUniqueViolation(error: unknown, constraint?: string): boolean {
  if (!error || typeof error !== "object") return false;
  const code = "code" in error ? String((error as { code?: unknown }).code ?? "") : "";
  if (code !== "23505") return false;
  if (!constraint) return true;
  return "constraint" in error ? String((error as { constraint?: unknown }).constraint ?? "") === constraint : false;
}

async function findActiveJobForSession(sessionId: string): Promise<SupportSearchJob | null> {
  const result = await pool.query<SupportSearchJobRow>(
    `SELECT *
     FROM ai_support_search_jobs
     WHERE session_id = $1
       AND status = ANY($2::text[])
     ORDER BY created_at DESC
     LIMIT 1`,
    [sessionId, ACTIVE_JOB_STATUSES]
  );
  return result.rows[0] ? mapJobRow(result.rows[0]) : null;
}

export async function enqueueSupportSearchJob(input: {
  sessionId: string;
  requestKey: string;
  query: string;
  answerLanguage: "zh" | "en";
  currentRound: number;
  conversation: Array<{ role: "user" | "assistant"; content: string }>;
  attachments: string[];
  maxAttempts?: number;
}): Promise<SupportSearchJob> {
  const byRequestKey = await pool.query<SupportSearchJobRow>(
    `SELECT *
     FROM ai_support_search_jobs
     WHERE request_key = $1
     LIMIT 1`,
    [input.requestKey]
  );
  if (byRequestKey.rows[0]) {
    return mapJobRow(byRequestKey.rows[0]);
  }

  const active = await findActiveJobForSession(input.sessionId);
  if (active) {
    throw new Error("Session already has an active support search job");
  }

  try {
    const result = await pool.query<SupportSearchJobRow>(
      `INSERT INTO ai_support_search_jobs (
        id, session_id, request_key, status, query, answer_language, current_round,
        request_json, stage_state_json, attempts, max_attempts, next_run_at
      ) VALUES ($1,$2,$3,'queued',$4,$5,$6,$7::jsonb,'{}'::jsonb,0,$8,NOW())
      RETURNING *`,
      [
        crypto.randomUUID(),
        input.sessionId,
        input.requestKey,
        input.query,
        input.answerLanguage,
        input.currentRound,
        JSON.stringify({
          query: input.query,
          answerLanguage: input.answerLanguage,
          currentRound: input.currentRound,
          conversation: input.conversation,
          attachments: input.attachments
        }),
        input.maxAttempts ?? 3
      ]
    );
    return mapJobRow(result.rows[0]);
  } catch (error) {
    if (isUniqueViolation(error, "ai_support_search_jobs_request_key_key")) {
      const deduped = await pool.query<SupportSearchJobRow>(
        `SELECT * FROM ai_support_search_jobs WHERE request_key = $1 LIMIT 1`,
        [input.requestKey]
      );
      if (deduped.rows[0]) return mapJobRow(deduped.rows[0]);
    }
    if (isUniqueViolation(error, "idx_ai_support_search_jobs_session_active")) {
      throw new Error("Session already has an active support search job");
    }
    throw error;
  }
}

export async function claimDueSupportSearchJobs(input: {
  limit: number;
  leaseMs: number;
  workerId: string;
  jobId?: string;
}): Promise<SupportSearchJob[]> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const due = await client.query<SupportSearchJobRow>(
      `SELECT *
       FROM ai_support_search_jobs
       WHERE status = ANY($1::text[])
         AND next_run_at <= NOW()
         AND ($3::uuid IS NULL OR id = $3::uuid)
       ORDER BY attempts ASC, next_run_at ASC, created_at ASC
       LIMIT $2
       FOR UPDATE SKIP LOCKED`,
      [["queued", "failed_retryable"], input.limit, input.jobId ?? null]
    );

    const claimed: SupportSearchJob[] = [];
    for (const row of due.rows) {
      const leaseKey = `${input.workerId}:${crypto.randomUUID()}`;
      const updated = await client.query<SupportSearchJobRow>(
        `UPDATE ai_support_search_jobs
         SET status = 'running',
             worker_id = $2,
             lease_key = $3,
             lease_expires_at = NOW() + ($4::int * INTERVAL '1 millisecond'),
             started_at = COALESCE(started_at, NOW()),
             updated_at = NOW()
         WHERE id = $1
         RETURNING *`,
        [row.id, input.workerId, leaseKey, input.leaseMs]
      );
      claimed.push(mapJobRow(updated.rows[0]));
    }

    await client.query("COMMIT");
    return claimed;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function getSupportSearchJob(jobId: string): Promise<SupportSearchJob | null> {
  const result = await pool.query<SupportSearchJobRow>(
    `SELECT * FROM ai_support_search_jobs WHERE id = $1 LIMIT 1`,
    [jobId]
  );
  return result.rows[0] ? mapJobRow(result.rows[0]) : null;
}

export async function heartbeatSupportSearchJob(input: {
  jobId: string;
  leaseKey: string;
  stageState?: Record<string, unknown>;
  leaseMs?: number;
}): Promise<void> {
  const result = await pool.query(
    `UPDATE ai_support_search_jobs
     SET stage_state_json = COALESCE($3::jsonb, stage_state_json),
         lease_expires_at = NOW() + ($4::int * INTERVAL '1 millisecond'),
         updated_at = NOW()
     WHERE id = $1
       AND lease_key = $2
       AND status = 'running'`,
    [input.jobId, input.leaseKey, input.stageState ? JSON.stringify(input.stageState) : null, input.leaseMs ?? 60_000]
  );
  if ((result.rowCount ?? 0) === 0) {
    throw new Error(SUPPORT_SEARCH_JOB_LEASE_INVALID_MESSAGE);
  }
}

export async function markSupportSearchJobFailed(input: {
  jobId: string;
  leaseKey: string;
  errorMessage: string;
  retryable: boolean;
  retryDelaySeconds?: number;
}): Promise<SupportSearchJobStatus> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const current = await client.query<SupportSearchJobRow>(
      `SELECT *
       FROM ai_support_search_jobs
       WHERE id = $1
       FOR UPDATE`,
      [input.jobId]
    );
    const job = current.rows[0];
    if (!job) {
      throw new Error("Support search job not found");
    }
    if (job.lease_key !== input.leaseKey || job.status !== "running") {
      throw new Error(SUPPORT_SEARCH_JOB_LEASE_INVALID_MESSAGE);
    }

    const attempts = job.attempts + 1;
    const terminal = !input.retryable || attempts >= job.max_attempts;
    const status: SupportSearchJobStatus = terminal ? "failed_terminal" : "failed_retryable";

    await client.query(
      `UPDATE ai_support_search_jobs
       SET status = $2,
           attempts = $3,
           error_message = $4,
           next_run_at = CASE
             WHEN $2 = 'failed_retryable'
             THEN NOW() + ($5::int * INTERVAL '1 second')
             ELSE next_run_at
           END,
           lease_key = NULL,
           lease_expires_at = NULL,
           worker_id = NULL,
           finished_at = CASE WHEN $2 = 'failed_terminal' THEN NOW() ELSE finished_at END,
           updated_at = NOW()
       WHERE id = $1`,
      [input.jobId, status, attempts, input.errorMessage.slice(0, 4000), input.retryDelaySeconds ?? 5]
    );
    await client.query("COMMIT");
    return status;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function markSupportSearchJobSucceeded(input: {
  jobId: string;
  leaseKey: string;
  result: unknown;
  stageState?: Record<string, unknown>;
}): Promise<void> {
  const result = await pool.query(
    `UPDATE ai_support_search_jobs
     SET status = 'completed',
         result_json = $3::jsonb,
         stage_state_json = COALESCE($4::jsonb, stage_state_json),
         error_message = NULL,
         lease_key = NULL,
         lease_expires_at = NULL,
         worker_id = NULL,
         finished_at = NOW(),
         updated_at = NOW()
     WHERE id = $1
       AND lease_key = $2
       AND status = 'running'`,
    [input.jobId, input.leaseKey, JSON.stringify(input.result), input.stageState ? JSON.stringify(input.stageState) : null]
  );
  if ((result.rowCount ?? 0) === 0) {
    throw new Error(SUPPORT_SEARCH_JOB_LEASE_INVALID_MESSAGE);
  }
}

export async function requeueStaleRunningSupportSearchJobs(maxAgeMinutes: number): Promise<number> {
  const normalizedMinutes = Number.isFinite(maxAgeMinutes) ? Math.max(1, Math.floor(maxAgeMinutes)) : 5;
  const result = await pool.query(
    `UPDATE ai_support_search_jobs
     SET status = 'queued',
         lease_key = NULL,
         lease_expires_at = NULL,
         worker_id = NULL,
         error_message = COALESCE(NULLIF(error_message, ''), 'stale running support search job requeued automatically'),
         started_at = NULL,
         next_run_at = NOW(),
         updated_at = NOW()
     WHERE status = 'running'
       AND (
         lease_expires_at < NOW()
         OR updated_at < NOW() - ($1::int * INTERVAL '1 minute')
       )`,
    [normalizedMinutes]
  );
  return result.rowCount ?? 0;
}
