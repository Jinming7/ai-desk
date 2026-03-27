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
  triage_reasoning_summary?: string | null;
  triage_evidence?: string[] | null;
  triage_support_insight?: TriageSupportInsight | null;
  triage_verification_summary?: SearchVerificationSummary | null;
  triage_case_frame?: SearchCaseFrame | null;
  evidence_bundle_digest?: string | null;
  customer_status_label?: string;
}

export interface TicketMessage {
  id: string;
  author_name: string;
  author_type: "CUSTOMER" | "AGENT";
  body: string;
  attachments: string[];
  is_ai_generated: boolean;
  created_at: string;
}

export interface UploadedAttachment {
  url: string;
  name: string;
  contentType: string;
}

export interface ConversationTurn {
  role: "user" | "assistant";
  content: string;
  at?: string;
}

export interface AiCapabilities {
  imageInputEnabled: boolean;
  provider: "openai" | "disabled";
  model: string | null;
  reason: string;
}

export interface DocsComCanonicalConfig {
  repoUrl: string;
  publicBaseUrl: string;
  defaultBranch: string;
  includePaths: string[];
  excludePaths: string[];
  pollingIntervalSeconds: number;
  actor: string;
}

export interface DocsComCorpusStat {
  prefix: string;
  total: number;
  active: number;
  sourceTotal: number | null;
  gap: number | null;
}

export interface DocsComSourceCorpusStat {
  prefix: string;
  total: number;
}

export interface DocsComRecentJob {
  id: string;
  mode: "full" | "incremental" | "reindex";
  status: string;
  branch: string;
  errorMessage: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  updatedAt: string;
}

export interface DocsComStatusSnapshot {
  registration: {
    id: string;
    repo: string;
    branch: string;
    repoUrl: string;
    publicBaseUrl: string | null;
    includePaths: string[];
    excludePaths: string[];
    lastValidationError: string | null;
  };
  corpus: DocsComCorpusStat[];
  sourceSnapshot: {
    mode: "local_mirror" | "remote";
    branch: string;
    head: string | null;
    total: number;
    errorMessage: string | null;
    corpus: DocsComSourceCorpusStat[];
  };
  overview: {
    kbTotal: number;
    kbActive: number;
    sourceTotal: number;
    activeCoverageRate: number | null;
    syncGap: number;
  };
  checkpoint: {
    lastSyncedCommitSha: string | null;
    lastSyncedAt: string | null;
    lastFullSyncedCommitSha: string | null;
    lastFullSyncedAt: string | null;
  } | null;
  health: {
    ok: boolean;
    message: string | null;
  };
  recentJobs: DocsComRecentJob[];
}

export interface DocsComStatusResult {
  exists: boolean;
  canonical: DocsComCanonicalConfig;
  status: DocsComStatusSnapshot | null;
}

export interface DocsComEnsureResult {
  registrationChanged: boolean;
  validation: {
    ok: boolean;
    scopes: string[];
    message: string;
  };
  enqueuedJob: {
    id: string;
    mode: "full" | "incremental" | "reindex";
    status: string;
    branch: string;
    idempotencyKey: string;
  };
  runResult: {
    processed: number;
    succeeded: number;
    failed: number;
    deadLetter: number;
  };
  beforeStatus: DocsComStatusSnapshot | null;
  afterStatus: DocsComStatusSnapshot;
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
  triage_support_insight?: TriageSupportInsight | null;
  triage_verification_summary?: SearchVerificationSummary | null;
  triage_case_frame?: SearchCaseFrame | null;
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
  customer_status_label?: string;
}

export interface SearchReference {
  documentId: string;
  title: string;
  snippet: string;
  sourceUrl: string;
  repoSourceUrl?: string;
  repo?: string;
  branch?: string;
  path?: string;
  commitSha?: string;
  headingPath?: string;
  supportMetadata?: Record<string, unknown>;
  chunkMetadata?: Record<string, unknown>;
  docMetadata?: Record<string, unknown>;
  score: number;
  retrievedAt: string;
}

export interface SearchCaseFrame {
  goal: string;
  symptom: string;
  object: string;
  action_type: string;
  deployment_model: string;
  product_area: string;
  constraints: string[];
  missing_critical_info: string[];
  retrieval_queries: string[];
  query_plan?: {
    concept_queries: string[];
    object_queries: string[];
    behavior_queries: string[];
  };
  question_type?:
    | "api_endpoint_lookup"
    | "api_field_lookup"
    | "api_scope_auth"
    | "how_to_product"
    | "why_behavior"
    | "troubleshooting"
    | "config_setup"
    | "capability_confirmation"
    | "data_export_reporting";
  specialist_agent?: "api-specialist" | "howto-specialist" | "behavior-specialist" | "troubleshooting-specialist";
  answer_contract?: string;
  routing_confidence?: number;
  evidence_priority?: string[];
  required_doc_kinds?: string[];
}

