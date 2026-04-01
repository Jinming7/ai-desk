import express from "express";
import cors from "cors";
import { z } from "zod";
import fs from "node:fs/promises";
import path from "node:path";
import {
  agentQueueQuerySchema,
  fileUploadSchema,
  imageUploadSchema,
  ticketAiApplySchema,
  ticketBulkActionSchema,
  ticketAssignSchema,
  ticketCreateSchema,
  ticketInternalTransitionSchema,
  ticketListQuerySchema,
  ticketReplySchema
} from "./contracts/tickets.js";
import {
  aiEscalateRequestSchema,
  aiSearchRequestSchema,
  aiTicketDraftRequestSchema,
  aiTicketSubmitRequestSchema
} from "./contracts/ai-search.js";
import {
  kbBuildsFullSchema,
  kbBuildsIncrementalSchema,
  kbDocsComEnsureSchema,
  kbDocsComStatusQuerySchema,
  kbEnqueueSyncSchema,
  kbPublicationPromoteSchema,
  kbPublicationStatusQuerySchema,
  kbRepoRegistrationSchema,
  kbRetrievalQuerySchema,
  kbRunJobsSchema,
  kbWebhookHeadersSchema
} from "./contracts/github-kb.js";
import * as ticketService from "./modules/tickets/service.js";
import * as agentService from "./modules/agent/service.js";
import * as aiService from "./modules/ai/service.js";
import * as aiRepo from "./modules/ai/repository.js";
import * as escalationService from "./modules/escalation/service.js";
import * as workflowService from "./modules/workflow/service.js";
import * as settingsService from "./modules/settings/service.js";
import * as onesSyncService from "./modules/ones-sync/service.js";
import * as supportUxService from "./modules/support-ux/service.js";
import * as githubKbService from "./modules/github-kb/service.js";
import { getAiTopology } from "./modules/ai/agent-router.js";
import { preloadLocalDocsIndex } from "./modules/ai/local-docs.js";
import { getAiCapabilities } from "./modules/ai/multimodal.js";
import { MockOpenClawAdapter } from "./infrastructure/openclaw/mock-adapter.js";
import { WsOpenClawAdapter } from "./infrastructure/openclaw/ws-adapter.js";
import { env } from "./config/env.js";
import { shouldStartBackgroundLoops } from "./config/runtime-env.js";
import { asyncHandler } from "./utils/http.js";

const app = express();
app.use(cors());
app.use(express.json({ limit: "10mb" }));

const uploadsRoot = path.resolve(process.cwd(), "uploads");
const imagesUploadRoot = path.join(uploadsRoot, "images");
const filesUploadRoot = path.join(uploadsRoot, "files");
app.use("/uploads", express.static(uploadsRoot));

const aiAdapter =
  env.NODE_ENV === "test"
    ? new MockOpenClawAdapter()
    : new WsOpenClawAdapter();

function currentAiTopology() {
  return getAiTopology();
}

function hasOpenClawGatewayAuth(): boolean {
  return Boolean(env.OPENCLAW_GATEWAY_TOKEN || env.OPENCLAW_BASIC_PASS);
}

export async function ensureAiRuntimeReady() {
  if (env.NODE_ENV === "test") return;
  if (!hasOpenClawGatewayAuth()) {
    throw new Error("OpenClaw gateway auth is not configured");
  }
  const topology = currentAiTopology();
  if (!topology.multiAgentReady) {
    throw new Error(`AI topology conflicts: ${topology.conflicts.map((item) => item.detail).join("; ")}`);
  }
  const health = await aiAdapter.healthCheck({
    agentIds: topology.configuredAgents
  });
  if (!health.ok || (health.unreachableAgents?.length ?? 0) > 0) {
    const detail =
      health.unreachableAgents?.map((item) => `${item.agentId}: ${item.detail}`).join("; ") ||
      health.detail ||
      "Unknown OpenClaw health failure";
    throw new Error(`OpenClaw multi-agent topology is not ready: ${detail}`);
  }
}

