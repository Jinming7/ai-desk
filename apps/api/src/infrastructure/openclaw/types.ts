import type {
  DraftSupportAnswer,
  SearchReference,
  SpecialistDraftAnswer,
  SupportAnswer,
  SupportCaseFrame,
  SupportEvidencePlan,
  SupportEvidenceBundle,
  SupportEvidenceSelection,
  SupportQuestionRoute,
  SupportVerificationClaim,
  SupportVerificationResult,
  TriageSupportInsight
} from "../../modules/ai/types.js";

export type OpenClawDecisionAction = "resolve" | "ask_user" | "escalate" | "none";

export interface OpenClawAnalyzeInput {
  ticket_id: string;
  title: string;
  description: string;
  priority: string;
  customer_meta: Record<string, unknown>;
  attachments?: string[];
  history: Array<{
    author: string;
    body: string;
    at: string;
  }>;
}

export interface OpenClawAnalyzeOutput {
  action: OpenClawDecisionAction;
  confidence: number;
  reply: string;
  reasoning_summary: string;
  evidence: string[];
  risk_flags: string[];
}

export interface OpenClawSearchInput {
  query: string;
  topK: number;
  index: string;
  attachments?: string[];
}

export interface OpenClawSearchResultItem {
  id: string;
  title: string;
  snippet: string;
  score: number;
  sourceUrl: string;
}

export interface OpenClawSearchOutput {
  confidence: number;
  hits: OpenClawSearchResultItem[];
}

export interface OpenClawSearchAnswerInput {
  query: string;
  language: "zh" | "en";
  routeHint?:
    | "openapi_doc"
    | "infra_runbook"
    | "integration_diagnosis"
    | "product_diagnosis"
    | "kb_guidance"
    | "clarification";
  grounded: boolean;
  references: Array<{
    title: string;
    snippet: string;
    sourceUrl: string;
    path?: string;
  }>;
  draftAnswer?: {
    answer: string;
    style?: "kb_answer" | "diagnosis" | "clarification";
    summary: string;
    assessment?: string;
    steps: string[];
    validation: string[];
    required_inputs?: string[];
  };
  conversationHistory?: Array<{ role: "user" | "assistant"; content: string }>;
  attachments?: string[];
}

export interface OpenClawSearchAnswerOutput {
  answer: string;
  style?: "kb_answer" | "diagnosis" | "clarification";
  summary: string;
  assessment?: string;
  steps: string[];
  validation: string[];
  required_inputs?: string[];
  suggested_next_step?: "self_serve" | "submit_ticket";
}

export interface OpenClawRuntimeContext {
  agentId?: string;
  sessionKey?: string;
  model?: string;
  intent?: "retrieval" | "clarify" | "execution";
  deliveryMode?: "interactive" | "async_job";
  stage?:
    | "router"
    | "evidence-planner"
    | "support-evidence-selector"
    | "api-specialist"
    | "howto-specialist"
    | "behavior-specialist"
    | "troubleshooting-specialist"
    | "evidence-judge"
    | "citation-curator"
    | "answer-composer"
    | "planner"
    | "support-writer"
    | "support-verifier"
    | "support-citation-binder"
    | "support-citation-selector"
    | "support-answer-composer"
    | "triage-writer"
    | "triage-verifier";
  timeoutMs?: number;
  overallTimeoutMs?: number;
  requestStartedAtMs?: number;
  disableLocalDocs?: boolean;
  allowMultiPassRetrieval?: boolean;
  allowRefinement?: boolean;
  kbTopK?: number;
  queryLimit?: number;
}

export interface OpenClawHealthCheckInput {
  agentIds?: string[];
}

export interface OpenClawHealthCheckResult {
  ok: boolean;
  mode: "ws" | "mock";
  detail?: string;
  configuredAgents?: string[];
  reachableAgents?: string[];
  unreachableAgents?: Array<{
    agentId: string;
    detail: string;
  }>;
}

export interface OpenClawClassifyIntentInput {
  query: string;
  language: "zh" | "en";
  conversationContext?: string[];
}

export interface OpenClawClassifyIntentOutput {
  intent: "api_operation" | "feature_usage" | "troubleshooting" | "concept_explanation" | "configuration" | "general";
  route: "openapi_doc" | "infra_runbook" | "integration_diagnosis" | "product_diagnosis" | "kb_guidance" | "clarification";
  confidence: number;
  reasoning: string;
}

