import express from "express";
import cors from "cors";
import { z } from "zod";
import {
  agentQueueQuerySchema,
  ticketBulkActionSchema,
  ticketAssignSchema,
  ticketCreateSchema,
  ticketInternalTransitionSchema,
  ticketListQuerySchema,
  ticketReplySchema
} from "./contracts/tickets.js";
import { aiEscalateRequestSchema, aiSearchRequestSchema } from "./contracts/ai-search.js";
import * as ticketService from "./modules/tickets/service.js";
import * as agentService from "./modules/agent/service.js";
import * as aiService from "./modules/ai/service.js";
import * as aiRepo from "./modules/ai/repository.js";
import * as escalationService from "./modules/escalation/service.js";
import * as workflowService from "./modules/workflow/service.js";
import * as settingsService from "./modules/settings/service.js";
import * as onesSyncService from "./modules/ones-sync/service.js";
import * as supportUxService from "./modules/support-ux/service.js";
import { MockOpenClawAdapter } from "./infrastructure/openclaw/mock-adapter.js";
import { WsOpenClawAdapter } from "./infrastructure/openclaw/ws-adapter.js";
import { env } from "./config/env.js";
import { asyncHandler } from "./utils/http.js";

const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));

const aiAdapter = env.OPENCLAW_GATEWAY_TOKEN ? new WsOpenClawAdapter() : new MockOpenClawAdapter();

function requireInternalRequest(req: express.Request, res: express.Response, next: express.NextFunction) {
  const surface = req.header("x-portal-surface");
  if (surface !== "internal") {
    res.status(403).json({ error: "Forbidden: internal portal access required" });
    return;
  }
  next();
}

app.get("/api/v1/health", (_req, res) => {
  res.json({ ok: true, service: "nexusflow-api", openclaw: env.OPENCLAW_GATEWAY_TOKEN ? "ws" : "mock" });
});

app.get(
  "/api/v1/integrations/openclaw/health",
  asyncHandler(async (_req, res) => {
    const health = await aiAdapter.healthCheck();
    res.status(health.ok ? 200 : 503).json(health);
  })
);

app.post(
  "/api/v1/tickets",
  asyncHandler(async (req, res) => {
    const input = ticketCreateSchema.parse(req.body);
    const result = await workflowService.submitTicketWorkflow(input, aiAdapter);
    res.status(201).json(result);
  })
);

app.post(
  "/api/v1/ai/search",
  asyncHandler(async (req, res) => {
    const body = aiSearchRequestSchema.parse(req.body);
    const result = await aiService.runSearchMode(body.query, aiAdapter);
    res.json({ result });
  })
);

app.post(
  "/api/v1/ai/escalations",
  asyncHandler(async (req, res) => {
    const body = aiEscalateRequestSchema.parse(req.body);
    const escalation = await escalationService.createOrGetEscalation({
      sessionId: body.sessionId,
      question: body.question,
      conversation: body.conversation,
      reasonCode: body.reasonCode,
      adapter: aiAdapter
    });
    res.status(201).json({ escalation });
  })
);

app.get(
  "/api/v1/ai/escalations/:id",
  asyncHandler(async (req, res) => {
    const id = z.string().uuid().parse(req.params.id);
    const escalation = await escalationService.getEscalation(id);
    if (!escalation) {
      res.status(404).json({ error: "Escalation not found" });
      return;
    }
    res.json({ escalation });
  })
);

app.get(
  "/api/v1/ai/metrics/summary",
  requireInternalRequest,
  asyncHandler(async (_req, res) => {
    const metrics = await aiRepo.aggregateMetricsLast24h();
    res.json({ metrics });
  })
);

app.get(
  "/api/v1/tickets",
  asyncHandler(async (req, res) => {
    const query = ticketListQuerySchema.parse(req.query);
    const tickets = await ticketService.listTickets(query);
    res.json({ tickets });
  })
);

app.get(
  "/api/v1/tickets/:id",
  asyncHandler(async (req, res) => {
    const id = z.string().parse(req.params.id);
    const data = await ticketService.getTicketDetail(id);
    res.json(data);
  })
);

app.post(
  "/api/v1/tickets/:id/replies",
  asyncHandler(async (req, res) => {
    const id = z.string().parse(req.params.id);
    const input = ticketReplySchema.parse(req.body);
    if (input.authorType === "AGENT" && req.header("x-portal-surface") !== "internal") {
      res.status(403).json({ error: "Forbidden: internal portal access required for AGENT replies" });
      return;
    }
    await ticketService.addReply(id, input);
    res.status(204).send();
  })
);

app.get(
  "/api/v1/internal/settings/ai-agent",
  requireInternalRequest,
  asyncHandler(async (_req, res) => {
    const mode = await settingsService.getAiAgentMode();
    res.json({ mode });
  })
);

app.put(
  "/api/v1/internal/settings/ai-agent",
  requireInternalRequest,
  asyncHandler(async (req, res) => {
    const mode = await settingsService.setAiAgentMode(req.body);
    res.json({ mode });
  })
);

app.post(
  "/api/v1/internal/tickets/bulk-actions",
  requireInternalRequest,
  asyncHandler(async (req, res) => {
    const input = ticketBulkActionSchema.parse(req.body);
    const result = await ticketService.applyBulkAction(input);
    res.json(result);
  })
);

app.post(
  "/api/v1/tickets/:id/close",
  asyncHandler(async (req, res) => {
    const id = z.string().parse(req.params.id);
    await ticketService.closeTicket(id);
    res.status(204).send();
  })
);

app.post(
  "/api/v1/tickets/:id/transition",
  requireInternalRequest,
  asyncHandler(async (req, res) => {
    const id = z.string().parse(req.params.id);
    const body = ticketInternalTransitionSchema.parse(req.body);
    await ticketService.transitionInternal(id, body);
    res.status(204).send();
  })
);

