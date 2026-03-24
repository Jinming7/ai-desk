import type {
  AgentQueueTicket,
  AiCapabilities,
  AiAgentMode,
  AiEscalation,
  OnesCatalogStatus,
  ConversationTurn,
  OnesConfigHistoryItem,
  ChatTicketDraft,
  OnesProjectIssueType,
  OnesProjectIssueTypeConfig,
  OnesSyncConfig,
  OnesTicketType,
  SearchResult,
  Ticket,
  TicketMessage,
  TicketStatus,
  UploadedAttachment
} from "./types";

const API = (() => {
  const configured = (import.meta.env.VITE_API_BASE_URL || "").replace(/\/$/, "");
  if (typeof window !== "undefined" && /^(localhost|127\.0\.0\.1)$/.test(window.location.hostname)) {
    return "";
  }
  if (configured) return configured;
  return "";
})();

function asUserError(error: unknown): Error {
  if (error instanceof TypeError) {
    return new Error("Cannot reach API server. Check deployment URL and API routing.");
  }
  return error instanceof Error ? error : new Error("Unexpected request error");
}

function asUploadError(): Error {
  return new Error("Failed to upload attachment");
}

const inFlightRequests = new Map<string, Promise<unknown>>();

function withInFlightDedup<T>(key: string, run: () => Promise<T>): Promise<T> {
  const existing = inFlightRequests.get(key);
  if (existing) return existing as Promise<T>;
  const promise = run().finally(() => {
    if (inFlightRequests.get(key) === promise) {
      inFlightRequests.delete(key);
    }
  });
  inFlightRequests.set(key, promise);
  return promise;
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

export async function applyAiSuggestion(ticketId: string, traceId?: string): Promise<{
  appliedAction: "resolve" | "ask_user" | "escalate";
  traceId?: string | null;
  messagePosted: boolean;
  ticket: Ticket;
}> {
  const res = await fetch(`${API}/api/v1/internal/tickets/${ticketId}/ai/apply`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-portal-surface": "internal"
    },
    body: JSON.stringify(traceId ? { traceId } : {})
  }).catch((error) => {
    throw asUserError(error);
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(text || "Failed to apply AI suggestion");
  }
  return res.json();
}

export async function createTicket(payload: {
  title: string;
  description: string;
  attachments?: string[];
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
      attachments: payload.attachments ?? [],
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

export async function searchKnowledge(input: {
  query: string;
  imageAttachments?: string[];
  attachments?: string[];
  sessionId?: string;
  conversation?: ConversationTurn[];
  answerLanguage?: "zh" | "en";
}): Promise<SearchResult> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let res: Response;
    try {
      res = await fetch(`${API}/api/v1/ai/search`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input)
      });
    } catch (error) {
      const message = error instanceof Error ? error.message.trim() : "";
      throw new Error(message || "Local API is unavailable. Start the backend service and retry.");
    }

    if (res.ok) {
      const data = await res.json();
      return data.result;
    }

    const errorText = await res.text();
    const normalized = errorText.toLowerCase();
    const retryable =
      normalized.includes("connection timeout") ||
      normalized.includes("connection terminated") ||
      normalized.includes("econnreset");
    if (retryable && attempt === 0) {
      await new Promise((resolve) => setTimeout(resolve, 600));
      continue;
    }
    if (retryable) {
      throw new Error("Knowledge base is temporarily busy. Please retry in a few seconds.");
    }
    try {
      const parsed = JSON.parse(errorText) as { error?: unknown };
      const message = typeof parsed.error === "string" ? parsed.error.trim() : "";
      throw new Error(message || "AI support request failed");
    } catch {
      throw new Error(errorText.trim() || "AI support request failed");
    }
  }
  throw new Error("AI support request failed");
}

export async function getAiCapabilities(): Promise<AiCapabilities> {
  const res = await fetch(`${API}/api/v1/ai/capabilities`).catch((error) => {
    throw asUserError(error);
  });
  if (!res.ok) throw new Error("Failed to load AI capabilities");
  const data = await res.json();
  return data.capabilities;
}

