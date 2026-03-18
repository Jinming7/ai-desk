import type {
  OpenClawAdapter,
  OpenClawAnalyzeInput,
  OpenClawAnalyzeOutput,
  OpenClawSupportPlannerInput,
  OpenClawSupportVerifierInput,
  OpenClawSupportWriterInput,
  OpenClawRuntimeContext,
  OpenClawSearchAnswerInput,
  OpenClawSearchAnswerOutput,
  OpenClawSearchInput,
  OpenClawSearchOutput
} from "./types.js";
import type {
  DraftSupportAnswer,
  SupportCaseFrame,
  SupportVerificationResult,
  TriageSupportInsight
} from "../../modules/ai/types.js";

const mockCorpus: Array<{ id: string; title: string; content: string; sourceUrl: string }> = [
  {
    id: "kb-auth-001",
    title: "Troubleshoot SSO Login Callback Failures",
    content:
      "Verify callback URL and tenant mapping, check clock skew, and collect browser console + request id before escalation.",
    sourceUrl:
      "https://github.com/BangWork/docs-com/blob/8d8f2ee6875f2d146f8f0d3bd82f51a8cb4d0a11/docs/sso-callback.md"
  },
  {
    id: "kb-api-002",
    title: "Reset API Token and Validate Integration Access",
    content: "For 401 issues rotate API token, confirm workspace permissions, and validate using curl.",
    sourceUrl:
      "https://github.com/BangWork/docs-com/blob/8d8f2ee6875f2d146f8f0d3bd82f51a8cb4d0a11/docs/api-token-reset.md"
  },
  {
    id: "kb-billing-003",
    title: "Fix Billing Permission Denied Errors",
    content: "Rebind billing admin role, refresh SSO claims, and retest checkout permissions.",
    sourceUrl:
      "https://github.com/BangWork/docs-com/blob/8d8f2ee6875f2d146f8f0d3bd82f51a8cb4d0a11/docs/billing-permissions.md"
  }
];

