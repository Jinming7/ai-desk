import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { test } from "node:test";
import { env } from "../../config/env.js";
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
  OpenClawSupportAnswerComposerInput,
  OpenClawSupportEvidencePlannerInput,
  OpenClawSupportEvidenceSelectorInput,
  OpenClawSupportPlannerInput,
  OpenClawSupportRouterInput,
  OpenClawSupportSpecialistInput,
  OpenClawSupportVerifierInput,
  OpenClawSupportWriterInput
} from "../../infrastructure/openclaw/types.js";
import { searchLocalDocs } from "./local-docs.js";
import { SearchOrchestrator } from "./search-orchestrator.js";
import {
  runSupportSearchAgent as coreRunSupportSearchAgent,
  runSupportTriageAgent as coreRunSupportTriageAgent
} from "./support-agent.js";
import {
  resolveSearchReferenceEvidenceId,
  type DraftSupportAnswer,
  type SearchReference,
  type SpecialistDraftAnswer,
  type SupportAnswer,
  type SupportCaseFrame,
  type SupportEvidencePlan,
  type SupportQuestionRoute,
  type SupportVerificationResult,
  type TriageSupportInsight
} from "./types.js";
import { getAiRuntimeReadinessProfile, getAiTopology } from "./agent-router.js";

const DEFAULT_TEST_LOCAL_DOCS_PATH = env.LOCAL_DOCS_COM_PATH;

async function createFixtureRoot(): Promise<string> {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "support-agent-test-"));
  execFileSync("git", ["init"], { cwd: rootDir, stdio: "ignore" });
  execFileSync("git", ["-c", "user.name=Test User", "-c", "user.email=test@example.com", "commit", "--allow-empty", "-m", "init"], {
    cwd: rootDir,
    stdio: "ignore"
  });
  return rootDir;
}

async function writeFixture(rootDir: string, relativePath: string, content: string): Promise<void> {
  const filePath = path.join(rootDir, relativePath);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, content, "utf8");
}

function createAdapter(options: {
  missingInfo?: string[];
  searchHits?: OpenClawSearchOutput["hits"];
  writerAnswer?: Partial<DraftSupportAnswer>;
  verification?: Partial<SupportVerificationResult>;
  queryPlan?: SupportCaseFrame["query_plan"];
  routeOverride?: Partial<SupportQuestionRoute>;
  evidencePlanOverride?: Partial<SupportEvidencePlan>;
}): OpenClawAdapter {
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
      return {
        confidence: 0.4,
        hits:
          options.searchHits ??
          [
            {
              id: "invalid-hit",
              title: "Invalid evidence",
              snippet: "This hit has no usable citation.",
              score: 0.4,
              sourceUrl: ""
            }
          ]
      };
    },
    async answerSearchQuery(
      _input: OpenClawSearchAnswerInput,
      _idempotencyKey: string,
      _runtime?: OpenClawRuntimeContext
    ): Promise<OpenClawSearchAnswerOutput> {
      return {
        answer: "",
        summary: "",
        steps: [],
        validation: []
      };
    },
    async classifyIntent(
      _input: OpenClawClassifyIntentInput,
      _idempotencyKey: string,
      _runtime?: OpenClawRuntimeContext
    ): Promise<OpenClawClassifyIntentOutput> {
      return {
        intent: "general",
        route: "kb_guidance",
        confidence: 0.1,
        reasoning: ""
      };
    },
    async planSupportCase(
      input: OpenClawSupportPlannerInput,
      _idempotencyKey: string,
      _runtime?: OpenClawRuntimeContext
    ): Promise<SupportCaseFrame> {
      return {
        goal: input.query,
        symptom: input.query,
        object: "api_token",
        action_type: "reset_access",
        deployment_model: "unknown",
        product_area: "openapi",
        constraints: [],
        missing_critical_info: options.missingInfo ?? [],
        retrieval_queries: [input.query],
        query_plan: options.queryPlan
      };
    },
    async routeSupportQuestion(
      input: OpenClawSupportRouterInput
    ): Promise<SupportQuestionRoute> {
      return {
        question_type: "api_scope_auth",
        user_goal: input.query,
        answer_contract: "Provide the exact API answer first.",
        specialist_agent: "api-specialist",
        routing_confidence: 0.9,
        ...options.routeOverride
      };
    },
    async planSupportEvidence(
      input: OpenClawSupportEvidencePlannerInput
    ): Promise<SupportEvidencePlan> {
      return {
        query_plan: options.queryPlan ?? {
          concept_queries: [input.query],
          object_queries: [input.query],
          behavior_queries: [input.query]
        },
        evidence_priority: [],
        required_doc_kinds: ["openapi/api"],
        ...options.evidencePlanOverride
      };
    },
    async selectSupportEvidence(
      input: OpenClawSupportEvidenceSelectorInput,
      _idempotencyKey: string,
      _runtime?: OpenClawRuntimeContext
    ) {
      return {
        primary_ids: input.references.slice(0, 3).map((item) => resolveSearchReferenceEvidenceId(item)),
        supplemental_ids: input.references.slice(3, 5).map((item) => resolveSearchReferenceEvidenceId(item)),
        rejected_ids: input.references.slice(5).map((item) => resolveSearchReferenceEvidenceId(item))
      };
    },
    async writeSupportAnswer(
      _input: OpenClawSupportWriterInput,
      _idempotencyKey: string,
      _runtime?: OpenClawRuntimeContext
    ): Promise<DraftSupportAnswer> {
      return {
        direct_answer: "I still need one critical detail before I can give a verified answer.",
        claims: [],
        next_actions: ["Please share the missing detail."],
        unknowns: [],
        escalation_needed: false,
        ...options.writerAnswer
      };
    },
    async writeApiSpecialistAnswer(
      _input: OpenClawSupportSpecialistInput
    ): Promise<SpecialistDraftAnswer> {
      return {
        question_type: "api_scope_auth",
        render_variant: "api",
        direct_answer: "Use the documented API details first.",
        claims: [],
        next_actions: ["Please share the missing detail."],
        unknowns: [],
        escalation_needed: false,
        ...(options.writerAnswer as Partial<SpecialistDraftAnswer>)
      };
    },
    async writeHowToSpecialistAnswer(input: OpenClawSupportSpecialistInput): Promise<SpecialistDraftAnswer> {
      return {
        ...(await this.writeApiSpecialistAnswer(input, "", undefined)),
        render_variant: "how_to"
      };
    },
    async writeBehaviorSpecialistAnswer(input: OpenClawSupportSpecialistInput): Promise<SpecialistDraftAnswer> {
      return {
        ...(await this.writeApiSpecialistAnswer(input, "", undefined)),
        render_variant: "behavior"
      };
    },
    async writeTroubleshootingSpecialistAnswer(input: OpenClawSupportSpecialistInput): Promise<SpecialistDraftAnswer> {
      return {
        ...(await this.writeApiSpecialistAnswer(input, "", undefined)),
        render_variant: "troubleshooting"
      };
    },
    async judgeSupportAnswer(
      input: OpenClawSupportVerifierInput,
      _idempotencyKey: string,
      _runtime?: OpenClawRuntimeContext
    ): Promise<SupportVerificationResult> {
      return this.verifySupportAnswer(input, "", _runtime);
    },
    async verifySupportAnswer(
      _input: OpenClawSupportVerifierInput,
      _idempotencyKey: string,
      _runtime?: OpenClawRuntimeContext
    ): Promise<SupportVerificationResult> {
      return {
        verdict: "partial",
        summary: "The answer is only partially supported.",
        unsupported_claims: [],
        missing_info: [],
        verified_citation_ids: [],
        display_citation_ids: [],
        verified_claims: [],
        claim_to_citation_map: [],
        ...options.verification
      };
    },
    async composeCustomerAnswer(
      input,
      _idempotencyKey: string,
      _runtime?: OpenClawRuntimeContext
    ): Promise<{
      question_type: SupportQuestionRoute["question_type"];
      render_variant: SpecialistDraftAnswer["render_variant"];
      direct_answer: string;
      sections: [];
      why: string[];
      what_to_do_now: string[];
      still_need_to_confirm: string[];
    }> {
      const directAnswer =
        input.supportedClaims[0]?.text ??
        (input.mode === "clarification"
          ? "I need one more detail before I can answer this accurately."
          : input.mode === "handoff"
          ? "I could not verify this from the current documentation, so the next step is to create a ticket with the current evidence."
          : input.draftSupportAnswer?.direct_answer ?? "");
      return {
        question_type: input.route.question_type,
        render_variant: input.draftSupportAnswer?.render_variant ?? "api",
        direct_answer: directAnswer,
        sections: [],
        why: input.supportedClaims.map((item) => item.text).slice(0, 3),
        what_to_do_now: input.nextActions.slice(0, 4),
        still_need_to_confirm: input.unknowns.slice(0, 4)
      };
    },
    async writeTriageInsight(
      _input: OpenClawSupportWriterInput,
      _idempotencyKey: string,
      _runtime?: OpenClawRuntimeContext
    ): Promise<TriageSupportInsight> {
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
    async verifyTriageInsight(
      _input: OpenClawSupportVerifierInput,
      _idempotencyKey: string,
      _runtime?: OpenClawRuntimeContext
    ): Promise<SupportVerificationResult> {
      return {
        verdict: "unsupported",
        summary: "",
        unsupported_claims: [],
        missing_info: [],
        verified_citation_ids: [],
        display_citation_ids: [],
        verified_claims: [],
        claim_to_citation_map: []
      };
    },
    async healthCheck() {
      return { ok: true as const, mode: "mock" as const };
    }
  };
}

