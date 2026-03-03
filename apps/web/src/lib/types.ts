export type TicketStatus = "OPEN" | "IN_PROGRESS" | "WAITING_CUSTOMER" | "ESCALATED_RND" | "RESOLVED" | "CLOSED";

export interface Ticket {
  id: string;
  ticket_no: string;
  title: string;
  status: TicketStatus;
  assignee_name: string;
  customer_name: string;
  customer_email?: string | null;
  environment?: "production" | "staging" | "test" | "unknown" | null;
  reproducibility?: "always" | "sometimes" | "once" | "unknown" | null;
  impact_summary?: string | null;
  updated_at: string;
  created_at: string;
  sla_due_at: string;
}

export interface TicketMessage {
  id: string;
  author_name: string;
  author_type: "CUSTOMER" | "AGENT";
  body: string;
  is_ai_generated: boolean;
  created_at: string;
}

export interface AgentQueueTicket {
  id: string;
  ticket_no: string;
  title: string;
  customer_name: string;
  status: TicketStatus;
  assignee_name: string;
  created_at: string;
  updated_at: string;
  sla_due_at: string | null;
  triage_reasoning_summary: string | null;
  triage_evidence: string[] | null;
  triage_confidence: number | null;
  handoff_reason_code: string | null;
}

export interface SearchReference {
  documentId: string;
  title: string;
  snippet: string;
  sourceUrl: string;
  score: number;
  retrievedAt: string;
}

export interface SearchResult {
  session_id: string;
  answer: string;
  confidence: number;
  suggested_next_step: "self_serve" | "submit_ticket";
  retrieval_status: "grounded" | "no_results" | "kb_unavailable";
  unresolved_reason_code: "NO_MATCHING_KB" | "LOW_CONFIDENCE" | "KB_RETRIEVAL_UNAVAILABLE" | null;
  references: SearchReference[];
  citations: Array<{ id: string; title: string; excerpt: string; score: number; source_url: string; retrieved_at: string }>;
}

export interface AiEscalation {
  id: string;
  sessionId: string;
  status: "ESCALATED" | "DEEP_RETRIEVING" | "RESOLVED_BY_AI" | "TICKET_CREATED";
  question: string;
  reasonCode: "NO_MATCHING_KB" | "LOW_CONFIDENCE" | "KB_RETRIEVAL_UNAVAILABLE";
  attempts: number;
  ticketId: string | null;
  resolution: { answer?: string; confidence?: number; references?: SearchReference[] } | null;
  createdAt: string;
  updatedAt: string;
}

export interface AiAgentMode {
  enabled: boolean;
  updatedBy: string;
  updatedAt: string;
}
