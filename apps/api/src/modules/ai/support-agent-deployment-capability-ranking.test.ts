import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  OpenClawAdapter,
  OpenClawAnalyzeInput,
  OpenClawAnalyzeOutput,
  OpenClawClassifyIntentInput,
  OpenClawClassifyIntentOutput,
  OpenClawRuntimeContext,
  OpenClawSearchAnswerInput,
  OpenClawSearchAnswerOutput,
  OpenClawSearchInput,
  OpenClawSearchOutput,
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
  SearchReference,
  SpecialistDraftAnswer,
  SupportCaseFrame,
  SupportEvidencePlan,
  SupportQuestionRoute,
  SupportVerificationResult,
  TriageSupportInsight
} from "./types.js";

function createReference(input: {
  documentId: string;
  evidenceId: string;
  title: string;
  path: string;
  headingPath: string;
  snippet: string;
  score: number;
  supportMetadata: Record<string, unknown>;
}): SearchReference {
  return {
    documentId: input.documentId,
    evidenceId: input.evidenceId,
    title: input.title,
    snippet: input.snippet,
    sourceUrl: `https://docs.ones.com/${input.path.replace(/\.mdx?$/, "")}`,
    repoSourceUrl: `https://github.com/BangWork/docs-com/blob/main/${input.path}`,
    repo: "BangWork/docs-com",
    branch: "main",
    path: input.path,
    commitSha: "abc1234",
    headingPath: input.headingPath,
    supportMetadata: input.supportMetadata,
    authority: "canonical_visible",
    sourceType: "github_kb",
    score: input.score,
    retrievedAt: new Date().toISOString()
  };
}

function buildVerifiedResult(input: { evidenceIds: string[]; claimText: string }): SupportVerificationResult {
  return {
    verdict: "verified",
    summary: "The answer is grounded in the retrieved documentation.",
    unsupported_claims: [],
    missing_info: [],
    verified_citation_ids: input.evidenceIds,
    display_citation_ids: input.evidenceIds.slice(0, 2),
    verified_claims: [input.claimText],
    claim_to_citation_map: [
      {
        text: input.claimText,
        kind: "verified_fact",
        verdict: "verified",
        citation_ids: input.evidenceIds
      }
    ]
  };
}