function createFixtureBackedSearchOrchestrator(adapter: OpenClawAdapter) {
  const hybridRuntime = {
    async retrieve(request: {
      query: string;
      answerLanguage: "zh" | "en";
      topK: number;
      rewrites: string[];
      requiredObjectTypes: string[];
      knowledgeSpace: string;
      repoId?: string;
      branch?: string;
    }) {
      const hits = await searchLocalDocs(request.query, request.answerLanguage, request.topK).catch(() => []);
      const retrievedAt = new Date().toISOString();
      const references: SearchReference[] = hits.map((hit) => ({
        documentId: hit.documentId,
        title: hit.title,
        snippet: hit.snippet,
        sourceUrl: hit.sourceUrl,
        repoSourceUrl: hit.repoSourceUrl,
        repo: hit.repo,
        branch: hit.branch,
        path: hit.path,
        commitSha: hit.commitSha,
        headingPath: hit.headingPath,
        supportMetadata: {
          ...(hit.supportMetadata ?? {}),
          authority: "canonical_visible",
          source_type: "local_docs"
        },
        authority: "canonical_visible",
        sourceType: "local_docs",
        score: hit.score,
        retrievedAt
      }));
      const topIds = references.map((item) => resolveSearchReferenceEvidenceId(item)).slice(0, request.topK);
      return {
        query: request.query,
        references,
        confidence: references[0]?.score ?? 0,
        retrievalStatus: references.length ? ("grounded" as const) : ("no_results" as const),
        unresolvedReasonCode: references.length ? null : ("NO_MATCHING_KB" as const),
        diagnostics: {
          publication: {
            knowledgeSpace: request.knowledgeSpace,
            repoId: request.repoId ?? "fixture-local-docs",
            branch: request.branch ?? "main",
            publishedBuildVersion: "fixture-local-docs"
          },
          rewrites: request.rewrites,
          requiredObjectTypes: request.requiredObjectTypes,
          perChannelCounts: references.length ? { structured_artifact: references.length } : {},
          channelTopIds: references.length ? { structured_artifact: topIds } : {},
          fusionTopIds: topIds,
          rerankTopIds: topIds,
          groundingSuccessRate: references.length ? 1 : 0,
          evidenceGate: {
            verdict: references.length ? ("grounded" as const) : ("insufficient" as const),
            reasons: references.length ? [] : ["no_fixture_match"],
            evidenceFamilies: references.length ? ["local_docs"] : []
          },
          finalConfidence: references[0]?.score ?? 0
        }
      };
    }
  };

  class FixtureBackedSearchOrchestrator extends SearchOrchestrator {
    override async collectEvidence(input: {
      queries: string[];
      idempotencyKey: string;
      runtime?: OpenClawRuntimeContext;
      answerLanguage?: "zh" | "en";
      attachments?: string[];
      caseFrame?: SupportCaseFrame;
      repoId?: string;
      branch?: string;
    }) {
      const normalizedQueries = [...new Set(input.queries.map((item) => item.trim()).filter(Boolean))];
      const query = normalizedQueries[0] ?? "";
      const topK = Math.max(1, Math.min(12, input.runtime?.kbTopK ?? 8));
      const lang = input.answerLanguage ?? "en";
      const hits = await searchLocalDocs(query, lang, topK).catch(() => []);
      const retrievedAt = new Date().toISOString();
      const references: SearchReference[] = hits.map((hit) => ({
        documentId: hit.documentId,
        title: hit.title,
        snippet: hit.snippet,
        sourceUrl: hit.sourceUrl,
        repoSourceUrl: hit.repoSourceUrl,
        repo: hit.repo,
        branch: hit.branch,
        path: hit.path,
        commitSha: hit.commitSha,
        headingPath: hit.headingPath,
        supportMetadata: {
          ...(hit.supportMetadata ?? {}),
          authority: "canonical_visible",
          source_type: "local_docs"
        },
        authority: "canonical_visible",
        sourceType: "local_docs",
        score: hit.score,
        retrievedAt
      }));
      return {
        query,
        answer: "",
        confidence: references[0]?.score ?? 0,
        references,
        retrievalStatus: references.length ? ("grounded" as const) : ("no_results" as const),
        unresolvedReasonCode: references.length ? null : ("NO_MATCHING_KB" as const),
        resolvedQueries: normalizedQueries,
        fallbackUsed: false
      };
    }
  }

  return new FixtureBackedSearchOrchestrator(adapter, hybridRuntime as never);
}

