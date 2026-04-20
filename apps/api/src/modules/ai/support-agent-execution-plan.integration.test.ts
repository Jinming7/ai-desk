import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  OpenClawAdapter,
  OpenClawAnalyzeInput,
  OpenClawAnalyzeOutput,
  OpenClawClassifyIntentInput,
  OpenClawClassifyIntentOutput,
  OpenClawHealthCheckResult,
  OpenClawRuntimeContext,
  OpenClawSearchAnswerInput,
  OpenClawSearchAnswerOutput,
  OpenClawSearchInput,
  OpenClawSearchOutput,
  OpenClawSupportAnswerComposerInput,
  OpenClawSupportExecutionPlannerOutput,
  OpenClawSupportCitationSelectorInput,
  OpenClawSupportEvidencePlannerInput,
  OpenClawSupportEvidenceSelectorInput,
  OpenClawSupportPlannerInput,
  OpenClawSupportRouterInput,
  OpenClawSupportSpecialistInput,
  OpenClawSupportVerifierInput,
  OpenClawSupportWriterInput
} from "../../infrastructure/openclaw/types.js";
import { SearchOrchestrator } from "./search-orchestrator.js";
import { runSupportSearchAgent } from "./support-agent.js";
import type {
  DraftSupportAnswer,
  SpecialistDraftAnswer,
  SupportQuestionRoute,
  TriageSupportInsight,
  SupportVerificationResult
} from "./types.js";
import { buildSearchRuntime } from "./agent-router.js";

