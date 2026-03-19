import type {
  OpenClawAdapter,
  OpenClawAnalyzeInput,
  OpenClawAnalyzeOutput,
  OpenClawSupportEvidencePlannerInput,
  OpenClawSupportAnswerComposerInput,
  OpenClawSupportCitationSelectorInput,
  OpenClawSupportEvidenceSelectorInput,
  OpenClawSupportPlannerInput,
  OpenClawSupportRouterInput,
  OpenClawSupportSpecialistInput,
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
  SpecialistDraftAnswer,
  SupportCaseFrame,
  SupportEvidencePlan,
  SupportEvidenceSelection,
  SupportQuestionRoute,
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

  async routeSupportQuestion(
    input: OpenClawSupportRouterInput,
    _idempotencyKey: string,
    _runtime?: OpenClawRuntimeContext
  ): Promise<SupportQuestionRoute> {
    const query = input.query.toLowerCase();
    const question_type: SupportQuestionRoute["question_type"] =
      /scope|oauth|token/.test(query)
        ? "api_scope_auth"
        : /接口|endpoint|api|method|path/.test(input.query)
        ? "api_endpoint_lookup"
        : /字段|field|status/.test(query) && /api|接口|openapi/.test(query)
        ? "api_field_lookup"
        : /为什么|why|行为|expected|预期/.test(input.query)
        ? "why_behavior"
        : /如何|怎么|步骤|setup|configure|config|export|导出/.test(input.query)
        ? "how_to_product"
        : "troubleshooting";
    return {
      question_type,
      user_goal: input.query,
      answer_contract: question_type.startsWith("api_") ? "Provide the exact API answer first." : "Provide the most useful support answer first.",
      specialist_agent:
        question_type.startsWith("api_")
          ? "api-specialist"
          : question_type === "why_behavior"
          ? "behavior-specialist"
          : question_type === "how_to_product"
          ? "howto-specialist"
          : "troubleshooting-specialist",
      routing_confidence: 0.82
    };
  }

  async planSupportEvidence(
    input: OpenClawSupportEvidencePlannerInput,
    _idempotencyKey: string,
    _runtime?: OpenClawRuntimeContext
  ): Promise<SupportEvidencePlan> {
    return {
      query_plan: {
        concept_queries: [input.query],
        object_queries: [input.route.user_goal],
        behavior_queries: [input.route.question_type]
      },
      evidence_priority: [input.route.question_type, input.route.specialist_agent],
      required_doc_kinds: input.route.question_type.startsWith("api_") ? ["openapi/api", "schema"] : ["product_guide", "rules"]
    };
  }

  async selectSupportEvidence(
    input: OpenClawSupportEvidenceSelectorInput,
    _idempotencyKey: string,
    _runtime?: OpenClawRuntimeContext
  ): Promise<SupportEvidenceSelection> {
    const terms = Array.from(
      new Set(
        input.query
          .toLowerCase()
          .match(/[a-z0-9:_./-]{3,}/g)?.filter(Boolean) ?? []
      )
    );
    const scored = input.references
      .map((reference) => {
        const text = `${reference.title} ${reference.headingPath ?? ""} ${reference.path ?? ""} ${reference.snippet}`.toLowerCase();
        const lexical = terms.reduce((sum, term) => sum + (text.includes(term) ? 1 : 0), 0);
        return { reference, lexical };
      })
      .sort((a, b) => b.lexical - a.lexical || b.reference.score - a.reference.score);

    const primary = scored.slice(0, 3).map((item) => item.reference.documentId);
    const supplemental = scored.slice(3, 5).map((item) => item.reference.documentId);
    const selected = new Set([...primary, ...supplemental]);

    return {
      primary_ids: primary,
      supplemental_ids: supplemental,
      rejected_ids: input.references.map((item) => item.documentId).filter((id) => !selected.has(id))
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

  async writeApiSpecialistAnswer(
    input: OpenClawSupportSpecialistInput,
    _idempotencyKey: string,
    _runtime?: OpenClawRuntimeContext
  ): Promise<SpecialistDraftAnswer> {
    const primary = input.evidenceBundle.primary[0];
    return {
      question_type: input.route.question_type,
      render_variant: "api",
      direct_answer: primary ? `Use the API documented in ${primary.title}.` : "I could not confirm the exact API yet.",
      claims: primary
        ? [{ text: primary.snippet, kind: "verified_fact", evidence_ids: [primary.documentId], authority: "canonical" }]
        : [],
      next_actions: ["Use the documented API details from the primary source first."],
      unknowns: input.caseFrame.missing_critical_info.slice(0, 2),
      escalation_needed: false,
      api_method: "GET",
      api_path: "/openapi/v2/example",
      required_params: ["teamID", "issueID"],
      auth_scope: ["read:project:issue"],
      response_field_hint: "Check the response body for the target field.",
      important_note: "If you mean the status list instead of the current status value, use the status list endpoint instead.",
      related_variant: "Status list and current status are different lookups."
    };
  }

  async writeHowToSpecialistAnswer(
    input: OpenClawSupportSpecialistInput,
    _idempotencyKey: string,
    _runtime?: OpenClawRuntimeContext
  ): Promise<SpecialistDraftAnswer> {
    const primary = input.evidenceBundle.primary[0];
    return {
      question_type: input.route.question_type,
      render_variant: "how_to",
      direct_answer: primary ? primary.snippet : "Follow the documented steps for this workflow.",
      claims: primary
        ? [{ text: primary.snippet, kind: "verified_fact", evidence_ids: [primary.documentId], authority: "canonical" }]
        : [],
      next_actions: ["Follow the documented steps in order.", "If the result differs, capture the exact step where it diverges."],
      unknowns: input.caseFrame.missing_critical_info.slice(0, 2),
      escalation_needed: false,
      steps: ["Open the relevant configuration page.", "Apply the documented setting.", "Verify the result in the target workflow."],
      prerequisites: ["Confirm your role and environment first."],
      limits_or_notes: ["The exact path can vary by deployment or permissions."]
    };
  }

  async writeBehaviorSpecialistAnswer(
    input: OpenClawSupportSpecialistInput,
    _idempotencyKey: string,
    _runtime?: OpenClawRuntimeContext
  ): Promise<SpecialistDraftAnswer> {
    const primary = input.evidenceBundle.primary[0];
    return {
      question_type: input.route.question_type,
      render_variant: "behavior",
      direct_answer: primary ? "The documentation supports a likely explanation, but not every detail is explicit." : "I could not confirm the behavior from the current evidence.",
      claims: primary
        ? [{ text: primary.snippet, kind: "grounded_inference", evidence_ids: [primary.documentId], authority: "canonical" }]
        : [],
      next_actions: ["Check whether the observed behavior matches the documented rule."],
      unknowns: input.caseFrame.missing_critical_info.slice(0, 2),
      escalation_needed: false,
      most_likely_explanation: primary?.snippet,
      confirmed_facts: primary ? [primary.snippet] : [],
      what_to_check_next: ["Verify the exact input, object, or configuration involved."]
    };
  }

  async writeTroubleshootingSpecialistAnswer(
    input: OpenClawSupportSpecialistInput,
    _idempotencyKey: string,
    _runtime?: OpenClawRuntimeContext
  ): Promise<SpecialistDraftAnswer> {
    const primary = input.evidenceBundle.primary[0];
    return {
      question_type: input.route.question_type,
      render_variant: "troubleshooting",
      direct_answer: primary ? "The current evidence points to a documented troubleshooting path." : "I still need one critical detail before I can suggest a reliable fix.",
      claims: primary
        ? [{ text: primary.snippet, kind: "verified_fact", evidence_ids: [primary.documentId], authority: "canonical" }]
        : [],
      next_actions: ["Start with the primary documented check.", "If the issue persists, collect the exact error and repro steps."],
      unknowns: input.caseFrame.missing_critical_info.slice(0, 2),
      escalation_needed: false,
      most_likely_causes: primary ? [primary.snippet] : [],
      recommended_checks: ["Validate the exact failing step.", "Compare the actual result with the expected behavior."],
      required_followup_info: input.caseFrame.missing_critical_info.slice(0, 2),
      when_to_handoff: "Escalate if the documented checks do not explain the result."
    };
  }

  async verifySupportAnswer(
    input: OpenClawSupportVerifierInput,
    _idempotencyKey: string,
    _runtime?: OpenClawRuntimeContext
  ): Promise<SupportVerificationResult> {
    const citationIds = [...input.evidenceBundle.primary, ...input.evidenceBundle.supplemental].map((item) => item.documentId);
    const draftClaims = input.draftSupportAnswer?.claims ?? [];
    if (!draftClaims.length) {
      return {
        verdict: "unsupported",
        summary: "No supported claims were produced from the current evidence.",
        unsupported_claims: [input.draftSupportAnswer?.direct_answer ?? ""].filter(Boolean),
        missing_info: input.caseFrame.missing_critical_info.slice(0, 3),
        verified_citation_ids: [],
        display_citation_ids: [],
        verified_claims: [],
        claim_to_citation_map: []
      };
    }
    if (/billing admin role denied checkout/i.test(input.query)) {
      const verifiedCitationIds = citationIds.slice(0, 2);
      const verifiedClaims = draftClaims.map((item) => item.text).slice(0, 2);
      return {
        verdict: "partial",
        summary: "The available evidence supports a likely billing-permission path, but the exact role mapping is still missing.",
        unsupported_claims: [],
        missing_info: ["the exact billing role mapping and denied checkout step"],
        verified_citation_ids: verifiedCitationIds,
        display_citation_ids: verifiedCitationIds,
        verified_claims: verifiedClaims,
        claim_to_citation_map:
          draftClaims.map((item) => ({
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
        display_citation_ids: [],
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
      display_citation_ids: citationIds.slice(0, 3),
      verified_claims: draftClaims.map((item) => item.text).slice(0, 3),
      claim_to_citation_map:
        draftClaims.map((item) => {
          const citation_ids = item.evidence_ids.length ? item.evidence_ids : citationIds.slice(0, 1);
          return {
            text: item.text,
            kind: item.kind,
            verdict:
              citation_ids.length === 0
                ? "unsupported"
                : item.kind === "grounded_inference"
                ? "supported_inference"
                : "verified",
            citation_ids
          };
        })
    };
  }

  async judgeSupportAnswer(
    input: OpenClawSupportVerifierInput,
    idempotencyKey: string,
    runtime?: OpenClawRuntimeContext
  ): Promise<SupportVerificationResult> {
    return this.verifySupportAnswer(input, idempotencyKey, runtime);
  }

  async bindSupportCitations(
    input: OpenClawSupportVerifierInput,
    _idempotencyKey: string,
    _runtime?: OpenClawRuntimeContext
  ): Promise<SupportVerificationResult> {
    const citationIds = [...input.evidenceBundle.primary, ...input.evidenceBundle.supplemental].map((item) => item.documentId);
    const claimMap =
      input.draftSupportAnswer?.claims.map((item) => {
        const boundIds = item.evidence_ids.length ? item.evidence_ids.slice(0, 2) : citationIds.slice(0, 2);
        return {
          text: item.text,
          kind: item.kind,
          verdict:
            boundIds.length === 0
              ? ("unsupported" as const)
              : item.kind === "grounded_inference"
              ? ("supported_inference" as const)
              : ("verified" as const),
          citation_ids: boundIds
        };
      }) ?? [];
    const displayCitationIds = Array.from(new Set(claimMap.flatMap((item) => item.citation_ids))).slice(0, 3);
    return {
      verdict: displayCitationIds.length ? "partial" : "unsupported",
      summary: displayCitationIds.length
        ? "Claims were rebound to the strongest available evidence."
        : "No claim could be rebound to the available evidence.",
      unsupported_claims: [],
      missing_info: [],
      verified_citation_ids: displayCitationIds,
      display_citation_ids: displayCitationIds,
      verified_claims: claimMap.filter((item) => item.citation_ids.length > 0).map((item) => item.text),
      claim_to_citation_map: claimMap
    };
  }

  async selectDisplayCitations(
    input: OpenClawSupportCitationSelectorInput,
    _idempotencyKey: string,
    _runtime?: OpenClawRuntimeContext
  ): Promise<{ display_citation_ids: string[] }> {
    return {
      display_citation_ids: Array.from(new Set(input.supportedClaims.flatMap((item) => item.citation_ids))).slice(0, 3)
    };
  }

  async curateSupportCitations(
    input: OpenClawSupportCitationSelectorInput,
    idempotencyKey: string,
    runtime?: OpenClawRuntimeContext
  ): Promise<{ display_citation_ids: string[] }> {
    return this.selectDisplayCitations(input, idempotencyKey, runtime);
  }

  async composeSupportAnswer(
    input: OpenClawSupportAnswerComposerInput,
    _idempotencyKey: string,
    _runtime?: OpenClawRuntimeContext
  ): Promise<{
    direct_answer: string;
    why: string[];
    what_to_do_now: string[];
    still_need_to_confirm: string[];
  }> {
    const facts = input.supportedClaims.map((item) => item.text);
    const direct_answer =
      facts[0] ??
      (input.mode === "partial"
        ? "I can confirm part of the answer, but some details are still unconfirmed."
        : "The available documentation supports this answer.");
    return {
      direct_answer,
      why: facts.slice(0, 3),
      what_to_do_now: input.nextActions.slice(0, 4),
      still_need_to_confirm: input.unknowns.slice(0, 4)
    };
  }

  async composeCustomerAnswer(
    input: OpenClawSupportAnswerComposerInput,
    _idempotencyKey: string,
    _runtime?: OpenClawRuntimeContext
  ): Promise<{
    question_type: SpecialistDraftAnswer["question_type"];
    render_variant: SpecialistDraftAnswer["render_variant"];
    direct_answer: string;
    sections: import("../../modules/ai/types.js").SupportAnswer["sections"];
    why: string[];
    what_to_do_now: string[];
    still_need_to_confirm: string[];
  }> {
    const direct_answer =
      input.supportedClaims[0]?.text ??
      input.draftSupportAnswer?.direct_answer ??
      (input.mode === "partial"
        ? "I could confirm part of the answer, but some details are still unconfirmed."
        : "The available documentation supports this answer.");
    const sections: import("../../modules/ai/types.js").SupportAnswer["sections"] = [];
    if (input.route.specialist_agent === "api-specialist") {
      sections.push({
        kind: "api_card",
        title: "API",
        method: input.draftSupportAnswer?.api_method ?? "",
        path: input.draftSupportAnswer?.api_path ?? "",
        required_params: input.draftSupportAnswer?.required_params ?? [],
        auth_scope: input.draftSupportAnswer?.auth_scope ?? [],
        response_field_hint: input.draftSupportAnswer?.response_field_hint,
        important_note: input.draftSupportAnswer?.important_note,
        related_variant: input.draftSupportAnswer?.related_variant
      });
    } else if (input.route.specialist_agent === "behavior-specialist") {
      if (input.draftSupportAnswer?.most_likely_explanation) {
        sections.push({ kind: "paragraph", title: "Most likely explanation", body: input.draftSupportAnswer.most_likely_explanation });
      }
      if (input.draftSupportAnswer?.what_to_check_next?.length) {
        sections.push({ kind: "bullet_list", title: "What to check next", items: input.draftSupportAnswer.what_to_check_next });
      }
    } else if (input.route.specialist_agent === "howto-specialist") {
      if (input.draftSupportAnswer?.steps?.length) sections.push({ kind: "bullet_list", title: "Steps", items: input.draftSupportAnswer.steps });
      if (input.draftSupportAnswer?.prerequisites?.length) {
        sections.push({ kind: "bullet_list", title: "Prerequisites", items: input.draftSupportAnswer.prerequisites });
      }
    } else {
      if (input.draftSupportAnswer?.recommended_checks?.length) {
        sections.push({ kind: "bullet_list", title: "Recommended checks", items: input.draftSupportAnswer.recommended_checks });
      }
      if (input.draftSupportAnswer?.required_followup_info?.length) {
        sections.push({ kind: "bullet_list", title: "Required follow-up info", items: input.draftSupportAnswer.required_followup_info });
      }
    }
    return {
      question_type: input.route.question_type,
      render_variant: input.draftSupportAnswer?.render_variant ?? "troubleshooting",
      direct_answer,
      sections,
      why: input.supportedClaims.map((item) => item.text).slice(0, 3),
      what_to_do_now: input.nextActions.slice(0, 4),
      still_need_to_confirm: input.unknowns.slice(0, 4)
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
        display_citation_ids: citationIds.slice(0, 3),
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
        display_citation_ids: citationIds.slice(0, 3),
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
      display_citation_ids: [],
      verified_claims: [],
      claim_to_citation_map: []
    };
  }

  async healthCheck() {
    return { ok: true, mode: "mock" as const, detail: "Mock adapter active" };
  }
}
