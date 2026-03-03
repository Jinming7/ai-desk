import type { AgentQueueTicket, AiEscalation, SearchResult, Ticket, TicketMessage, TicketStatus } from "./types";

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
  serviceCategory: "technical_support" | "feature_consulting" | "account_issue";
}) {
  const res = await fetch(`${API}/api/v1/tickets`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      ...payload,
      priority: "P3",
      customer: {
        id: "customer_demo",
        name: "Acme User"
      }
    })
  }).catch((error) => {
    throw asUserError(error);
  });

  if (!res.ok) throw new Error("Failed to create ticket");
  return res.json() as Promise<{
    ticket: Ticket;
    triage: {
      action: "resolve" | "ask_user" | "escalate" | "none";
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

export async function listAgentTickets(queue: "pending" | "mine" | "all", assignee?: string): Promise<AgentQueueTicket[]> {
  const params = new URLSearchParams();
  params.set("queue", queue);
  if (assignee) params.set("assignee", assignee);

  const res = await fetch(`${API}/api/v1/agent/tickets?${params.toString()}`, {
    headers: { "x-portal-surface": "internal" }
  }).catch((error) => {
    throw asUserError(error);
  });
  if (!res.ok) throw new Error("Failed to load agent queue");
  const data = await res.json();
  return data.tickets;
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