app.post(
  "/api/v1/tickets/:id/assign",
  requireInternalRequest,
  asyncHandler(async (req, res) => {
    const id = z.string().parse(req.params.id);
    const input = ticketAssignSchema.parse(req.body);
    await ticketService.assign(id, input);
    res.status(204).send();
  })
);

app.post(
  "/api/v1/tickets/:id/ai/triage",
  asyncHandler(async (req, res) => {
    const id = z.string().parse(req.params.id);
    const result = await aiService.runTicketTriage(id, aiAdapter);
    res.json({ result });
  })
);

app.post(
  "/api/v1/tickets/:id/ai/analyze",
  asyncHandler(async (req, res) => {
    const id = z.string().parse(req.params.id);
    const result = await aiService.runTicketTriage(id, aiAdapter);
    res.json({ result });
  })
);

app.get(
  "/api/v1/agent/tickets",
  requireInternalRequest,
  asyncHandler(async (req, res) => {
    const query = agentQueueQuerySchema.parse(req.query);
    const tickets = await agentService.listQueue(query);
    res.json({ tickets });
  })
);

app.get(
  "/api/v1/support/tickets",
  requireInternalRequest,
  asyncHandler(async (req, res) => {
    const query = agentQueueQuerySchema.parse(req.query);
    const tickets = await agentService.listQueue(query);
    res.json({ tickets });
  })
);

app.get(
  "/api/v1/support/queue-counts",
  requireInternalRequest,
  asyncHandler(async (req, res) => {
    const assignee = z.string().optional().parse(req.query.assignee);
    const counts = await agentService.getQueueCounts(assignee);
    res.json({ counts });
  })
);

app.post(
  "/api/v1/internal/support/ux-events",
  requireInternalRequest,
  asyncHandler(async (req, res) => {
    await supportUxService.trackEvent(req.body);
    res.status(204).send();
  })
);

app.get(
  "/api/v1/internal/support/ux-metrics",
  requireInternalRequest,
  asyncHandler(async (_req, res) => {
    const metrics = await supportUxService.getMetricsSummary();
    res.json({ metrics });
  })
);

app.get(
  "/api/v1/ones/ticket-types",
  asyncHandler(async (_req, res) => {
    const rows = await onesSyncService.listTicketTypes();
    res.json({ ticketTypes: rows });
  })
);

app.get(
  "/api/v1/internal/ones-sync/config",
  requireInternalRequest,
  asyncHandler(async (_req, res) => {
    const config = await onesSyncService.getConfig();
    res.json({ config });
  })
);

app.put(
  "/api/v1/internal/ones-sync/config",
  requireInternalRequest,
  asyncHandler(async (req, res) => {
    const config = await onesSyncService.upsertConfig(req.body);
    res.json({ config });
  })
);

app.post(
  "/api/v1/internal/ones-sync/discover",
  requireInternalRequest,
  asyncHandler(async (req, res) => {
    const actor = z.string().default("internal_operator").parse(req.body?.actor);
    const rows = await onesSyncService.discoverTicketTypes(actor);
    res.json({ ticketTypes: rows });
  })
);

app.get(
  "/api/v1/internal/ones-sync/ticket-types",
  requireInternalRequest,
  asyncHandler(async (_req, res) => {
    const ticketTypes = await onesSyncService.listTicketTypes();
    res.json({ ticketTypes });
  })
);

app.get(
  "/api/v1/internal/ones-sync/mappings",
  requireInternalRequest,
  asyncHandler(async (req, res) => {
    const ticketTypeKey = z.string().min(1).parse(req.query.ticketTypeKey);
    const flow = z.enum(["create", "update"]).parse(req.query.flow);
    const mappings = await onesSyncService.listMappings(ticketTypeKey, flow);
    res.json({ mappings });
  })
);

app.put(
  "/api/v1/internal/ones-sync/mappings/draft",
  requireInternalRequest,
  asyncHandler(async (req, res) => {
    const mapping = await onesSyncService.saveDraftMapping(req.body);
    res.json({ mapping });
  })
);

app.post(
  "/api/v1/internal/ones-sync/mappings/validate",
  requireInternalRequest,
  asyncHandler(async (req, res) => {
    const body = z.object({
      ticketTypeKey: z.string().min(1),
      flow: z.enum(["create", "update"]),
      mappings: z.array(
        z.object({
          source: z.string().min(1),
          target: z.string().min(1),
          transform: z.enum(["none", "concat", "enumMap", "dateFormat", "constant", "fallback"]).default("none"),
          transformConfig: z.record(z.string(), z.any()).default({}),
          requiredPolicy: z.enum(["hard_fail", "default_value"]).default("hard_fail")
        })
      ),
      sampleContext: z.record(z.string(), z.any()).default({})
    }).parse(req.body);
    const validation = await onesSyncService.dryRunMapping(body);
    res.json({ validation });
  })
);

app.post(
  "/api/v1/internal/ones-sync/mappings/publish",
  requireInternalRequest,
  asyncHandler(async (req, res) => {
    const mapping = await onesSyncService.publishMapping(req.body);
    res.json({ mapping });
  })
);

app.post(
  "/api/v1/internal/ones-sync/mappings/rollback",
  requireInternalRequest,
  asyncHandler(async (req, res) => {
    const mapping = await onesSyncService.rollbackMapping(req.body);
    res.json({ mapping });
  })
);

app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  if (err instanceof z.ZodError) {
    res.status(400).json({ error: "Validation error", details: err.flatten() });
    return;
  }

  const message = err instanceof Error ? err.message : "Internal Server Error";
  const code = message.includes("not found") ? 404 : 500;
  res.status(code).json({ error: message });
});

export { app };