const aiTopology = currentAiTopology();
if (env.NODE_ENV !== "test") {
  const stageSummary = [...aiTopology.searchStages, ...aiTopology.supportStages.stages]
    .map((stage) => `${stage.stage}:${stage.agentId}`)
    .join(",");
  console.info(
    `[ai-topology] multiAgentReady=${String(aiTopology.multiAgentReady)} configuredAgents=${aiTopology.configuredAgents.length} topologyHash=${aiTopology.topologyHash}${stageSummary ? ` [${stageSummary}]` : ""}${
      aiTopology.conflicts.length ? ` conflicts=${aiTopology.conflicts.map((item) => item.detail).join(" | ")}` : ""
    }`
  );
}

async function enrichCustomerStatus<T extends { status: string; ones_ticket_type_key?: string | null }>(ticket: T) {
  const mapped = await onesSyncService.resolveCustomerStatusLabel({
    issueTypeKey: ticket.ones_ticket_type_key ?? null,
    internalStatus: ticket.status
  });
  return { ...ticket, customer_status_label: mapped.label };
}

if (shouldStartBackgroundLoops()) {
  void preloadLocalDocsIndex().catch(() => undefined);

  setInterval(() => {
    void onesSyncService.reconcileReadModel(20).catch(() => undefined);
  }, 5 * 60 * 1000);

  if (env.GITHUB_KB_ENABLED) {
    void githubKbService.bootstrapRepositoryFromEnvIfConfigured().catch(() => undefined);
    void githubKbService.validateStartupConfig().catch(() => undefined);
    setInterval(() => {
      void githubKbService.runDueSyncJobs(env.GITHUB_KB_WORKER_BATCH_SIZE).catch(() => undefined);
    }, env.GITHUB_KB_WORKER_INTERVAL_SECONDS * 1000);
    setInterval(() => {
      void githubKbService.pollAndEnqueueIncremental(env.GITHUB_KB_POLL_BATCH_SIZE).catch(() => undefined);
    }, Math.max(30, env.GITHUB_KB_WORKER_INTERVAL_SECONDS) * 1000);
  }
}

function requireInternalRequest(req: express.Request, res: express.Response, next: express.NextFunction) {
  const surface = req.header("x-portal-surface");
  if (surface !== "internal") {
    res.status(403).json({ error: "Forbidden: internal portal access required" });
    return;
  }
  next();
}

function hasAutomationBearerToken(req: express.Request): boolean {
  const authorization = req.header("authorization") ?? "";
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  const token = match?.[1]?.trim();
  if (!token) return false;
  return token === env.INTERNAL_OPS_TOKEN || token === env.CRON_SECRET;
}

function requireInternalOrAutomationRequest(req: express.Request, res: express.Response, next: express.NextFunction) {
  if (req.header("x-portal-surface") === "internal" || hasAutomationBearerToken(req)) {
    next();
    return;
  }
  res.status(403).json({ error: "Forbidden: internal portal or automation token required" });
}

app.get(
  "/api/v1/health",
  asyncHandler(async (_req, res) => {
    const topology = currentAiTopology();
    const health = await aiAdapter.healthCheck({
      agentIds: topology.configuredAgents
    });
    res.json({
      ok: topology.multiAgentReady && health.ok,
      service: "nexusflow-api",
      openclaw: health.mode,
      multiAgentReady: topology.multiAgentReady && health.ok,
      topologyHash: topology.topologyHash,
      aiTopology: topology,
      configuredAgents: topology.configuredAgents,
      reachableAgents: health.reachableAgents ?? [],
      unreachableAgents: health.unreachableAgents ?? [],
      conflicts: topology.conflicts
    });
  })
);

app.get("/api/v1/internal/ai/topology", requireInternalRequest, (_req, res) => {
  res.json(currentAiTopology());
});

app.get(
  "/api/v1/integrations/openclaw/health",
  asyncHandler(async (_req, res) => {
    const topology = currentAiTopology();
    const health = await aiAdapter.healthCheck({
      agentIds: topology.configuredAgents
    });
    const ok = topology.multiAgentReady && health.ok;
    res.status(ok ? 200 : 503).json({
      ...health,
      multiAgentReady: ok,
      topologyHash: topology.topologyHash,
      configuredAgents: topology.configuredAgents,
      conflicts: topology.conflicts
    });
  })
);