async function runSupportSearchAgent(input: Parameters<typeof coreRunSupportSearchAgent>[0]) {
  const orchestrator =
    input.orchestrator ??
    (env.LOCAL_DOCS_COM_PATH !== DEFAULT_TEST_LOCAL_DOCS_PATH ? createFixtureBackedSearchOrchestrator(input.adapter) : undefined);
  return coreRunSupportSearchAgent(
    orchestrator
      ? {
          ...input,
          orchestrator
        }
      : input
  );
}

async function runSupportTriageAgent(input: Parameters<typeof coreRunSupportTriageAgent>[0]) {
  const orchestrator =
    input.orchestrator ??
    (env.LOCAL_DOCS_COM_PATH !== DEFAULT_TEST_LOCAL_DOCS_PATH ? createFixtureBackedSearchOrchestrator(input.adapter) : undefined);
  return coreRunSupportTriageAgent(
    orchestrator
      ? {
          ...input,
          orchestrator
        }
      : input
  );
}

function createStageRecordingAdapter(options?: {
  failRoute?: boolean;
  failEvidencePlan?: boolean;
}): OpenClawAdapter & { calls: string[] } {
  const calls: string[] = [];

  const record = (name: string) => {
    calls.push(name);
  };

  const adapter: OpenClawAdapter & { calls: string[] } = {
    calls,
    async analyzeTicket(_input: OpenClawAnalyzeInput): Promise<OpenClawAnalyzeOutput> {
      record("analyzeTicket");
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
      record("searchKnowledge");
      return {
        confidence: 0.91,
        hits: [
          {
            id: "kb-auth-001",
            title: "Troubleshoot SSO Login Callback Failures",
            snippet: "Verify callback URL and tenant mapping before escalation.",
            score: 0.91,
            sourceUrl:
              "https://github.com/BangWork/docs-com/blob/8d8f2ee6875f2d146f8f0d3bd82f51a8cb4d0a11/docs/sso-callback.md"
          }
        ]
      };
    },
    async answerSearchQuery(
      _input: OpenClawSearchAnswerInput
    ): Promise<OpenClawSearchAnswerOutput> {
      record("answerSearchQuery");
      return {
        answer: "",
        summary: "",
        steps: [],
        validation: []
      };
    },
    async classifyIntent(
      _input: OpenClawClassifyIntentInput
    ): Promise<OpenClawClassifyIntentOutput> {
      record("classifyIntent");
      return {
        intent: "general",
        route: "kb_guidance",
        confidence: 0.1,
        reasoning: ""
      };
    },
    async planSupportCase(input: OpenClawSupportPlannerInput): Promise<SupportCaseFrame> {
      record("planSupportCase");
      return {
        goal: input.query,
        symptom: input.query,
        object: "oauth callback",
        action_type: "troubleshooting",
        deployment_model: "shared",
        product_area: "integrations",
        constraints: [],
        missing_critical_info: [],
        retrieval_queries: [input.query],
        query_plan: {
          concept_queries: [input.query],
          object_queries: ["oauth callback"],
          behavior_queries: ["callback failure"]
        }
      };
    },
    async routeSupportQuestion(input: OpenClawSupportRouterInput): Promise<SupportQuestionRoute> {
      record("routeSupportQuestion");
      if (options?.failRoute) {
        throw new Error("router failed");
      }
      return {
        question_type: "troubleshooting",
        user_goal: input.query,
        answer_contract: "Give the most likely integration cause first.",
        specialist_agent: "troubleshooting-specialist",
        routing_confidence: 0.88
      };
    },
    async planSupportEvidence(input: OpenClawSupportEvidencePlannerInput): Promise<SupportEvidencePlan> {
      record("planSupportEvidence");
      if (options?.failEvidencePlan) {
        throw new Error("planner failed");
      }
      return {
        query_plan: {
          concept_queries: [input.query],
          object_queries: ["oauth callback"],
          behavior_queries: ["callback failure"]
        },
        evidence_priority: ["troubleshooting", "integrations"],
        required_doc_kinds: ["troubleshooting", "product_guide"],
        retrieval_rounds: 1,
        allow_refinement: false,
        stop_after_grounded_evidence: false
      };
    },
    async selectSupportEvidence(input: OpenClawSupportEvidenceSelectorInput) {
      record("selectSupportEvidence");
      return {
        primary_ids: input.references.slice(0, 1).map((item) => resolveSearchReferenceEvidenceId(item)),
        supplemental_ids: [],
        rejected_ids: []
      };
    },
    async writeApiSpecialistAnswer(input: OpenClawSupportSpecialistInput): Promise<SpecialistDraftAnswer> {
      record("writeApiSpecialistAnswer");
      return {
        question_type: input.route.question_type,
        render_variant: "api",
        direct_answer: "Use the documented API details first.",
        claims: [],
        next_actions: [],
        unknowns: [],
        escalation_needed: false
      };
    },
    async writeHowToSpecialistAnswer(input: OpenClawSupportSpecialistInput): Promise<SpecialistDraftAnswer> {
      record("writeHowToSpecialistAnswer");
      return {
        question_type: input.route.question_type,
        render_variant: "how_to",
        direct_answer: "Follow the documented steps.",
        claims: [],
        next_actions: [],
        unknowns: [],
        escalation_needed: false
      };
    },
    async writeBehaviorSpecialistAnswer(input: OpenClawSupportSpecialistInput): Promise<SpecialistDraftAnswer> {
      record("writeBehaviorSpecialistAnswer");
      return {
        question_type: input.route.question_type,
        render_variant: "behavior",
        direct_answer: "The current behavior matches the documented rule.",
        claims: [],
        next_actions: [],
        unknowns: [],
        escalation_needed: false
      };
    },
    async writeTroubleshootingSpecialistAnswer(input: OpenClawSupportSpecialistInput): Promise<SpecialistDraftAnswer> {
      record("writeTroubleshootingSpecialistAnswer");
      return {
        question_type: input.route.question_type,
        render_variant: "troubleshooting",
        direct_answer: "The callback configuration is the most likely issue.",
        claims: [
          {
            text: "Callback and Redirect URI must be consistent.",
            kind: "verified_fact",
            evidence_ids: input.evidenceBundle.primary.map((item) => resolveSearchReferenceEvidenceId(item)).slice(0, 1),
            authority: "canonical"
          }
        ],
        next_actions: ["Check Redirect URI and callback URL consistency."],
        unknowns: [],
        escalation_needed: false,
        most_likely_causes: ["Callback URL mismatch"],
        recommended_checks: ["Compare Redirect URI, callback URL, and base URL."]
      };
    },
    async writeSupportAnswer(_input: OpenClawSupportWriterInput): Promise<DraftSupportAnswer> {
      record("writeSupportAnswer");
      return {
        direct_answer: "Fallback support answer",
        claims: [],
        next_actions: [],
        unknowns: [],
        escalation_needed: false
      };
    },
    async judgeSupportAnswer(input: OpenClawSupportVerifierInput): Promise<SupportVerificationResult> {
      record("judgeSupportAnswer");
      const citationIds = input.evidenceBundle.primary.map((item) => resolveSearchReferenceEvidenceId(item)).slice(0, 1);
      return {
        verdict: citationIds.length ? "verified" : "unsupported",
        summary: "verified",
        unsupported_claims: [],
        missing_info: [],
        verified_citation_ids: citationIds,
        display_citation_ids: citationIds,
        verified_claims: input.draftSupportAnswer?.claims.map((item) => item.text) ?? [],
        claim_to_citation_map:
          input.draftSupportAnswer?.claims.map((item) => ({
            text: item.text,
            kind: item.kind,
            verdict: item.kind === "grounded_inference" ? "supported_inference" : "verified",
            citation_ids: citationIds
          })) ?? []
      };
    },
    async verifySupportAnswer(input: OpenClawSupportVerifierInput): Promise<SupportVerificationResult> {
      record("verifySupportAnswer");
      return this.judgeSupportAnswer(input, "", undefined);
    },
    async composeCustomerAnswer(input) {
      record("composeCustomerAnswer");
      return {
        question_type: input.route.question_type,
        render_variant: input.draftSupportAnswer?.render_variant ?? "troubleshooting",
        direct_answer: input.supportedClaims[0]?.text ?? input.draftSupportAnswer?.direct_answer ?? "",
        sections: [],
        why: input.supportedClaims.map((item) => item.text).slice(0, 3),
        what_to_do_now: input.nextActions.slice(0, 4),
        still_need_to_confirm: input.unknowns.slice(0, 4)
      };
    },
    async writeTriageInsight(_input: OpenClawSupportWriterInput): Promise<TriageSupportInsight> {
      record("writeTriageInsight");
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
      record("verifyTriageInsight");
      return {
        verdict: "unsupported",
        summary: "",
        unsupported_claims: [],
        missing_info: [],
        verified_citation_ids: [],
        display_citation_ids: [],
        verified_claims: [],
        claim_to_citation_map: []
      };
    },
    async healthCheck() {
      record("healthCheck");
      return { ok: true as const, mode: "mock" as const };
    }
  };

  return adapter;
}

