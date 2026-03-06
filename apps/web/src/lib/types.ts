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
  first_response_due_at?: string | null;
  first_response_at?: string | null;
  resolution_due_at?: string | null;
  sla_paused_at?: string | null;
  sla_pause_reason?: string | null;
  ones_ticket_type_key?: string | null;
  ones_ticket_key?: string | null;
  ones_sync_status?: string | null;
  ones_sync_error?: string | null;
  ai_mode_snapshot?: string | null;
  ai_last_trace_id?: string | null;
  ai_last_action?: "resolve" | "ask_user" | "escalate" | null;
  ai_last_confidence?: number | null;
  ai_last_model?: string | null;
  ai_last_fallback_applied?: boolean;
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
  priority?: "P1" | "P2" | "P3" | "P4";
  resolution_due_at?: string | null;
  first_response_due_at?: string | null;
  first_response_at?: string | null;
  sla_paused_at?: string | null;
  sla_pause_reason?: string | null;
  ones_ticket_type_key?: string | null;
  ones_ticket_key?: string | null;
  ones_sync_status?: string | null;
  ai_mode_snapshot?: string | null;
  ai_last_trace_id?: string | null;
  ai_last_action?: "resolve" | "ask_user" | "escalate" | null;
  ai_last_confidence?: number | null;
  ai_suggestion_pending?: boolean;
  assigned_at?: string | null;
  last_customer_reply_at?: string | null;
  last_agent_reply_at?: string | null;
  sla_risk?: "healthy" | "at_risk" | "breached";
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

export interface OnesTicketType {
  key: string;
  name: string;
  fields: Array<Record<string, unknown>>;
  syncedAt?: string;
}

export interface OnesSyncConfig {
  id: string;
  profileName: string;
  baseUrl: string;
  authType: "bearer" | "header";
  authHeader: string;
  authSecretMasked: string;
  createTicketPath: string;
  listProjectsPath: string;
  listTicketTypesPath: string;
  listFieldsPathTemplate: string;
  endpointTemplates?: Record<string, string>;
  allowedTicketTypeKeys?: string[];
  statusMapping?: Record<string, string>;
  workflowMapping?: Record<string, string>;
  configVersion?: number;
  publishState?: "draft" | "published";
  publishChecks?: Record<string, unknown>;
  changeReason?: string | null;
  rolledBackFrom?: string | null;
  timeoutMs: number;
  retries: number;
  dataSourceMode: "ones_primary" | "local_mirror";
  onesProjectKey?: string | null;
  onesTeamId?: string | null;
  schemaHash?: string | null;
  schemaSyncedAt?: string | null;
  updatedBy: string;
  updatedAt: string;
}

export interface OnesConfigHistoryItem {
  id: string;
  version: number;
  profileName: string;
  publishState: "draft" | "published";
  updatedBy: string;
  updatedAt: string;
  changeReason: string | null;
  rolledBackFrom: string | null;
  isActive: boolean;
}

export interface OnesCatalogStatus {
  ticketTypeCount: number;
  schemaHash: string | null;
  currentHash: string;
  driftDetected: boolean;
  schemaSyncedAt: string | null;
}