app.post(
  "/api/v1/uploads/images",
  asyncHandler(async (req, res) => {
    const body = imageUploadSchema.parse(req.body);
    const match = body.dataUrl.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/);
    if (!match) {
      res.status(400).json({ error: "Invalid image payload" });
      return;
    }

    const [, mimeType, base64Payload] = match;
    if (mimeType !== body.contentType) {
      res.status(400).json({ error: "Image content type mismatch" });
      return;
    }

    const extension = mimeType.split("/")[1]?.replace("jpeg", "jpg") || "png";
    const safeName = body.filename.replace(/[^a-zA-Z0-9._-]/g, "_");
    const imageId = `${Date.now()}-${safeName}`;
    const finalName = imageId.endsWith(`.${extension}`) ? imageId : `${imageId}.${extension}`;
    const absolutePath = path.join(imagesUploadRoot, finalName);

    await fs.mkdir(imagesUploadRoot, { recursive: true });
    await fs.writeFile(absolutePath, Buffer.from(base64Payload, "base64"));

    res.status(201).json({
      attachment: {
        url: `/uploads/images/${finalName}`,
        name: body.filename,
        contentType: body.contentType
      }
    });
  })
);

app.post(
  "/api/v1/uploads/files",
  asyncHandler(async (req, res) => {
    const body = fileUploadSchema.parse(req.body);
    const match = body.dataUrl.match(/^data:([^;]+);base64,(.+)$/);
    if (!match) {
      res.status(400).json({ error: "Invalid file payload" });
      return;
    }

    const [, mimeType, base64Payload] = match;
    if (mimeType !== body.contentType) {
      res.status(400).json({ error: "File content type mismatch" });
      return;
    }

    const safeName = body.filename.replace(/[^a-zA-Z0-9._-]/g, "_");
    const fileId = `${Date.now()}-${safeName}`;
    const absolutePath = path.join(filesUploadRoot, fileId);

    await fs.mkdir(filesUploadRoot, { recursive: true });
    await fs.writeFile(absolutePath, Buffer.from(base64Payload, "base64"));

    res.status(201).json({
      attachment: {
        url: `/uploads/files/${fileId}`,
        name: body.filename,
        contentType: body.contentType
      }
    });
  })
);

app.post(
  "/api/v1/internal/tickets/:id/ai/apply",
  requireInternalRequest,
  asyncHandler(async (req, res) => {
    const body = ticketAiApplySchema.parse(req.body ?? {});
    try {
      const result = await ticketService.applyLatestAiSuggestion(String(req.params.id), body);
      res.json(result);
    } catch (error) {
      const statusCode = typeof (error as { statusCode?: unknown }).statusCode === "number" ? Number((error as { statusCode: number }).statusCode) : 500;
      if (statusCode !== 500) {
        res.status(statusCode).json({ error: (error as Error).message });
        return;
      }
      throw error;
    }
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
    if (env.NODE_ENV !== "test" && !hasOpenClawGatewayAuth()) {
      res.status(503).json({ error: "OpenClaw gateway auth is not configured" });
      return;
    }
    const body = aiSearchRequestSchema.parse(req.body);
    const result = await aiService.runSearchMode(body.query, aiAdapter, {
      sessionId: body.sessionId,
      conversation: body.conversation,
      answerLanguage: body.answerLanguage,
      imageAttachments: body.imageAttachments,
      attachments: body.attachments
    });
    res.json({ result });
  })
);

app.get(
  "/api/v1/ai/capabilities",
  asyncHandler(async (_req, res) => {
    res.json({ capabilities: await getAiCapabilities() });
  })
);

app.post(
  "/api/v1/ai/handoff/draft",
  asyncHandler(async (req, res) => {
    const body = aiTicketDraftRequestSchema.parse(req.body);
    const draft = await aiService.buildTicketDraftFromConversation({
      sessionId: body.sessionId,
      question: body.question,
      conversation: body.conversation,
      retrievalTraces: body.retrievalTraces
    });
    res.status(201).json({ draft });
  })
);

app.post(
  "/api/v1/ai/handoff/submit",
  asyncHandler(async (req, res) => {
    const body = aiTicketSubmitRequestSchema.parse(req.body);
    const { payload } = await aiService.buildTicketPayloadFromDraft({
      draftId: body.draftId,
      overrides: {
        title: body.title,
        description: body.description,
        attachments: body.attachments,
        serviceCategory: body.serviceCategory,
        onesTicketTypeKey: body.onesTicketTypeKey,
        onesFields: body.onesFields,
        customer: body.customer
      }
    });
    const created = await workflowService.submitTicketWorkflow(payload, aiAdapter);
    await aiService.markTicketDraftSubmitted(body.draftId, created.ticket.id);
    res.status(201).json({ ticket: created.ticket, triage: created.triage, triageError: created.triageError });
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
    const enriched = await Promise.all(tickets.map((ticket) => enrichCustomerStatus(ticket)));
    res.json({ tickets: enriched });
  })
);

