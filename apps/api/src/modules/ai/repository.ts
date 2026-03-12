import { v4 as uuidv4 } from "uuid";
import { pool } from "../../db/client.js";
import type { SearchReference, SearchDialogState, ChatTicketDraftField } from "./types.js";

export async function createSearchSession(input: {
  sessionId?: string;
  query: string;
  answer: string;
  confidence: number;
  retrievalStatus: "grounded" | "no_results" | "kb_unavailable";
  unresolvedReasonCode: "NO_MATCHING_KB" | "LOW_CONFIDENCE" | "KB_RETRIEVAL_UNAVAILABLE" | null;
  suggestedNextStep: "self_serve" | "submit_ticket";
}): Promise<string> {
  const id = input.sessionId ?? uuidv4();
  await pool.query(
    `INSERT INTO ai_search_sessions (
      id, query, answer, confidence, retrieval_status, unresolved_reason_code, suggested_next_step
    ) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [id, input.query, input.answer, input.confidence, input.retrievalStatus, input.unresolvedReasonCode, input.suggestedNextStep]
  );
  return id;
}

export async function updateSearchSession(input: {
  sessionId: string;
  answer: string;
  confidence: number;
  retrievalStatus: "grounded" | "no_results" | "kb_unavailable";
  unresolvedReasonCode: "NO_MATCHING_KB" | "LOW_CONFIDENCE" | "KB_RETRIEVAL_UNAVAILABLE" | null;
  suggestedNextStep: "self_serve" | "submit_ticket";
}): Promise<void> {
  await pool.query(
    `UPDATE ai_search_sessions
     SET answer = $2,
         confidence = $3,
         retrieval_status = $4,
         unresolved_reason_code = $5,
         suggested_next_step = $6,
         updated_at = NOW()
     WHERE id = $1`,
    [
      input.sessionId,
      input.answer,
      input.confidence,
      input.retrievalStatus,
      input.unresolvedReasonCode,
      input.suggestedNextStep
    ]
  );
}

export async function saveSearchReferences(sessionId: string, references: SearchReference[]): Promise<void> {
  await pool.query(`DELETE FROM ai_search_references WHERE session_id = $1`, [sessionId]);
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
  name:
    | "hit_rate"
    | "citation_coverage"
    | "fallback_rate"
    | "no_citation_rate"
    | "clarification_resolution_rate"
    | "chat_to_ticket_conversion";
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

export async function upsertDialogState(input: {
  sessionId: string;
  state: SearchDialogState;
  clarificationRound: number;
  showCreateTicketNow: boolean;
  answerLanguage: "zh" | "en";
  followUpQuestion: string | null;
  transcript: Array<{ role: "user" | "assistant"; content: string; at: string }>;
  retrievalOutcome: Record<string, unknown>;
}): Promise<void> {
  await pool.query(
    `INSERT INTO ai_search_dialog_states (
      session_id, state, clarification_round, show_create_ticket_now,
      answer_language, follow_up_question, transcript, retrieval_outcome
    ) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb)
    ON CONFLICT (session_id)
    DO UPDATE SET
      state = EXCLUDED.state,
      clarification_round = EXCLUDED.clarification_round,
      show_create_ticket_now = EXCLUDED.show_create_ticket_now,
      answer_language = EXCLUDED.answer_language,
      follow_up_question = EXCLUDED.follow_up_question,
      transcript = EXCLUDED.transcript,
      retrieval_outcome = EXCLUDED.retrieval_outcome,
      updated_at = NOW()`,
    [
      input.sessionId,
      input.state,
      input.clarificationRound,
      input.showCreateTicketNow,
      input.answerLanguage,
      input.followUpQuestion,
      JSON.stringify(input.transcript),
      JSON.stringify(input.retrievalOutcome)
    ]
  );
}

export async function getDialogState(sessionId: string): Promise<
  | {
      state: SearchDialogState;
      clarification_round: number;
      show_create_ticket_now: boolean;
      answer_language: "zh" | "en";
      follow_up_question: string | null;
      transcript: Array<{ role: "user" | "assistant"; content: string; at: string }>;
      retrieval_outcome: Record<string, unknown>;
    }
  | null
> {
  const result = await pool.query<{
    state: SearchDialogState;
    clarification_round: number;
    show_create_ticket_now: boolean;
    answer_language: "zh" | "en";
    follow_up_question: string | null;
    transcript: Array<{ role: "user" | "assistant"; content: string; at: string }>;
    retrieval_outcome: Record<string, unknown>;
  }>(
    `SELECT state, clarification_round, show_create_ticket_now, answer_language, follow_up_question, transcript, retrieval_outcome
     FROM ai_search_dialog_states
     WHERE session_id = $1`,
    [sessionId]
  );
  return result.rows[0] ?? null;
}

export async function upsertTicketDraft(input: {
  draftId?: string;
  sessionId: string;
  ticketTypeKey: string;
  ticketTypeConfidence: number;
  draft: {
    ticketTypeName: string;
    title: string;
    description: string;
    serviceCategory: "technical_support" | "feature_consulting" | "account_issue";
    onesFields: Record<string, string>;
    fieldHints: ChatTicketDraftField[];
  };
  missingRequiredFields: string[];
  provenance: Record<string, unknown>;
}): Promise<string> {
  const id = input.draftId ?? uuidv4();
  await pool.query(
    `INSERT INTO ai_search_ticket_drafts (
      id, session_id, status, ticket_type_key, ticket_type_confidence,
      draft_json, missing_required_fields, provenance_json
    ) VALUES ($1,$2,'draft',$3,$4,$5::jsonb,$6::jsonb,$7::jsonb)
    ON CONFLICT (id)
    DO UPDATE SET
      ticket_type_key = EXCLUDED.ticket_type_key,
      ticket_type_confidence = EXCLUDED.ticket_type_confidence,
      draft_json = EXCLUDED.draft_json,
      missing_required_fields = EXCLUDED.missing_required_fields,
      provenance_json = EXCLUDED.provenance_json,
      updated_at = NOW()`,
    [
      id,
      input.sessionId,
      input.ticketTypeKey,
      input.ticketTypeConfidence,
      JSON.stringify(input.draft),
      JSON.stringify(input.missingRequiredFields),
      JSON.stringify(input.provenance)
    ]
  );
  return id;
}

export async function getTicketDraft(draftId: string): Promise<
  | {
      id: string;
      session_id: string;
      status: string;
      ticket_type_key: string | null;
      ticket_type_confidence: number;
      draft_json: {
        ticketTypeName: string;
        title: string;
        description: string;
        serviceCategory: "technical_support" | "feature_consulting" | "account_issue";
        onesFields: Record<string, string>;
        fieldHints: ChatTicketDraftField[];
      };
      missing_required_fields: string[];
      provenance_json: Record<string, unknown>;
      created_ticket_id: string | null;
    }
  | null
> {
  const result = await pool.query<{
    id: string;
    session_id: string;
    status: string;
    ticket_type_key: string | null;
    ticket_type_confidence: string;
    draft_json: {
      ticketTypeName: string;
      title: string;
      description: string;
      serviceCategory: "technical_support" | "feature_consulting" | "account_issue";
      onesFields: Record<string, string>;
      fieldHints: ChatTicketDraftField[];
    };
    missing_required_fields: string[];
    provenance_json: Record<string, unknown>;
    created_ticket_id: string | null;
  }>(
    `SELECT id, session_id, status, ticket_type_key, ticket_type_confidence::text, draft_json, missing_required_fields, provenance_json, created_ticket_id
     FROM ai_search_ticket_drafts
     WHERE id = $1
     LIMIT 1`,
    [draftId]
  );

  const row = result.rows[0];
  if (!row) return null;
  return {
    ...row,
    ticket_type_confidence: Number(row.ticket_type_confidence)
  };
}

export async function markTicketDraftSubmitted(input: {
  draftId: string;
  ticketId: string;
}): Promise<void> {
  await pool.query(
    `UPDATE ai_search_ticket_drafts
     SET status = 'submitted',
         created_ticket_id = $2,
         updated_at = NOW()
     WHERE id = $1`,
    [input.draftId, input.ticketId]
  );
}

export async function addHandoffEvent(input: {
  sessionId: string;
  eventType: "handoff_triggered" | "draft_generated" | "ticket_submitted";
  draftId?: string;
  ticketId?: string;
  payload?: Record<string, unknown>;
}): Promise<void> {
  await pool.query(
    `INSERT INTO ai_search_handoff_events (id, session_id, draft_id, ticket_id, event_type, payload)
     VALUES ($1,$2,$3,$4,$5,$6::jsonb)`,
    [
      uuidv4(),
      input.sessionId,
      input.draftId ?? null,
      input.ticketId ?? null,
      input.eventType,
      JSON.stringify(input.payload ?? {})
    ]
  );
}

export async function aggregateMetricsLast24h(): Promise<{
  hitRate: number;
  citationCoverage: number;
  fallbackRate: number;
  noCitationRate: number;
  clarificationResolutionRate: number;
  chatToTicketConversion: number;
}> {
  const result = await pool.query<{
    metric_name: string;
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
    fallbackRate: byName.get("fallback_rate") ?? 0,
    noCitationRate: byName.get("no_citation_rate") ?? 0,
    clarificationResolutionRate: byName.get("clarification_resolution_rate") ?? 0,
    chatToTicketConversion: byName.get("chat_to_ticket_conversion") ?? 0
  };
}
