import { v4 as uuidv4 } from "uuid";
import { pool } from "../../db/client.js";
import type { SearchReference } from "./types.js";

export async function createSearchSession(input: {
  query: string;
  answer: string;
  confidence: number;
  retrievalStatus: "grounded" | "no_results" | "kb_unavailable";
  unresolvedReasonCode: "NO_MATCHING_KB" | "LOW_CONFIDENCE" | "KB_RETRIEVAL_UNAVAILABLE" | null;
  suggestedNextStep: "self_serve" | "submit_ticket";
}): Promise<string> {
  const id = uuidv4();
  await pool.query(
    `INSERT INTO ai_search_sessions (
      id, query, answer, confidence, retrieval_status, unresolved_reason_code, suggested_next_step
    ) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [id, input.query, input.answer, input.confidence, input.retrievalStatus, input.unresolvedReasonCode, input.suggestedNextStep]
  );
  return id;
}

export async function saveSearchReferences(sessionId: string, references: SearchReference[]): Promise<void> {
  for (const reference of references) {
    await pool.query(
      `INSERT INTO ai_search_references (
        id, session_id, document_id, title, snippet, source_url, score, retrieved_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        uuidv4(),
        sessionId,
        reference.documentId,
        reference.title,
        reference.snippet,
        reference.sourceUrl,
        reference.score,
        reference.retrievedAt
      ]
    );
  }
}

export async function logMetric(input: {
  sessionId?: string;
  name: "hit_rate" | "citation_coverage" | "fallback_rate";
  value: number;
  payload?: Record<string, unknown>;
}): Promise<void> {
  await pool.query(
    `INSERT INTO ai_search_metrics_events (id, session_id, metric_name, metric_value, payload)
     VALUES ($1,$2,$3,$4,$5::jsonb)`,
    [uuidv4(), input.sessionId ?? null, input.name, input.value, JSON.stringify(input.payload ?? {})]
  );
}

export async function getSearchSessionWithReferences(id: string): Promise<
  | {
      id: string;
      query: string;
      answer: string;
      confidence: number;
      retrieval_status: "grounded" | "no_results" | "kb_unavailable";
      unresolved_reason_code: "NO_MATCHING_KB" | "LOW_CONFIDENCE" | "KB_RETRIEVAL_UNAVAILABLE" | null;
      suggested_next_step: "self_serve" | "submit_ticket";
      references: SearchReference[];
    }
  | null
> {
  const sessionRes = await pool.query<{
    id: string;
    query: string;
    answer: string;
    confidence: string;
    retrieval_status: "grounded" | "no_results" | "kb_unavailable";
    unresolved_reason_code: "NO_MATCHING_KB" | "LOW_CONFIDENCE" | "KB_RETRIEVAL_UNAVAILABLE" | null;
    suggested_next_step: "self_serve" | "submit_ticket";
  }>(
    `SELECT id, query, answer, confidence::text, retrieval_status, unresolved_reason_code, suggested_next_step
     FROM ai_search_sessions
     WHERE id = $1`,
    [id]
  );

  const session = sessionRes.rows[0];
  if (!session) {
    return null;
  }

  const refsRes = await pool.query<{
    document_id: string;
    title: string;
    snippet: string;
    source_url: string;
    score: string;
    retrieved_at: string;
  }>(
    `SELECT document_id, title, snippet, source_url, score::text, retrieved_at
     FROM ai_search_references
     WHERE session_id = $1
     ORDER BY score DESC`,
    [id]
  );

  return {
    id: session.id,
    query: session.query,
    answer: session.answer,
    confidence: Number(session.confidence),
    retrieval_status: session.retrieval_status,
    unresolved_reason_code: session.unresolved_reason_code,
    suggested_next_step: session.suggested_next_step,
    references: refsRes.rows.map((row) => ({
      documentId: row.document_id,
      title: row.title,
      snippet: row.snippet,
      sourceUrl: row.source_url,
      score: Number(row.score),
      retrievedAt: row.retrieved_at
    }))
  };
}

export async function aggregateMetricsLast24h(): Promise<{
  hitRate: number;
  citationCoverage: number;
  fallbackRate: number;
}> {
  const result = await pool.query<{
    metric_name: "hit_rate" | "citation_coverage" | "fallback_rate";
    avg_value: string;
  }>(
    `SELECT metric_name, AVG(metric_value)::text AS avg_value
     FROM ai_search_metrics_events
     WHERE created_at >= NOW() - INTERVAL '24 hours'
     GROUP BY metric_name`
  );

  const byName = new Map(result.rows.map((row) => [row.metric_name, Number(row.avg_value)]));
  return {
    hitRate: byName.get("hit_rate") ?? 0,
    citationCoverage: byName.get("citation_coverage") ?? 0,
    fallbackRate: byName.get("fallback_rate") ?? 0
  };
}
