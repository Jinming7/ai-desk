export interface SearchReference {
  documentId: string;
  title: string;
  snippet: string;
  sourceUrl: string;
  score: number;
  retrievedAt: string;
}

export interface StructuredSearchAnswer {
  summary: string;
  assessment?: string;
  steps: string[];
  validation: string[];
  required_inputs?: string[];
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
