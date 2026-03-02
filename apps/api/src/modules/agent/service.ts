import { pool } from "../../db/client.js";

export async function listQueue(params: { queue: "pending" | "mine" | "all"; assignee?: string }) {
  const where: string[] = [];
  const values: string[] = [];

  if (params.queue === "pending") {
    where.push("status IN ('IN_PROGRESS', 'ESCALATED_RND')");
  }

  if (params.queue === "mine" && params.assignee) {
    values.push(params.assignee);
    where.push(`assignee_name = $${values.length}`);
  }

  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const result = await pool.query(
    `SELECT
      t.id,
      t.ticket_no,
      t.title,
      t.customer_name,
      t.status,
      t.assignee_name,
      t.created_at,
      t.updated_at,
      t.sla_due_at,
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
     ${whereSql.replace(/status/g, "t.status").replace(/assignee_name/g, "t.assignee_name")}
     ORDER BY t.updated_at DESC
     LIMIT 200`,
    values
  );

  return result.rows;
}
