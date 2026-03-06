import type { AgentQueueTicket, AiAgentMode, AiEscalation, OnesCatalogStatus, OnesSyncConfig, OnesTicketType, SearchResult, Ticket, TicketMessage, TicketStatus } from "./types";

const API = (import.meta.env.VITE_API_BASE_URL || "").replace(/\/$/, "");

function asUserError(error: unknown): Error {
  if (error instanceof TypeError) {
    return new Error("Cannot reach API server. Check deployment URL and API routing.");
  }
  return error instanceof Error ? error : new Error("Unexpected request error");
}

export async function listTickets(customerId?: string, status?: TicketStatus | "ALL"): Promise<Ticket[]> {
  const params = new URLSearchParams();
  if (customerId) params.set("customerId", customerId);
  if (status && status !== "ALL") params.set("status", status);
  const query = params.toString() ? `?${params.toString()}` : "";
  const res = await fetch(`${API}/api/v1/tickets${query}`).catch((error) => {
    throw asUserError(error);
  });
  if (!res.ok) throw new Error("Failed to load tickets");
  const data = await res.json();
  return data.tickets;
}

export async function getTicketDetail(id: string): Promise<{ ticket: Ticket; messages: TicketMessage[] }> {
  const res = await fetch(`${API}/api/v1/tickets/${id}`).catch((error) => {
    throw asUserError(error);
  });
  if (!res.ok) throw new Error("Failed to load ticket detail");
  return res.json();
}

export async function createTicket(payload: {
  title: string;
  description: string;
  serviceCategory?: "technical_support" | "feature_consulting" | "account_issue";
  onesTicketTypeKey?: string;
  onesFields?: Record<string, unknown>;
  customer?: { id: string; name: string; email?: string };
  environment?: "production" | "staging" | "test" | "unknown";
  reproducibility?: "always" | "sometimes" | "once" | "unknown";
  impactSummary?: string;
}) {
  const customer = payload.customer ?? { id: "customer_demo", name: "Acme User" };
  const res = await fetch(`${API}/api/v1/tickets`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      ...payload,
      priority: "P3",
      serviceCategory: payload.serviceCategory ?? "technical_support",
      customer,
      environment: payload.environment ?? "unknown",
      reproducibility: payload.reproducibility ?? "unknown",
      impactSummary: payload.impactSummary ?? ""
    })
  }).catch((error) => {
    throw asUserError(error);
  });

  if (!res.ok) throw new Error("Failed to create ticket");
  return res.json() as Promise<{
    ticket: Ticket;
    triage: {
      action: "resolve" | "ask_user" | "escalate";
      confidence: number;
      reply: string;
      reasoning_summary: string;
      evidence: string[];
    } | null;
    triageError: string | null;
  }>;
}

export async function searchKnowledge(query: string): Promise<SearchResult> {
  const res = await fetch(`${API}/api/v1/ai/search`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query })
  }).catch((error) => {
    throw asUserError(error);
  });
  if (!res.ok) throw new Error("Failed to search knowledge base");
  const data = await res.json();
  return data.result;
}

export async function createQuickEscalation(input: {
  sessionId: string;
  question: string;
  conversation: string[];
  reasonCode: "NO_MATCHING_KB" | "LOW_CONFIDENCE" | "KB_RETRIEVAL_UNAVAILABLE";
}): Promise<AiEscalation> {
  const res = await fetch(`${API}/api/v1/ai/escalations`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input)
  }).catch((error) => {
    throw asUserError(error);
  });
  if (!res.ok) throw new Error("Failed to create quick escalation");
  const data = await res.json();
  return data.escalation;
}

export async function getEscalationStatus(id: string): Promise<AiEscalation> {
  const res = await fetch(`${API}/api/v1/ai/escalations/${id}`).catch((error) => {
    throw asUserError(error);
  });
  if (!res.ok) throw new Error("Failed to fetch escalation status");
  const data = await res.json();
  return data.escalation;
}

