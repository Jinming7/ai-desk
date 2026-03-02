import express from "express";
import cors from "cors";
import { z } from "zod";
import {
  agentQueueQuerySchema,
  ticketCreateSchema,
  ticketListQuerySchema,
  ticketReplySchema,
  ticketStatusSchema
} from "./contracts/tickets.js";
import * as ticketService from "./modules/tickets/service.js";
import * as agentService from "./modules/agent/service.js";
import * as aiService from "./modules/ai/service.js";
import { MockOpenClawAdapter } from "./infrastructure/openclaw/mock-adapter.js";
import { WsOpenClawAdapter } from "./infrastructure/openclaw/ws-adapter.js";
import { env } from "./config/env.js";
import { asyncHandler } from "./utils/http.js";

const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));

const aiAdapter = env.OPENCLAW_GATEWAY_TOKEN ? new WsOpenClawAdapter() : new MockOpenClawAdapter();

app.get("/api/v1/health", (_req, res) => {
  res.json({ ok: true, service: "nexusflow-api", openclaw: env.OPENCLAW_GATEWAY_TOKEN ? "ws" : "mock" });
});

app.post(
  "/api/v1/tickets",
  asyncHandler(async (req, res) => {
    const input = ticketCreateSchema.parse(req.body);
    const ticket = await ticketService.createTicket(input);
    let triage: unknown = null;
    let triageError: string | null = null;

    try {
      triage = await aiService.runTicketTriage(ticket.id, aiAdapter);
    } catch (error) {
      triageError = (error as Error).message;
    }

    res.status(201).json({ ticket, triage, triageError });
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
  asyncHandler(async (req, res) => {
    const id = z.string().parse(req.params.id);
    const body = z.object({ to: ticketStatusSchema }).parse(req.body);
    await ticketService.transition(id, body.to);
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
