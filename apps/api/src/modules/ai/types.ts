export interface SearchReference {
  documentId: string;
  evidenceId?: string;
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

export function resolveSearchReferenceEvidenceId(reference: Pick<SearchReference, "documentId" | "evidenceId">): string {
  const evidenceId = String(reference.evidenceId ?? "").trim();
  return evidenceId || reference.documentId;
}

export interface ConversationTurn {
  role: "user" | "assistant";
  content: string;
  at?: string;
}

export interface SupportQueryPlan {
  concept_queries: string[];
  object_queries: string[];
  behavior_queries: string[];
}

export type SupportQuestionType =
  | "api_endpoint_lookup"
  | "api_field_lookup"
  | "api_scope_auth"
  | "how_to_product"
  | "why_behavior"
  | "troubleshooting"
  | "config_setup"
  | "capability_confirmation"
  | "data_export_reporting";

export type SupportSpecialistAgent =
  | "api-specialist"
  | "howto-specialist"
  | "behavior-specialist"
  | "troubleshooting-specialist";

export type SupportRenderVariant = "api" | "how_to" | "behavior" | "troubleshooting" | "clarification" | "handoff";

export interface SupportQuestionRoute {
  question_type: SupportQuestionType;
  user_goal: string;
  answer_contract: string;
  specialist_agent: SupportSpecialistAgent;
  routing_confidence: number;
  specialist_budget?: number;
}

export interface SupportEvidencePlan {
  query_plan: SupportQueryPlan;
  evidence_priority: string[];
  required_doc_kinds: string[];
  retrieval_rounds?: number;
  allow_refinement?: boolean;
  stop_after_grounded_evidence?: boolean;
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
  question_type?: SupportQuestionType;
  specialist_agent?: SupportSpecialistAgent;
  answer_contract?: string;
  routing_confidence?: number;
  evidence_priority?: string[];
  required_doc_kinds?: string[];
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

export interface SpecialistDraftAnswer extends DraftSupportAnswer {
  question_type: SupportQuestionType;
  render_variant: SupportRenderVariant;
  api_method?: string;
  api_path?: string;
  required_params?: string[];
  auth_scope?: string[];
  response_field_hint?: string;
  important_note?: string;
  related_variant?: string;
  steps?: string[];
  prerequisites?: string[];
  limits_or_notes?: string[];
  most_likely_explanation?: string;
  confirmed_facts?: string[];
  what_to_check_next?: string[];
  most_likely_causes?: string[];
  recommended_checks?: string[];
  required_followup_info?: string[];
  when_to_handoff?: string;
}

export type SupportAnswerSection =
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

export interface SupportAnswer {
  mode: "grounded" | "partial" | "clarification" | "handoff";
  question_type: SupportQuestionType;
  render_variant: SupportRenderVariant;
  direct_answer: string;
  sections: SupportAnswerSection[];
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
  display_citation_ids: string[];
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

export interface SupportEvidenceSelection {
  primary_ids: string[];
  supplemental_ids: string[];
  rejected_ids: string[];
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

export type SupportAgentRuntimeStage =
  | "route"
  | "evidence_plan"
  | "case_plan"
  | "retrieval"
  | "retrieval_refine"
  | "evidence_selection"
  | "specialist"
  | "generic_writer"
  | "verification"
  | "citation_binding"
  | "citation_selection"
  | "answer_composition";

export interface SupportAgentStageTraceEntry {
  stage: SupportAgentRuntimeStage;
  status: SupportAgentStageTiming["status"];
  duration_ms: number;
  agent_id?: string;
  model?: string | null;
  idempotency_key?: string;
  query_count?: number;
  reference_count?: number;
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
  delivery_mode?: "agent_orchestrated" | "kb_direct";
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
  internal_diagnostics?: {
    case_id?: string;
    route: SupportQuestionRoute;
    evidence_plan: SupportEvidencePlan;
    stage_budget: {
      retrieval_rounds: number;
      allow_refinement: boolean;
      stop_after_grounded_evidence: boolean;
      specialist_budget: number;
    };
    retrieval_queries_used: string[];
    retrieval_queries_refined: string[];
    claim_graph: Array<{
      text: string;
      kind: SupportClaimKind;
      verdict: "verified" | "supported_inference" | "unsupported";
      citation_ids: string[];
      has_citation: boolean;
    }>;
    specialist_skipped: boolean;
    specialists_used?: string[];
    evidence_sources?: string[];
    runtime_policy?: {
      deliveryMode: "interactive" | "async_job";
      tighteningEnabled: boolean;
      fastPathAllowed: boolean;
      profile: "latency_optimized" | "quality_optimized" | "tightened";
    };
    fast_path_used?: boolean;
    confirmed_facts?: string[];
    search_agents_used?: Array<{
      stage: "retrieval" | "clarify" | "execution";
      agent_id: string;
      session_key: string;
    }>;
    stage_trace?: SupportAgentStageTraceEntry[];
    orchestration_trace?: Array<{
      stage: string;
      agent_id: string;
      model?: string | null;
    }>;
  };
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