export async function getAiMetricsSummary(): Promise<{
  hitRate: number;
  citationCoverage: number;
  fallbackRate: number;
}> {
  const res = await fetch(`${API}/api/v1/ai/metrics/summary`, {
    headers: { "x-portal-surface": "internal" }
  }).catch((error) => {
    throw asUserError(error);
  });
  if (!res.ok) throw new Error("Failed to fetch AI metrics");
  const data = await res.json();
  return data.metrics;
}

export async function replyTicket(id: string, body: string) {
  const res = await fetch(`${API}/api/v1/tickets/${id}/replies`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      body,
      authorType: "CUSTOMER",
      authorName: "Acme User",
      attachments: []
    })
  }).catch((error) => {
    throw asUserError(error);
  });
  if (!res.ok) throw new Error("Failed to send reply");
}

export async function replyTicketAsAgent(id: string, body: string, authorName = "Support Team") {
  const res = await fetch(`${API}/api/v1/tickets/${id}/replies`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-portal-surface": "internal" },
    body: JSON.stringify({
      body,
      authorType: "AGENT",
      authorName,
      attachments: []
    })
  }).catch((error) => {
    throw asUserError(error);
  });
  if (!res.ok) throw new Error("Failed to send agent reply");
}

export async function listAgentTickets(queue: "pending" | "mine" | "all", assignee?: string): Promise<AgentQueueTicket[]> {
  return listSupportTickets({ queue, assignee });
}

export async function listSupportTickets(input: {
  queue: "pending" | "mine" | "all" | "sla_at_risk" | "ai_suggested" | "new_assigned" | "waiting_my_reply" | "my_all" | "resolved";
  assignee?: string;
  status?: TicketStatus;
  priority?: "P1" | "P2" | "P3" | "P4";
  slaRisk?: "healthy" | "at_risk" | "breached";
  ticketType?: string;
  sort?: "sla_risk" | "updated_desc" | "created_desc";
}): Promise<AgentQueueTicket[]> {
  const params = new URLSearchParams();
  params.set("queue", input.queue);
  if (input.assignee) params.set("assignee", input.assignee);
  if (input.status) params.set("status", input.status);
  if (input.priority) params.set("priority", input.priority);
  if (input.slaRisk) params.set("slaRisk", input.slaRisk);
  if (input.ticketType) params.set("ticketType", input.ticketType);
  if (input.sort) params.set("sort", input.sort);

  const res = await fetch(`${API}/api/v1/support/tickets?${params.toString()}`, {
    headers: { "x-portal-surface": "internal" }
  }).catch((error) => {
    throw asUserError(error);
  });
  if (!res.ok) throw new Error("Failed to load support queue");
  const data = await res.json();
  return data.tickets;
}

export async function getSupportQueueCounts(assignee?: string): Promise<Record<string, number>> {
  const params = new URLSearchParams();
  if (assignee) params.set("assignee", assignee);
  const query = params.toString() ? `?${params.toString()}` : "";
  const res = await fetch(`${API}/api/v1/support/queue-counts${query}`, {
    headers: { "x-portal-surface": "internal" }
  }).catch((error) => {
    throw asUserError(error);
  });
  if (!res.ok) throw new Error("Failed to load support queue counts");
  return (await res.json()).counts;
}

export async function trackSupportUxEvent(input: {
  actor: string;
  eventType:
    | "queue_selected"
    | "ticket_opened"
    | "ai_suggestion_viewed"
    | "ai_suggestion_applied"
    | "ai_suggestion_overridden"
    | "action_executed"
    | "response_sent";
  ticketId?: string;
  queueKey?: string;
  traceId?: string;
  payload?: Record<string, unknown>;
}) {
  const res = await fetch(`${API}/api/v1/internal/support/ux-events`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-portal-surface": "internal" },
    body: JSON.stringify(input)
  }).catch((error) => {
    throw asUserError(error);
  });
  if (!res.ok) throw new Error("Failed to track support UX event");
}

