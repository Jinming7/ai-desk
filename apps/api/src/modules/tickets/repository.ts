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
  assignee_type: string;
  assignee_name: string;
  ai_run_seq: number;
  sla_due_at: string | null;
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
  const slaDue = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

  const result = await pool.query<TicketRecord>(
    `INSERT INTO tickets (
      id, ticket_no, title, description, service_category, priority, status, customer_id, customer_name, assignee_type, assignee_name, sla_due_at
    ) VALUES ($1,$2,$3,$4,$5,$6,'OPEN',$7,$8,'SUPPORT_TEAM','Support Team',$9)
    RETURNING *`,
    [id, no, input.title, input.description, input.serviceCategory, input.priority, input.customer.id, input.customer.name, slaDue]
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
  await pool.query(
    `INSERT INTO ticket_messages (id, ticket_id, author_type, author_name, body, attachments, is_ai_generated, ai_confidence)
     VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8)`,
    [uuidv4(), input.ticketId, input.authorType, input.authorName, input.body, JSON.stringify(input.attachments), input.isAiGenerated, input.aiConfidence]
  );

  await pool.query("UPDATE tickets SET updated_at = NOW() WHERE id = $1", [input.ticketId]);
}

export async function transitionTicket(id: string, from: TicketStatus, to: TicketStatus): Promise<void> {
  const updateFields =
    to === "RESOLVED"
      ? ", resolved_at = NOW()"
      : to === "CLOSED"
      ? ", closed_at = NOW()"
      : "";

  const result = await pool.query(
    `UPDATE tickets SET status = $2, updated_at = NOW() ${updateFields} WHERE id = $1 AND status = $3`,
    [id, to, from]
  );

  if (!result.rowCount) {
    throw new Error(`Cannot transition ticket ${id} from ${from} to ${to}`);
  }

  await addAuditLog(id, "status_changed", from, to, {});
}

export async function setTicketAssignee(id: string, type: "SUPPORT_TEAM" | "RND_TEAM", name: string): Promise<void> {
  await pool.query("UPDATE tickets SET assignee_type = $2, assignee_name = $3, updated_at = NOW() WHERE id = $1", [id, type, name]);
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
