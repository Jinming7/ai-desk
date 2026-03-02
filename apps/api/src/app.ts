import express from "express";
import cors from "cors";
import { z } from "zod";
import {
  agentQueueQuerySchema,
  ticketAssignSchema,
  ticketCreateSchema,
  ticketInternalTransitionSchema,
  ticketListQuerySchema,
  ticketReplySchema,
  ticketStatusSchema
} from "./contracts/tickets.js";
import * as ticketService from "./modules/tickets/service.js";
import * as agentService from "./modules/agent/service.js";
import * as aiService from "./modules/ai/service.js";
import * as workflowService from "./modules/workflow/service.js";
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
    const body = z.object({ query: z.string().min(2) }).parse(req.body);
    const result = await aiService.runSearchMode(body.query);
    res.json({ result });
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
    await ticketService.addReply(id, input);
    res.status(204).send();
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
