import { pool } from "../../db/client.js";

export async function listQueue(params: { queue: "pending" | "mine" | "all"; assignee?: string }) {
  const where: string[] = [];
  const values: string[] = [];

  if (params.queue === "pending") {
    where.push("status IN ('ESCALATED', 'AI_REVIEWING')");
  }

  if (params.queue === "mine" && params.assignee) {
    values.push(params.assignee);
    where.push(`assignee_name = $${values.length}`);
  }

  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const result = await pool.query(
    `SELECT id, ticket_no, title, customer_name, status, assignee_name, created_at, updated_at, sla_due_at
     FROM tickets ${whereSql} ORDER BY updated_at DESC LIMIT 200`,
    values
  );

  return result.rows;
}
