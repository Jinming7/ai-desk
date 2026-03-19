import type {
  DraftSupportAnswer,
  SearchReference,
  SupportAnswer,
  SupportCaseFrame,
  SupportEvidenceBundle,
  SupportEvidenceSelection,
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
  stage?:
    | "planner"
    | "support-evidence-selector"
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
  mode: "grounded" | "partial";
  caseFrame: SupportCaseFrame;
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
  planSupportCase(
    input: OpenClawSupportPlannerInput,
    idempotencyKey: string,
    runtime?: OpenClawRuntimeContext
  ): Promise<SupportCaseFrame>;
  selectSupportEvidence(
    input: OpenClawSupportEvidenceSelectorInput,
    idempotencyKey: string,
    runtime?: OpenClawRuntimeContext
  ): Promise<SupportEvidenceSelection>;
  writeSupportAnswer(
    input: OpenClawSupportWriterInput,
    idempotencyKey: string,
    runtime?: OpenClawRuntimeContext
  ): Promise<DraftSupportAnswer>;
  verifySupportAnswer(
    input: OpenClawSupportVerifierInput,
    idempotencyKey: string,
    runtime?: OpenClawRuntimeContext
  ): Promise<SupportVerificationResult>;
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
  healthCheck(): Promise<{ ok: boolean; mode: "ws" | "mock"; detail?: string }>;
}