export class MockOpenClawAdapter implements OpenClawAdapter {
  async analyzeTicket(input: OpenClawAnalyzeInput, _idempotencyKey: string, _runtime?: OpenClawRuntimeContext): Promise<OpenClawAnalyzeOutput> {
    const combined = `${input.title} ${input.description}`;

    if (/simulate_openclaw_failure/i.test(`${input.title} ${input.description}`)) {
      throw new Error("Simulated OpenClaw failure");
    }

    if (/none_with_reply/i.test(combined)) {
      return {
        action: "none",
        confidence: 0.73,
        reply: "Please provide the exact issue details so we can continue troubleshooting.",
        reasoning_summary: "Test fixture: none action with non-empty reply.",
        evidence: ["fixture:none_with_reply"],
        risk_flags: []
      };
    }

    if (/none_noop/i.test(combined)) {
      return {
        action: "none",
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

  async searchKnowledge(input: OpenClawSearchInput, _idempotencyKey: string, _runtime?: OpenClawRuntimeContext): Promise<OpenClawSearchOutput> {
    if (/simulate_openclaw_failure/i.test(input.query)) {
      throw new Error("Simulated OpenClaw KB retrieval failure");
    }
    if (/simulate_support_agent_failure/i.test(input.query)) {
      throw new Error("Simulated support-agent retrieval failure");
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

  async answerSearchQuery(
    input: OpenClawSearchAnswerInput,
    _idempotencyKey: string,
    _runtime?: OpenClawRuntimeContext
  ): Promise<OpenClawSearchAnswerOutput> {
    if (input.draftAnswer) {
      return {
        answer: input.draftAnswer.answer,
        style: input.draftAnswer.style,
        summary: input.draftAnswer.summary,
        assessment: input.draftAnswer.assessment,
        steps: input.draftAnswer.steps,
        validation: input.draftAnswer.validation,
        required_inputs: input.draftAnswer.required_inputs,
        suggested_next_step: input.draftAnswer.style === "diagnosis" ? "submit_ticket" : "self_serve"
      };
    }

    return {
      answer: input.language === "zh" ? "当前缺少足够证据。" : "There is not enough evidence yet.",
      style: "clarification",
      summary: input.language === "zh" ? "当前缺少足够证据。" : "There is not enough evidence yet.",
      assessment: input.language === "zh" ? "请补充关键信息。" : "Please add key context.",
      steps: [],
      validation: [],
      suggested_next_step: "submit_ticket"
    };
  }

  async planSupportCase(
    input: OpenClawSupportPlannerInput,
    _idempotencyKey: string,
    _runtime?: OpenClawRuntimeContext
  ): Promise<SupportCaseFrame> {
    const query = input.query.trim();
    const strippedQuery = query.replace(/how to|如何|怎么/gi, "").trim();
    const isBillingCheckout = /billing admin role denied checkout/i.test(query);
    return {
      goal: query,
      symptom: /failed|error|timeout|not work|问题|失败|报错/i.test(query) ? query : "needs product/support guidance",
      object: /api|openapi|token|oauth|comment|issue/i.test(query) ? "api_or_integration" : "general_support",
      action_type: /how|如何|怎么|create|创建|导出|export/i.test(query) ? "how_to" : "troubleshooting",
      deployment_model: /public cloud|公有云/i.test(query) ? "public_cloud" : "shared",
      product_area: /api|openapi/i.test(query) ? "openapi" : /oauth|login|sso|github/i.test(query) ? "integrations" : "general",
      constraints: [],
      missing_critical_info: [
        /thisquerywillnotmatchkbx/i.test(query) ? "the exact object or failing step" : "",
        isBillingCheckout ? "the exact billing role mapping and denied checkout step" : ""
      ].filter(Boolean),
      retrieval_queries: [query, strippedQuery].filter(Boolean),
      query_plan: {
        concept_queries: [query].filter(Boolean),
        object_queries: [strippedQuery || query].filter(Boolean),
        behavior_queries: [/why|原因|为什么/i.test(query) ? `${query} rule behavior limitation` : `${query} procedure step`]
      }
    };
  }

  async writeSupportAnswer(
    input: OpenClawSupportWriterInput,
    _idempotencyKey: string,
    _runtime?: OpenClawRuntimeContext
  ): Promise<DraftSupportAnswer> {
    const primary = input.evidenceBundle.primary[0];
    if (!primary) {
      return {
        direct_answer:
          input.language === "zh"
            ? "我还缺少一个关键信息，无法给出被证据支撑的结论。"
            : "I still need one critical detail before I can give a verified answer.",
        claims: [],
        next_actions: [
          input.language === "zh"
            ? `请补充：${input.caseFrame.missing_critical_info[0] ?? "最关键的一条上下文"}`
            : `Please share: ${input.caseFrame.missing_critical_info[0] ?? "the single most important missing detail"}`
        ],
        unknowns: input.caseFrame.missing_critical_info.slice(0, 3),
        escalation_needed: false
      };
    }

    return {
      direct_answer:
        input.language === "zh"
          ? `${primary.snippet}`
          : `${primary.snippet}`,
      claims: [
        {
          text: primary.snippet,
          kind: "verified_fact",
          evidence_ids: [primary.documentId],
          authority: "canonical"
        }
      ],
      next_actions: [
        input.language === "zh"
          ? "如果仍未恢复，请补充准确报错、复现步骤和影响范围。"
          : "If the issue persists, share the exact error, repro steps, and impact scope."
      ],
      unknowns: [],
      escalation_needed: false
    };
  }

  async verifySupportAnswer(
    input: OpenClawSupportVerifierInput,
    _idempotencyKey: string,
    _runtime?: OpenClawRuntimeContext
  ): Promise<SupportVerificationResult> {
    const citationIds = [...input.evidenceBundle.primary, ...input.evidenceBundle.supplemental].map((item) => item.documentId);
    if (/billing admin role denied checkout/i.test(input.query)) {
      const verifiedCitationIds = citationIds.slice(0, 2);
      const verifiedClaims = input.draftSupportAnswer?.claims.map((item) => item.text).slice(0, 2) ?? [];
      return {
        verdict: "partial",
        summary: "The available evidence supports a likely billing-permission path, but the exact role mapping is still missing.",
        unsupported_claims: [],
        missing_info: ["the exact billing role mapping and denied checkout step"],
        verified_citation_ids: verifiedCitationIds,
        verified_claims: verifiedClaims,
        claim_to_citation_map:
          input.draftSupportAnswer?.claims.map((item) => ({
            text: item.text,
            kind: item.kind,
            verdict: item.kind === "grounded_inference" ? "supported_inference" : "verified",
            citation_ids: item.evidence_ids.length ? item.evidence_ids.slice(0, 2) : verifiedCitationIds
          })) ?? []
      };
    }
    if (!citationIds.length) {
      return {
        verdict: "unsupported",
        summary: input.language === "zh" ? "没有足够证据支撑最终结论。" : "There is not enough evidence to support a final conclusion.",
        unsupported_claims: [input.draftSupportAnswer?.direct_answer ?? ""].filter(Boolean),
        missing_info: input.caseFrame.missing_critical_info.slice(0, 3),
        verified_citation_ids: [],
        verified_claims: [],
        claim_to_citation_map: []
      };
    }
    return {
      verdict: citationIds.length >= 3 ? "verified" : "partial",
      summary:
        citationIds.length >= 3
          ? input.language === "zh"
            ? "回答与知识库证据基本一致。"
            : "The answer is aligned with the knowledge-base evidence."
          : input.language === "zh"
          ? "回答仅有部分证据支撑。"
          : "The answer is only partially supported by evidence.",
      unsupported_claims: [],
      missing_info: citationIds.length > 1 ? [] : input.caseFrame.missing_critical_info.slice(0, 2),
      verified_citation_ids: citationIds.slice(0, 3),
      verified_claims: input.draftSupportAnswer?.claims.map((item) => item.text).slice(0, 3) ?? [],
      claim_to_citation_map:
        input.draftSupportAnswer?.claims.map((item) => ({
          text: item.text,
          kind: item.kind,
          verdict: item.kind === "grounded_inference" ? "supported_inference" : "verified",
          citation_ids: item.evidence_ids.length ? item.evidence_ids : citationIds.slice(0, 1)
        })) ?? []
    };
  }

  async writeTriageInsight(
    input: OpenClawSupportWriterInput,
    _idempotencyKey: string,
    _runtime?: OpenClawRuntimeContext
  ): Promise<TriageSupportInsight> {
    const combined = `${input.query} ${input.ticketContext?.history.map((item) => item.body).join(" ") ?? ""}`;
    const hasEvidence = input.evidenceBundle.primary.length > 0;
    const recommended_action: "resolve" | "ask_user" | "escalate" =
      /error|failed|urgent|production|bug|regression/i.test(combined) ? "escalate" : hasEvidence ? "resolve" : "ask_user";

    return {
      direct_answer:
        recommended_action === "escalate"
          ? "The issue is better handled by engineering with the current evidence."
          : recommended_action === "resolve"
          ? "The issue maps to an evidence-backed self-serve flow."
          : "One critical detail is still missing before a reliable resolution can be suggested.",
      recommended_action,
      customer_reply:
        recommended_action === "escalate"
          ? "Thanks for your report. This issue needs deeper technical analysis, so I have escalated it to our engineering team."
          : recommended_action === "resolve"
          ? "Thanks for contacting support. Please try the verified steps from the knowledge base first, and reply if the issue continues."
          : `Please share: ${input.caseFrame.missing_critical_info[0] ?? "the single most important missing detail"}.`,
      customer_reply_policy: recommended_action === "escalate" ? "no_send" : "send_now",
      support_summary:
        recommended_action === "escalate"
          ? "Escalate to R&D based on current issue signals."
          : recommended_action === "resolve"
          ? "A knowledge-backed support flow is available."
          : "Ask one targeted follow-up question before suggesting resolution.",
      verified_evidence: input.evidenceBundle.primary.slice(0, 3).map((item) => item.title),
      risk_flags: recommended_action === "escalate" ? ["needs_rnd"] : [],
      missing_info: input.caseFrame.missing_critical_info.slice(0, 3),
      verifier_verdict: recommended_action === "resolve" && hasEvidence ? "verified" : hasEvidence ? "partial" : "unsupported"
    };
  }

  async verifyTriageInsight(
    input: OpenClawSupportVerifierInput,
    _idempotencyKey: string,
    _runtime?: OpenClawRuntimeContext
  ): Promise<SupportVerificationResult> {
    const citationIds = [...input.evidenceBundle.primary, ...input.evidenceBundle.supplemental].map((item) => item.documentId);
    const recommended = input.triageInsight?.recommended_action ?? "ask_user";
    if (recommended === "resolve" && citationIds.length > 0) {
      return {
        verdict: "verified",
        summary: "The triage action is supported by evidence.",
        unsupported_claims: [],
        missing_info: [],
        verified_citation_ids: citationIds.slice(0, 3),
        verified_claims: [input.triageInsight?.direct_answer ?? ""].filter(Boolean),
        claim_to_citation_map: [
          {
            text: input.triageInsight?.direct_answer ?? "",
            kind: "verified_fact" as const,
            verdict: "verified" as const,
            citation_ids: citationIds.slice(0, 3)
          }
        ].filter((item) => Boolean(item.text))
      };
    }
    if (recommended === "escalate") {
      return {
        verdict: citationIds.length > 0 ? "partial" : "unsupported",
        summary: citationIds.length > 0 ? "Escalation is reasonable with the current evidence." : "Escalation lacks direct KB support.",
        unsupported_claims: [],
        missing_info: citationIds.length > 0 ? [] : input.caseFrame.missing_critical_info.slice(0, 2),
        verified_citation_ids: citationIds.slice(0, 3),
        verified_claims: citationIds.length > 0 ? [input.triageInsight?.direct_answer ?? ""].filter(Boolean) : [],
        claim_to_citation_map:
          citationIds.length > 0
            ? [
                {
                  text: input.triageInsight?.direct_answer ?? "",
                  kind: "grounded_inference" as const,
                  verdict: "supported_inference" as const,
                  citation_ids: citationIds.slice(0, 3)
                }
              ].filter((item) => Boolean(item.text))
            : []
      };
    }
    return {
      verdict: "unsupported",
      summary: "More customer information is required.",
      unsupported_claims: [],
      missing_info: input.caseFrame.missing_critical_info.slice(0, 3),
      verified_citation_ids: citationIds.slice(0, 2),
      verified_claims: [],
      claim_to_citation_map: []
    };
  }

  async healthCheck() {
    return { ok: true, mode: "mock" as const, detail: "Mock adapter active" };
  }
}