app.get(
  "/api/v1/tickets/:id",
  asyncHandler(async (req, res) => {
    const id = z.string().parse(req.params.id);
    const data = await ticketService.getTicketDetail(id);
    const ticket = await enrichCustomerStatus(data.ticket);
    res.json({ ...data, ticket });
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
    const rows = await onesSyncService.listCustomerTicketTypes();
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

app.get(
  "/api/v1/internal/configuration/config",
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

app.put(
  "/api/v1/internal/configuration/config",
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

app.post(
  "/api/v1/internal/configuration/catalog/discover",
  requireInternalRequest,
  asyncHandler(async (req, res) => {
    const actor = z.string().default("internal_operator").parse(req.body?.actor);
    const rows = await onesSyncService.discoverTicketTypes(actor);
    res.json({ ticketTypes: rows });
  })
);

app.post(
  "/api/v1/internal/configuration/projects/discover",
  requireInternalRequest,
  asyncHandler(async (req, res) => {
    const result = await onesSyncService.discoverProjects(req.body);
    res.json(result);
  })
);

app.post(
  "/api/v1/internal/configuration/project-issue-types/discover",
  requireInternalRequest,
  asyncHandler(async (req, res) => {
    const result = await onesSyncService.discoverProjectIssueTypes(req.body);
    res.json({ issueTypes: result });
  })
);

app.get(
  "/api/v1/internal/configuration/project-issue-types",
  requireInternalRequest,
  asyncHandler(async (req, res) => {
    const projectKey = z.string().min(1).parse(req.query.projectKey);
    const issueTypes = await onesSyncService.listProjectIssueTypes(projectKey);
    res.json({ issueTypes });
  })
);

app.put(
  "/api/v1/internal/configuration/project-issue-types/:issueTypeKey/exposure",
  requireInternalRequest,
  asyncHandler(async (req, res) => {
    const issueTypeKey = z.string().min(1).parse(req.params.issueTypeKey);
    const projectKey = z.string().min(1).parse(req.body?.projectKey);
    const enabledForCustomer = z.coerce.boolean().parse(req.body?.enabledForCustomer);
    const issueTypeName = z.string().optional().parse(req.body?.issueTypeName);
    const actor = z.string().default("internal_operator").parse(req.body?.actor);
    const saved = await onesSyncService.setProjectIssueTypeExposure({
      projectKey,
      issueTypeKey,
      issueTypeName,
      enabledForCustomer,
      actor
    });
    res.json({ config: saved });
  })
);

app.get(
  "/api/v1/internal/configuration/project-issue-types/:issueTypeKey/fields",
  requireInternalRequest,
  asyncHandler(async (req, res) => {
    const issueTypeKey = z.string().min(1).parse(req.params.issueTypeKey);
    const projectKey = z.string().min(1).parse(req.query.projectKey);
    const fields = await onesSyncService.getProjectIssueTypeFields({ projectKey, issueTypeKey });
    res.json({ fields });
  })
);

app.get(
  "/api/v1/internal/configuration/project-issue-types/:issueTypeKey/config",
  requireInternalRequest,
  asyncHandler(async (req, res) => {
    const issueTypeKey = z.string().min(1).parse(req.params.issueTypeKey);
    const projectKey = z.string().min(1).parse(req.query.projectKey);
    const config = await onesSyncService.getProjectIssueTypeConfig({ projectKey, issueTypeKey });
    res.json({ config });
  })
);

app.put(
  "/api/v1/internal/configuration/project-issue-types/:issueTypeKey/config",
  requireInternalRequest,
  asyncHandler(async (req, res) => {
    const issueTypeKey = z.string().min(1).parse(req.params.issueTypeKey);
    const projectKey = z.string().min(1).parse(req.body?.projectKey);
    const issueTypeName = z.string().optional().parse(req.body?.issueTypeName);
    const actor = z.string().default("internal_operator").parse(req.body?.actor);
    const fieldSchema = z.array(z.any()).default([]).parse(req.body?.fieldSchema ?? []);
    const statusMapping = z.record(z.string(), z.string()).default({}).parse(req.body?.statusMapping ?? {});
    const config = await onesSyncService.saveProjectIssueTypeConfig({
      projectKey,
      issueTypeKey,
      issueTypeName,
      fieldSchema,
      statusMapping,
      actor
    });
    res.json({ config });
  })
);

app.post(
  "/api/v1/internal/configuration/endpoint/test",
  requireInternalRequest,
  asyncHandler(async (req, res) => {
    const result = await onesSyncService.testEndpoint(req.body);
    res.status(result.ok ? 200 : 400).json(result);
  })
);

app.get(
  "/api/v1/internal/configuration/statuses/discover",
  requireInternalRequest,
  asyncHandler(async (req, res) => {
    const teamId = z.string().optional().parse(req.query.teamId);
    const projectKey = z.string().optional().parse(req.query.projectKey);
    const issueTypeKey = z.string().min(1).parse(req.query.issueTypeKey);
    const statuses = await onesSyncService.discoverIssueStatuses({ teamId, projectKey, issueTypeKey });
    res.json({ statuses });
  })
);

app.get(
  "/api/v1/internal/configuration/history",
  requireInternalRequest,
  asyncHandler(async (req, res) => {
    const limit = z.coerce.number().int().min(1).max(100).default(20).parse(req.query.limit);
    const history = await onesSyncService.listConfigHistory(limit);
    res.json({ history });
  })
);

app.post(
  "/api/v1/internal/configuration/publish/preflight",
  requireInternalRequest,
  asyncHandler(async (_req, res) => {
    const result = await onesSyncService.runPublishPreflight();
    res.status(result.ready ? 200 : 400).json(result);
  })
);

app.post(
  "/api/v1/internal/configuration/publish",
  requireInternalRequest,
  asyncHandler(async (req, res) => {
    const actor = z.string().default("internal_operator").parse(req.body?.actor);
    const reason = z.string().max(500).optional().parse(req.body?.reason);
    const config = await onesSyncService.publishConfig(actor, reason);
    res.json({ config });
  })
);

app.post(
  "/api/v1/internal/configuration/rollback",
  requireInternalRequest,
  asyncHandler(async (req, res) => {
    const configId = z.string().uuid().parse(req.body?.configId);
    const actor = z.string().default("internal_operator").parse(req.body?.actor);
    const reason = z.string().max(500).optional().parse(req.body?.reason);
    const config = await onesSyncService.rollbackConfig(configId, actor, reason);
    res.json({ config });
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
  "/api/v1/internal/configuration/catalog/ticket-types",
  requireInternalRequest,
  asyncHandler(async (_req, res) => {
    const ticketTypes = await onesSyncService.listTicketTypes();
    res.json({ ticketTypes });
  })
);

app.get(
  "/api/v1/internal/configuration/catalog/status",
  requireInternalRequest,
  asyncHandler(async (_req, res) => {
    const status = await onesSyncService.getCatalogStatus();
    res.json({ status });
  })
);

app.get(
  "/api/v1/internal/ones-sync/mappings",
  requireInternalRequest,
  asyncHandler(async (req, res) => {
    const ticketTypeKey = z.string().min(1).parse(req.query.ticketTypeKey);
    const flow = z.enum(["create", "update", "transition", "comment"]).parse(req.query.flow);
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
      flow: z.enum(["create", "update", "transition", "comment"]),
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

app.post(
  "/api/v1/internal/configuration/webhook/ingest",
  asyncHandler(async (req, res) => {
    const result = await onesSyncService.ingestWebhook(req.body);
    res.status(202).json({ result });
  })
);

app.get(
  "/api/v1/internal/configuration/webhook/failed",
  requireInternalRequest,
  asyncHandler(async (_req, res) => {
    const events = await onesSyncService.listFailedWebhooks();
    res.json({ events });
  })
);

app.post(
  "/api/v1/internal/configuration/webhook/replay",
  requireInternalRequest,
  asyncHandler(async (req, res) => {
    const eventId = z.string().uuid().parse(req.body?.eventId);
    const result = await onesSyncService.replayFailedWebhook(eventId);
    res.json({ result });
  })
);

app.get(
  "/api/v1/internal/configuration/operations/health",
  requireInternalRequest,
  asyncHandler(async (_req, res) => {
    const health = await onesSyncService.getSyncHealthSummary();
    res.json({ health });
  })
);

app.post(
  "/api/v1/internal/configuration/operations/reconcile",
  requireInternalRequest,
  asyncHandler(async (req, res) => {
    const limit = z.coerce.number().int().min(1).max(200).default(50).parse(req.body?.limit ?? 50);
    const result = await onesSyncService.reconcileReadModel(limit);
    res.json({ result });
  })
);

app.get(
  "/api/v1/internal/kb/repos",
  requireInternalRequest,
  asyncHandler(async (_req, res) => {
    const repos = await githubKbService.listRepositories();
    res.json({ repos });
  })
);

app.post(
  "/api/v1/internal/kb/repos/register",
  requireInternalOrAutomationRequest,
  asyncHandler(async (req, res) => {
    const body = kbRepoRegistrationSchema.parse(req.body);
    const result = await githubKbService.registerRepository(body);
    res.status(201).json(result);
  })
);

app.post(
  "/api/v1/internal/kb/builds/full",
  requireInternalOrAutomationRequest,
  asyncHandler(async (req, res) => {
    const body = kbBuildsFullSchema.parse(req.body ?? {});
    const result = await githubKbService.startKnowledgeBaseFullBuild(body);
    res.status(202).json({ result });
  })
);

app.post(
  "/api/v1/internal/kb/builds/incremental",
  requireInternalOrAutomationRequest,
  asyncHandler(async (req, res) => {
    const body = kbBuildsIncrementalSchema.parse(req.body ?? {});
    const result = await githubKbService.startKnowledgeBaseIncrementalBuild(body);
    res.status(202).json({ result });
  })
);

app.get(
  "/api/v1/internal/kb/builds/:id",
  requireInternalOrAutomationRequest,
  asyncHandler(async (req, res) => {
    const buildId = z.string().uuid().parse(req.params.id);
    const result = await githubKbService.getKnowledgeBaseBuildDetails(buildId);
    if (!result) {
      res.status(404).json({ error: "build_not_found" });
      return;
    }
    res.json({ result });
  })
);

app.post(
  "/api/v1/internal/kb/publications/promote",
  requireInternalRequest,
  asyncHandler(async (req, res) => {
    const body = kbPublicationPromoteSchema.parse(req.body ?? {});
    const result = await githubKbService.promoteValidatedBuild(body);
    res.json({ result });
  })
);

app.get(
  "/api/v1/internal/kb/publications/status",
  requireInternalOrAutomationRequest,
  asyncHandler(async (req, res) => {
    const query = kbPublicationStatusQuerySchema.parse(req.query);
    const result = await githubKbService.getKnowledgeBasePublicationStatus(query);
    res.json({ result });
  })
);

app.get(
  "/api/v1/internal/kb/docs-com/status",
  requireInternalOrAutomationRequest,
  asyncHandler(async (req, res) => {
    const query = kbDocsComStatusQuerySchema.parse(req.query);
    const result = await githubKbService.getDocsComStatus({ recentJobLimit: query.limit });
    res.json({ result });
  })
);

app.post(
  "/api/v1/internal/kb/docs-com/ensure",
  requireInternalOrAutomationRequest,
  asyncHandler(async (req, res) => {
    const body = kbDocsComEnsureSchema.parse(req.body ?? {});
    const result = await githubKbService.ensureDocsComKnowledgeBase({
      actor: body.actor,
      mode: body.mode,
      runLimit: body.runLimit,
      idempotencySeed: req.header("x-vercel-deployment-url") ?? req.header("x-deployment-id") ?? undefined
    });
    res.status(202).json({ result });
  })
);

app.post(
  "/api/v1/internal/kb/sync/full",
  requireInternalOrAutomationRequest,
  asyncHandler(async (req, res) => {
    const body = kbEnqueueSyncSchema.parse({ ...req.body, mode: "full", source: "manual" });
    const job = await githubKbService.enqueueSyncJob({
      repoId: body.repoId,
      branch: body.branch,
      mode: "full",
      source: "manual",
      beforeCommitSha: body.beforeCommitSha,
      afterCommitSha: body.afterCommitSha,
      payload: body.payload,
      idempotencyKey: body.idempotencyKey
    });
    res.status(202).json({ job });
  })
);

app.post(
  "/api/v1/internal/kb/sync/incremental",
  requireInternalOrAutomationRequest,
  asyncHandler(async (req, res) => {
    const body = kbEnqueueSyncSchema.parse({ ...req.body, mode: "incremental", source: "manual" });
    const job = await githubKbService.enqueueSyncJob({
      repoId: body.repoId,
      branch: body.branch,
      mode: "incremental",
      source: "manual",
      beforeCommitSha: body.beforeCommitSha,
      afterCommitSha: body.afterCommitSha,
      payload: body.payload,
      idempotencyKey: body.idempotencyKey
    });
    res.status(202).json({ job });
  })
);

app.post(
  "/api/v1/internal/kb/sync/reindex",
  requireInternalOrAutomationRequest,
  asyncHandler(async (req, res) => {
    const repoId = z.string().uuid().parse(req.body?.repoId);
    const branch = z.string().default("main").parse(req.body?.branch);
    const job = await githubKbService.triggerReindex(repoId, branch);
    res.status(202).json({ job });
  })
);

app.post(
  "/api/v1/internal/kb/sync/run",
  requireInternalOrAutomationRequest,
  asyncHandler(async (req, res) => {
    const body = kbRunJobsSchema.parse(req.body);
    const result = await githubKbService.runDueSyncJobs(body.limit);
    res.json({ result });
  })
);

app.get(
  "/api/v1/internal/kb/sync/cron/:lane",
  requireInternalOrAutomationRequest,
  asyncHandler(async (req, res) => {
    const lane = z.enum(["lane-a", "lane-b", "lane-c", "poll"]).parse(req.params.lane);
    const pollResult = lane === "poll" ? await githubKbService.pollAndEnqueueIncremental(env.GITHUB_KB_POLL_BATCH_SIZE) : null;
    const result = await githubKbService.runDueSyncJobs(1);
    res.json({ lane, pollResult, result });
  })
);

app.get(
  "/api/v1/internal/kb/sync/jobs",
  requireInternalOrAutomationRequest,
  asyncHandler(async (req, res) => {
    const limit = z.coerce.number().int().min(1).max(200).default(50).parse(req.query.limit);
    const jobs = await githubKbService.listSyncJobs(limit);
    res.json({ jobs });
  })
);

app.get(
  "/api/v1/internal/kb/sync/health",
  requireInternalOrAutomationRequest,
  asyncHandler(async (_req, res) => {
    const health = await githubKbService.getSyncHealthSummary();
    res.json({ health });
  })
);

app.get(
  "/api/v1/internal/kb/metrics",
  requireInternalRequest,
  asyncHandler(async (_req, res) => {
    const metrics = await githubKbService.getMetricsSummary();
    res.json({ metrics });
  })
);

app.post(
  "/api/v1/internal/kb/compliance/read-only",
  requireInternalRequest,
  asyncHandler(async (_req, res) => {
    const compliance = await githubKbService.runReadOnlyComplianceCheck();
    res.json({ compliance });
  })
);

app.post(
  "/api/v1/internal/kb/webhook/github",
  asyncHandler(async (req, res) => {
    const headers = kbWebhookHeadersSchema.parse({
      event: req.header("x-github-event"),
      delivery: req.header("x-github-delivery"),
      signature256: req.header("x-hub-signature-256")
    });
    const payload = (req.body ?? {}) as Record<string, unknown>;
    const result = await githubKbService.ingestGithubWebhook({
      event: headers.event,
      delivery: headers.delivery,
      signature256: headers.signature256,
      payload
    });
    res.status(result.accepted ? 202 : 400).json({ result });
  })
);

app.post(
  "/api/v1/kb/retrieval/query",
  asyncHandler(async (req, res) => {
    const body = kbRetrievalQuerySchema.parse(req.body);
    const result = await githubKbService.retrieveKnowledge({
      query: body.query,
      profile: body.profile,
      repoId: body.repoId,
      branch: body.branch,
      topK: body.topK,
      includeFallback: body.includeFallback
    });
    res.json({ result });
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
