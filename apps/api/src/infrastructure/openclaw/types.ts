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
  intent?: "retrieval" | "clarify" | "execution";
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
  healthCheck(): Promise<{ ok: boolean; mode: "ws" | "mock"; detail?: string }>;
}