function createDeploymentCapabilityAdapter(): OpenClawAdapter {
  const route: SupportQuestionRoute = {
    question_type: "capability_confirmation",
    user_goal: "确认 ONES 支持哪些 Linux 发行版",
    answer_contract: "基于官方文档给出支持的 Linux 发行版和版本范围。",
    specialist_agent: "behavior-specialist",
    routing_confidence: 0.95,
    specialist_budget: 1
  };
  const caseFrame: SupportCaseFrame = {
    goal: "确认 ONES 支持哪些 Linux 发行版",
    symptom: "用户需要确认私有化部署的 Linux 兼容性范围",
    object: "linux distributions",
    action_type: "capability_confirmation",
    deployment_model: "private_deployment",
    product_area: "deployment",
    constraints: [],
    missing_critical_info: [],
    retrieval_queries: ["ONES 支持哪些 Linux 发行版", "ONES 操作系统支持矩阵"],
    query_plan: {
      concept_queries: ["操作系统要求", "支持矩阵"],
      object_queries: ["linux distributions", "ubuntu red hat centos"],
      behavior_queries: ["supports officially"]
    },
    question_type: route.question_type,
    specialist_agent: route.specialist_agent,
    answer_contract: route.answer_contract,
    routing_confidence: route.routing_confidence,
    required_doc_kinds: ["deployment_runbook", "product_guide", "rules"]
  };
  const evidencePlan: SupportEvidencePlan = {
    query_plan: caseFrame.query_plan!,
    evidence_priority: ["support matrix", "operating system requirements"],
    required_doc_kinds: ["deployment_runbook", "product_guide", "rules"],
    retrieval_rounds: 2,
    allow_refinement: true,
    stop_after_grounded_evidence: false
  };

  return {
    async analyzeTicket(_input: OpenClawAnalyzeInput): Promise<OpenClawAnalyzeOutput> {
      return {
        action: "ask_user",
        confidence: 0,
        reply: "",
        reasoning_summary: "",
        evidence: [],
        risk_flags: []
      };
    },
    async searchKnowledge(_input: OpenClawSearchInput): Promise<OpenClawSearchOutput> {
      return { confidence: 0, hits: [] };
    },
    async answerSearchQuery(_input: OpenClawSearchAnswerInput): Promise<OpenClawSearchAnswerOutput> {
      return {
        answer: "",
        summary: "",
        steps: [],
        validation: []
      };
    },
    async classifyIntent(_input: OpenClawClassifyIntentInput): Promise<OpenClawClassifyIntentOutput> {
      return {
        intent: "general",
        route: "kb_guidance",
        confidence: 0.1,
        reasoning: ""
      };
    },
    async planSupportCase(_input: OpenClawSupportPlannerInput): Promise<SupportCaseFrame> {
      return caseFrame;
    },
    async routeSupportQuestion(_input: OpenClawSupportRouterInput): Promise<SupportQuestionRoute> {
      return route;
    },
    async planSupportEvidence(_input: OpenClawSupportEvidencePlannerInput): Promise<SupportEvidencePlan> {
      return evidencePlan;
    },
    async planSupportExecution() {
      return {
        route,
        caseFrame,
        evidencePlan
      };
    },
    async selectSupportEvidence(_input: OpenClawSupportEvidenceSelectorInput): Promise<never> {
      throw new Error("force fallback evidence selection to exercise runtime reranking");
    },
    async writeSupportAnswer(_input: OpenClawSupportWriterInput): Promise<DraftSupportAnswer> {
      return {
        direct_answer: "我已经找到相关部署文档，但需要进一步确认支持范围。",
        claims: [],
        next_actions: [],
        unknowns: [],
        escalation_needed: false
      };
    },
    async writeApiSpecialistAnswer(_input: OpenClawSupportSpecialistInput): Promise<SpecialistDraftAnswer> {
      throw new Error("api specialist should not be used");
    },
    async writeHowToSpecialistAnswer(_input: OpenClawSupportSpecialistInput): Promise<SpecialistDraftAnswer> {
      throw new Error("howto specialist should not be used");
    },
    async writeBehaviorSpecialistAnswer(_input: OpenClawSupportSpecialistInput): Promise<SpecialistDraftAnswer> {
      return {
        question_type: "capability_confirmation",
        render_variant: "behavior",
        direct_answer: "当前文档说明了私有化部署的环境要求。",
        claims: [],
        next_actions: [],
        unknowns: [],
        escalation_needed: false
      };
    },
    async writeTroubleshootingSpecialistAnswer(_input: OpenClawSupportSpecialistInput): Promise<SpecialistDraftAnswer> {
      throw new Error("troubleshooting specialist should not be used");
    },
    async judgeSupportAnswer(input: OpenClawSupportVerifierInput): Promise<SupportVerificationResult> {
      const claim = input.draftSupportAnswer.claims[0];
      return buildVerifiedResult({
        evidenceIds: claim?.evidence_ids ?? [],
        claimText: claim?.text ?? input.draftSupportAnswer.direct_answer
      });
    },
    async verifySupportAnswer(input: OpenClawSupportVerifierInput): Promise<SupportVerificationResult> {
      return this.judgeSupportAnswer(input, "", undefined);
    },
    async bindSupportCitations(input: OpenClawSupportVerifierInput): Promise<SupportVerificationResult> {
      const claim = input.draftSupportAnswer.claims[0];
      return buildVerifiedResult({
        evidenceIds: claim?.evidence_ids ?? [],
        claimText: claim?.text ?? input.draftSupportAnswer.direct_answer
      });
    },
    async selectDisplayCitations(input: OpenClawSupportCitationSelectorInput): Promise<{ display_citation_ids: string[] }> {
      return {
        display_citation_ids: Array.from(new Set(input.supportedClaims.flatMap((item) => item.citation_ids))).slice(0, 2)
      };
    },
    async curateSupportCitations(input: OpenClawSupportCitationSelectorInput): Promise<{ display_citation_ids: string[] }> {
      return {
        display_citation_ids: Array.from(new Set(input.supportedClaims.flatMap((item) => item.citation_ids))).slice(0, 2)
      };
    },
    async composeSupportAnswer(input) {
      return {
        question_type: input.route.question_type,
        render_variant: "behavior" as const,
        direct_answer: input.supportedClaims[0]?.text ?? "",
        sections: [],
        why: [],
        what_to_do_now: input.nextActions,
        still_need_to_confirm: input.unknowns
      };
    },
    async composeCustomerAnswer(input) {
      return {
        question_type: input.route.question_type,
        render_variant: "behavior" as const,
        direct_answer: input.supportedClaims[0]?.text ?? "",
        sections: [],
        why: [],
        what_to_do_now: input.nextActions,
        still_need_to_confirm: input.unknowns
      };
    },
    async writeTriageInsight(): Promise<TriageSupportInsight> {
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
      return buildVerifiedResult({
        evidenceIds: [],
        claimText: ""
      });
    }
  };
}

