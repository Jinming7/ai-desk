import { pool } from "../../db/client.js";

export async function listQueue(params: {
  queue: "pending" | "mine" | "all";
  assignee?: string;
  status?: string;
  priority?: string;
  slaRisk?: "healthy" | "at_risk" | "breached";
  productArea?: string;
  ticketType?: string;
  sort: "sla_risk" | "updated_desc" | "created_desc";
}) {
  const columns = await pool.query<{ column_name: string }>(
    "SELECT column_name FROM information_schema.columns WHERE table_name = 'tickets'"
  );
  const supported = new Set(columns.rows.map((r) => r.column_name));
  const hasResolutionDue = supported.has("resolution_due_at");
  const hasFirstResponseDue = supported.has("first_response_due_at");
  const hasFirstResponseAt = supported.has("first_response_at");
  const hasSlaPausedAt = supported.has("sla_paused_at");
  const hasSlaPauseReason = supported.has("sla_pause_reason");
  const hasOnesTicketType = supported.has("ones_ticket_type_key");
  const hasOnesTicketKey = supported.has("ones_ticket_key");
  const hasOnesSyncStatus = supported.has("ones_sync_status");
  const hasAiModeSnapshot = supported.has("ai_mode_snapshot");
  const hasAiLastTrace = supported.has("ai_last_trace_id");

  const resolutionDueExpr = hasResolutionDue ? "t.resolution_due_at" : "NULL::timestamptz";

  const where: string[] = [];
  const values: string[] = [];

  if (params.queue === "pending") {
    where.push("status IN ('IN_PROGRESS', 'ESCALATED_RND')");
  }

  if (params.queue === "mine" && params.assignee) {
    values.push(params.assignee);
    where.push(`assignee_name = $${values.length}`);
  }

  if (params.status) {
    values.push(params.status);
    where.push(`status = $${values.length}`);
  }

  if (params.priority) {
    values.push(params.priority);
    where.push(`priority = $${values.length}`);
  }

  if (params.ticketType) {
    if (hasOnesTicketType) {
      values.push(params.ticketType);
      where.push(`ones_ticket_type_key = $${values.length}`);
    } else {
      values.push(params.ticketType);
      where.push(`service_category = $${values.length}`);
    }
  }

  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const now = new Date().toISOString();
  const sortSql =
    params.sort === "updated_desc"
      ? "t.updated_at DESC"
      : params.sort === "created_desc"
      ? "t.created_at DESC"
      : `CASE
           WHEN COALESCE(${resolutionDueExpr}, t.sla_due_at, NOW()) <= '${now}'::timestamptz THEN 3
           WHEN COALESCE(${resolutionDueExpr}, t.sla_due_at, NOW()) <= ('${now}'::timestamptz + INTERVAL '1 hour') THEN 2
           ELSE 1
         END DESC,
         COALESCE(${resolutionDueExpr}, t.sla_due_at) ASC,
         t.priority ASC,
         t.updated_at DESC`;
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
      ${hasFirstResponseDue ? "t.first_response_due_at" : "NULL::timestamptz"} AS first_response_due_at,
      ${hasFirstResponseAt ? "t.first_response_at" : "NULL::timestamptz"} AS first_response_at,
      ${hasSlaPausedAt ? "t.sla_paused_at" : "NULL::timestamptz"} AS sla_paused_at,
      ${hasSlaPauseReason ? "t.sla_pause_reason" : "NULL::text"} AS sla_pause_reason,
      ${hasOnesTicketType ? "t.ones_ticket_type_key" : "NULL::text"} AS ones_ticket_type_key,
      ${hasOnesTicketKey ? "t.ones_ticket_key" : "NULL::text"} AS ones_ticket_key,
      ${hasOnesSyncStatus ? "t.ones_sync_status" : "NULL::text"} AS ones_sync_status,
      ${hasAiModeSnapshot ? "t.ai_mode_snapshot" : "'AI_ON'::text"} AS ai_mode_snapshot,
      ${hasAiLastTrace ? "t.ai_last_trace_id" : "NULL::text"} AS ai_last_trace_id,
      latest.response_json->>'reasoning_summary' AS triage_reasoning_summary,
      latest.response_json->'evidence' AS triage_evidence,
      (latest.response_json->>'confidence')::numeric AS triage_confidence
      ,handoff.payload->>'reasonCode' AS handoff_reason_code
     FROM tickets t
     LEFT JOIN LATERAL (
       SELECT response_json
       FROM ai_runs
       WHERE ai_runs.ticket_id = t.id AND ai_runs.status = 'completed'
       ORDER BY created_at DESC
       LIMIT 1
     ) latest ON true
     LEFT JOIN LATERAL (
       SELECT payload
       FROM ticket_audit_logs
       WHERE ticket_audit_logs.ticket_id = t.id
         AND event_type IN ('assignee_changed', 'internal_transition', 'ai_triage_escalated', 'ai_triage_fallback_escalated')
       ORDER BY created_at DESC
       LIMIT 1
     ) handoff ON true
     ${whereSql.replace(/status/g, "t.status").replace(/assignee_name/g, "t.assignee_name")}
     ORDER BY ${sortSql}
     LIMIT 200`,
    values
  );
  return result.rows.map((row) => {
    const due = row.resolution_due_at ?? row.sla_due_at;
    const dueMs = due ? new Date(due).getTime() : Date.now();
    const diff = dueMs - Date.now();
    const slaRisk = diff <= 0 ? "breached" : diff <= 60 * 60 * 1000 ? "at_risk" : "healthy";
    if (params.slaRisk && params.slaRisk !== slaRisk) return null;
    return { ...row, sla_risk: slaRisk };
  }).filter(Boolean);
}
