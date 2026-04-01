import { v4 as uuidv4 } from "uuid";
import { pool } from "../../db/client.js";

export async function addEvent(input: {
  actor: string;
  eventType: string;
  ticketId?: string | null;
  queueKey?: string | null;
  traceId?: string | null;
  payload?: Record<string, unknown>;
}) {
  await pool.query(
    `INSERT INTO support_ux_events (id, actor, event_type, ticket_id, queue_key, trace_id, payload)
     VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)`,
    [uuidv4(), input.actor, input.eventType, input.ticketId ?? null, input.queueKey ?? null, input.traceId ?? null, JSON.stringify(input.payload ?? {})]
  );
}

export async function summaryLast24h() {
  const result = await pool.query<{
    first_action_latency_seconds_avg: number | null;
    ai_suggestion_applied: number;
    ai_suggestion_viewed: number;
    queue_sla_at_risk_selected: number;
    action_executed: number;
  }>(`
    WITH recent AS (
      SELECT * FROM support_ux_events
      WHERE created_at >= NOW() - INTERVAL '24 hours'
    ),
    ticket_first_open AS (
      SELECT ticket_id, MIN(created_at) AS opened_at
      FROM recent
      WHERE event_type = 'ticket_opened' AND ticket_id IS NOT NULL
      GROUP BY ticket_id
    ),
    ticket_first_action AS (
      SELECT ticket_id, MIN(created_at) AS acted_at
      FROM recent
      WHERE event_type = 'action_executed' AND ticket_id IS NOT NULL
      GROUP BY ticket_id
    )
    SELECT
      AVG(EXTRACT(EPOCH FROM (a.acted_at - o.opened_at)))::numeric AS first_action_latency_seconds_avg,
      COUNT(*) FILTER (WHERE recent.event_type = 'ai_suggestion_applied')::int AS ai_suggestion_applied,
      COUNT(*) FILTER (WHERE recent.event_type = 'ai_suggestion_viewed')::int AS ai_suggestion_viewed,
      COUNT(*) FILTER (WHERE recent.event_type = 'queue_selected' AND recent.queue_key = 'sla_at_risk')::int AS queue_sla_at_risk_selected,
      COUNT(*) FILTER (WHERE recent.event_type = 'action_executed')::int AS action_executed
    FROM recent
    LEFT JOIN ticket_first_open o ON recent.ticket_id = o.ticket_id
    LEFT JOIN ticket_first_action a ON recent.ticket_id = a.ticket_id
  `);
  return result.rows[0] ?? {
    first_action_latency_seconds_avg: null,
    ai_suggestion_applied: 0,
    ai_suggestion_viewed: 0,
    queue_sla_at_risk_selected: 0,
    action_executed: 0
  };
}