export interface OpenClawSupportPlannerInput {
  contextType: "search" | "triage";
  language: "zh" | "en";
  query: string;
  conversationHistory?: Array<{ role: "user" | "assistant"; content: string }>;
  ticketContext?: {
    priority: string;
    customerMeta: Record<string, unknown>;
    history: Array<{ author: string; body: string; at: string }>;
  };
}

export interface OpenClawSupportExecutionPlannerInput extends OpenClawSupportPlannerInput {}

export interface OpenClawSupportExecutionPlannerOutput {
  route: SupportQuestionRoute;
  caseFrame: SupportCaseFrame;
  evidencePlan: SupportEvidencePlan;
}

export interface OpenClawSupportRouterInput {
  contextType: "search" | "triage";
  language: "zh" | "en";
  query: string;
  conversationHistory?: Array<{ role: "user" | "assistant"; content: string }>;
}

export interface OpenClawSupportEvidencePlannerInput {
  contextType: "search" | "triage";
  language: "zh" | "en";
  query: string;
  route: SupportQuestionRoute;
  conversationHistory?: Array<{ role: "user" | "assistant"; content: string }>;
}

export interface OpenClawSupportWriterInput {
  contextType: "search" | "triage";
  language: "zh" | "en";
  query: string;
  caseFrame: SupportCaseFrame;
  evidenceBundle: SupportEvidenceBundle;
  conversationHistory?: Array<{ role: "user" | "assistant"; content: string }>;
  ticketContext?: {
    priority: string;
    customerMeta: Record<string, unknown>;
    history: Array<{ author: string; body: string; at: string }>;
  };
}

export interface OpenClawSupportSpecialistInput {
  contextType: "search" | "triage";
  language: "zh" | "en";
  query: string;
  route: SupportQuestionRoute;
  caseFrame: SupportCaseFrame;
  evidenceBundle: SupportEvidenceBundle;
  conversationHistory?: Array<{ role: "user" | "assistant"; content: string }>;
}

export interface OpenClawSupportVerifierInput {
  contextType: "search" | "triage";
  language: "zh" | "en";
  query: string;
  caseFrame: SupportCaseFrame;
  evidenceBundle: SupportEvidenceBundle;
  draftSupportAnswer?: DraftSupportAnswer;
  triageInsight?: TriageSupportInsight;
}

export interface OpenClawSupportEvidenceSelectorInput {
  contextType: "search" | "triage";
  language: "zh" | "en";
  query: string;
  caseFrame: SupportCaseFrame;
  references: SearchReference[];
}

export interface OpenClawSupportCitationSelectorInput {
  contextType: "search" | "triage";
  language: "zh" | "en";
  query: string;
  caseFrame: SupportCaseFrame;
  evidenceBundle: SupportEvidenceBundle;
  supportedClaims: SupportVerificationClaim[];
}

export interface OpenClawSupportAnswerComposerInput {
  contextType: "search" | "triage";
  language: "zh" | "en";
  query: string;
  mode: SupportAnswer["mode"];
  route: SupportQuestionRoute;
  caseFrame: SupportCaseFrame;
  draftSupportAnswer?: SpecialistDraftAnswer;
  supportedClaims: SupportVerificationClaim[];
  nextActions: string[];
  unknowns: string[];
}