function createPlannerFailureAdapter(): OpenClawAdapter {
  const emptyVerification: SupportVerificationResult = {
    verdict: "unsupported",
    summary: "",
    unsupported_claims: [],
    missing_info: [],
    verified_citation_ids: [],
    display_citation_ids: [],
    verified_claims: [],
    claim_to_citation_map: []
  };

  const emptySpecialist: SpecialistDraftAnswer = {
    question_type: "capability_confirmation",
    render_variant: "behavior",
    direct_answer: "",
    claims: [],
    next_actions: [],
    unknowns: [],
    escalation_needed: false
  };

  return {
    async analyzeTicket(_input: OpenClawAnalyzeInput, _idempotencyKey: string, _runtime?: OpenClawRuntimeContext): Promise<OpenClawAnalyzeOutput> {
      return {
        action: "ask_user",
        confidence: 0,
        reply: "",
        reasoning_summary: "",
        evidence: [],
        risk_flags: []
      };
    },
    async searchKnowledge(_input: OpenClawSearchInput, _idempotencyKey: string, _runtime?: OpenClawRuntimeContext): Promise<OpenClawSearchOutput> {
      return { confidence: 0, hits: [] };
    },
    async answerSearchQuery(
      _input: OpenClawSearchAnswerInput,
      _idempotencyKey: string,
      _runtime?: OpenClawRuntimeContext
    ): Promise<OpenClawSearchAnswerOutput> {
      return { answer: "", summary: "", steps: [], validation: [] };
    },
    async classifyIntent(
      _input: OpenClawClassifyIntentInput,
      _idempotencyKey: string,
      _runtime?: OpenClawRuntimeContext
    ): Promise<OpenClawClassifyIntentOutput> {
      return { intent: "general", route: "kb_guidance", confidence: 0, reasoning: "" };
    },
    async routeSupportQuestion(_input: OpenClawSupportRouterInput): Promise<SupportQuestionRoute> {
      return {
        question_type: "capability_confirmation",
        user_goal: "Confirm which Linux distributions are officially supported.",
        answer_contract:
          "State the officially supported Linux distributions clearly, note any version constraints if documented, and distinguish official support from unsupported distributions.",
        specialist_agent: "behavior-specialist",
        routing_confidence: 0.93,
        specialist_budget: 1
      };
    },
    async planSupportEvidence(_input: OpenClawSupportEvidencePlannerInput): Promise<never> {
      throw new Error("simulated evidence planner timeout");
    },
    async planSupportCase(_input: OpenClawSupportPlannerInput): Promise<never> {
      throw new Error("simulated case planner timeout");
    },
    async planSupportDispatch(input: Parameters<NonNullable<OpenClawAdapter["planSupportDispatch"]>>[0]) {
      const route = await this.routeSupportQuestion(
        {
          contextType: input.contextType,
          language: input.language,
          query: input.query,
          conversationHistory: input.conversationHistory
        },
        "",
        undefined
      );
      const primaryDomain =
        route.primary_domain ??
        ((route.question_type.startsWith("api_") ? "openapi" : "product") as "openapi" | "product");
      return {
        primaryDomain,
        route: {
          ...route,
          primary_domain: primaryDomain
        },
        caseFrame: {
          goal: input.query,
          symptom: input.query,
          object: input.query,
          action_type: "capability_confirmation",
          deployment_model: "unknown",
          product_area: "general",
          constraints: [],
          missing_critical_info: [],
          retrieval_queries: [input.query],
          query_plan: {
            concept_queries: [input.query],
            object_queries: [input.query],
            behavior_queries: ["capability_confirmation"]
          },
          question_type: route.question_type,
          specialist_agent: route.specialist_agent,
          answer_contract: route.answer_contract,
          routing_confidence: route.routing_confidence,
          required_doc_kinds: [],
          primary_domain: primaryDomain
        },
        retrievalQueries: [input.query]
      };
    },
    async selectSupportEvidence(_input: OpenClawSupportEvidenceSelectorInput) {
      return { primary_ids: [], supplemental_ids: [], rejected_ids: [] };
    },
    async writeSupportAnswer(_input: OpenClawSupportWriterInput): Promise<DraftSupportAnswer> {
      return {
        direct_answer: "",
        claims: [],
        next_actions: [],
        unknowns: [],
        escalation_needed: false
      };
    },
    async writeApiSpecialistAnswer(_input: OpenClawSupportSpecialistInput): Promise<SpecialistDraftAnswer> {
      return emptySpecialist;
    },
    async writeHowToSpecialistAnswer(_input: OpenClawSupportSpecialistInput): Promise<SpecialistDraftAnswer> {
      return emptySpecialist;
    },
    async writeBehaviorSpecialistAnswer(_input: OpenClawSupportSpecialistInput): Promise<SpecialistDraftAnswer> {
      return emptySpecialist;
    },
    async writeTroubleshootingSpecialistAnswer(_input: OpenClawSupportSpecialistInput): Promise<SpecialistDraftAnswer> {
      return emptySpecialist;
    },
    async judgeSupportAnswer(_input: OpenClawSupportVerifierInput): Promise<SupportVerificationResult> {
      return emptyVerification;
    },
    async verifySupportAnswer(_input: OpenClawSupportVerifierInput): Promise<SupportVerificationResult> {
      return emptyVerification;
    },
    async bindSupportCitations(_input: OpenClawSupportVerifierInput): Promise<SupportVerificationResult> {
      return emptyVerification;
    },
    async selectDisplayCitations(_input: OpenClawSupportCitationSelectorInput) {
      return { display_citation_ids: [] };
    },
    async curateSupportCitations(_input: OpenClawSupportCitationSelectorInput) {
      return { display_citation_ids: [] };
    },
    async composeSupportAnswer(input: OpenClawSupportAnswerComposerInput) {
      return {
        question_type: "capability_confirmation",
        render_variant: "behavior",
        direct_answer: input.supportedClaims[0]?.text ?? "",
        sections: [],
        why: [],
        what_to_do_now: input.nextActions,
        still_need_to_confirm: input.unknowns
      };
    },
    async composeCustomerAnswer(input: OpenClawSupportAnswerComposerInput) {
      return {
        question_type: "capability_confirmation",
        render_variant: "behavior",
        direct_answer: input.supportedClaims[0]?.text ?? "",
        sections: [],
        why: [],
        what_to_do_now: input.nextActions,
        still_need_to_confirm: input.unknowns
      };
    },
    async writeTriageInsight(_input: OpenClawSupportWriterInput): Promise<TriageSupportInsight> {
      return {
        direct_answer: "",
        recommended_action: "ask_user",
        customer_reply: "",
        customer_reply_policy: "send_now",
        support_summary: "",
        verified_evidence: [],
        risk_flags: [],
        missing_info: [],
        verifier_verdict: "unsupported"
      };
    },
    async verifyTriageInsight(_input: OpenClawSupportVerifierInput): Promise<SupportVerificationResult> {
      return emptyVerification;
    },
    async healthCheck(): Promise<OpenClawHealthCheckResult> {
      return { ok: true, mode: "mock", configuredAgents: [], reachableAgents: [], unreachableAgents: [] };
    }
  };
}