test("runSupportSearchAgent converts invalid uncited evidence into handoff when no blocking question exists", async () => {
  const originalLocalDocsPath = env.LOCAL_DOCS_COM_PATH;
  env.LOCAL_DOCS_COM_PATH = "/tmp/__missing_local_docs__";
  const adapter = createAdapter({});
  try {
    const result = await runSupportSearchAgent({
      query: "reset api token access",
      language: "en",
      currentRound: 0,
      conversationHistory: [],
      adapter,
      idempotencyKey: "support-agent-invalid-evidence-handoff"
    });

    assert.equal(result.result.support_answer?.mode, "handoff");
    assert.equal(result.result.citations.length, 0);
    assert.equal(result.result.clarification_round, 0);
    assert.equal(result.result.follow_up_question, null);
    assert.equal(typeof result.result.answer, "string");
    assert.equal(result.result.answer.length > 0, true);
    assert.equal(result.result.show_create_ticket_now, true);
    assert.equal(typeof result.stageTimings.total_ms, "number");
    assert.equal(result.stageTimings.retrieval_base.status, "completed");
  } finally {
    env.LOCAL_DOCS_COM_PATH = originalLocalDocsPath;
  }
});

test("runSupportSearchAgent skips extra retrieval passes in fast runtime mode", async () => {
  const originalLocalDocsPath = env.LOCAL_DOCS_COM_PATH;
  env.LOCAL_DOCS_COM_PATH = "/tmp/__missing_local_docs__";
  const adapter = createAdapter({
    queryPlan: {
      concept_queries: ["workspace role permission inheritance"],
      object_queries: ["role permission"],
      behavior_queries: ["why permission inherited"]
    },
    verification: {
      verdict: "unsupported",
      missing_info: ["the exact permission path"]
    }
  });
  try {
    const result = await runSupportSearchAgent({
      query: "why is this permission inherited",
      language: "en",
      currentRound: 0,
      conversationHistory: [],
      adapter,
      idempotencyKey: "support-agent-fast-runtime",
      runtime: {
        intent: "retrieval",
        sessionKey: "test-fast-runtime",
        disableLocalDocs: true,
        allowMultiPassRetrieval: false,
        allowRefinement: false,
        kbTopK: 4,
        queryLimit: 1
      }
    });

    assert.equal(result.stageTimings.retrieval_extra.status, "skipped");
  } finally {
    env.LOCAL_DOCS_COM_PATH = originalLocalDocsPath;
  }
});

