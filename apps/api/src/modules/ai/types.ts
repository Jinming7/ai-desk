export interface SearchReference {
  documentId: string;
  title: string;
  snippet: string;
  sourceUrl: string;
  score: number;
  retrievedAt: string;
}

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
  }>;
}