export async function createChatTicketDraft(input: {
  sessionId: string;
  question: string;
  conversation: ConversationTurn[];
  retrievalTraces?: unknown[];
}): Promise<ChatTicketDraft> {
  const res = await fetch(`${API}/api/v1/ai/handoff/draft`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      ...input,
      retrievalTraces: input.retrievalTraces ?? []
    })
  }).catch((error) => {
    throw asUserError(error);
  });
  if (!res.ok) throw new Error("Failed to generate ticket draft");
  const data = await res.json();
  return data.draft;
}

export async function submitChatTicketDraft(input: {
  draftId: string;
  customer?: { id: string; name: string; email?: string };
  title?: string;
  description?: string;
  attachments?: string[];
  serviceCategory?: "technical_support" | "feature_consulting" | "account_issue";
  onesTicketTypeKey?: string;
  onesFields?: Record<string, unknown>;
}) {
  const res = await fetch(`${API}/api/v1/ai/handoff/submit`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      ...input,
      attachments: input.attachments ?? [],
      onesFields: input.onesFields ?? {}
    })
  }).catch((error) => {
    throw asUserError(error);
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(text || "Failed to submit ticket draft");
  }
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

export async function createQuickEscalation(input: {
  sessionId: string;
  question: string;
  conversation: ConversationTurn[];
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
  noCitationRate: number;
  clarificationResolutionRate: number;
  chatToTicketConversion: number;
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

export async function replyTicket(id: string, body: string, attachments: string[] = []) {
  const res = await fetch(`${API}/api/v1/tickets/${id}/replies`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      body,
      authorType: "CUSTOMER",
      authorName: "Acme User",
      attachments
    })
  }).catch((error) => {
    throw asUserError(error);
  });
  if (!res.ok) throw new Error("Failed to send reply");
}

export async function replyTicketAsAgent(id: string, body: string, authorName = "Support Team", attachments: string[] = []) {
  const res = await fetch(`${API}/api/v1/tickets/${id}/replies`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-portal-surface": "internal" },
    body: JSON.stringify({
      body,
      authorType: "AGENT",
      authorName,
      attachments
    })
  }).catch((error) => {
    throw asUserError(error);
  });
  if (!res.ok) throw new Error("Failed to send agent reply");
}

export async function uploadImageAttachment(file: File): Promise<UploadedAttachment> {
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(new Error("Failed to read image"));
    reader.readAsDataURL(file);
  });

  const res = await fetch(`${API}/api/v1/uploads/images`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      filename: file.name,
      contentType: file.type,
      dataUrl
    })
  }).catch((error) => {
    throw error instanceof Error && error.message === "Failed to read image" ? error : asUploadError();
  });

  if (!res.ok) {
    throw asUploadError();
  }

  const data = await res.json();
  return {
    ...data.attachment,
    url: data.attachment.url.startsWith("http") ? data.attachment.url : `${API}${data.attachment.url}`
  };
}

export async function uploadAttachment(file: File): Promise<UploadedAttachment> {
  if (file.type.startsWith("image/")) {
    return uploadImageAttachment(file);
  }

  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(new Error("Failed to read file"));
    reader.readAsDataURL(file);
  });

  const res = await fetch(`${API}/api/v1/uploads/files`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      filename: file.name,
      contentType: file.type || "application/octet-stream",
      dataUrl
    })
  }).catch((error) => {
    throw error instanceof Error && error.message === "Failed to read file" ? error : asUploadError();
  });

  if (!res.ok) {
    throw asUploadError();
  }

  const data = await res.json();
  return {
    ...data.attachment,
    url: data.attachment.url.startsWith("http") ? data.attachment.url : `${API}${data.attachment.url}`
  };
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
  systemAuthSecret?: string;
  keepExistingSystemSecret?: boolean;
  createTicketPath: string;
  listProjectsPath: string;
  listTicketTypesPath: string;
  listFieldsPathTemplate: string;
  endpointTemplates?: Record<string, string>;
  allowedTicketTypeKeys?: string[];
  statusMapping?: Record<string, string>;
  workflowMapping?: Record<string, string>;
  publishState?: "draft" | "published";
  publishChecks?: Record<string, unknown>;
  changeReason?: string;
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
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const detail = typeof data?.error === "string" ? data.error : "Failed to update ONES sync config";
    throw new Error(detail);
  }
  return data.config;
}