export async function getSupportUxMetrics(): Promise<{
  firstActionLatencySecondsAvg: number;
  aiSuggestionAdoptionRate: number;
  slaAtRiskQueueSelections: number;
  actionsExecuted: number;
}> {
  const res = await fetch(`${API}/api/v1/internal/support/ux-metrics`, {
    headers: { "x-portal-surface": "internal" }
  }).catch((error) => {
    throw asUserError(error);
  });
  if (!res.ok) throw new Error("Failed to fetch support UX metrics");
  return (await res.json()).metrics;
}

export async function runBulkTicketAction(input: {
  ticketIds: string[];
  action: "assign" | "priority" | "escalate";
  assigneeType?: "SUPPORT_TEAM" | "RND_TEAM";
  assigneeName?: string;
  priority?: "P1" | "P2" | "P3" | "P4";
  actor?: string;
}) {
  const res = await fetch(`${API}/api/v1/internal/tickets/bulk-actions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-portal-surface": "internal" },
    body: JSON.stringify(input)
  }).catch((error) => {
    throw asUserError(error);
  });
  if (!res.ok) throw new Error("Failed to run bulk action");
  return res.json();
}

export async function transitionTicket(
  id: string,
  to: TicketStatus,
  reasonCode: "manual_escalation" | "manual_resolution" | "manual_waiting_customer" | "customer_reply"
) {
  const res = await fetch(`${API}/api/v1/tickets/${id}/transition`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-portal-surface": "internal" },
    body: JSON.stringify({ to, reasonCode })
  }).catch((error) => {
    throw asUserError(error);
  });
  if (!res.ok) throw new Error("Failed to transition ticket");
}

export async function assignTicket(
  id: string,
  assigneeType: "SUPPORT_TEAM" | "RND_TEAM",
  assigneeName: string,
  reasonCode:
    | "manual_claim"
    | "manual_escalation"
    | "manual_resolution"
    | "manual_waiting_customer"
    | "ai_model_escalation"
    | "integration_failure"
    | "customer_reply"
) {
  const res = await fetch(`${API}/api/v1/tickets/${id}/assign`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-portal-surface": "internal" },
    body: JSON.stringify({ assigneeType, assigneeName, reasonCode })
  }).catch((error) => {
    throw asUserError(error);
  });
  if (!res.ok) throw new Error("Failed to assign ticket");
}

export async function getAiAgentMode(): Promise<AiAgentMode> {
  const res = await fetch(`${API}/api/v1/internal/settings/ai-agent`, {
    headers: { "x-portal-surface": "internal" }
  }).catch((error) => {
    throw asUserError(error);
  });
  if (!res.ok) throw new Error("Failed to get AI mode");
  const data = await res.json();
  return data.mode;
}

export async function setAiAgentMode(enabled: boolean, actor = "admin_operator", reason = "support_operation"): Promise<AiAgentMode> {
  const res = await fetch(`${API}/api/v1/internal/settings/ai-agent`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", "x-portal-surface": "internal" },
    body: JSON.stringify({ enabled, actor, reason })
  }).catch((error) => {
    throw asUserError(error);
  });
  if (!res.ok) throw new Error("Failed to update AI mode");
  const data = await res.json();
  return data.mode;
}

export async function listOnesTicketTypesInternal(): Promise<OnesTicketType[]> {
  const res = await fetch(`${API}/api/v1/internal/ones-sync/ticket-types`, {
    headers: { "x-portal-surface": "internal" }
  }).catch((error) => {
    throw asUserError(error);
  });
  if (!res.ok) throw new Error("Failed to load ONES ticket types");
  const data = await res.json();
  return data.ticketTypes;
}

export async function listOnesTicketTypesPublic(): Promise<OnesTicketType[]> {
  const res = await fetch(`${API}/api/v1/ones/ticket-types`).catch((error) => {
    throw asUserError(error);
  });
  if (!res.ok) throw new Error("Failed to load ONES ticket types");
  const data = await res.json();
  return data.ticketTypes;
}

export async function getOnesSyncConfig(): Promise<OnesSyncConfig | null> {
  const res = await fetch(`${API}/api/v1/internal/configuration/config`, {
    headers: { "x-portal-surface": "internal" }
  }).catch((error) => {
    throw asUserError(error);
  });
  if (!res.ok) throw new Error("Failed to load ONES sync config");
  const data = await res.json();
  return data.config;
}

export async function updateOnesSyncConfig(input: {
  profileName: string;
  baseUrl: string;
  authType: "bearer" | "header";
  authHeader: string;
  authSecret?: string;
  keepExistingSecret?: boolean;
  createTicketPath: string;
  listProjectsPath: string;
  listTicketTypesPath: string;
  listFieldsPathTemplate: string;
  timeoutMs: number;
  retries: number;
  dataSourceMode: "ones_primary" | "local_mirror";
  onesProjectKey?: string;
  onesTeamId?: string;
  actor?: string;
}): Promise<OnesSyncConfig> {
  const res = await fetch(`${API}/api/v1/internal/configuration/config`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", "x-portal-surface": "internal" },
    body: JSON.stringify(input)
  }).catch((error) => {
    throw asUserError(error);
  });
  if (!res.ok) throw new Error("Failed to update ONES sync config");
  const data = await res.json();
  return data.config;
}

export async function discoverOnesTicketTypes(actor = "support_admin"): Promise<OnesTicketType[]> {
  const res = await fetch(`${API}/api/v1/internal/configuration/catalog/discover`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-portal-surface": "internal" },
    body: JSON.stringify({ actor })
  }).catch((error) => {
    throw asUserError(error);
  });
  if (!res.ok) throw new Error("Failed to discover ONES ticket types");
  const data = await res.json();
  return data.ticketTypes;
}

export async function listOnesMappings(ticketTypeKey: string, flow: "create" | "update" | "transition" | "comment") {
  const params = new URLSearchParams({ ticketTypeKey, flow });
  const res = await fetch(`${API}/api/v1/internal/ones-sync/mappings?${params.toString()}`, {
    headers: { "x-portal-surface": "internal" }
  }).catch((error) => {
    throw asUserError(error);
  });
  if (!res.ok) throw new Error("Failed to load ONES mappings");
  return (await res.json()).mappings;
}

export async function saveOnesMappingDraft(input: {
  ticketTypeKey: string;
  flow: "create" | "update" | "transition" | "comment";
  mappings: Array<{
    source: string;
    target: string;
    transform: "none" | "concat" | "enumMap" | "dateFormat" | "constant" | "fallback";
    transformConfig: Record<string, unknown>;
    requiredPolicy: "hard_fail" | "default_value";
  }>;
  actor?: string;
}) {
  const res = await fetch(`${API}/api/v1/internal/ones-sync/mappings/draft`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", "x-portal-surface": "internal" },
    body: JSON.stringify(input)
  }).catch((error) => {
    throw asUserError(error);
  });
  if (!res.ok) throw new Error("Failed to save ONES mapping draft");
  return (await res.json()).mapping;
}

export async function validateOnesMapping(input: {
  ticketTypeKey: string;
  flow: "create" | "update" | "transition" | "comment";
  mappings: Array<{
    source: string;
    target: string;
    transform: "none" | "concat" | "enumMap" | "dateFormat" | "constant" | "fallback";
    transformConfig: Record<string, unknown>;
    requiredPolicy: "hard_fail" | "default_value";
  }>;
  sampleContext: Record<string, unknown>;
}) {
  const res = await fetch(`${API}/api/v1/internal/ones-sync/mappings/validate`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-portal-surface": "internal" },
    body: JSON.stringify(input)
  }).catch((error) => {
    throw asUserError(error);
  });
  if (!res.ok) throw new Error("Failed to validate ONES mapping");
  return (await res.json()).validation;
}

export async function publishOnesMapping(mappingId: string, actor = "support_admin") {
  const res = await fetch(`${API}/api/v1/internal/ones-sync/mappings/publish`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-portal-surface": "internal" },
    body: JSON.stringify({ mappingId, actor })
  }).catch((error) => {
    throw asUserError(error);
  });
  if (!res.ok) throw new Error("Failed to publish ONES mapping");
  return (await res.json()).mapping;
}

export async function rollbackOnesMapping(ticketTypeKey: string, flow: "create" | "update" | "transition" | "comment", actor = "support_admin") {
  const res = await fetch(`${API}/api/v1/internal/ones-sync/mappings/rollback`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-portal-surface": "internal" },
    body: JSON.stringify({ ticketTypeKey, flow, actor })
  }).catch((error) => {
    throw asUserError(error);
  });
  if (!res.ok) throw new Error("Failed to rollback ONES mapping");
  return (await res.json()).mapping;
}

export async function getOnesCatalogStatus(): Promise<OnesCatalogStatus> {
  const res = await fetch(`${API}/api/v1/internal/configuration/catalog/status`, {
    headers: { "x-portal-surface": "internal" }
  }).catch((error) => {
    throw asUserError(error);
  });
  if (!res.ok) throw new Error("Failed to load ONES catalog status");
  return (await res.json()).status;
}

export async function discoverOnesProjects(input: {
  baseUrl: string;
  authType: "bearer" | "header";
  authHeader: string;
  authSecret?: string;
  keepExistingSecret?: boolean;
  teamId: string;
  limit?: number;
  cursor?: string;
  listProjectsPath: string;
  timeoutMs: number;
}) {
  const res = await fetch(`${API}/api/v1/internal/configuration/projects/discover`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-portal-surface": "internal" },
    body: JSON.stringify(input)
  }).catch((error) => {
    throw asUserError(error);
  });
  if (!res.ok) throw new Error("Failed to discover ONES projects");
  return (await res.json()) as { projects: Array<{ key: string; name: string }>; nextCursor: string | null };
}

export async function testIntegrationEndpoint(input: {
  baseUrl: string;
  authType: "bearer" | "header";
  authHeader: string;
  authSecret?: string;
  keepExistingSecret?: boolean;
  customHeaders?: Record<string, string>;
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  body?: unknown;
  timeoutMs: number;
}) {
  const res = await fetch(`${API}/api/v1/internal/configuration/endpoint/test`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-portal-surface": "internal" },
    body: JSON.stringify(input)
  }).catch((error) => {
    throw asUserError(error);
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.error ? `Endpoint test failed: ${data.error}` : `Endpoint test failed: ${data.status ?? res.status} ${data.statusText ?? ""}`);
  }
  return data as {
    ok: boolean;
    status: number;
    statusText: string;
    url: string;
    elapsedMs: number;
    response: unknown;
    error?: string | null;
  };
}

export async function listFailedWebhookEvents() {
  const res = await fetch(`${API}/api/v1/internal/configuration/webhook/failed`, {
    headers: { "x-portal-surface": "internal" }
  }).catch((error) => {
    throw asUserError(error);
  });
  if (!res.ok) throw new Error("Failed to load webhook failed events");
  return (await res.json()).events as Array<{ id: string; event_type: string; ones_ticket_key: string | null; error: string | null; retries: number; received_at: string }>;
}

export async function replayWebhookEvent(eventId: string) {
  const res = await fetch(`${API}/api/v1/internal/configuration/webhook/replay`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-portal-surface": "internal" },
    body: JSON.stringify({ eventId })
  }).catch((error) => {
    throw asUserError(error);
  });
  if (!res.ok) throw new Error("Failed to replay webhook event");
  return (await res.json()).result;
}

export async function getOnesSyncHealth() {
  const res = await fetch(`${API}/api/v1/internal/configuration/operations/health`, {
    headers: { "x-portal-surface": "internal" }
  }).catch((error) => {
    throw asUserError(error);
  });
  if (!res.ok) throw new Error("Failed to load sync health");
  return (await res.json()).health as { failedWebhookCount: number; topErrors: string[]; updatedAt: string };
}
