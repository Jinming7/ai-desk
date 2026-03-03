import { pool } from "../../db/client.js";

type QueueKey =
  | "pending"
  | "mine"
  | "all"
  | "sla_at_risk"
  | "ai_suggested"
  | "new_assigned"
  | "waiting_my_reply"
  | "my_all"
  | "resolved";

interface QueueParams {
  queue: QueueKey;
  assignee?: string;
  status?: string;
  priority?: string;
  slaRisk?: "healthy" | "at_risk" | "breached";
  productArea?: string;
  ticketType?: string;
  sort: "sla_risk" | "updated_desc" | "created_desc";
}

function computeSlaRisk(due: string | null): "healthy" | "at_risk" | "breached" {
  if (!due) return "healthy";
  const diff = new Date(due).getTime() - Date.now();
  if (diff <= 0) return "breached";
  if (diff <= 2 * 60 * 60 * 1000) return "at_risk";
  return "healthy";
}

function matchesQueue(row: Record<string, unknown>, queue: QueueKey, assignee?: string): boolean {
  const status = String(row.status ?? "");
  const assignedName = String(row.assignee_name ?? "");
  const risk = String(row.sla_risk ?? "healthy");
  const aiSuggested = Boolean(row.ai_suggestion_pending);
  const assignedAt = row.assigned_at ? new Date(String(row.assigned_at)).getTime() : 0;
  const newAssigned = Date.now() - assignedAt <= 2 * 60 * 60 * 1000;
  const waitingMyReply =
    row.last_customer_reply_at &&
    (!row.last_agent_reply_at ||
      new Date(String(row.last_customer_reply_at)).getTime() > new Date(String(row.last_agent_reply_at)).getTime()) &&
    ["IN_PROGRESS", "ESCALATED_RND", "WAITING_CUSTOMER"].includes(status);

  switch (queue) {
    case "pending":
      return ["IN_PROGRESS", "ESCALATED_RND"].includes(status);
    case "mine":
      return assignee ? assignedName === assignee : true;
    case "all":
      return true;
    case "sla_at_risk":
      return (risk === "at_risk" || risk === "breached") && !["RESOLVED", "CLOSED"].includes(status);
    case "ai_suggested":
      return aiSuggested && ["IN_PROGRESS", "WAITING_CUSTOMER", "ESCALATED_RND"].includes(status);
    case "new_assigned":
      return newAssigned && !["RESOLVED", "CLOSED"].includes(status);
    case "waiting_my_reply":
      return Boolean(waitingMyReply);
    case "my_all":
      return assignee ? assignedName === assignee : true;
    case "resolved":
      return ["RESOLVED", "CLOSED"].includes(status);
    default:
      return true;
  }
}

export async function listQueue(params: QueueParams) {
  const columns = await pool.query<{ column_name: string }>(
    "SELECT column_name FROM information_schema.columns WHERE table_name = 'tickets'"
  );
  const supported = new Set(columns.rows.map((r) => r.column_name));

  const has = (name: string) => supported.has(name);
  const resolutionDueExpr = has("resolution_due_at") ? "t.resolution_due_at" : "t.sla_due_at";

  const where: string[] = [];
  const values: string[] = [];

  if (params.status) {
    values.push(params.status);
    where.push(`t.status = $${values.length}`);
  }
  if (params.priority) {
    values.push(params.priority);
    where.push(`t.priority = $${values.length}`);
  }
  if (params.ticketType) {
    values.push(params.ticketType);
    where.push(`${has("ones_ticket_type_key") ? "t.ones_ticket_type_key" : "t.service_category"} = $${values.length}`);
  }

  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const sortSql =
    params.sort === "updated_desc"
      ? "t.updated_at DESC"
      : params.sort === "created_desc"
      ? "t.created_at DESC"
      : `COALESCE(${resolutionDueExpr}, t.sla_due_at, NOW()) ASC, t.updated_at DESC`;

  const result = await pool.query(
    `SELECT
      t.id,
      t.ticket_no,
      t.title,
      t.priority,
      t.customer_name,
      t.status,
      t.assignee_name,
      t.created_at,
      t.updated_at,
      t.sla_due_at,
      ${resolutionDueExpr} AS resolution_due_at,
      ${has("first_response_due_at") ? "t.first_response_due_at" : "NULL::timestamptz"} AS first_response_due_at,
      ${has("first_response_at") ? "t.first_response_at" : "NULL::timestamptz"} AS first_response_at,
      ${has("sla_paused_at") ? "t.sla_paused_at" : "NULL::timestamptz"} AS sla_paused_at,
      ${has("sla_pause_reason") ? "t.sla_pause_reason" : "NULL::text"} AS sla_pause_reason,
      ${has("ones_ticket_type_key") ? "t.ones_ticket_type_key" : "t.service_category"} AS ones_ticket_type_key,
      ${has("ones_ticket_key") ? "t.ones_ticket_key" : "NULL::text"} AS ones_ticket_key,
      ${has("ones_sync_status") ? "t.ones_sync_status" : "NULL::text"} AS ones_sync_status,
      ${has("ai_mode_snapshot") ? "t.ai_mode_snapshot" : "'AI_ON'::text"} AS ai_mode_snapshot,
      ${has("ai_last_trace_id") ? "t.ai_last_trace_id" : "NULL::text"} AS ai_last_trace_id,
      ${has("ai_last_action") ? "t.ai_last_action" : "latest.response_json->>'action'"} AS ai_last_action,
      ${has("ai_last_confidence") ? "t.ai_last_confidence" : "(latest.response_json->>'confidence')::numeric"} AS ai_last_confidence,
      ${has("ai_suggestion_pending") ? "t.ai_suggestion_pending" : "false"} AS ai_suggestion_pending,
      ${has("assigned_at") ? "t.assigned_at" : "t.updated_at"} AS assigned_at,
      ${has("last_customer_reply_at") ? "t.last_customer_reply_at" : "NULL::timestamptz"} AS last_customer_reply_at,
      ${has("last_agent_reply_at") ? "t.last_agent_reply_at" : "NULL::timestamptz"} AS last_agent_reply_at,
      latest.response_json->>'reasoning_summary' AS triage_reasoning_summary,
      latest.response_json->'evidence' AS triage_evidence,
      (latest.response_json->>'confidence')::numeric AS triage_confidence
     FROM tickets t
     LEFT JOIN LATERAL (
       SELECT response_json
       FROM ai_runs
       WHERE ai_runs.ticket_id = t.id AND ai_runs.status = 'completed'
       ORDER BY created_at DESC
       LIMIT 1
     ) latest ON true
     ${whereSql}
     ORDER BY ${sortSql}
     LIMIT 300`,
    values
  );

  return result.rows
    .map((row) => {
      const due = (row.resolution_due_at ?? row.sla_due_at) as string | null;
      const sla_risk = computeSlaRisk(due);
      return { ...row, sla_risk };
    })
    .filter((row) => {
      if (params.slaRisk && params.slaRisk !== row.sla_risk) return false;
      return matchesQueue(row, params.queue, params.assignee);
    });
}

export async function getQueueCounts(assignee?: string) {
  const keys: QueueKey[] = ["sla_at_risk", "ai_suggested", "new_assigned", "waiting_my_reply", "my_all", "resolved"];
  const entries = await Promise.all(
    keys.map(async (key) => {
      const rows = await listQueue({ queue: key, assignee, sort: "sla_risk" });
      return [key, rows.length] as const;
    })
  );
  return Object.fromEntries(entries);
}
