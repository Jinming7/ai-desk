import { v4 as uuidv4 } from "uuid";
import { env } from "../../config/env.js";
import { pool } from "../../db/client.js";
import type { OpenClawAdapter } from "../../infrastructure/openclaw/types.js";
import * as aiRepo from "../ai/repository.js";
import { resolveOpenClawRuntime } from "../ai/agent-router.js";
import { SearchOrchestrator } from "../ai/search-orchestrator.js";
import type { SearchReference } from "../ai/types.js";
import * as ticketService from "../tickets/service.js";

type EscalationStatus = "ESCALATED" | "DEEP_RETRIEVING" | "RESOLVED_BY_AI" | "TICKET_CREATED";

const processing = new Set<string>();

interface EscalationRecord {
  id: string;
  session_id: string;
  status: EscalationStatus;
  question: string;
  reason_code: "NO_MATCHING_KB" | "LOW_CONFIDENCE" | "KB_RETRIEVAL_UNAVAILABLE";
  attempts: number;
  correlation_id: string;
  created_ticket_id: string | null;
  resolved_payload: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
}

async function addEvent(input: {
  escalationId: string;
  fromStatus: EscalationStatus | null;
  toStatus: EscalationStatus;
  actorType: "user" | "agent" | "system";
  correlationId: string;
  payload?: Record<string, unknown>;
}) {
  await pool.query(
    `INSERT INTO ai_search_escalation_events (id, escalation_id, from_status, to_status, actor_type, correlation_id, payload)
     VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)`,
    [uuidv4(), input.escalationId, input.fromStatus, input.toStatus, input.actorType, input.correlationId, JSON.stringify(input.payload ?? {})]
  );
}

async function getEscalationBySession(sessionId: string): Promise<EscalationRecord | null> {
  const result = await pool.query<EscalationRecord>(
    `SELECT id, session_id, status, question, reason_code, attempts, correlation_id, created_ticket_id, resolved_payload, created_at, updated_at
     FROM ai_search_escalations
     WHERE session_id = $1
     ORDER BY created_at DESC
     LIMIT 1`,
    [sessionId]
  );
  return result.rows[0] ?? null;
}

export async function createOrGetEscalation(input: {
  sessionId: string;
  question: string;
  conversation: string[];
  reasonCode: "NO_MATCHING_KB" | "LOW_CONFIDENCE" | "KB_RETRIEVAL_UNAVAILABLE";
  adapter: OpenClawAdapter;
}) {
  if (!env.FEATURE_QUICK_TICKET) {
    throw new Error("Quick ticket is disabled by feature flag");
  }

  const session = await aiRepo.getSearchSessionWithReferences(input.sessionId);
  if (!session) {
    throw new Error("Search session not found");
  }

  const existing = await getEscalationBySession(input.sessionId);
  if (existing && existing.status !== "TICKET_CREATED" && existing.status !== "RESOLVED_BY_AI") {
    return mapEscalation(existing);
  }

  const id = uuidv4();
  const idempotencyKey = `${input.sessionId}-escalate`;
  const correlationId = uuidv4();
  await pool.query(
    `INSERT INTO ai_search_escalations (
      id, session_id, idempotency_key, status, question, conversation, reason_code, retrieval_snapshot, correlation_id
     ) VALUES ($1,$2,$3,'ESCALATED',$4,$5::jsonb,$6,$7::jsonb,$8)`,
    [
      id,
      input.sessionId,
      idempotencyKey,
      input.question,
      JSON.stringify(input.conversation),
      input.reasonCode,
      JSON.stringify({ session, createdAt: new Date().toISOString() }),
      correlationId
    ]
  );

  await addEvent({
    escalationId: id,
    fromStatus: null,
    toStatus: "ESCALATED",
    actorType: "user",
    correlationId,
    payload: { reasonCode: input.reasonCode }
  });

  void processEscalation(id, input.adapter);

  const created = await getEscalation(id);
  if (!created) {
    throw new Error("Failed to create escalation");
  }
  return created;
}

