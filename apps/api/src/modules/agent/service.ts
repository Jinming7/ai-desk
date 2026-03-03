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
    values.push(params.ticketType);
    where.push(`ones_ticket_type_key = $${values.length}`);
  }

  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const now = new Date().toISOString();
  const sortSql =
    params.sort === "updated_desc"
      ? "t.updated_at DESC"
      : params.sort === "created_desc"
      ? "t.created_at DESC"
      : `CASE
           WHEN COALESCE(t.resolution_due_at, t.sla_due_at, NOW()) <= '${now}'::timestamptz THEN 3
           WHEN COALESCE(t.resolution_due_at, t.sla_due_at, NOW()) <= ('${now}'::timestamptz + INTERVAL '1 hour') THEN 2
           ELSE 1
         END DESC,
         COALESCE(t.resolution_due_at, t.sla_due_at) ASC,
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
      t.resolution_due_at,
      t.first_response_due_at,
      t.first_response_at,
      t.sla_paused_at,
      t.sla_pause_reason,
      t.ones_ticket_type_key,
      t.ones_ticket_key,
      t.ones_sync_status,
      t.ai_mode_snapshot,
      t.ai_last_trace_id,
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