test("runSupportSearchAgent keeps clarification only when blocking missing info exists", async () => {
  const originalLocalDocsPath = env.LOCAL_DOCS_COM_PATH;
  env.LOCAL_DOCS_COM_PATH = "/tmp/__missing_local_docs__";
  const adapter = createAdapter({
    missingInfo: ["the workspace where the token is being used"],
    verification: {
      verdict: "unsupported",
      missing_info: ["the workspace where the token is being used"]
    }
  });
  try {
    const result = await runSupportSearchAgent({
      query: "reset api token access",
      language: "en",
      currentRound: 0,
      conversationHistory: [],
      adapter,
      idempotencyKey: "support-agent-invalid-evidence-clarification"
    });

    assert.equal(result.result.support_answer?.mode, "clarification");
    assert.equal(result.result.references.length, 0);
    assert.equal(result.result.citations.length, 0);
    assert.equal(result.result.clarification_round, 1);
    assert.equal(result.result.follow_up_question, "the workspace where the token is being used");
    assert.equal(typeof result.stageTimings.total_ms, "number");
    assert.match(result.stageTimings.retrieval_extra.status, /completed|skipped/);
  } finally {
    env.LOCAL_DOCS_COM_PATH = originalLocalDocsPath;
  }
});

test("runSupportSearchAgent uses customer answer composer for clarification replies", async () => {
  const originalLocalDocsPath = env.LOCAL_DOCS_COM_PATH;
  env.LOCAL_DOCS_COM_PATH = "/tmp/__missing_local_docs__";
  const adapter = createAdapter({
    missingInfo: ["the workspace where the token is being used"],
    verification: {
      verdict: "unsupported",
      missing_info: ["the workspace where the token is being used"]
    }
  });
  let composeCalled = false;
  adapter.composeCustomerAnswer = async (input) => {
    composeCalled = true;
    return {
      question_type: input.route.question_type,
      render_variant: "clarification",
      direct_answer: "Please confirm which workspace the token belongs to before I continue.",
      sections: [
        {
          kind: "bullet_list",
          title: "Need from you",
          items: ["the workspace where the token is being used"]
        }
      ],
      why: [],
      what_to_do_now: ["Share the workspace name or URL."],
      still_need_to_confirm: ["the workspace where the token is being used"]
    };
  };

  try {
    const result = await runSupportSearchAgent({
      query: "reset api token access",
      language: "en",
      currentRound: 0,
      conversationHistory: [],
      adapter,
      idempotencyKey: "support-agent-clarification-composer"
    });

    assert.equal(composeCalled, true);
    assert.equal(result.result.support_answer?.mode, "clarification");
    assert.equal(result.result.answer, "Please confirm which workspace the token belongs to before I continue.");
    assert.deepEqual(result.result.support_answer?.what_to_do_now, ["Share the workspace name or URL."]);
    assert.deepEqual(result.result.support_answer?.sections, [
      {
        kind: "bullet_list",
        title: "Need from you",
        items: ["the workspace where the token is being used"]
      }
    ]);
  } finally {
    env.LOCAL_DOCS_COM_PATH = originalLocalDocsPath;
  }
});

test("runSupportSearchAgent uses customer answer composer for handoff replies", async () => {
  const originalLocalDocsPath = env.LOCAL_DOCS_COM_PATH;
  env.LOCAL_DOCS_COM_PATH = "/tmp/__missing_local_docs__";
  const adapter = createAdapter({});
  let composeCalled = false;
  adapter.composeCustomerAnswer = async (input) => {
    composeCalled = true;
    return {
      question_type: input.route.question_type,
      render_variant: "handoff",
      direct_answer: "I cannot verify this from documentation, so the next step is to create a ticket with the current evidence.",
      sections: [
        {
          kind: "bullet_list",
          title: "What to do now",
          items: ["Create the ticket draft now."]
        }
      ],
      why: [],
      what_to_do_now: ["Create the ticket draft now."],
      still_need_to_confirm: []
    };
  };

  try {
    const result = await runSupportSearchAgent({
      query: "reset api token access",
      language: "en",
      currentRound: env.AI_SEARCH_MAX_CLARIFICATION_ROUNDS,
      conversationHistory: [],
      adapter,
      idempotencyKey: "support-agent-handoff-composer"
    });

    assert.equal(composeCalled, true);
    assert.equal(result.result.support_answer?.mode, "handoff");
    assert.equal(
      result.result.answer,
      "I cannot verify this from documentation, so the next step is to create a ticket with the current evidence."
    );
    assert.deepEqual(result.result.support_answer?.what_to_do_now, ["Create the ticket draft now."]);
    assert.deepEqual(result.result.support_answer?.sections, [
      {
        kind: "bullet_list",
        title: "What to do now",
        items: ["Create the ticket draft now."]
      }
    ]);
  } finally {
    env.LOCAL_DOCS_COM_PATH = originalLocalDocsPath;
  }
});