export async function discoverOnesIssueStatuses(input?: { teamId?: string; projectKey?: string; issueTypeKey?: string; signal?: AbortSignal }) {
  const run = async () => {
    const params = new URLSearchParams();
    if (input?.teamId) params.set("teamId", input.teamId);
    if (input?.projectKey) params.set("projectKey", input.projectKey);
    if (input?.issueTypeKey) params.set("issueTypeKey", input.issueTypeKey);
    const q = params.toString() ? `?${params.toString()}` : "";
    const res = await fetch(`${API}/api/v1/internal/configuration/statuses/discover${q}`, {
      headers: { "x-portal-surface": "internal" },
      signal: input?.signal
    }).catch((error) => {
      throw asUserError(error);
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error ?? "Failed to discover ONES issue statuses");
    return data.statuses as Array<{ key: string; name: string; source: Record<string, unknown> }>;
  };
  if (input?.signal) return run();
  const key = `statuses:${input?.teamId ?? ""}:${input?.projectKey ?? ""}:${input?.issueTypeKey ?? ""}`;
  return withInFlightDedup(key, run);
}

export async function getOnesConfigHistory(limit = 20): Promise<OnesConfigHistoryItem[]> {
  const res = await fetch(`${API}/api/v1/internal/configuration/history?limit=${limit}`, {
    headers: { "x-portal-surface": "internal" }
  }).catch((error) => {
    throw asUserError(error);
  });
  if (!res.ok) throw new Error("Failed to load config history");
  return (await res.json()).history as OnesConfigHistoryItem[];
}

export async function runOnesPublishPreflight() {
  const res = await fetch(`${API}/api/v1/internal/configuration/publish/preflight`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-portal-surface": "internal" }
  }).catch((error) => {
    throw asUserError(error);
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Preflight failed: ${(data.errors ?? []).join(" | ") || "unknown error"}`);
  return data as { ready: boolean; checks: Record<string, boolean>; errors: string[] };
}

export async function publishOnesConfig(actor = "support_admin", reason?: string) {
  const res = await fetch(`${API}/api/v1/internal/configuration/publish`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-portal-surface": "internal" },
    body: JSON.stringify({ actor, reason })
  }).catch((error) => {
    throw asUserError(error);
  });
  if (!res.ok) throw new Error("Failed to publish ONES configuration");
  return (await res.json()).config as OnesSyncConfig;
}

export async function rollbackOnesConfig(configId: string, actor = "support_admin", reason?: string) {
  const res = await fetch(`${API}/api/v1/internal/configuration/rollback`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-portal-surface": "internal" },
    body: JSON.stringify({ configId, actor, reason })
  }).catch((error) => {
    throw asUserError(error);
  });
  if (!res.ok) throw new Error("Failed to rollback ONES configuration");
  return (await res.json()).config as OnesSyncConfig;
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
  signal?: AbortSignal;
}) {
  const { signal, ...body } = input;
  const res = await fetch(`${API}/api/v1/internal/configuration/projects/discover`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-portal-surface": "internal" },
    body: JSON.stringify(body),
    signal
  }).catch((error) => {
    throw asUserError(error);
  });
  const data = await res.json();
  if (!res.ok) {
    const raw = typeof data?.error === "string" ? data.error : "Failed to discover ONES projects";
    if (raw.includes("401")) throw new Error(`Failed to discover ONES projects: 401 Unauthorized. ${raw}`);
    if (raw.includes("403")) throw new Error(`Failed to discover ONES projects: 403 Forbidden. ${raw}`);
    throw new Error(raw);
  }
  return data as { projects: Array<{ key: string; name: string }>; nextCursor: string | null };
}

export async function discoverProjectIssueTypes(input: { projectKey: string; actor?: string; signal?: AbortSignal }): Promise<OnesProjectIssueType[]> {
  const { signal, ...body } = input;
  const res = await fetch(`${API}/api/v1/internal/configuration/project-issue-types/discover`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-portal-surface": "internal" },
    body: JSON.stringify(body),
    signal
  }).catch((error) => {
    throw asUserError(error);
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? "Failed to discover issue types");
  return data.issueTypes as OnesProjectIssueType[];
}

export async function listProjectIssueTypes(projectKey: string): Promise<OnesProjectIssueType[]> {
  return withInFlightDedup(`issue-types:${projectKey}`, async () => {
    const params = new URLSearchParams({ projectKey });
    const res = await fetch(`${API}/api/v1/internal/configuration/project-issue-types?${params.toString()}`, {
      headers: { "x-portal-surface": "internal" }
    }).catch((error) => {
      throw asUserError(error);
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error ?? "Failed to load issue types");
    return data.issueTypes as OnesProjectIssueType[];
  });
}

export async function setProjectIssueTypeExposure(input: {
  projectKey: string;
  issueTypeKey: string;
  issueTypeName?: string;
  enabledForCustomer: boolean;
  actor?: string;
}) {
  const { issueTypeKey, ...body } = input;
  const res = await fetch(`${API}/api/v1/internal/configuration/project-issue-types/${encodeURIComponent(issueTypeKey)}/exposure`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", "x-portal-surface": "internal" },
    body: JSON.stringify(body)
  }).catch((error) => {
    throw asUserError(error);
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? "Failed to update exposure");
  return data.config;
}

export async function getProjectIssueTypeFields(projectKey: string, issueTypeKey: string, signal?: AbortSignal) {
  const run = async () => {
    const params = new URLSearchParams({ projectKey });
    const res = await fetch(
      `${API}/api/v1/internal/configuration/project-issue-types/${encodeURIComponent(issueTypeKey)}/fields?${params.toString()}`,
      { headers: { "x-portal-surface": "internal" }, signal }
    ).catch((error) => {
      throw asUserError(error);
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error ?? "Failed to load issue fields");
    return data.fields as OnesProjectIssueTypeConfig["fieldSchema"];
  };
  if (signal) return run();
  return withInFlightDedup(`issue-fields:${projectKey}:${issueTypeKey}`, run);
}

export async function getProjectIssueTypeConfig(projectKey: string, issueTypeKey: string): Promise<OnesProjectIssueTypeConfig> {
  return withInFlightDedup(`issue-type-config:${projectKey}:${issueTypeKey}`, async () => {
    const params = new URLSearchParams({ projectKey });
    const res = await fetch(
      `${API}/api/v1/internal/configuration/project-issue-types/${encodeURIComponent(issueTypeKey)}/config?${params.toString()}`,
      { headers: { "x-portal-surface": "internal" } }
    ).catch((error) => {
      throw asUserError(error);
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error ?? "Failed to load issue type config");
    return data.config as OnesProjectIssueTypeConfig;
  });
}

export async function saveProjectIssueTypeConfig(input: {
  projectKey: string;
  issueTypeKey: string;
  issueTypeName?: string;
  fieldSchema: OnesProjectIssueTypeConfig["fieldSchema"];
  statusMapping: Record<string, string>;
  actor?: string;
}) {
  const { issueTypeKey, ...body } = input;
  const res = await fetch(`${API}/api/v1/internal/configuration/project-issue-types/${encodeURIComponent(issueTypeKey)}/config`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", "x-portal-surface": "internal" },
    body: JSON.stringify(body)
  }).catch((error) => {
    throw asUserError(error);
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? "Failed to save issue type config");
  return data.config;
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
