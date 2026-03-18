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
  authority?: "canonical_visible" | "assistive_internal" | "disabled_for_user";
  sourceType?: "local_docs" | "github_kb" | "official_docs" | "adapter_fallback";
  score: number;
  retrievedAt: string;
}

export interface SupportQueryPlan {
  concept_queries: string[];
  object_queries: string[];
  behavior_queries: string[];
}

export interface SupportCaseFrame {
  goal: string;
  symptom: string;
  object: string;
  action_type: string;
  deployment_model: string;
  product_area: string;
  constraints: string[];
  missing_critical_info: string[];
  retrieval_queries: string[];
  query_plan?: SupportQueryPlan;
}

export type SupportClaimKind = "verified_fact" | "grounded_inference" | "operational_advice" | "unknown";

export interface SupportDraftClaim {
  text: string;
  kind: SupportClaimKind;
  evidence_ids: string[];
  authority: "canonical" | "assistive";
}

export interface DraftSupportAnswer {
  direct_answer: string;
  claims: SupportDraftClaim[];
  next_actions: string[];
  unknowns: string[];
  escalation_needed: boolean;
}

export interface SupportAnswer {
  mode: "grounded" | "partial" | "clarification" | "handoff";
  direct_answer: string;
  why: string[];
  what_to_do_now: string[];
  still_need_to_confirm: string[];
}

export interface SupportVerificationClaim {
  text: string;
  kind: SupportClaimKind;
  verdict: "verified" | "supported_inference" | "unsupported";
  citation_ids: string[];
}

export interface SupportVerificationResult {
  verdict: "verified" | "partial" | "unsupported";
  summary: string;
  unsupported_claims: string[];
  missing_info: string[];
  verified_citation_ids: string[];
  verified_claims: string[];
  claim_to_citation_map: SupportVerificationClaim[];
}

export interface SupportEvidenceBundle {
  primary: SearchReference[];
  supplemental: SearchReference[];
  evidence_gaps: string[];
  confidence: number;
  fallbackUsed: boolean;
  resolvedQueries: string[];
}

export interface SupportAgentStageTiming {
  duration_ms: number;
  status: "completed" | "fallback" | "skipped";
  query_count?: number;
  reference_count?: number;
}

export interface SupportAgentStageTimings {
  total_ms: number;
  planner: SupportAgentStageTiming;
  retrieval_base: SupportAgentStageTiming;
  retrieval_extra: SupportAgentStageTiming;
  writer: SupportAgentStageTiming;
  verifier: SupportAgentStageTiming;
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

export interface StructuredSearchAnswer {
  summary: string;
  assessment?: string;
  steps: string[];
  validation: string[];
  required_inputs?: string[];
  style?: "kb_answer" | "diagnosis" | "clarification";
}

export type SearchDialogState =
  | "GROUNDABLE_ANSWER_READY"
  | "CLARIFICATION_REQUIRED"
  | "CLARIFICATION_IN_PROGRESS"
  | "TICKET_HANDOFF_RECOMMENDED"
  | "TICKET_DRAFT_READY"
  | "TICKET_SUBMITTED";

export interface SearchResponseEnvelope {
  query: string;
  answer: string;
  confidence: number;
  references: SearchReference[];
  retrievalStatus: "grounded" | "no_results" | "kb_unavailable";
  unresolvedReasonCode: "NO_MATCHING_KB" | "LOW_CONFIDENCE" | "KB_RETRIEVAL_UNAVAILABLE" | null;
}

export interface SearchModeResult {
  session_id: string;
  answer: string;
  answer_language: "zh" | "en";
  case_frame?: SupportCaseFrame;
  support_answer?: SupportAnswer;
  verification?: SupportVerificationResult;
  structured_answer?: StructuredSearchAnswer;
  confidence: number;
  suggested_next_step: "self_serve" | "submit_ticket";
  retrieval_status: "grounded" | "no_results" | "kb_unavailable";
  unresolved_reason_code: "NO_MATCHING_KB" | "LOW_CONFIDENCE" | "KB_RETRIEVAL_UNAVAILABLE" | null;
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
  state: SearchDialogState;
  clarification_round: number;
  show_create_ticket_now: boolean;
  follow_up_question: string | null;
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