export interface OpenClawAdapter {
  analyzeTicket(input: OpenClawAnalyzeInput, idempotencyKey: string, runtime?: OpenClawRuntimeContext): Promise<OpenClawAnalyzeOutput>;
  searchKnowledge(input: OpenClawSearchInput, idempotencyKey: string, runtime?: OpenClawRuntimeContext): Promise<OpenClawSearchOutput>;
  answerSearchQuery(
    input: OpenClawSearchAnswerInput,
    idempotencyKey: string,
    runtime?: OpenClawRuntimeContext
  ): Promise<OpenClawSearchAnswerOutput>;
  classifyIntent?(
    input: OpenClawClassifyIntentInput,
    idempotencyKey: string,
    runtime?: OpenClawRuntimeContext
  ): Promise<OpenClawClassifyIntentOutput>;
  planSupportExecution?(
    input: OpenClawSupportExecutionPlannerInput,
    idempotencyKey: string,
    runtime?: OpenClawRuntimeContext
  ): Promise<OpenClawSupportExecutionPlannerOutput>;
  planSupportCase(
    input: OpenClawSupportPlannerInput,
    idempotencyKey: string,
    runtime?: OpenClawRuntimeContext
  ): Promise<SupportCaseFrame>;
  routeSupportQuestion(
    input: OpenClawSupportRouterInput,
    idempotencyKey: string,
    runtime?: OpenClawRuntimeContext
  ): Promise<SupportQuestionRoute>;
  planSupportEvidence(
    input: OpenClawSupportEvidencePlannerInput,
    idempotencyKey: string,
    runtime?: OpenClawRuntimeContext
  ): Promise<SupportEvidencePlan>;
  selectSupportEvidence(
    input: OpenClawSupportEvidenceSelectorInput,
    idempotencyKey: string,
    runtime?: OpenClawRuntimeContext
  ): Promise<SupportEvidenceSelection>;
  writeApiSpecialistAnswer(
    input: OpenClawSupportSpecialistInput,
    idempotencyKey: string,
    runtime?: OpenClawRuntimeContext
  ): Promise<SpecialistDraftAnswer>;
  writeHowToSpecialistAnswer(
    input: OpenClawSupportSpecialistInput,
    idempotencyKey: string,
    runtime?: OpenClawRuntimeContext
  ): Promise<SpecialistDraftAnswer>;
  writeBehaviorSpecialistAnswer(
    input: OpenClawSupportSpecialistInput,
    idempotencyKey: string,
    runtime?: OpenClawRuntimeContext
  ): Promise<SpecialistDraftAnswer>;
  writeTroubleshootingSpecialistAnswer(
    input: OpenClawSupportSpecialistInput,
    idempotencyKey: string,
    runtime?: OpenClawRuntimeContext
  ): Promise<SpecialistDraftAnswer>;
  writeSupportAnswer(
    input: OpenClawSupportWriterInput,
    idempotencyKey: string,
    runtime?: OpenClawRuntimeContext
  ): Promise<DraftSupportAnswer>;
  judgeSupportAnswer(
    input: OpenClawSupportVerifierInput,
    idempotencyKey: string,
    runtime?: OpenClawRuntimeContext
  ): Promise<SupportVerificationResult>;
  verifySupportAnswer(
    input: OpenClawSupportVerifierInput,
    idempotencyKey: string,
    runtime?: OpenClawRuntimeContext
  ): Promise<SupportVerificationResult>;
  curateSupportCitations(
    input: OpenClawSupportCitationSelectorInput,
    idempotencyKey: string,
    runtime?: OpenClawRuntimeContext
  ): Promise<{ display_citation_ids: string[] }>;
  bindSupportCitations(
    input: OpenClawSupportVerifierInput,
    idempotencyKey: string,
    runtime?: OpenClawRuntimeContext
  ): Promise<SupportVerificationResult>;
  selectDisplayCitations(
    input: OpenClawSupportCitationSelectorInput,
    idempotencyKey: string,
    runtime?: OpenClawRuntimeContext
  ): Promise<{ display_citation_ids: string[] }>;
  composeSupportAnswer(
    input: OpenClawSupportAnswerComposerInput,
    idempotencyKey: string,
    runtime?: OpenClawRuntimeContext
  ): Promise<{
    direct_answer: string;
    why: string[];
    what_to_do_now: string[];
    still_need_to_confirm: string[];
  }>;
  composeCustomerAnswer(
    input: OpenClawSupportAnswerComposerInput,
    idempotencyKey: string,
    runtime?: OpenClawRuntimeContext
  ): Promise<Omit<SupportAnswer, "mode">>;
  writeTriageInsight(
    input: OpenClawSupportWriterInput,
    idempotencyKey: string,
    runtime?: OpenClawRuntimeContext
  ): Promise<TriageSupportInsight>;
  verifyTriageInsight(
    input: OpenClawSupportVerifierInput,
    idempotencyKey: string,
    runtime?: OpenClawRuntimeContext
  ): Promise<SupportVerificationResult>;
  healthCheck(input?: OpenClawHealthCheckInput): Promise<OpenClawHealthCheckResult>;
}
