import type { OpenClawAdapter, OpenClawAnalyzeInput, OpenClawAnalyzeOutput } from "./types.js";

export class MockOpenClawAdapter implements OpenClawAdapter {
  async analyzeTicket(input: OpenClawAnalyzeInput): Promise<OpenClawAnalyzeOutput> {
    const needsEscalation = /error|failed|urgent|production/i.test(`${input.title} ${input.description}`);
    const likelyFixable = /how to|cannot login|permission|billing|api key|setup/i.test(`${input.title} ${input.description}`);

    return {
      action: needsEscalation ? "escalate" : likelyFixable ? "resolve" : "ask_user",
      confidence: needsEscalation ? 0.82 : likelyFixable ? 0.74 : 0.66,
      reply: needsEscalation
        ? "Thanks for the details. We have escalated this issue to our engineering team and will follow up with progress."
        : likelyFixable
          ? "Thanks for contacting support. Please try the linked troubleshooting steps first. If the issue continues, reply with screenshots and exact timestamps."
          : "To proceed, please share your environment details (browser/app version), exact error message, and the time the issue occurred.",
      reasoning_summary: needsEscalation
        ? "Potential production-impacting issue detected from ticket wording."
        : likelyFixable
          ? "Issue pattern matches known knowledge base troubleshooting flows."
          : "More context is required before suggesting deterministic fix steps.",
      evidence: ["title_description_keyword_analysis"],
      risk_flags: needsEscalation ? ["possible_prod_impact"] : []
    };
  }
}