function createUnifiedPlannerAdapter() {
  const adapter = createPlannerFailureAdapter() as OpenClawAdapter & {
    legacyCalls: string[];
    observedDispatchTimeoutMs?: number;
    planSupportExecution: (
      input: OpenClawSupportPlannerInput,
      idempotencyKey: string,
      runtime?: OpenClawRuntimeContext
    ) => Promise<{
      route: SupportQuestionRoute;
      caseFrame: {
        goal: string;
        symptom: string;
        object: string;
        action_type: string;
        deployment_model: string;
        product_area: string;
        constraints: string[];
        missing_critical_info: string[];
        retrieval_queries: string[];
        query_plan: {
          concept_queries: string[];
          object_queries: string[];
          behavior_queries: string[];
        };
        question_type: SupportQuestionRoute["question_type"];
        specialist_agent: SupportQuestionRoute["specialist_agent"];
        answer_contract: string;
        routing_confidence: number;
      };
      evidencePlan: {
        query_plan: {
          concept_queries: string[];
          object_queries: string[];
          behavior_queries: string[];
        };
        evidence_priority: string[];
        required_doc_kinds: string[];
        retrieval_rounds: number;
        allow_refinement: boolean;
        stop_after_grounded_evidence: boolean;
      };
    }>;
  };

  adapter.legacyCalls = [];
  adapter.routeSupportQuestion = async (_input: OpenClawSupportRouterInput): Promise<SupportQuestionRoute> => {
    adapter.legacyCalls.push("route");
    throw new Error("legacy route should not be called when unified planner is available");
  };
  adapter.planSupportEvidence = async (_input: OpenClawSupportEvidencePlannerInput): Promise<never> => {
    adapter.legacyCalls.push("evidence");
    throw new Error("legacy evidence planner should not be called when unified planner is available");
  };
  adapter.planSupportCase = async (_input: OpenClawSupportPlannerInput): Promise<never> => {
    adapter.legacyCalls.push("case");
    throw new Error("legacy case planner should not be called when unified planner is available");
  };
  adapter.planSupportDispatch = async (input, _idempotencyKey, runtime) => {
    adapter.observedDispatchTimeoutMs = runtime?.timeoutMs;
    const unified = await adapter.planSupportExecution(input, _idempotencyKey, runtime);
    const primaryDomain = "deployment" as const;
    return {
      primaryDomain,
      route: {
        ...unified.route,
        primary_domain: primaryDomain
      },
      caseFrame: {
        ...unified.caseFrame,
        primary_domain: primaryDomain,
        required_doc_kinds: unified.evidencePlan.required_doc_kinds
      },
      retrievalQueries: Array.from(
        new Set([
          input.query,
          ...(unified.caseFrame.retrieval_queries ?? []),
          ...(unified.evidencePlan.query_plan?.concept_queries ?? []),
          ...(unified.evidencePlan.query_plan?.object_queries ?? []),
          ...(unified.evidencePlan.query_plan?.behavior_queries ?? [])
        ])
      )
    };
  };
  adapter.planSupportExecution = async (): Promise<{
    route: SupportQuestionRoute;
    caseFrame: {
      goal: string;
      symptom: string;
      object: string;
      action_type: string;
      deployment_model: string;
      product_area: string;
      constraints: string[];
      missing_critical_info: string[];
      retrieval_queries: string[];
      query_plan: {
        concept_queries: string[];
        object_queries: string[];
        behavior_queries: string[];
      };
      question_type: SupportQuestionRoute["question_type"];
      specialist_agent: SupportQuestionRoute["specialist_agent"];
      answer_contract: string;
      routing_confidence: number;
    };
    evidencePlan: {
      query_plan: {
        concept_queries: string[];
        object_queries: string[];
        behavior_queries: string[];
      };
      evidence_priority: string[];
      required_doc_kinds: string[];
      retrieval_rounds: number;
      allow_refinement: boolean;
      stop_after_grounded_evidence: boolean;
    };
  }> => ({
    route: {
      question_type: "capability_confirmation",
      user_goal: "Confirm which Linux distributions are officially supported.",
      answer_contract:
        "State the officially supported Linux distributions clearly, note any version constraints if documented, and distinguish official support from unsupported distributions.",
      specialist_agent: "behavior-specialist",
      routing_confidence: 0.96,
      specialist_budget: 1
    },
    caseFrame: {
      goal: "Confirm which Linux distributions are officially supported.",
      symptom: "Need the official Linux support scope.",
      object: "linux distributions",
      action_type: "capability_confirmation",
      deployment_model: "private_deployment",
      product_area: "deployment",
      constraints: [],
      missing_critical_info: [],
      retrieval_queries: [
        "supported operating systems",
        "linux distributions",
        "deployment environment requirements"
      ],
      query_plan: {
        concept_queries: ["supported operating systems"],
        object_queries: ["linux distributions"],
        behavior_queries: ["officially supported"]
      },
      question_type: "capability_confirmation",
      specialist_agent: "behavior-specialist",
      answer_contract:
        "State the officially supported Linux distributions clearly, note any version constraints if documented, and distinguish official support from unsupported distributions.",
      routing_confidence: 0.96
    },
    evidencePlan: {
      query_plan: {
        concept_queries: ["supported operating systems"],
        object_queries: ["linux distributions"],
        behavior_queries: ["officially supported"]
      },
      evidence_priority: ["support matrix", "deployment guide"],
      required_doc_kinds: ["product_guide", "rules"],
      retrieval_rounds: 2,
      allow_refinement: true,
      stop_after_grounded_evidence: false
    }
  });

  return adapter;
}

