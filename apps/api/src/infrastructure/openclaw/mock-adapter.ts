import type {
  OpenClawAdapter,
  OpenClawAnalyzeInput,
  OpenClawAnalyzeOutput,
  OpenClawSearchInput,
  OpenClawSearchOutput
} from "./types.js";

const mockCorpus: Array<{ id: string; title: string; content: string; sourceUrl: string }> = [
  {
    id: "kb-auth-001",
    title: "Troubleshoot SSO Login Callback Failures",
    content:
      "Verify callback URL and tenant mapping, check clock skew, and collect browser console + request id before escalation.",
    sourceUrl: "https://kb.nexusflow.local/auth/sso-callback"
  },
  {
    id: "kb-api-002",
    title: "Reset API Token and Validate Integration Access",
    content: "For 401 issues rotate API token, confirm workspace permissions, and validate using curl.",
    sourceUrl: "https://kb.nexusflow.local/api/token-reset"
  },
  {
    id: "kb-billing-003",
    title: "Fix Billing Permission Denied Errors",
    content: "Rebind billing admin role, refresh SSO claims, and retest checkout permissions.",
    sourceUrl: "https://kb.nexusflow.local/account/billing-permissions"
  }
];

export class MockOpenClawAdapter implements OpenClawAdapter {
  async analyzeTicket(input: OpenClawAnalyzeInput): Promise<OpenClawAnalyzeOutput> {
    const combined = `${input.title} ${input.description}`;

    if (/simulate_openclaw_failure/i.test(`${input.title} ${input.description}`)) {
      throw new Error("Simulated OpenClaw failure");
    }

    if (/none_with_reply/i.test(combined)) {
      return {
        action: "ask_user",
        confidence: 0.73,
        reply: "Please provide the exact issue details so we can continue troubleshooting.",
        reasoning_summary: "Test fixture: none action with non-empty reply.",
        evidence: ["fixture:none_with_reply"],
        risk_flags: []
      };
    }

    if (/none_noop/i.test(combined)) {
      return {
        action: "ask_user",
        confidence: 0.7,
        reply: "",
        reasoning_summary: "Test fixture: none action with empty reply.",
        evidence: ["fixture:none_noop"],
        risk_flags: []
      };
    }

    const needsEscalation = /error|failed|urgent|production/i.test(combined);
    const likelyFixable = /how to|cannot login|permission|billing|api key|setup/i.test(combined);

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

  async searchKnowledge(input: OpenClawSearchInput): Promise<OpenClawSearchOutput> {
    if (/simulate_openclaw_failure/i.test(input.query)) {
      throw new Error("Simulated OpenClaw KB retrieval failure");
    }

    if (/resolve_fast/i.test(input.query)) {
      return {
        confidence: 0.92,
        hits: mockCorpus.slice(0, 2).map((doc, index) => ({
          id: doc.id,
          title: doc.title,
          snippet: doc.content.slice(0, 200),
          score: 0.92 - index * 0.03,
          sourceUrl: doc.sourceUrl
        }))
      };
    }

    const normalized = input.query.toLowerCase();
    const scored = mockCorpus
      .map((doc) => {
        const hitWords = normalized
          .split(/\s+/)
          .filter((word) => word.length > 2 && `${doc.title} ${doc.content}`.toLowerCase().includes(word)).length;
        const score = Math.min(0.95, hitWords / 5 + (doc.title.toLowerCase().includes(normalized) ? 0.3 : 0));
        return { doc, score };
      })
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, input.topK);

    return {
      confidence: scored[0]?.score ?? 0,
      hits: scored.map((item) => ({
        id: item.doc.id,
        title: item.doc.title,
        snippet: item.doc.content.slice(0, 200),
        score: Number(item.score.toFixed(3)),
        sourceUrl: item.doc.sourceUrl
      }))
    };
  }

  async healthCheck() {
    return { ok: true, mode: "mock" as const, detail: "Mock adapter active" };
  }
}
