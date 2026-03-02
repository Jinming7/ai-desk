export type OpenClawDecisionAction = "auto_resolve" | "ask_info" | "escalate";

export interface OpenClawAnalyzeInput {
  ticket_id: string;
  title: string;
  description: string;
  priority: string;
  customer_meta: Record<string, unknown>;
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

export interface OpenClawAdapter {
  analyzeTicket(input: OpenClawAnalyzeInput, idempotencyKey: string): Promise<OpenClawAnalyzeOutput>;
}