async function processEscalation(escalationId: string, adapter: OpenClawAdapter) {
  if (processing.has(escalationId)) {
    return;
  }
  if (!env.FEATURE_DEEP_RETRIEVAL) {
    return;
  }

  processing.add(escalationId);

  try {
    const escalation = await getEscalationRaw(escalationId);
    if (!escalation || escalation.status !== "ESCALATED") {
      return;
    }

    await transition(escalationId, "ESCALATED", "DEEP_RETRIEVING", "agent", escalation.correlation_id, {
      stage: "deep_retrieval_started"
    });

    const orchestrator = new SearchOrchestrator(adapter);
    const runtime = resolveOpenClawRuntime({ intent: "retrieval", sessionId: escalation.session_id });
    let bestConfidence = 0;
    let bestAnswer = "";
    let bestRefs: SearchReference[] = [];
    let attempts = 0;

    const queries = [escalation.question, `${escalation.question} troubleshooting`, `${escalation.question} root cause`];
    for (let i = 0; i < Math.min(env.OPENCLAW_DEEP_SEARCH_MAX_ROUNDS, queries.length); i += 1) {
      attempts += 1;
      const response = await orchestrator.search(queries[i], `${escalation.id}-round-${i + 1}`, runtime);
      if (response.confidence > bestConfidence) {
        bestConfidence = response.confidence;
        bestAnswer = response.answer;
        bestRefs = response.references;
      }
      if (response.confidence >= env.AGENT_RESOLUTION_CONFIDENCE_THRESHOLD && response.references.length >= 2) {
        break;
      }
    }

    await pool.query("UPDATE ai_search_escalations SET attempts = $2, updated_at = NOW() WHERE id = $1", [escalationId, attempts]);

    if (bestConfidence >= env.AGENT_RESOLUTION_CONFIDENCE_THRESHOLD && bestRefs.length >= 2) {
      await transition(escalationId, "DEEP_RETRIEVING", "RESOLVED_BY_AI", "agent", escalation.correlation_id, {
        confidence: bestConfidence,
        references: bestRefs
      });
      await pool.query("UPDATE ai_search_escalations SET resolved_payload = $2::jsonb, updated_at = NOW() WHERE id = $1", [
        escalationId,
        JSON.stringify({ answer: bestAnswer, confidence: bestConfidence, references: bestRefs })
      ]);
      return;
    }

    const ticket = await ticketService.createTicket({
      title: `[AI Escalation] ${escalation.question.slice(0, 100)}`,
      description: `${escalation.question}\n\nReason: ${escalation.reason_code}\nDeep retrieval confidence: ${bestConfidence.toFixed(3)}`,
      serviceCategory: "technical_support",
      priority: "P2",
      customer: {
        id: "ai_escalation_customer",
        name: "AI Escalation"
      },
      environment: "unknown",
      reproducibility: "unknown",
      impactSummary: "Generated from AI escalation flow"
    });

    await pool.query("UPDATE ai_search_escalations SET created_ticket_id = $2, updated_at = NOW() WHERE id = $1", [escalationId, ticket.id]);

    await transition(escalationId, "DEEP_RETRIEVING", "TICKET_CREATED", "agent", escalation.correlation_id, {
      ticketId: ticket.id,
      ticketNo: ticket.ticket_no,
      confidence: bestConfidence
    });
  } catch (error) {
    await pool.query(
      "UPDATE ai_search_escalations SET updated_at = NOW(), resolved_payload = $2::jsonb WHERE id = $1",
      [escalationId, JSON.stringify({ error: (error as Error).message })]
    );
  } finally {
    processing.delete(escalationId);
  }
}

async function transition(
  escalationId: string,
  fromStatus: EscalationStatus,
  toStatus: EscalationStatus,
  actorType: "agent" | "system" | "user",
  correlationId: string,
  payload: Record<string, unknown>
) {
  await pool.query(
    "UPDATE ai_search_escalations SET status = $2, updated_at = NOW() WHERE id = $1 AND status = $3",
    [escalationId, toStatus, fromStatus]
  );
  await addEvent({
    escalationId,
    fromStatus,
    toStatus,
    actorType,
    correlationId,
    payload
  });
}

async function getEscalationRaw(id: string): Promise<EscalationRecord | null> {
  const result = await pool.query<EscalationRecord>(
    `SELECT id, session_id, status, question, reason_code, attempts, correlation_id, created_ticket_id, resolved_payload, created_at, updated_at
     FROM ai_search_escalations WHERE id = $1`,
    [id]
  );
  return result.rows[0] ?? null;
}

function mapEscalation(row: EscalationRecord) {
  return {
    id: row.id,
    sessionId: row.session_id,
    status: row.status,
    question: row.question,
    reasonCode: row.reason_code,
    attempts: row.attempts,
    ticketId: row.created_ticket_id,
    resolution: row.resolved_payload,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export async function getEscalation(id: string) {
  const raw = await getEscalationRaw(id);
  if (!raw) {
    return null;
  }
  return mapEscalation(raw);
}