test("runSupportSearchAgent honors composer suppression signal for still-need delivery", async () => {
  const rootDir = await createFixtureRoot();
  const originalLocalDocsPath = env.LOCAL_DOCS_COM_PATH;
  env.LOCAL_DOCS_COM_PATH = rootDir;
  const adapter = createAdapter({
    writerAnswer: {
      unknowns: []
    },
    verification: {
      verdict: "partial",
      missing_info: [],
      verified_citation_ids: ["chunk:deployment-reset"],
      display_citation_ids: ["chunk:deployment-reset"],
      verified_claims: ["The deployment runbook documents this reset path."],
      claim_to_citation_map: [
        {
          text: "The deployment runbook documents this reset path.",
          kind: "verified_fact",
          verdict: "verified",
          citation_ids: ["chunk:deployment-reset"]
        }
      ]
    }
  });
  adapter.composeCustomerAnswer = async (input) => ({
    question_type: input.route.question_type,
    render_variant: "how_to",
    direct_answer: "You can execute the documented reset flow now on the private deployment host.",
    sections: [
      {
        kind: "bullet_list" as const,
        title: "Steps",
        items: ["Open host-side recovery.", "Run the password reset action for administrator."]
      }
    ],
    why: ["The deployment runbook documents this reset path."],
    what_to_do_now: ["Run the host-side recovery reset flow now."],
    still_need_to_confirm: ["the exact private deployment topology"],
    suppress_still_need_to_confirm: true
  });

  try {
    const result = await runSupportSearchAgent({
      query: "private deployment forgot admin password, no SMTP",
      language: "en",
      currentRound: 0,
      conversationHistory: [],
      adapter,
      idempotencyKey: "support-agent-composer-suppress-still-need"
    });

    assert.deepEqual(result.result.support_answer?.still_need_to_confirm, []);
    assert.equal(
      result.result.answer,
      "You can execute the documented reset flow now on the private deployment host."
    );
    assert.deepEqual(result.result.support_answer?.what_to_do_now, ["Run the host-side recovery reset flow now."]);
  } finally {
    env.LOCAL_DOCS_COM_PATH = originalLocalDocsPath;
  }
});


test("runSupportSearchAgent keeps API answers structurally organized when the shared answer chain is available", async () => {
  const rootDir = await createFixtureRoot();
  const originalLocalDocsPath = env.LOCAL_DOCS_COM_PATH;
  env.LOCAL_DOCS_COM_PATH = rootDir;

  await writeFixture(
    rootDir,
    "open-docs/docs/openapi/api/04-update-a-issue.api.mdx",
    `---
title: "Update a issue"
---

# Update a issue

通过 PUT /project/issues/{issueID} 更新工作项。
`
  );

  const adapter = createAdapter({});
  adapter.writeApiSpecialistAnswer = async () => ({
    question_type: "api_endpoint_lookup",
    render_variant: "api",
    direct_answer: "更新工作项可以使用更新工作项接口。",
    claims: [
      {
        text: "可以通过 PUT /project/issues/{issueID} 更新工作项。",
        kind: "verified_fact",
        evidence_ids: ["local:open-docs/docs/openapi/api/04-update-a-issue.api.mdx:root"],
        authority: "canonical"
      }
    ],
    next_actions: ["先准备 `teamID` 和 `issueID`。", "再提交更新字段的请求体。"],
    unknowns: [],
    api_method: "PUT",
    api_path: "https://openapi.ones.pro/project/issues/{issueID}?teamID={teamID}",
    required_params: ["`teamID`：从团队 URL 中获取。", "`issueID`：先通过查询接口拿到 UUID。"],
    auth_scope: ["`write:project:issue`"],
    response_field_hint: "返回更新后的工作项数据。",
    important_note: "`issueID` 必须是 UUID，不能直接使用 `OPS-1` 这类编号。",
    related_variant: "如果要先拿状态列表，可使用状态列表接口。",
    escalation_needed: false
  });
  adapter.composeCustomerAnswer = async (input) => ({
    question_type: input.route.question_type,
    render_variant: "api",
    direct_answer: "更新工作项可以使用更新工作项接口。",
    sections: [
      {
        kind: "api_card",
        title: "接口信息",
        method: "PUT",
        path: "https://openapi.ones.pro/project/issues/{issueID}?teamID={teamID}",
        required_params: ["`teamID`：从团队 URL 中获取。", "`issueID`：先通过查询接口拿到 UUID。"],
        auth_scope: ["`write:project:issue`"]
      },
      {
        kind: "bullet_list",
        title: "必填参数及获取方式",
        items: ["`teamID`：从团队 URL 中获取。", "`issueID`：先通过查询接口拿到 UUID。"]
      },
      {
        kind: "bullet_list",
        title: "关键说明",
        items: ["`issueID` 必须是 UUID，不能直接使用 `OPS-1` 这类编号。"]
      }
    ],
    why: ["可以通过 PUT /project/issues/{issueID} 更新工作项。"],
    what_to_do_now: ["先准备 `teamID` 和 `issueID`。", "再提交更新字段的请求体。"],
    still_need_to_confirm: [],
    suppress_still_need_to_confirm: true
  });

  try {
    const result = await runSupportSearchAgent({
      query: "怎么通过接口更新工作项？",
      language: "zh",
      currentRound: 0,
      conversationHistory: [],
      adapter,
      idempotencyKey: "support-agent-fast-api-structure"
    });

    assert.equal(result.result.support_answer?.render_variant, "api");
    assert.deepEqual(
      result.result.support_answer?.sections.map((section) => section.title),
      ["接口信息", "必填参数及获取方式", "关键说明"]
    );
  } finally {
    env.LOCAL_DOCS_COM_PATH = originalLocalDocsPath;
    await rm(rootDir, { recursive: true, force: true });
  }
});