export type SearchSupportSection =
  | {
      kind: "paragraph";
      title: string;
      body: string;
    }
  | {
      kind: "bullet_list";
      title: string;
      items: string[];
    }
  | {
      kind: "code_block";
      title: string;
      code: string;
      language?: string;
    }
  | {
      kind: "api_card";
      title: string;
      method: string;
      path: string;
      required_params: string[];
      auth_scope: string[];
      response_field_hint?: string;
      important_note?: string;
      related_variant?: string;
    };

export interface SearchSupportAnswer {
  mode: "grounded" | "partial" | "clarification" | "handoff";
  question_type:
    | "api_endpoint_lookup"
    | "api_field_lookup"
    | "api_scope_auth"
    | "how_to_product"
    | "why_behavior"
    | "troubleshooting"
    | "config_setup"
    | "capability_confirmation"
    | "data_export_reporting";
  render_variant: "api" | "how_to" | "behavior" | "troubleshooting" | "clarification" | "handoff";
  direct_answer: string;
  sections: SearchSupportSection[];
  why: string[];
  what_to_do_now: string[];
  still_need_to_confirm: string[];
}

export interface SearchVerificationSummary {
  verdict: "verified" | "partial" | "unsupported";
  summary: string;
  unsupported_claims: string[];
  missing_info: string[];
  verified_citation_ids: string[];
  verified_claims: string[];
  claim_to_citation_map: Array<{
    text: string;
    kind: "verified_fact" | "grounded_inference" | "operational_advice" | "unknown";
    verdict: "verified" | "supported_inference" | "unsupported";
    citation_ids: string[];
  }>;
}

export interface TriageSupportInsight {
  direct_answer: string;
  recommended_action: "resolve" | "ask_user" | "escalate";
  customer_reply: string;
  customer_reply_policy: "send_now" | "no_send";
  support_summary: string;
  verified_evidence: string[];
  risk_flags: string[];
  missing_info: string[];
  verifier_verdict: "verified" | "partial" | "unsupported";
}

export interface SearchResult {
  session_id: string;
  answer: string;
  answer_language?: "zh" | "en";
  delivery_mode?: "agent_orchestrated" | "kb_direct";
  case_frame?: SearchCaseFrame;
  support_answer?: SearchSupportAnswer;
  verification?: SearchVerificationSummary;
  structured_answer?: {
    summary: string;
    assessment?: string;
    steps: string[];
    validation: string[];
    required_inputs?: string[];
    style?: "kb_answer" | "diagnosis" | "clarification";
  };
  confidence: number;
  suggested_next_step: "self_serve" | "submit_ticket";
  retrieval_status: "grounded" | "no_results" | "kb_unavailable";
  unresolved_reason_code: "NO_MATCHING_KB" | "LOW_CONFIDENCE" | "KB_RETRIEVAL_UNAVAILABLE" | null;
  state?:
    | "GROUNDABLE_ANSWER_READY"
    | "CLARIFICATION_REQUIRED"
    | "CLARIFICATION_IN_PROGRESS"
    | "TICKET_HANDOFF_RECOMMENDED"
    | "TICKET_DRAFT_READY"
    | "TICKET_SUBMITTED";
  clarification_round?: number;
  show_create_ticket_now?: boolean;
  follow_up_question?: string | null;
  references: SearchReference[];
  citations: Array<{
    id: string;
    title: string;
    excerpt: string;
    score: number;
    source_url: string;
    retrieved_at: string;
    repo?: string;
    path?: string;
    commit_sha?: string;
  }>;
}

export interface ChatTicketDraftField {
  key: string;
  label: string;
  required: boolean;
  value: string;
  confidence: number;
}

export interface ChatTicketDraft {
  id: string;
  sessionId: string;
  ticketTypeKey: string;
  ticketTypeName: string;
  ticketTypeConfidence: number;
  title: string;
  description: string;
  serviceCategory: "technical_support" | "feature_consulting" | "account_issue";
  onesFields: Record<string, string>;
  fieldHints: ChatTicketDraftField[];
  missingRequiredFields: string[];
  provenance: Record<string, unknown>;
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

export interface OnesProjectIssueType {
  projectKey: string;
  key: string;
  name: string;
  enabledForCustomer: boolean;
  configured: boolean;
  updatedAt: string;
}

export interface OnesProjectIssueTypeConfig {
  projectKey: string;
  issueTypeKey: string;
  issueTypeName: string;
  enabledForCustomer: boolean;
  fieldSchema: Array<{
    key: string;
    label: string;
    type: string;
    required: boolean;
    visible: boolean;
    options: Array<{ value: string; label: string }>;
    defaultValue?: unknown;
  }>;
  statusMapping: Record<string, string>;
  updatedAt: string | null;
  updatedBy: string | null;
}

export interface OnesSyncConfig {
  id: string;
  profileName: string;
  baseUrl: string;
  authType: "bearer" | "header";
  authHeader: string;
  authSecretMasked: string;
  systemAuthSecretMasked?: string;
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
