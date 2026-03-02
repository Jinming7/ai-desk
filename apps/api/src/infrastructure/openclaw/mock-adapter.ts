import type { OpenClawAdapter, OpenClawAnalyzeInput, OpenClawAnalyzeOutput } from "./types.js";

export class MockOpenClawAdapter implements OpenClawAdapter {
  async analyzeTicket(input: OpenClawAnalyzeInput): Promise<OpenClawAnalyzeOutput> {
    const needsEscalation = /error|failed|urgent|production/i.test(`${input.title} ${input.description}`);

    return {
      action: needsEscalation ? "escalate" : "ask_info",
      confidence: needsEscalation ? 0.82 : 0.66,
      reply: needsEscalation
        ? "I have escalated this to the engineering support queue and included your context."
        : "Please share your environment details (browser/app version) so I can continue diagnosis.",
      reasoning_summary: needsEscalation
        ? "Potential production-impacting issue detected from ticket wording."
        : "More context is required before suggesting deterministic fix steps.",
      evidence: ["Title and description keyword analysis"],
      risk_flags: needsEscalation ? ["possible_prod_impact"] : []
    };
  }
}