test("runSupportSearchAgent prefers judge-preserved narrow behavior claims over a generic draft direct answer", async () => {
  const rootDir = await createFixtureRoot();
  const originalLocalDocsPath = env.LOCAL_DOCS_COM_PATH;
  env.LOCAL_DOCS_COM_PATH = rootDir;

  await writeFixture(
    rootDir,
    "deploy-docs/docs/installation/linux-server/requirements.mdx",
    `---
title: "Linux 服务端环境要求"
---

# Linux 服务端环境要求

ONES 私有部署服务端支持 Ubuntu 18/20/24 与 Red Hat 8+。
`
  );

  const adapter = createAdapter({
    routeOverride: {
      question_type: "capability_confirmation",
      specialist_agent: "behavior-specialist",
      specialist_budget: 1
    },
    evidencePlanOverride: {
      retrieval_rounds: 1,
      allow_refinement: false,
      stop_after_grounded_evidence: false
    }
  });
  adapter.planSupportCase = async (input) => ({
    goal: input.query,
    symptom: input.query,
    object: "linux distributions",
    action_type: "capability_confirmation",
    deployment_model: "private_deployment",
    product_area: "deployment",
    constraints: [],
    missing_critical_info: [],
    retrieval_queries: ["supported operating systems", "linux distributions"],
    query_plan: {
      concept_queries: ["supported operating systems", "deployment requirements"],
      object_queries: ["linux distributions", "server environment"],
      behavior_queries: ["supported", "recommended"]
    }
  });
  adapter.writeBehaviorSpecialistAnswer = async () => ({
    question_type: "capability_confirmation",
    render_variant: "behavior",
    direct_answer: "I still need one critical detail before I can give a verified answer.",
    claims: [],
    next_actions: [],
    unknowns: [],
    escalation_needed: false
  });
  adapter.judgeSupportAnswer = async () => ({
    verdict: "partial",
    summary: "The current deployment requirements support a narrow answer.",
    unsupported_claims: [],
    missing_info: ["whether the question is about the server environment"],
    verified_citation_ids: ["local:deploy-docs/docs/installation/linux-server/requirements.mdx:root"],
    display_citation_ids: ["local:deploy-docs/docs/installation/linux-server/requirements.mdx:root"],
    verified_claims: ["ONES 私有部署服务端支持 Ubuntu 18/20/24 与 Red Hat 8+。"],
    claim_to_citation_map: [
      {
        text: "ONES 私有部署服务端支持 Ubuntu 18/20/24 与 Red Hat 8+。",
        kind: "verified_fact",
        verdict: "verified",
        citation_ids: ["local:deploy-docs/docs/installation/linux-server/requirements.mdx:root"]
      }
    ]
  });
  class FixedEvidenceOrchestrator extends SearchOrchestrator {
    override async collectEvidence(_input: {
      queries: string[];
      idempotencyKey: string;
      runtime?: OpenClawRuntimeContext;
      answerLanguage?: "zh" | "en";
      attachments?: string[];
      caseFrame?: SupportCaseFrame;
      repoId?: string;
      branch?: string;
    }) {
      const retrievedAt = new Date().toISOString();
      return {
        query: "ONES 支持哪些 Linux 发行版？",
        answer: "",
        confidence: 0.91,
        references: [
          {
            documentId: "local:deploy-docs/docs/installation/linux-server/requirements.mdx:root",
            title: "Linux 服务端环境要求",
            snippet: "ONES 私有部署服务端支持 Ubuntu 18/20/24 与 Red Hat 8+。",
            sourceUrl: "https://docs.ones.com/deploy/linux-server/requirements",
            repoSourceUrl:
              "https://github.com/BangWork/docs-com/blob/main/deploy-docs/docs/installation/linux-server/requirements.mdx",
            repo: "BangWork/docs-com",
            branch: "main",
            path: "deploy-docs/docs/installation/linux-server/requirements.mdx",
            commitSha: "fixture",
            headingPath: "ROOT",
            supportMetadata: {
              authority: "canonical_visible",
              source_type: "local_docs"
            },
            authority: "canonical_visible" as const,
            sourceType: "local_docs" as const,
            score: 0.91,
            retrievedAt
          }
        ],
        retrievalStatus: "grounded" as const,
        unresolvedReasonCode: null,
        resolvedQueries: ["ONES 支持哪些 Linux 发行版？"],
        fallbackUsed: false
      };
    }
  }
  const orchestrator = new FixedEvidenceOrchestrator(adapter, {} as never);

  try {
    const result = await runSupportSearchAgent({
      query: "ONES 支持哪些 Linux 发行版？",
      language: "zh",
      currentRound: 0,
      conversationHistory: [],
      adapter,
      orchestrator,
      idempotencyKey: "support-agent-judge-preserved-narrow-behavior-answer"
    });

    assert.match(result.result.answer, /Ubuntu 18\/20\/24.*Red Hat 8\+/);
    assert.doesNotMatch(result.result.answer, /critical detail|verified answer|关键信息/);
    assert.equal(result.result.support_answer?.mode, "partial");
  } finally {
    env.LOCAL_DOCS_COM_PATH = originalLocalDocsPath;
    await rm(rootDir, { recursive: true, force: true });
  }
});


test("runSupportSearchAgent keeps the evidence selector in the live orchestration trace", async () => {
  const originalLocalDocsPath = env.LOCAL_DOCS_COM_PATH;
  env.LOCAL_DOCS_COM_PATH = "/tmp/__missing_local_docs__";
  const adapter = createAdapter({
    verification: {
      verdict: "unsupported",
      missing_info: ["the exact object or scenario"]
    }
  });

  try {
    const result = await runSupportSearchAgent({
      query: "which scope is needed to create an issue comment",
      language: "en",
      currentRound: 0,
      conversationHistory: [],
      adapter,
      idempotencyKey: "support-agent-selector-stage-trace"
    });

    const trace = result.result.internal_diagnostics?.orchestration_trace ?? [];
    assert.equal(trace.some((item) => item.stage === "support-evidence-selector"), true);
  } finally {
    env.LOCAL_DOCS_COM_PATH = originalLocalDocsPath;
  }
});

test("AI topology excludes retired citation post-processing stages from the live support runtime", () => {
  const topology = getAiTopology();
  const stages = topology.supportStages.stages.map((stage) => stage.stage);
  assert.equal(stages.includes("router"), true);
  assert.equal(stages.includes("evidence-planner"), true);
  assert.equal(stages.includes("planner"), true);
  assert.equal(stages.includes("support-evidence-selector"), true);
  assert.equal(stages.includes("evidence-judge"), true);
  assert.equal(stages.includes("answer-composer"), true);
  assert.equal(stages.includes("api-specialist"), true);
  assert.equal(stages.includes("howto-specialist"), true);
  assert.equal(stages.includes("behavior-specialist"), true);
  assert.equal(stages.includes("troubleshooting-specialist"), true);
});