test("runSupportSearchAgent prefers the unified support execution planner over legacy planner stages", async () => {
  const originalCollectEvidence = SearchOrchestrator.prototype.collectEvidence;
  SearchOrchestrator.prototype.collectEvidence = async function collectEvidenceStub(input) {
    return {
      query: input.queries[0] ?? "",
      answer: "",
      confidence: 0.4,
      references: [],
      retrievalStatus: "no_results",
      unresolvedReasonCode: "NO_MATCHING_KB",
      resolvedQueries: input.queries,
      fallbackUsed: false
    };
  };

  try {
    const adapter = createUnifiedPlannerAdapter();
    const execution = await runSupportSearchAgent({
      query: "Which Linux distributions are officially supported?",
      language: "en",
      currentRound: 0,
      conversationHistory: [],
      adapter,
      idempotencyKey: "support-execution-plan-unified-planner"
    });

    assert.deepEqual(adapter.legacyCalls, []);
    const retrievalQueries = execution.result.internal_diagnostics?.retrieval_queries_used ?? [];
    assert.equal(retrievalQueries.some((query) => /linux distributions|supported operating systems/i.test(query)), true);
  } finally {
    SearchOrchestrator.prototype.collectEvidence = originalCollectEvidence;
  }
});

test("runSupportSearchAgent gives the unified planner a larger async-job timeout budget than the legacy planner cap", async () => {
  const originalCollectEvidence = SearchOrchestrator.prototype.collectEvidence;
  SearchOrchestrator.prototype.collectEvidence = async function collectEvidenceStub(input) {
    return {
      query: input.queries[0] ?? "",
      answer: "",
      confidence: 0.4,
      references: [],
      retrievalStatus: "no_results",
      unresolvedReasonCode: "NO_MATCHING_KB",
      resolvedQueries: input.queries,
      fallbackUsed: false
    };
  };

  try {
    const adapter = createUnifiedPlannerAdapter() as OpenClawAdapter & {
      observedDispatchTimeoutMs?: number;
    };

    await runSupportSearchAgent({
      query: "Which Linux distributions are officially supported?",
      language: "en",
      currentRound: 0,
      conversationHistory: [],
      adapter,
      runtime: buildSearchRuntime({
        intent: "retrieval",
        sessionId: "support-execution-plan-async-timeout",
        delivery: "async_job"
      }),
      idempotencyKey: "support-execution-plan-async-timeout"
    });

    assert.equal(typeof adapter.observedDispatchTimeoutMs, "number");
    assert.equal((adapter.observedDispatchTimeoutMs ?? 0) > 14_000, true);
  } finally {
    SearchOrchestrator.prototype.collectEvidence = originalCollectEvidence;
  }
});

test("runSupportSearchAgent does not emit generic fallback retrieval queries when planner stages time out", async () => {
  const originalCollectEvidence = SearchOrchestrator.prototype.collectEvidence;

  SearchOrchestrator.prototype.collectEvidence = async function collectEvidenceStub(input) {
    return {
      query: input.queries[0] ?? "",
      answer: "",
      confidence: 0.4,
      references: [],
      retrievalStatus: "no_results",
      unresolvedReasonCode: "NO_MATCHING_KB",
      resolvedQueries: input.queries,
      fallbackUsed: false
    };
  };

  try {
    const execution = await runSupportSearchAgent({
      query: "Which Linux distributions are officially supported?",
      language: "en",
      currentRound: 0,
      conversationHistory: [],
      adapter: createPlannerFailureAdapter(),
      idempotencyKey: "support-execution-plan-integration"
    });

    const retrievalQueries = execution.result.internal_diagnostics?.retrieval_queries_used ?? [];
    assert.equal(retrievalQueries.length > 0, true);
    assert.equal(retrievalQueries.some((query) => /unspecified|general|shared|troubleshooting/i.test(query)), false);
    assert.equal(
      retrievalQueries.some((query) =>
        /linux distributions|supported operating systems|deployment environment requirements/i.test(query)
      ),
      true
    );
  } finally {
    SearchOrchestrator.prototype.collectEvidence = originalCollectEvidence;
  }
});
