import { v4 as uuidv4 } from "uuid";
import { pool } from "../../db/client.js";
import type { TicketCreateInput, TicketStatus } from "../../contracts/tickets.js";

export interface TicketRecord {
  id: string;
  ticket_no: string;
  title: string;
  description: string;
  service_category: string;
  priority: string;
  status: TicketStatus;
  customer_id: string;
  customer_name: string;
  customer_email: string | null;
  environment: string | null;
  reproducibility: string | null;
  impact_summary: string | null;
  assignee_type: string;
  assignee_name: string;
  ai_run_seq: number;
  sla_due_at: string | null;
  first_response_due_at: string | null;
  first_response_at: string | null;
  resolution_due_at: string | null;
  sla_paused_at: string | null;
  sla_pause_reason: string | null;
  sla_paused_total_seconds: number;
  ones_ticket_type_key: string | null;
  ones_ticket_key: string | null;
  ones_sync_status: string | null;
  ones_sync_error: string | null;
  ai_mode_snapshot: string | null;
  ai_last_trace_id: string | null;
  ai_last_action: string | null;
  ai_last_confidence: number | null;
  ai_last_model: string | null;
  ai_last_fallback_applied: boolean;
  assigned_at: string | null;
  last_customer_reply_at: string | null;
  last_agent_reply_at: string | null;
  ai_suggestion_pending: boolean;
  resolved_at: string | null;
  closed_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface TicketMessage {
  id: string;
  ticket_id: string;
  author_type: string;
  author_name: string;
  body: string;
  attachments: string[];
  is_ai_generated: boolean;
  ai_confidence: number | null;
  created_at: string;
}

function ticketNumber(): string {
  return `T-${Date.now().toString().slice(-8)}`;
}

export async function createTicket(input: TicketCreateInput): Promise<TicketRecord> {
  const id = uuidv4();
  const no = ticketNumber();
  const firstResponseDue = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  const resolutionDue = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

  const result = await pool.query<TicketRecord>(
    `INSERT INTO tickets (
      id, ticket_no, title, description, service_category, priority, status, customer_id, customer_name, customer_email,
      environment, reproducibility, impact_summary, assignee_type, assignee_name, assigned_at, sla_due_at,
      first_response_due_at, resolution_due_at, ones_ticket_type_key, ai_mode_snapshot
    ) VALUES ($1,$2,$3,$4,$5,$6,'OPEN',$7,$8,$9,$10,$11,$12,'SUPPORT_TEAM','Support Team',NOW(),$13,$14,$15,$16,$17)
    RETURNING *`,
    [
      id,
      no,
      input.title,
      input.description,
      input.serviceCategory ?? "technical_support",
      input.priority,
      input.customer.id,
      input.customer.name,
      input.customer.email ?? null,
      input.environment,
      input.reproducibility,
      input.impactSummary?.trim() || null,
      resolutionDue,
      firstResponseDue,
      resolutionDue,
      input.onesTicketTypeKey ?? null,
      "AI_ON"
    ]
  );

  await addMessage({
    ticketId: id,
    authorType: "CUSTOMER",
    authorName: input.customer.name,
    body: input.description,
    attachments: [],
    isAiGenerated: false,
    aiConfidence: null
  });

  await addAuditLog(id, "ticket_created", null, "OPEN", { source: "portal" });

  return result.rows[0];
}

export async function listTickets(params: {
  customerId?: string;
  status?: TicketStatus;
  sort: "created_desc" | "updated_desc";
}): Promise<TicketRecord[]> {
  const where: string[] = [];
  const values: string[] = [];

  if (params.customerId) {
    values.push(params.customerId);
    where.push(`customer_id = $${values.length}`);
  }

  if (params.status) {
    values.push(params.status);
    where.push(`status = $${values.length}`);
  }

  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const orderBy = params.sort === "created_desc" ? "created_at DESC" : "updated_at DESC";

  const result = await pool.query<TicketRecord>(`SELECT * FROM tickets ${whereSql} ORDER BY ${orderBy} LIMIT 100` , values);
  return result.rows;
}

export async function getTicketById(id: string): Promise<TicketRecord | null> {
  const result = await pool.query<TicketRecord>("SELECT * FROM tickets WHERE id = $1", [id]);
  return result.rows[0] ?? null;
}

export async function listTicketMessages(ticketId: string): Promise<TicketMessage[]> {
  const result = await pool.query<TicketMessage>(
    "SELECT * FROM ticket_messages WHERE ticket_id = $1 ORDER BY created_at DESC",
    [ticketId]
  );
  return result.rows;
}

export async function addMessage(input: {
  ticketId: string;
  authorType: "CUSTOMER" | "AGENT";
  authorName: string;
  body: string;
  attachments: string[];
  isAiGenerated: boolean;
  aiConfidence: number | null;
}): Promise<void> {
  const ticket = await getTicketById(input.ticketId);
  await pool.query(
    `INSERT INTO ticket_messages (id, ticket_id, author_type, author_name, body, attachments, is_ai_generated, ai_confidence)
     VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8)`,
    [uuidv4(), input.ticketId, input.authorType, input.authorName, input.body, JSON.stringify(input.attachments), input.isAiGenerated, input.aiConfidence]
  );

  await pool.query("UPDATE tickets SET updated_at = NOW() WHERE id = $1", [input.ticketId]);

  if (input.authorType === "CUSTOMER") {
    await pool.query("UPDATE tickets SET last_customer_reply_at = NOW(), updated_at = NOW() WHERE id = $1", [input.ticketId]);
  } else {
    await pool.query("UPDATE tickets SET last_agent_reply_at = NOW(), updated_at = NOW() WHERE id = $1", [input.ticketId]);
  }

  if (ticket && !ticket.first_response_at && (input.authorType === "AGENT" || input.isAiGenerated)) {
    await pool.query("UPDATE tickets SET first_response_at = NOW() WHERE id = $1 AND first_response_at IS NULL", [input.ticketId]);
  }
}

export async function transitionTicket(id: string, from: TicketStatus, to: TicketStatus): Promise<void> {
  const now = new Date();
  const previous = await getTicketById(id);
  if (!previous) {
    throw new Error("Ticket not found");
  }
  let pausedSeconds = previous.sla_paused_total_seconds ?? 0;
  if (from === "WAITING_CUSTOMER" && previous.sla_paused_at) {
    pausedSeconds += Math.max(0, Math.floor((now.getTime() - new Date(previous.sla_paused_at).getTime()) / 1000));
  }

  const updateFields =
    to === "RESOLVED"
      ? ", resolved_at = NOW(), sla_paused_at = NULL, sla_pause_reason = NULL"
      : to === "CLOSED"
      ? ", closed_at = NOW()"
      : to === "WAITING_CUSTOMER"
      ? ", sla_paused_at = NOW(), sla_pause_reason = 'waiting_customer'"
      : ", sla_paused_at = NULL, sla_pause_reason = NULL";

  const result = await pool.query(
    `UPDATE tickets
     SET status = $2, updated_at = NOW(), sla_paused_total_seconds = $4 ${updateFields}
     WHERE id = $1 AND status = $3`,
    [id, to, from, pausedSeconds]
  );

  if (!result.rowCount) {
    throw new Error(`Cannot transition ticket ${id} from ${from} to ${to}`);
  }

  await addAuditLog(id, "status_changed", from, to, {});
}

export async function setTicketPriority(id: string, priority: "P1" | "P2" | "P3" | "P4"): Promise<void> {
  await pool.query("UPDATE tickets SET priority = $2, updated_at = NOW() WHERE id = $1", [id, priority]);
}

export async function setTicketAssignee(id: string, type: "SUPPORT_TEAM" | "RND_TEAM", name: string): Promise<void> {
  await pool.query("UPDATE tickets SET assignee_type = $2, assignee_name = $3, assigned_at = NOW(), updated_at = NOW() WHERE id = $1", [id, type, name]);
}

export async function bumpAiRunSeq(id: string): Promise<number> {
  const result = await pool.query<{ ai_run_seq: number }>(
    "UPDATE tickets SET ai_run_seq = ai_run_seq + 1, updated_at = NOW() WHERE id = $1 RETURNING ai_run_seq",
    [id]
  );
  return result.rows[0].ai_run_seq;
}

export async function createAiRun(input: {
  ticketId: string;
  idempotencyKey: string;
  payload: Record<string, unknown>;
}): Promise<string> {
  const id = uuidv4();
  await pool.query(
    "INSERT INTO ai_runs (id, ticket_id, idempotency_key, input_json, status) VALUES ($1,$2,$3,$4::jsonb,'running')",
    [id, input.ticketId, input.idempotencyKey, JSON.stringify(input.payload)]
  );
  return id;
}

export async function completeAiRun(id: string, response: Record<string, unknown>): Promise<void> {
  await pool.query("UPDATE ai_runs SET status = 'completed', response_json = $2::jsonb WHERE id = $1", [id, JSON.stringify(response)]);
}

export async function failAiRun(id: string, error: string): Promise<void> {
  await pool.query("UPDATE ai_runs SET status = 'failed', error = $2 WHERE id = $1", [id, error]);
}

export async function finalizeAiRun(id: string, input: {
  response: Record<string, unknown>;
  traceId: string;
  action: string;
  model: string;
  confidence: number;
  evidence: string[];
  fallbackApplied: boolean;
  promptHash: string;
}): Promise<void> {
  await pool.query(
    `UPDATE ai_runs
     SET status = 'completed',
         response_json = $2::jsonb,
         trace_id = $3,
         decision_action = $4,
         model_name = $5,
         confidence = $6,
         evidence_json = $7::jsonb,
         fallback_applied = $8,
         prompt_hash = $9
     WHERE id = $1`,
    [id, JSON.stringify(input.response), input.traceId, input.action, input.model, input.confidence, JSON.stringify(input.evidence), input.fallbackApplied, input.promptHash]
  );
}

export async function setTicketAiSnapshot(ticketId: string, input: {
  traceId: string;
  action: string;
  confidence: number;
  model: string;
  fallbackApplied: boolean;
  aiModeSnapshot: string;
}) {
  const suggestionPending = input.action === "ask_user" || input.action === "resolve";
  await pool.query(
    `UPDATE tickets
     SET ai_last_trace_id = $2,
         ai_last_action = $3,
         ai_last_confidence = $4,
         ai_last_model = $5,
         ai_last_fallback_applied = $6,
         ai_mode_snapshot = $7,
         ai_suggestion_pending = $8,
         updated_at = NOW()
     WHERE id = $1`,
    [ticketId, input.traceId, input.action, input.confidence, input.model, input.fallbackApplied, input.aiModeSnapshot, suggestionPending]
  );
}

export async function clearAiSuggestionPending(ticketId: string): Promise<void> {
  await pool.query("UPDATE tickets SET ai_suggestion_pending = false, updated_at = NOW() WHERE id = $1", [ticketId]);
}

export async function setTicketOnesSyncResult(ticketId: string, input: { status: "synced" | "failed" | "not_configured"; key?: string | null; error?: string | null }) {
  await pool.query(
    "UPDATE tickets SET ones_sync_status = $2, ones_ticket_key = $3, ones_sync_error = $4, updated_at = NOW() WHERE id = $1",
    [ticketId, input.status, input.key ?? null, input.error ?? null]
  );
}

export async function deleteTicket(ticketId: string): Promise<void> {
  await pool.query("DELETE FROM tickets WHERE id = $1", [ticketId]);
}

export async function applyOnesWebhookEvent(input: {
  onesTicketKey: string;
  status?: string;
  assigneeName?: string;
  commentBody?: string;
}) {
  const ticket = await pool.query<TicketRecord>("SELECT * FROM tickets WHERE ones_ticket_key = $1 LIMIT 1", [input.onesTicketKey]);
  if (!ticket.rowCount) return;
  const row = ticket.rows[0];

  if (input.status) {
    const mapped = ["OPEN", "IN_PROGRESS", "WAITING_CUSTOMER", "ESCALATED_RND", "RESOLVED", "CLOSED"].includes(input.status) ? input.status : row.status;
    await pool.query("UPDATE tickets SET status = $2, updated_at = NOW() WHERE id = $1", [row.id, mapped]);
  }

  if (input.assigneeName) {
    await pool.query("UPDATE tickets SET assignee_name = $2, updated_at = NOW() WHERE id = $1", [row.id, input.assigneeName]);
  }

  if (input.commentBody) {
    await pool.query(
      `INSERT INTO ticket_messages (id, ticket_id, author_type, author_name, body, attachments, is_ai_generated, ai_confidence)
       VALUES ($1,$2,'AGENT','ONES Sync',$3,'[]'::jsonb,false,NULL)`,
      [uuidv4(), row.id, input.commentBody]
    );
    await pool.query("UPDATE tickets SET last_agent_reply_at = NOW(), updated_at = NOW() WHERE id = $1", [row.id]);
  }
}

export async function listOnesLinkedTickets(limit = 100): Promise<Array<Pick<TicketRecord, "id" | "ones_ticket_key" | "ones_ticket_type_key" | "status" | "assignee_name">>> {
  const result = await pool.query<Pick<TicketRecord, "id" | "ones_ticket_key" | "ones_ticket_type_key" | "status" | "assignee_name">>(
    `SELECT id, ones_ticket_key, ones_ticket_type_key, status, assignee_name
     FROM tickets
     WHERE ones_ticket_key IS NOT NULL
     ORDER BY updated_at DESC
     LIMIT $1`,
    [limit]
  );
  return result.rows;
}

export async function addAuditLog(
  ticketId: string,
  eventType: string,
  fromStatus: TicketStatus | null,
  toStatus: TicketStatus | null,
  payload: Record<string, unknown>
): Promise<void> {
  await pool.query(
    `INSERT INTO ticket_audit_logs (id, ticket_id, event_type, from_status, to_status, payload)
     VALUES ($1,$2,$3,$4,$5,$6::jsonb)`,
    [uuidv4(), ticketId, eventType, fromStatus, toStatus, JSON.stringify(payload)]
  );
}