test("runSupportSearchAgent prioritizes operating-system support evidence over generic deployment overview for deployment capability questions", async () => {
  const originalCollectEvidence = SearchOrchestrator.prototype.collectEvidence;
  SearchOrchestrator.prototype.collectEvidence = async function collectEvidenceStub(input) {
    return {
      query: input.queries[0] ?? "",
      answer: "",
      confidence: 0.82,
      retrievalStatus: "grounded",
      unresolvedReasonCode: null,
      resolvedQueries: input.queries,
      fallbackUsed: false,
      references: [
        createReference({
          documentId: "doc-deployment-root",
          evidenceId: "doc-deployment-root::root",
          title: "ONES 私有部署环境要求",
          path: "deploy-docs/prepare/deployment-requirements.md",
          headingPath: "ROOT",
          snippet:
            "部署环境要求，本文描述在私有部署 ONES 前所需准备的系统环境要求，可配合部署说明阅读，并在复杂环境下联系 ONES 工程师评估。",
          score: 0.94,
          supportMetadata: {
            evidence_kind: "procedure",
            product_area: "deployment",
            deployment_model: "private_deployment",
            doc_kind: "deployment_runbook"
          }
        }),
        createReference({
          documentId: "doc-deployment-os",
          evidenceId: "doc-deployment-os::os",
          title: "ONES 私有部署环境要求",
          path: "deploy-docs/prepare/deployment-requirements.md",
          headingPath: "操作系统要求",
          snippet: "支持 64 位 Ubuntu 18/20/24、64 位 Red Hat 8.0 及以上，不再支持 CentOS 7 系列。",
          score: 0.86,
          supportMetadata: {
            evidence_kind: "constraint",
            product_area: "deployment",
            deployment_model: "private_deployment",
            object_type: "linux distributions",
            doc_kind: "rules"
          }
        }),
        createReference({
          documentId: "doc-install-root",
          evidenceId: "doc-install-root::root",
          title: "ONES 单机安装说明",
          path: "deploy-docs/install-upgrade/install/install.md",
          headingPath: "ROOT",
          snippet: "安装前需确认服务器配置、网络要求、操作系统要求、存储资源要求等基本环境要求。",
          score: 0.88,
          supportMetadata: {
            evidence_kind: "procedure",
            product_area: "deployment",
            deployment_model: "private_deployment",
            doc_kind: "deployment_runbook"
          }
        })
      ]
    };
  };

  try {
    const execution = await runSupportSearchAgent({
      query: "ONES 支持哪些 Linux 发行版？",
      language: "zh",
      currentRound: 0,
      conversationHistory: [],
      adapter: createDeploymentCapabilityAdapter(),
      idempotencyKey: "support-agent-deployment-capability-ranking",
      runtime: {
        deliveryMode: "async_job",
        overallTimeoutMs: 240000,
        requestStartedAtMs: Date.now()
      }
    });

    assert.match(execution.result.answer, /Ubuntu 18\/20\/24/);
    assert.match(execution.result.answer, /Red Hat 8/);
    assert.equal(execution.result.references[0]?.headingPath, "操作系统要求");
    assert.equal(execution.result.citations[0]?.title, "ONES 私有部署环境要求");
  } finally {
    SearchOrchestrator.prototype.collectEvidence = originalCollectEvidence;
  }
});
