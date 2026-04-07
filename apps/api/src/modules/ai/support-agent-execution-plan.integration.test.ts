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