test("AI runtime readiness requires the active support chain", () => {
  const topology = getAiTopology();
  const executionAgentId = topology.searchStages.find((stage) => stage.stage === "execution")?.agentId ?? "";
  const readiness = getAiRuntimeReadinessProfile();

  assert.equal(readiness.requiredAgents.includes("search-retrieval"), true);
  assert.equal(readiness.requiredAgents.includes("search-clarify"), true);
  assert.equal(readiness.requiredAgents.includes(executionAgentId), true);
  assert.equal(readiness.requiredAgents.includes("support-router"), true);
  assert.equal(readiness.requiredAgents.includes("support-evidence-planner"), true);
  assert.equal(readiness.requiredAgents.includes("support-planner"), true);
  assert.equal(readiness.requiredAgents.includes("support-evidence-selector"), true);
  assert.equal(readiness.requiredAgents.includes("support-api-specialist"), true);
  assert.equal(readiness.requiredAgents.includes("support-howto-specialist"), true);
  assert.equal(readiness.requiredAgents.includes("support-behavior-specialist"), true);
  assert.equal(readiness.requiredAgents.includes("support-troubleshooting-specialist"), true);
  assert.equal(readiness.requiredAgents.includes("support-evidence-judge"), true);
  assert.equal(readiness.requiredAgents.includes("support-answer-composer"), true);
  assert.equal(readiness.requiredAgents.includes("support-main"), false);
  assert.deepEqual(readiness.optionalAgents, []);
});

test("runSupportSearchAgent drops supported claims that are missing citation ids", async () => {
  const rootDir = await createFixtureRoot();
  const originalLocalDocsPath = env.LOCAL_DOCS_COM_PATH;
  env.LOCAL_DOCS_COM_PATH = rootDir;

  await writeFixture(
    rootDir,
    "open-docs/docs/openapi/api/execute-onesql.api.mdx",
    `---
title: "Execute ONESQL query"
---

# Execute ONESQL query

ONESQL supports ORDER BY and GROUP BY clauses in POST /onesql/query.
`
  );

  const adapter = createAdapter({
    writerAnswer: {
      direct_answer: "ONESQL supports ORDER BY and GROUP BY in the query syntax.",
      claims: [
        {
          text: "ONESQL supports ORDER BY and GROUP BY in the query syntax.",
          kind: "verified_fact",
          evidence_ids: [],
          authority: "canonical"
        }
      ]
    },
    verification: {
      verdict: "verified",
      unsupported_claims: [],
      missing_info: [],
      verified_citation_ids: [],
      display_citation_ids: [],
      verified_claims: ["ONESQL supports ORDER BY and GROUP BY in the query syntax."],
      claim_to_citation_map: [
        {
          text: "ONESQL supports ORDER BY and GROUP BY in the query syntax.",
          kind: "verified_fact",
          verdict: "verified",
          citation_ids: []
        }
      ]
    }
  });

  try {
    const result = await runSupportSearchAgent({
      query: "does ONESQL support ORDER BY and GROUP BY?",
      language: "en",
      currentRound: 0,
      conversationHistory: [],
      adapter,
      idempotencyKey: "support-agent-no-citation-no-grounded"
    });

    assert.equal(result.result.support_answer?.mode, "handoff");
    assert.equal(result.result.answer, "I could not verify this from the current documentation, so the next step is to create a ticket with the current evidence.");
    assert.deepEqual(result.result.citations, []);
    assert.equal(result.result.show_create_ticket_now, true);
  } finally {
    env.LOCAL_DOCS_COM_PATH = originalLocalDocsPath;
    await rm(rootDir, { recursive: true, force: true });
  }
});



test("runSupportTriageAgent uses the shared support stages instead of legacy triage-only stages", async () => {
  const originalLocalDocsPath = env.LOCAL_DOCS_COM_PATH;
  const rootDir = await createFixtureRoot();
  env.LOCAL_DOCS_COM_PATH = rootDir;
  const adapter = createStageRecordingAdapter();

  try {
    await writeFixture(
      rootDir,
      "docs/integrations/github-callback.mdx",
      `---
title: "GitHub callback troubleshooting"
---

# GitHub callback troubleshooting

If authorization returns page not found, verify Redirect URI, callback URL, and baseURL are consistent.
`
    );
    const result = await runSupportTriageAgent({
      query: "GitHub callback page not found after authorization",
      language: "en",
      adapter,
      idempotencyKey: "support-agent-triage-shared-runtime",
      priority: "P2",
      customerMeta: {},
      history: [{ author: "customer", body: "Authorization callback fails with page not found", at: new Date().toISOString() }],
      runtime: {
        allowMultiPassRetrieval: false,
        allowRefinement: false
      }
    });

    assert.equal(adapter.calls.includes("routeSupportQuestion"), true);
    assert.equal(adapter.calls.includes("planSupportEvidence"), true);
    assert.equal(adapter.calls.includes("selectSupportEvidence"), true);
    assert.equal(adapter.calls.includes("writeTroubleshootingSpecialistAnswer"), true);
    assert.equal(adapter.calls.includes("judgeSupportAnswer"), true);
    assert.equal(adapter.calls.includes("curateSupportCitations") || adapter.calls.includes("selectDisplayCitations"), false);
    assert.equal(adapter.calls.includes("composeCustomerAnswer"), true);
    assert.equal(adapter.calls.includes("writeTriageInsight"), false);
    assert.equal(adapter.calls.includes("verifyTriageInsight"), false);
    assert.equal(result.analyzeOutput.action, "resolve");
    assert.equal(typeof result.analyzeOutput.reply, "string");
  } finally {
    env.LOCAL_DOCS_COM_PATH = originalLocalDocsPath;
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("runSupportSearchAgent fails closed when dispatch routing is unavailable", async () => {
  const originalLocalDocsPath = env.LOCAL_DOCS_COM_PATH;
  const rootDir = await createFixtureRoot();
  env.LOCAL_DOCS_COM_PATH = rootDir;
  const adapter = createStageRecordingAdapter({
    failRoute: true,
    failEvidencePlan: true
  });

  try {
    await writeFixture(
      rootDir,
      "docs/integrations/github-callback.mdx",
      `---
title: "GitHub callback troubleshooting"
---

# GitHub callback troubleshooting

If authorization returns page not found, verify Redirect URI, callback URL, and baseURL are consistent.
`
    );
    await assert.rejects(
      runSupportSearchAgent({
        query: "GitHub callback page not found after authorization",
        language: "en",
        currentRound: 0,
        conversationHistory: [],
        adapter,
        idempotencyKey: "support-agent-stage-trace-fallback",
        runtime: {
          allowMultiPassRetrieval: false,
          allowRefinement: false
        }
      }),
      /support route unavailable: router failed/
    );
  } finally {
    env.LOCAL_DOCS_COM_PATH = originalLocalDocsPath;
    await rm(rootDir, { recursive: true, force: true });
  }
});
