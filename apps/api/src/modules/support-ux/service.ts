import { z } from "zod";
import * as repo from "./repository.js";

const eventSchema = z.object({
  actor: z.string().min(1).default("support_user"),
  eventType: z.enum([
    "queue_selected",
    "ticket_opened",
    "ai_suggestion_viewed",
    "ai_suggestion_applied",
    "ai_suggestion_overridden",
    "action_executed",
    "response_sent"
  ]),
  ticketId: z.string().uuid().optional(),
  queueKey: z.string().optional(),
  traceId: z.string().optional(),
  payload: z.record(z.string(), z.any()).default({})
});

export async function trackEvent(input: unknown) {
  const parsed = eventSchema.parse(input);
  await repo.addEvent({
    actor: parsed.actor,
    eventType: parsed.eventType,
    ticketId: parsed.ticketId,
    queueKey: parsed.queueKey,
    traceId: parsed.traceId,
    payload: parsed.payload
  });
}

export async function getMetricsSummary() {
  const summary = await repo.summaryLast24h();
  const adoptionBase = summary.ai_suggestion_viewed || 0;
  return {
    firstActionLatencySecondsAvg: Number(summary.first_action_latency_seconds_avg ?? 0),
    aiSuggestionAdoptionRate: adoptionBase > 0 ? summary.ai_suggestion_applied / adoptionBase : 0,
    slaAtRiskQueueSelections: summary.queue_sla_at_risk_selected,
    actionsExecuted: summary.action_executed
  };
}
