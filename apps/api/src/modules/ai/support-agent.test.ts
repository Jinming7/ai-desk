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
import { getAiRuntimeReadinessProfile, getAiTopology, resolveStageSpecificAgent } from "./agent-router.js";

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
        unknowns: ["the exact object or scenario"],
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
        unknowns: ["the exact object or scenario"],
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
    async bindSupportCitations(
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
    async selectDisplayCitations(
      input,
      _idempotencyKey: string,
      _runtime?: OpenClawRuntimeContext
    ): Promise<{ display_citation_ids: string[] }> {
      return {
        display_citation_ids: Array.from(new Set(input.supportedClaims.flatMap((item) => item.citation_ids))).slice(0, 3)
      };
    },
    async curateSupportCitations(input, _idempotencyKey: string, _runtime?: OpenClawRuntimeContext): Promise<{ display_citation_ids: string[] }> {
      return this.selectDisplayCitations(input, "", _runtime);
    },
    async composeSupportAnswer(
      input,
      _idempotencyKey: string,
      _runtime?: OpenClawRuntimeContext
    ): Promise<{ direct_answer: string; why: string[]; what_to_do_now: string[]; still_need_to_confirm: string[] }> {
      return {
        direct_answer: input.supportedClaims[0]?.text ?? "",
        why: input.supportedClaims.map((item) => item.text).slice(0, 3),
        what_to_do_now: input.nextActions.slice(0, 4),
        still_need_to_confirm: input.unknowns.slice(0, 4)
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
      return {
        question_type: input.route.question_type,
        render_variant: input.draftSupportAnswer?.render_variant ?? "api",
        direct_answer: input.supportedClaims[0]?.text ?? "",
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

  return new SearchOrchestrator(adapter, hybridRuntime as never);
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
    async bindSupportCitations(input: OpenClawSupportVerifierInput): Promise<SupportVerificationResult> {
      record("bindSupportCitations");
      return this.judgeSupportAnswer(input, "", undefined);
    },
    async selectDisplayCitations(input) {
      record("selectDisplayCitations");
      return {
        display_citation_ids: Array.from(new Set(input.supportedClaims.flatMap((item) => item.citation_ids))).slice(0, 3)
      };
    },
    async curateSupportCitations(input) {
      record("curateSupportCitations");
      return {
        display_citation_ids: Array.from(new Set(input.supportedClaims.flatMap((item) => item.citation_ids))).slice(0, 3)
      };
    },
    async composeSupportAnswer(input) {
      record("composeSupportAnswer");
      return {
        direct_answer: input.supportedClaims[0]?.text ?? "",
        why: input.supportedClaims.map((item) => item.text).slice(0, 3),
        what_to_do_now: input.nextActions.slice(0, 4),
        still_need_to_confirm: input.unknowns.slice(0, 4)
      };
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
    assert.equal(result.result.references.length, 0);
    assert.equal(result.result.citations.length, 0);
    assert.equal(result.result.retrieval_status, "no_results");
    assert.equal(result.result.clarification_round, 0);
    assert.equal(result.result.follow_up_question, null);
    assert.match(result.result.answer, /Create a ticket/i);
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
      sections: [],
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
      sections: [],
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

test("runSupportSearchAgent records planner-driven retrieval queries in internal diagnostics", async () => {
  const originalLocalDocsPath = env.LOCAL_DOCS_COM_PATH;
  env.LOCAL_DOCS_COM_PATH = "/tmp/__missing_local_docs__";
  const adapter = createAdapter({
    queryPlan: {
      concept_queries: ["workspace role permission inheritance"],
      object_queries: ["role permission path"],
      behavior_queries: ["why permission inherited after role change"]
    },
    evidencePlanOverride: {
      retrieval_rounds: 2,
      allow_refinement: false
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
      idempotencyKey: "support-agent-retrieval-query-graph"
    });

    const diagnostics = result.result.internal_diagnostics;
    assert.ok(diagnostics);
    assert.deepEqual(diagnostics.stage_budget, {
      retrieval_rounds: 2,
      allow_refinement: false,
      stop_after_grounded_evidence: false,
      specialist_budget: 1
    });
    assert.equal(
      diagnostics.retrieval_queries_used.includes("workspace role permission inheritance"),
      true
    );
    assert.equal(diagnostics.retrieval_queries_used.includes("role permission path"), true);
    assert.equal(
      diagnostics.retrieval_queries_used.includes("why permission inherited after role change"),
      true
    );
  } finally {
    env.LOCAL_DOCS_COM_PATH = originalLocalDocsPath;
  }
});

test("runSupportSearchAgent removes unsupported auxiliary claims without downgrading a supported core answer", async () => {
  const rootDir = await createFixtureRoot();
  const originalLocalDocsPath = env.LOCAL_DOCS_COM_PATH;
  env.LOCAL_DOCS_COM_PATH = rootDir;
  await writeFixture(
    rootDir,
    "open-docs/docs/openapi/api/issue-comment.info.mdx",
    `---
title: "Issue Comment"
---

# Issue Comment

write:project:issue-comment: Add, edit, delete issue comments
`
  );

  const adapter = createAdapter({
    writerAnswer: {
      direct_answer: "The required OAuth scope is `write:project:issue-comment`.",
      claims: [
        {
          text: "The required OAuth scope is `write:project:issue-comment`.",
          kind: "verified_fact",
          evidence_ids: [],
          authority: "canonical"
        }
      ],
      next_actions: [
        "Request an OAuth token with the `write:project:issue-comment` scope.",
        "Call the API with that token in the Authorization header."
      ]
    }
  });
  const originalVerify = adapter.verifySupportAnswer;
  adapter.verifySupportAnswer = async (input, idempotencyKey, runtime) => {
    const cited = [...input.evidenceBundle.primary, ...input.evidenceBundle.supplemental][0];
    const verifiedId = cited ? [resolveSearchReferenceEvidenceId(cited)] : [];
    return {
      ...(await originalVerify(input, idempotencyKey, runtime)),
      verdict: "partial",
      summary: "The core answer is supported, but the Authorization header detail is not explicitly shown.",
      unsupported_claims: ["Call the API with that token in the Authorization header."],
      verified_citation_ids: verifiedId,
      display_citation_ids: verifiedId,
      verified_claims: ["The required OAuth scope is `write:project:issue-comment`."],
      claim_to_citation_map: [
        {
          text: "The required OAuth scope is `write:project:issue-comment`.",
          kind: "verified_fact",
          verdict: "verified",
          citation_ids: verifiedId
        }
      ]
    };
  };

  try {
    const result = await runSupportSearchAgent({
      query: "What scope is required to create an issue comment via OpenAPI?",
      language: "en",
      currentRound: 0,
      conversationHistory: [],
      adapter,
      idempotencyKey: "support-agent-remove-unsupported-aux-claims"
    });

    assert.equal(result.result.support_answer?.mode, "grounded");
    assert.equal(result.result.verification?.verdict, "verified");
    assert.equal(
      result.result.support_answer?.what_to_do_now.some(
        (step) => /Request an OAuth token/i.test(step) && /write:project:issue-comment/.test(step)
      ),
      true
    );
    assert.equal(
      result.result.support_answer?.what_to_do_now.some((step) => /Authorization header/i.test(step)),
      false
    );
    assert.equal(result.result.unresolved_reason_code, null);
  } finally {
    env.LOCAL_DOCS_COM_PATH = originalLocalDocsPath;
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("runSupportSearchAgent uses fast multi-agent path for grounded how-to answers without retired citation selectors", async () => {
  const rootDir = await createFixtureRoot();
  const originalLocalDocsPath = env.LOCAL_DOCS_COM_PATH;
  env.LOCAL_DOCS_COM_PATH = rootDir;
  await writeFixture(
    rootDir,
    "docs/import-data-into-ones/rebuild-indexes-after-migration.mdx",
    `---
title: "Rebuild indexes after migration"
---

# Rebuild indexes after migration

1. Open the migration tool.
2. Run the rebuild indexes task.
3. Verify the latest indexing job completed successfully.
`
  );

  const adapter = createAdapter({
    routeOverride: {
      question_type: "how_to_product",
      specialist_agent: "howto-specialist"
    },
    writerAnswer: {
      direct_answer: "要重建索引，可以直接执行迁移工具里的 rebuild indexes 任务。",
      claims: [
        {
          text: "可以通过迁移工具执行 rebuild indexes 任务来重建索引。",
          kind: "verified_fact",
          evidence_ids: ["local:docs/import-data-into-ones/rebuild-indexes-after-migration.mdx:root"],
          authority: "canonical"
        }
      ],
      next_actions: ["执行 rebuild indexes。", "确认最新索引任务执行完成。"],
      unknowns: [],
      escalation_needed: false
    }
  });
  adapter.writeHowToSpecialistAnswer = async () => ({
    question_type: "how_to_product",
    render_variant: "how_to",
    direct_answer: "要重建索引，可以直接执行迁移工具里的 rebuild indexes 任务。",
    claims: [
      {
        text: "可以通过迁移工具执行 rebuild indexes 任务来重建索引。",
        kind: "verified_fact",
        evidence_ids: ["local:docs/import-data-into-ones/rebuild-indexes-after-migration.mdx:root"],
        authority: "canonical"
      }
    ],
    next_actions: ["执行 rebuild indexes。", "确认最新索引任务执行完成。"],
    steps: ["打开迁移工具。", "执行 rebuild indexes 任务。", "确认最新索引任务执行完成。"],
    unknowns: [],
    escalation_needed: false
  });
  let judgeCalled = false;
  let composeCalled = false;
  let curateCalled = false;
  let displaySelectorCalled = false;
  adapter.judgeSupportAnswer = async () => {
    judgeCalled = true;
    throw new Error("judge should be skipped in fast path");
  };
  adapter.composeCustomerAnswer = async () => {
    composeCalled = true;
    throw new Error("composer should be skipped in fast path");
  };
  adapter.curateSupportCitations = async () => {
    curateCalled = true;
    throw new Error("citation curator should be skipped in fast path");
  };
  adapter.selectDisplayCitations = async (input) => {
    displaySelectorCalled = true;
    return {
      display_citation_ids: Array.from(new Set(input.supportedClaims.flatMap((item) => item.citation_ids))).slice(0, 3)
    };
  };

  try {
    const result = await runSupportSearchAgent({
      query: "怎么重建索引",
      language: "zh",
      currentRound: 0,
      conversationHistory: [],
      adapter,
      idempotencyKey: "support-agent-fast-howto"
    });

    assert.equal(judgeCalled, false);
    assert.equal(composeCalled, false);
    assert.equal(curateCalled, false);
    assert.equal(displaySelectorCalled, false);
    assert.equal(result.result.support_answer?.render_variant, "how_to");
    assert.deepEqual(
      result.result.support_answer?.sections.map((section) => section.title),
      ["操作步骤"]
    );
    assert.equal(result.result.internal_diagnostics?.fast_path_used, true);
    assert.ok(result.result.answer.includes("重建索引"));
    assert.equal(result.result.references.length > 0, true);
    assert.equal(result.result.citations.length > 0, true);
  } finally {
    env.LOCAL_DOCS_COM_PATH = originalLocalDocsPath;
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("runSupportSearchAgent disables fast path for async job delivery and executes full verification/composition", async () => {
  const rootDir = await createFixtureRoot();
  const originalLocalDocsPath = env.LOCAL_DOCS_COM_PATH;
  env.LOCAL_DOCS_COM_PATH = rootDir;
  await writeFixture(
    rootDir,
    "docs/import-data-into-ones/rebuild-indexes-after-migration.mdx",
    `---
title: "Rebuild indexes after migration"
---

# Rebuild indexes after migration

1. Open the migration tool.
2. Run the rebuild indexes task.
3. Verify the latest indexing job completed successfully.
`
  );

  const adapter = createAdapter({
    routeOverride: {
      question_type: "how_to_product",
      specialist_agent: "howto-specialist"
    }
  });
  adapter.writeHowToSpecialistAnswer = async () => ({
    question_type: "how_to_product",
    render_variant: "how_to",
    direct_answer: "要重建索引，可以直接执行迁移工具里的 rebuild indexes 任务。",
    claims: [
      {
        text: "可以通过迁移工具执行 rebuild indexes 任务来重建索引。",
        kind: "verified_fact",
        evidence_ids: ["local:docs/import-data-into-ones/rebuild-indexes-after-migration.mdx:root"],
        authority: "canonical"
      }
    ],
    next_actions: ["执行 rebuild indexes。", "确认最新索引任务执行完成。"],
    steps: ["打开迁移工具。", "执行 rebuild indexes 任务。", "确认最新索引任务执行完成。"],
    unknowns: [],
    escalation_needed: false
  });
  let judgeCalled = false;
  let composeCalled = false;
  let curateCalled = false;
  let displaySelectorCalled = false;
  adapter.judgeSupportAnswer = async (input) => {
    judgeCalled = true;
    return {
      verdict: "verified",
      summary: "The rebuild-indexes procedure is documented.",
      unsupported_claims: [],
      missing_info: [],
      verified_citation_ids: input.evidenceBundle.primary.map((item) => resolveSearchReferenceEvidenceId(item)),
      display_citation_ids: input.evidenceBundle.primary.map((item) => resolveSearchReferenceEvidenceId(item)),
      verified_claims: ["可以通过迁移工具执行 rebuild indexes 任务来重建索引。"],
      claim_to_citation_map: [
        {
          text: "可以通过迁移工具执行 rebuild indexes 任务来重建索引。",
          kind: "verified_fact",
          verdict: "verified",
          citation_ids: input.evidenceBundle.primary.map((item) => resolveSearchReferenceEvidenceId(item))
        }
      ]
    };
  };
  adapter.composeCustomerAnswer = async (input) => {
    composeCalled = true;
    return {
      question_type: "how_to_product",
      render_variant: "how_to",
      direct_answer: input.supportedClaims[0]?.text ?? "",
      sections: [],
      why: [],
      what_to_do_now: input.nextActions,
      still_need_to_confirm: input.unknowns
    };
  };
  adapter.curateSupportCitations = async (input) => {
    curateCalled = true;
    return {
      display_citation_ids: Array.from(new Set(input.supportedClaims.flatMap((item) => item.citation_ids))).slice(0, 3)
    };
  };
  adapter.selectDisplayCitations = async () => {
    displaySelectorCalled = true;
    throw new Error("fast-path selector should not be used for async job delivery");
  };

  try {
    const result = await runSupportSearchAgent({
      query: "怎么重建索引",
      language: "zh",
      currentRound: 0,
      conversationHistory: [],
      adapter,
      idempotencyKey: "support-agent-async-job-no-fast-path",
      runtime: {
        deliveryMode: "async_job",
        overallTimeoutMs: 240000,
        requestStartedAtMs: Date.now()
      }
    });

    const stageTrace = result.result.internal_diagnostics?.stage_trace ?? [];
    assert.equal(result.result.internal_diagnostics?.fast_path_used, false);
    assert.equal(judgeCalled, true);
    assert.equal(composeCalled, false);
    assert.equal(curateCalled, false);
    assert.equal(displaySelectorCalled, false);
    assert.equal(stageTrace.find((item) => item.stage === "verification")?.status, "completed");
    assert.equal(stageTrace.find((item) => item.stage === "answer_composition")?.status, "completed");
    assert.match(result.result.answer, /rebuild indexes/);
  } finally {
    env.LOCAL_DOCS_COM_PATH = originalLocalDocsPath;
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("runSupportSearchAgent disables fast path when runtime tightening is enabled", async () => {
  const rootDir = await createFixtureRoot();
  const originalLocalDocsPath = env.LOCAL_DOCS_COM_PATH;
  const originalRuntimeTightening = env.FEATURE_SUPPORT_AGENT_RUNTIME_TIGHTENING;
  env.LOCAL_DOCS_COM_PATH = rootDir;
  env.FEATURE_SUPPORT_AGENT_RUNTIME_TIGHTENING = true;
  await writeFixture(
    rootDir,
    "docs/import-data-into-ones/rebuild-indexes-after-migration.mdx",
    `---
title: "Rebuild indexes after migration"
---

# Rebuild indexes after migration

1. Open the migration tool.
2. Run the rebuild indexes task.
3. Verify the latest indexing job completed successfully.
`
  );

  const adapter = createAdapter({
    routeOverride: {
      question_type: "how_to_product",
      specialist_agent: "howto-specialist"
    }
  });
  adapter.writeHowToSpecialistAnswer = async () => ({
    question_type: "how_to_product",
    render_variant: "how_to",
    direct_answer: "要重建索引，可以直接执行迁移工具里的 rebuild indexes 任务。",
    claims: [
      {
        text: "可以通过迁移工具执行 rebuild indexes 任务来重建索引。",
        kind: "verified_fact",
        evidence_ids: ["local:docs/import-data-into-ones/rebuild-indexes-after-migration.mdx:root"],
        authority: "canonical"
      }
    ],
    next_actions: ["执行 rebuild indexes。", "确认最新索引任务执行完成。"],
    steps: ["打开迁移工具。", "执行 rebuild indexes 任务。", "确认最新索引任务执行完成。"],
    unknowns: [],
    escalation_needed: false
  });
  let judgeCalled = false;
  let composeCalled = false;
  adapter.judgeSupportAnswer = async (input) => {
    judgeCalled = true;
    return {
      verdict: "verified",
      summary: "The rebuild-indexes procedure is documented.",
      unsupported_claims: [],
      missing_info: [],
      verified_citation_ids: input.evidenceBundle.primary.map((item) => resolveSearchReferenceEvidenceId(item)),
      display_citation_ids: input.evidenceBundle.primary.map((item) => resolveSearchReferenceEvidenceId(item)),
      verified_claims: ["可以通过迁移工具执行 rebuild indexes 任务来重建索引。"],
      claim_to_citation_map: [
        {
          text: "可以通过迁移工具执行 rebuild indexes 任务来重建索引。",
          kind: "verified_fact",
          verdict: "verified",
          citation_ids: input.evidenceBundle.primary.map((item) => resolveSearchReferenceEvidenceId(item))
        }
      ]
    };
  };
  adapter.composeCustomerAnswer = async (input) => {
    composeCalled = true;
    return {
      question_type: "how_to_product",
      render_variant: "how_to",
      direct_answer: input.supportedClaims[0]?.text ?? "",
      sections: [],
      why: [],
      what_to_do_now: input.nextActions,
      still_need_to_confirm: input.unknowns
    };
  };

  try {
    const result = await runSupportSearchAgent({
      query: "怎么重建索引",
      language: "zh",
      currentRound: 0,
      conversationHistory: [],
      adapter,
      idempotencyKey: "support-agent-tightened-no-fast-path",
      runtime: {
        overallTimeoutMs: 240000,
        requestStartedAtMs: Date.now()
      }
    });

    assert.equal(result.result.internal_diagnostics?.fast_path_used, false);
    assert.equal(judgeCalled, true);
    assert.equal(composeCalled, false);
    assert.match(result.result.answer, /rebuild indexes/);
  } finally {
    env.LOCAL_DOCS_COM_PATH = originalLocalDocsPath;
    env.FEATURE_SUPPORT_AGENT_RUNTIME_TIGHTENING = originalRuntimeTightening;
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("runSupportSearchAgent keeps API answers structurally organized in fast path fallback", async () => {
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

test("runSupportSearchAgent recovers the documented create-issue scope instead of drifting to sibling API scopes", async () => {
  const rootDir = await createFixtureRoot();
  const originalLocalDocsPath = env.LOCAL_DOCS_COM_PATH;
  env.LOCAL_DOCS_COM_PATH = rootDir;

  await writeFixture(
    rootDir,
    "open-docs/docs/openapi/api/create-a-issue.api.mdx",
    `---
title: "Create an issue"
---

# Create an issue

通过 POST /project/issues 创建工作项。
需要 OAuth scope: write:project:issue
`
  );

  await writeFixture(
    rootDir,
    "open-docs/docs/openapi/api/create-a-issue-comment.api.mdx",
    `---
title: "Create issue comment"
---

# Create issue comment

通过 POST /project/issues/{issueID}/comments 创建工作项评论。
需要 OAuth scope: write:project:issue-comment
`
  );

  await writeFixture(
    rootDir,
    "open-docs/docs/openapi/auth/scope.md",
    `# Scopes

## Issue

- write:project:issue: Add, edit, delete issues
- write:project:issue-comment: Add, edit, delete issue comments
`
  );

  const adapter = createAdapter({
    routeOverride: {
      question_type: "api_scope_auth",
      specialist_agent: "api-specialist",
      answer_contract: "Provide the exact API scope first."
    },
    evidencePlanOverride: {
      required_doc_kinds: ["openapi/api", "permissions"],
      retrieval_rounds: 2,
      allow_refinement: true,
      stop_after_grounded_evidence: false
    }
  });

  try {
    const result = await runSupportSearchAgent({
      query: "OpenAPI 创建 issue 需要哪些 scope？",
      language: "zh",
      currentRound: 0,
      conversationHistory: [],
      adapter,
      idempotencyKey: "support-agent-create-issue-scope-recovery"
    });

    assert.match(result.result.answer, /write:project:issue/);
    assert.doesNotMatch(result.result.answer, /write:project:issue-comment/);
    assert.equal(result.result.support_answer?.render_variant, "api");
    assert.equal(result.result.citations.length > 0, true);
  } finally {
    env.LOCAL_DOCS_COM_PATH = originalLocalDocsPath;
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("runSupportSearchAgent turns how-to evidence into direct actionable steps instead of doc navigation", async () => {
  const rootDir = await createFixtureRoot();
  const originalLocalDocsPath = env.LOCAL_DOCS_COM_PATH;
  env.LOCAL_DOCS_COM_PATH = rootDir;

  await writeFixture(
    rootDir,
    "deploy-docs/configure/ops/admin-password.cn.md",
    `---
title: "修改用户密码"
---

# 修改用户密码

## 操作步骤

#### 进入 ONES pod

\`\`\`shell
ones-ai-k8s.sh
\`\`\`

### 增加脚本

将以下内容保存为 shell 文件 \`reset-password.sh\`

\`\`\`shell
#!/bin/bash
echo "reset"
\`\`\`

### 使用脚本更新密码

执行以下命令

\`\`\`bash
bash reset-password.sh
\`\`\`

根据提示输入邮箱账号，然后脚本会自动重置密码并输出新密码。

注意：因为密码是固定的，记得提示用户修改密码。
`
  );

  const adapter = createAdapter({
    routeOverride: {
      question_type: "how_to_product",
      specialist_agent: "howto-specialist"
    }
  });

  try {
    const result = await runSupportSearchAgent({
      query: "私有部署环境怎么重置管理员密码？",
      language: "zh",
      currentRound: 0,
      conversationHistory: [],
      adapter,
      idempotencyKey: "support-agent-howto-actionable-output"
    });

    assert.notEqual(result.result.support_answer?.mode, "handoff");
    assert.equal(result.result.support_answer?.render_variant, "how_to");
    assert.match(result.result.answer, /ones-ai-k8s\.sh|reset-password\.sh|输入邮箱账号/);
    assert.doesNotMatch(result.result.answer, /按《|打开《|章节执行|section to follow|open the .* section/i);
    assert.ok((result.result.internal_diagnostics?.claim_graph ?? []).length > 0);
    assert.ok(result.result.citations.length > 0);
  } finally {
    env.LOCAL_DOCS_COM_PATH = originalLocalDocsPath;
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("runSupportSearchAgent realigns private deployment password recovery questions from behavior to how-to", async () => {
  const rootDir = await createFixtureRoot();
  const originalLocalDocsPath = env.LOCAL_DOCS_COM_PATH;
  env.LOCAL_DOCS_COM_PATH = rootDir;

  await writeFixture(
    rootDir,
    "deploy-docs/configure/ops/admin-password.cn.md",
    `---
title: "修改用户密码"
---

# 修改用户密码

适用于私有部署环境。

## 操作步骤

#### 进入 ONES pod

\`\`\`shell
ones-ai-k8s.sh
\`\`\`

### 使用脚本更新密码

执行以下命令

\`\`\`bash
bash reset-password.sh
\`\`\`

根据提示输入邮箱账号，然后脚本会自动重置密码并输出新密码。
`
  );

  const adapter = createAdapter({
    routeOverride: {
      question_type: "capability_confirmation",
      specialist_agent: "behavior-specialist",
      answer_contract: "Give the most likely explanation first."
    },
    queryPlan: {
      concept_queries: ["闭网 邮件不可用"],
      object_queries: ["管理员访问恢复"],
      behavior_queries: ["是否支持"]
    }
  });

  try {
    const result = await runSupportSearchAgent({
      query: "私有部署环境闭网且邮件不可用时，是否可以通过服务器或 OS 层直接重置管理员密码来恢复访问？",
      language: "zh",
      currentRound: 0,
      conversationHistory: [],
      adapter,
      idempotencyKey: "support-agent-private-deployment-route-realign"
    });

    assert.equal(result.caseFrame.deployment_model, "private_deployment");
    assert.equal(result.caseFrame.product_area, "deployment");
    assert.equal(result.caseFrame.question_type, "how_to_product");
    assert.equal(result.caseFrame.specialist_agent, "howto-specialist");
    assert.equal(result.result.support_answer?.render_variant, "how_to");
    assert.match(result.result.answer, /重置管理员密码|reset-password\.sh|ones-ai-k8s\.sh/);
  } finally {
    env.LOCAL_DOCS_COM_PATH = originalLocalDocsPath;
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("runSupportSearchAgent stabilizes API update questions onto OpenAPI evidence instead of generic docs", async () => {
  const rootDir = await createFixtureRoot();
  const originalLocalDocsPath = env.LOCAL_DOCS_COM_PATH;
  env.LOCAL_DOCS_COM_PATH = rootDir;

  await writeFixture(
    rootDir,
    "open-docs/docs/openapi/api/04-update-a-issue.api.mdx",
    `---
id: 04-update-a-issue
title: "Update a issue"
description: "Update a issue."
sidebar_label: "Update a issue"
---

# Update a issue

通过 PUT /project/issues/{issueID} 更新工作项。

可更新工作项标题、字段等信息。
`
  );

  await writeFixture(
    rootDir,
    "open-docs/docs/openapi/api/get-a-list-of-issue-status.api.mdx",
    `---
id: get-a-list-of-issue-status
title: "获取工作项状态列表"
---

# 获取工作项状态列表

通过 GET /project/issueStatuses 获取工作项状态列表。
`
  );

  await writeFixture(
    rootDir,
    "docs/ones-project/integrations/how-to-configure-multiple-integrations-ad-cas.mdx",
    `---
title: "如何配置多个集成?以 AD 和 CAS 为例"
description: "支持的版本+ 集成 AD 和 CAS 仅在本地部署版本中可用。"
slug: /admin/account-integration/start-to-account-integration/account-binding-or-unbinding
sidebarposition: 2
---

# 如何配置多个集成?以 AD 和 CAS 为例

支持的版本+ 集成 AD 和 CAS 仅在本地部署版本中可用。
在添加 CAS 页面选择账号绑定方式时，需要选择“自动绑定具有相同唯一标识符的同步源账号”。
`
  );

  const adapter = createAdapter({
    routeOverride: {
      question_type: "how_to_product",
      specialist_agent: "howto-specialist",
      answer_contract: "Give direct steps first."
    }
  });

  try {
    const result = await runSupportSearchAgent({
      query: "如何通过接口更新工作项及工作项状态？",
      language: "zh",
      currentRound: 0,
      conversationHistory: [],
      adapter,
      idempotencyKey: "support-agent-api-route-stabilization"
    });

    assert.equal(result.caseFrame.specialist_agent, "api-specialist");
    assert.match(String(result.caseFrame.question_type ?? ""), /^api_/);
    assert.equal(result.result.references.length > 0, true);
    assert.equal(String(result.result.references[0]?.supportMetadata?.product_area ?? ""), "openapi");
    assert.equal(String(result.result.references[0]?.supportMetadata?.evidence_kind ?? ""), "api_operation");
    assert.doesNotMatch(result.result.answer, /sidebarposition|slug:\s*\/admin\/account-integration|AD 和 CAS|本地部署版本中可用/i);
  } finally {
    env.LOCAL_DOCS_COM_PATH = originalLocalDocsPath;
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("runSupportSearchAgent keeps integration callback troubleshooting out of forced API auth routing", async () => {
  const rootDir = await createFixtureRoot();
  const originalLocalDocsPath = env.LOCAL_DOCS_COM_PATH;
  env.LOCAL_DOCS_COM_PATH = rootDir;

  await writeFixture(
    rootDir,
    "docs/ones-devops/code-integration/github-and-public-gitlab.mdx",
    `---
title: "GitHub 和公共 GitLab"
---

# GitHub 和公共 GitLab

## 链接仓库

如果授权完成后无法返回 ONES，或者回调页面显示 page not found，请检查 Redirect URI、Webhook 回调地址，以及 baseURL 配置是否一致。
`
  );

  await writeFixture(
    rootDir,
    "open-docs/docs/openapi/auth/scope.md",
    `# Scopes

## Scope list

- write:project:issue-comment
`
  );

  const adapter = createAdapter({
    routeOverride: {
      question_type: "api_scope_auth",
      specialist_agent: "api-specialist",
      answer_contract: "Provide the exact API answer first."
    }
  });

  try {
    const result = await runSupportSearchAgent({
      query: "GitHub 集成授权后回调页面显示 page not found，怎么排查？",
      language: "zh",
      currentRound: 0,
      conversationHistory: [],
      adapter,
      idempotencyKey: "support-agent-integration-callback-troubleshooting"
    });

    assert.equal(result.caseFrame.product_area, "integrations");
    assert.equal(result.caseFrame.question_type, "troubleshooting");
    assert.equal(result.caseFrame.specialist_agent, "troubleshooting-specialist");
    assert.equal(result.result.references.length > 0, true);
    assert.equal(String(result.result.references[0]?.supportMetadata?.product_area ?? ""), "integrations");
    assert.match(result.result.references[0]?.snippet ?? "", /Redirect URI|回调|page not found/i);
    assert.equal(result.result.support_answer?.render_variant, "troubleshooting");
  } finally {
    env.LOCAL_DOCS_COM_PATH = originalLocalDocsPath;
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("runSupportSearchAgent enforces a second retrieval round for api routes even when planner requests one round", async () => {
  const rootDir = await createFixtureRoot();
  const originalLocalDocsPath = env.LOCAL_DOCS_COM_PATH;
  env.LOCAL_DOCS_COM_PATH = rootDir;

  await writeFixture(
    rootDir,
    "open-docs/docs/openapi/api/04-update-a-issue.api.mdx",
    `---
id: 04-update-a-issue
title: "Update a issue"
---

# Update a issue

通过 PUT /project/issues/{issueID} 更新工作项字段。
`
  );

  const adapter = createAdapter({
    routeOverride: {
      question_type: "api_endpoint_lookup",
      specialist_agent: "api-specialist",
      answer_contract: "Provide the exact API answer first."
    },
    evidencePlanOverride: {
      retrieval_rounds: 1,
      allow_refinement: true
    }
  });

  try {
    const result = await runSupportSearchAgent({
      query: "如何通过接口更新工作项属性/状态？",
      language: "zh",
      currentRound: 0,
      conversationHistory: [],
      adapter,
      idempotencyKey: "support-agent-api-force-second-round"
    });

    assert.equal(result.stageTimings.retrieval_extra.status, "completed");
    assert.equal(result.result.references.length > 0, true);
    assert.match(result.result.answer, /PUT \/project\/issues\/\{issueID\}/);
  } finally {
    env.LOCAL_DOCS_COM_PATH = originalLocalDocsPath;
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("runSupportSearchAgent reclassifies self-hosted deployment architecture questions onto deployment evidence", async () => {
  const rootDir = await createFixtureRoot();
  const originalLocalDocsPath = env.LOCAL_DOCS_COM_PATH;
  env.LOCAL_DOCS_COM_PATH = rootDir;

  await writeFixture(
    rootDir,
    "docs/admin/account-integration/third-party-integration/azure-ad-and-ones.mdx",
    `---
id: azure-ad-and-ones
title: "Azure AD & ONES.com"
---

# Azure AD & ONES.com

Microsoft Azure AD integration is available only in ONES.com Cloud.
`
  );

  await writeFixture(
    rootDir,
    "deploy-docs/prepare/deployment-requirements.md",
    `# ONES 私有部署环境要求

ONES K3s single-node deployment uses a unified app plus storage topology by default.
Storage can also be externalized to NFS or OSS.
`
  );

  await writeFixture(
    rootDir,
    "deploy-docs/scaling/database/OceanBase-external.cn.md",
    `# OceanBase 外置

OceanBase can be used as an external database for ONES private deployment.
`
  );

  const adapter = createAdapter({
    routeOverride: {
      question_type: "capability_confirmation",
      specialist_agent: "behavior-specialist",
      answer_contract:
        "State whether requirements and issues are deployed on shared or separable backend services, databases, and query paths in self-hosted deployments."
    },
    evidencePlanOverride: {
      required_doc_kinds: ["openapi/api", "syntax_reference"]
    },
    writerAnswer: {
      question_type: "capability_confirmation",
      render_variant: "behavior",
      direct_answer: "",
      claims: [],
      next_actions: [],
      unknowns: [],
      escalation_needed: false
    } as Partial<SpecialistDraftAnswer>
  });

  try {
    const result = await runSupportSearchAgent({
      query:
        "Since we are considering a self-hosted deployment, can requirements and issues use isolated backend services, databases, and query paths?",
      language: "en",
      currentRound: 0,
      conversationHistory: [],
      adapter,
      idempotencyKey: "support-agent-self-hosted-architecture"
    });

    assert.equal(result.caseFrame.deployment_model, "private_deployment");
    assert.equal(result.caseFrame.product_area, "deployment");
    assert.ok(result.caseFrame.required_doc_kinds?.includes("deployment_runbook"));
    assert.ok(!(result.caseFrame.required_doc_kinds ?? []).includes("openapi/api"));
    assert.equal(result.result.references.length > 0, true);
    assert.equal(String(result.result.references[0]?.supportMetadata?.product_area ?? ""), "deployment");
    assert.equal(String(result.result.references[0]?.supportMetadata?.deployment_model ?? ""), "private_deployment");
    assert.doesNotMatch(result.result.references[0]?.title ?? "", /Azure AD|ONES\.com/i);
    assert.equal(result.result.support_answer?.mode === "partial" || result.result.support_answer?.mode === "grounded", true);
    assert.match(result.result.answer, /unified|colocated|externalized|cannot confirm/i);
    assert.equal(result.result.citations.length > 0, true);
  } finally {
    env.LOCAL_DOCS_COM_PATH = originalLocalDocsPath;
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("runSupportSearchAgent prioritizes update operations over status-list variants for composite API queries", async () => {
  const rootDir = await createFixtureRoot();
  const originalLocalDocsPath = env.LOCAL_DOCS_COM_PATH;
  env.LOCAL_DOCS_COM_PATH = rootDir;

  await writeFixture(
    rootDir,
    "open-docs/docs/openapi/api/04-update-a-issue.api.mdx",
    `---
id: 04-update-a-issue
title: "Update a issue"
---

# Update a issue

通过 PUT /project/issues/{issueID} 更新工作项。
可更新工作项标题、字段等信息。
`
  );

  await writeFixture(
    rootDir,
    "open-docs/docs/openapi/api/get-a-list-of-issue-status.api.mdx",
    `---
id: get-a-list-of-issue-status
title: "获取工作项状态列表"
---

# 获取工作项状态列表

通过 GET /project/issueStatuses 获取工作项状态列表。
`
  );

  const adapter = createAdapter({
    routeOverride: {
      question_type: "api_endpoint_lookup",
      specialist_agent: "api-specialist",
      answer_contract: "Provide the exact API answer first."
    },
    writerAnswer: {
      question_type: "api_endpoint_lookup",
      render_variant: "api",
      direct_answer: "",
      claims: [],
      next_actions: [],
      unknowns: [],
      escalation_needed: false
    } as Partial<SpecialistDraftAnswer>
  });

  try {
    const result = await runSupportSearchAgent({
      query: "如何通过接口更新工作项属性/状态？",
      language: "zh",
      currentRound: 0,
      conversationHistory: [],
      adapter,
      idempotencyKey: "support-agent-api-update-over-status-list"
    });

    assert.match(result.result.answer, /PUT \/project\/issues\/\{issueID\}/);
    assert.equal(result.result.support_answer?.render_variant, "api");
    assert.equal(result.result.support_answer?.sections[0]?.kind, "api_card");
    if (result.result.support_answer?.sections[0]?.kind === "api_card") {
      assert.equal(result.result.support_answer.sections[0].method, "PUT");
      assert.equal(result.result.support_answer.sections[0].path, "/project/issues/{issueID}");
    }
    assert.ok(result.result.references.some((reference) => /04-update-a-issue\.api\.mdx/.test(reference.path ?? "")));
    assert.match(result.result.citations[0]?.title ?? "", /Update a issue/i);
  } finally {
    env.LOCAL_DOCS_COM_PATH = originalLocalDocsPath;
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("runSupportSearchAgent uses AI stage budget to skip specialist and emit a claim graph", async () => {
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

The ONESQL syntax reference explicitly supports ORDER BY and GROUP BY clauses.
`
  );

  const adapter = createAdapter({
    routeOverride: {
      specialist_budget: 0
    },
    evidencePlanOverride: {
      retrieval_rounds: 1,
      allow_refinement: false,
      stop_after_grounded_evidence: true
    },
    verification: {
      verdict: "verified",
      unsupported_claims: [],
      missing_info: [],
      verified_citation_ids: [],
      display_citation_ids: [],
      verified_claims: ["The ONESQL syntax reference explicitly supports ORDER BY and GROUP BY clauses."],
      claim_to_citation_map: []
    }
  });
  adapter.verifySupportAnswer = async (input) => {
    const cited = [...input.evidenceBundle.primary, ...input.evidenceBundle.supplemental].find((item) =>
      /execute onesql query/i.test(item.title)
    );
    const verifiedId = cited ? [resolveSearchReferenceEvidenceId(cited)] : [];
    return {
      verdict: "verified",
      summary: "The cited ONESQL syntax page directly supports the answer.",
      unsupported_claims: [],
      missing_info: [],
      verified_citation_ids: verifiedId,
      display_citation_ids: verifiedId,
      verified_claims: ["The ONESQL syntax reference explicitly supports ORDER BY and GROUP BY clauses."],
      claim_to_citation_map: [
        {
          text: "The ONESQL syntax reference explicitly supports ORDER BY and GROUP BY clauses.",
          kind: "verified_fact",
          verdict: "verified",
          citation_ids: verifiedId
        }
      ]
    };
  };

  try {
    const result = await runSupportSearchAgent({
      query: "does ONESQL support ORDER BY and GROUP BY?",
      language: "en",
      currentRound: 0,
      conversationHistory: [],
      adapter,
      idempotencyKey: "support-agent-stage-budget-claim-graph"
    });

    const diagnostics = result.result.internal_diagnostics;
    assert.ok(diagnostics);
    const stageTrace = diagnostics.stage_trace ?? [];
    assert.equal(result.stageTimings.writer.status, "skipped");
    assert.equal(diagnostics.specialist_skipped, true);
    assert.equal(stageTrace.find((item) => item.stage === "specialist")?.status, "skipped");
    assert.equal(stageTrace.some((item) => item.stage === "generic_writer"), false);
    assert.deepEqual(diagnostics.stage_budget, {
      retrieval_rounds: 1,
      allow_refinement: false,
      stop_after_grounded_evidence: true,
      specialist_budget: 0
    });
    assert.deepEqual(diagnostics.claim_graph, [
      {
        text: "The ONESQL syntax reference explicitly supports ORDER BY and GROUP BY clauses.",
        kind: "verified_fact",
        verdict: "verified",
        citation_ids: result.result.citations.map((item) => item.id),
        has_citation: true
      }
    ]);
  } finally {
    env.LOCAL_DOCS_COM_PATH = originalLocalDocsPath;
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("runSupportSearchAgent keeps the route specialist active for async-job quality runs even when evidence is already grounded", async () => {
  const rootDir = await createFixtureRoot();
  const originalLocalDocsPath = env.LOCAL_DOCS_COM_PATH;
  env.LOCAL_DOCS_COM_PATH = rootDir;

  await writeFixture(
    rootDir,
    "deploy-docs/docs/installation/linux-server/requirements.mdx",
    `---
title: "Linux server requirements"
---

# Linux server requirements

ONES self-hosted deployment supports Ubuntu 18/20/24 and Red Hat 8+ for the server environment.
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
      stop_after_grounded_evidence: true
    },
    verification: {
      verdict: "verified",
      summary: "The Linux support statement is grounded in the deployment requirements page.",
      unsupported_claims: [],
      missing_info: [],
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
    }
  });
  let specialistCalled = false;
  adapter.writeBehaviorSpecialistAnswer = async () => {
    specialistCalled = true;
    return {
      question_type: "capability_confirmation",
      render_variant: "behavior",
      direct_answer: "当前文档明确支持 Ubuntu 18/20/24 与 Red Hat 8+ 作为 ONES 私有部署服务端 Linux 环境。",
      claims: [
        {
          text: "ONES 私有部署服务端支持 Ubuntu 18/20/24 与 Red Hat 8+。",
          kind: "verified_fact",
          evidence_ids: ["local:deploy-docs/docs/installation/linux-server/requirements.mdx:root"],
          authority: "canonical"
        }
      ],
      next_actions: ["如果你要做正式部署，优先按 Ubuntu 22.04 或 Red Hat 8+ 规划环境。"],
      unknowns: [],
      escalation_needed: false
    };
  };

  try {
    const result = await runSupportSearchAgent({
      query: "ONES 支持哪些 Linux 发行版？",
      language: "zh",
      currentRound: 0,
      conversationHistory: [],
      adapter,
      idempotencyKey: "support-agent-async-specialist-not-skipped",
      runtime: {
        deliveryMode: "async_job",
        overallTimeoutMs: 240000,
        requestStartedAtMs: Date.now()
      }
    });

    const stageTrace = result.result.internal_diagnostics?.stage_trace ?? [];
    assert.equal(specialistCalled, true);
    assert.equal(stageTrace.find((item) => item.stage === "specialist")?.status, "completed");
    assert.match(result.result.answer, /Ubuntu 18\/20\/24.*Red Hat 8\+/);
  } finally {
    env.LOCAL_DOCS_COM_PATH = originalLocalDocsPath;
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("runSupportSearchAgent preserves a grounded specialist answer when downstream judge and citation stages fall back", async () => {
  const rootDir = await createFixtureRoot();
  const originalLocalDocsPath = env.LOCAL_DOCS_COM_PATH;
  env.LOCAL_DOCS_COM_PATH = rootDir;

  await writeFixture(
    rootDir,
    "deploy-docs/docs/installation/linux-server/requirements.mdx",
    `---
title: "Linux server requirements"
---

# Linux server requirements

ONES self-hosted deployment supports Ubuntu 18/20/24 and Red Hat 8+ for the server environment.
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
      stop_after_grounded_evidence: true
    }
  });
  adapter.writeBehaviorSpecialistAnswer = async () => ({
    question_type: "capability_confirmation",
    render_variant: "behavior",
    direct_answer: "当前文档明确支持 Ubuntu 18/20/24 与 Red Hat 8+ 作为 ONES 私有部署服务端 Linux 环境。",
    claims: [
      {
        text: "ONES 私有部署服务端支持 Ubuntu 18/20/24 与 Red Hat 8+。",
        kind: "verified_fact",
        evidence_ids: ["local:deploy-docs/docs/installation/linux-server/requirements.mdx:root"],
        authority: "canonical"
      }
    ],
    next_actions: ["正式部署优先按 Ubuntu 22.04 或 Red Hat 8+ 规划环境。"],
    unknowns: [],
    escalation_needed: false
  });
  adapter.judgeSupportAnswer = async () => {
    throw new Error("judge timeout");
  };
  adapter.bindSupportCitations = async () => {
    throw new Error("citation binder timeout");
  };
  adapter.curateSupportCitations = async () => {
    throw new Error("citation curator timeout");
  };
  adapter.composeCustomerAnswer = async () => {
    throw new Error("answer composer timeout");
  };

  try {
    const result = await runSupportSearchAgent({
      query: "ONES 支持哪些 Linux 发行版？",
      language: "zh",
      currentRound: 0,
      conversationHistory: [],
      adapter,
      idempotencyKey: "support-agent-preserve-specialist-answer-on-downstream-fallback",
      runtime: {
        deliveryMode: "async_job",
        overallTimeoutMs: 240000,
        requestStartedAtMs: Date.now()
      }
    });

    assert.match(result.result.answer, /Ubuntu 18\/20\/24.*Red Hat 8\+/);
    assert.equal(result.result.support_answer?.mode, "grounded");
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
title: "Linux server requirements"
---

# Linux server requirements

ONES self-hosted deployment supports Ubuntu 18/20/24 and Red Hat 8+ for the server environment.
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

  try {
    const result = await runSupportSearchAgent({
      query: "ONES 支持哪些 Linux 发行版？",
      language: "zh",
      currentRound: 0,
      conversationHistory: [],
      adapter,
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

test("runSupportSearchAgent recovers a grounded capability answer from deployment requirements evidence when behavior drafts are generic", async () => {
  const rootDir = await createFixtureRoot();
  const originalLocalDocsPath = env.LOCAL_DOCS_COM_PATH;
  env.LOCAL_DOCS_COM_PATH = rootDir;

  await writeFixture(
    rootDir,
    "deploy-docs/docs/installation/linux-server/requirements.mdx",
    `---
title: "Linux server requirements"
---

# Linux server requirements

ONES self-hosted deployment supports Ubuntu 18/20/24 and Red Hat 8+ for the server environment.
Recommended: Ubuntu 22.04 Server.
`
  );

  const adapter = createAdapter({
    routeOverride: {
      question_type: "capability_confirmation",
      specialist_agent: "behavior-specialist",
      answer_contract: "State the supported Linux distributions first."
    },
    evidencePlanOverride: {
      required_doc_kinds: ["deployment_runbook", "product_guide", "rules"],
      retrieval_rounds: 1,
      allow_refinement: false
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

  try {
    const result = await runSupportSearchAgent({
      query: "ONES 支持哪些 Linux 发行版？",
      language: "zh",
      currentRound: 0,
      conversationHistory: [],
      adapter,
      idempotencyKey: "support-agent-capability-salvage-linux-support"
    });

    assert.match(result.result.answer, /Ubuntu 18\/20\/24.*Red Hat 8\+/);
    assert.equal(result.result.support_answer?.mode, "grounded");
    assert.equal(result.result.citations.length > 0, true);
    assert.match(result.result.citations[0]?.title ?? "", /Linux server requirements/i);
  } finally {
    env.LOCAL_DOCS_COM_PATH = originalLocalDocsPath;
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("runSupportSearchAgent prefers object-specific requirements evidence over generic deployment introductions for capability salvage", async () => {
  const rootDir = await createFixtureRoot();
  const originalLocalDocsPath = env.LOCAL_DOCS_COM_PATH;
  env.LOCAL_DOCS_COM_PATH = rootDir;

  await writeFixture(
    rootDir,
    "deploy-docs/prepare/deployment-flow.md",
    `---
title: "ONES 私有部署说明"
---

# ONES 私有部署说明

本文描述在私有部署 ONES(K3s版本)前所需准备的系统环境要求，可配合部署说明阅读。
`
  );

  await writeFixture(
    rootDir,
    "deploy-docs/prepare/deployment-requirements.md",
    `---
title: "ONES 私有部署环境要求"
---

# ONES 私有部署环境要求

## 操作系统要求

只支持 Linux 4.* 以上内核的操作系统，最佳实践为 Ubuntu 22.04 server，支持 64 位 Ubuntu 18/20/24、64 位 Red Hat 8.0 及以上，不再支持 CentOS 7 系列。
`
  );

  const adapter = createAdapter({
    routeOverride: {
      question_type: "capability_confirmation",
      specialist_agent: "behavior-specialist",
      answer_contract: "State the supported Linux distributions first."
    },
    evidencePlanOverride: {
      required_doc_kinds: ["deployment_runbook", "product_guide", "rules"],
      retrieval_rounds: 2,
      allow_refinement: true
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
    retrieval_queries: ["ONES Linux 发行版 支持", "ONES 部署环境 Linux 要求", "操作系统要求"],
    query_plan: {
      concept_queries: ["supported operating systems", "deployment requirements"],
      object_queries: ["linux distributions", "Ubuntu Red Hat CentOS"],
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

  try {
    const result = await runSupportSearchAgent({
      query: "ONES 支持哪些 Linux 发行版？",
      language: "zh",
      currentRound: 0,
      conversationHistory: [],
      adapter,
      idempotencyKey: "support-agent-capability-salvage-specificity"
    });

    assert.match(result.result.answer, /Ubuntu 18\/20\/24.*Red Hat 8/);
    assert.doesNotMatch(result.result.answer, /可配合部署说明阅读/);
    assert.equal(result.result.support_answer?.mode, "grounded");
  } finally {
    env.LOCAL_DOCS_COM_PATH = originalLocalDocsPath;
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("runSupportSearchAgent canonicalizes planner capability routes onto the behavior specialist", async () => {
  const rootDir = await createFixtureRoot();
  const originalLocalDocsPath = env.LOCAL_DOCS_COM_PATH;
  env.LOCAL_DOCS_COM_PATH = rootDir;

  await writeFixture(
    rootDir,
    "deploy-docs/prepare/deployment-requirements.md",
    `---
title: "ONES 私有部署环境要求"
---

# ONES 私有部署环境要求

## 操作系统要求

**（1）操作系统**：只支持Linux 4.* 以上内核的操作系统，最佳实践为Ubuntu 22.04 server，支持64位 Ubuntu 18/20/24、64位Red Hat 8.0及以上等操作系统；不再支持Centos7系列。
`
  );

  const adapter = createAdapter({});
  adapter.planSupportExecution = async () => ({
    route: {
      question_type: "capability_confirmation",
      user_goal: "确认 ONES 支持哪些 Linux 发行版",
      answer_contract: "基于官方文档给出受支持的 Linux 发行版清单，并注明适用范围与版本限制。",
      specialist_agent: "howto-specialist",
      routing_confidence: 0.96
    },
    caseFrame: {
      goal: "确认 ONES 官方支持的 Linux 发行版范围",
      symptom: "用户需要在部署前确认可用的 Linux 系统发行版",
      object: "ONES 私有部署运行环境中的 Linux 发行版支持列表",
      action_type: "capability_confirmation",
      deployment_model: "private_deployment",
      product_area: "deployment_environment",
      constraints: [],
      missing_critical_info: [],
      retrieval_queries: ["ONES Linux 发行版 支持 私有部署"],
      query_plan: {
        concept_queries: ["ONES 私有部署 系统要求 操作系统"],
        object_queries: ["ONES 支持的 Linux 发行版"],
        behavior_queries: ["ONES 安装环境要求 Linux 版本"]
      },
      question_type: "capability_confirmation",
      specialist_agent: "howto-specialist",
      answer_contract: "基于官方文档给出受支持的 Linux 发行版清单，并注明适用范围与版本限制。",
      routing_confidence: 0.96,
      required_doc_kinds: ["product_guide", "rules"]
    },
    evidencePlan: {
      query_plan: {
        concept_queries: ["ONES 私有部署 系统要求 操作系统"],
        object_queries: ["ONES 支持的 Linux 发行版"],
        behavior_queries: ["ONES 安装环境要求 Linux 版本"]
      },
      evidence_priority: ["系统要求/环境要求", "部署文档"],
      required_doc_kinds: ["product_guide", "rules"],
      retrieval_rounds: 1,
      allow_refinement: false,
      stop_after_grounded_evidence: true
    }
  });

  let behaviorCalled = false;
  let howtoCalled = false;
  adapter.writeBehaviorSpecialistAnswer = async () => {
    behaviorCalled = true;
    return {
      question_type: "capability_confirmation",
      render_variant: "behavior",
      direct_answer: "I still need one critical detail before I can give a verified answer.",
      claims: [],
      next_actions: [],
      unknowns: [],
      escalation_needed: false
    };
  };
  adapter.writeHowToSpecialistAnswer = async () => {
    howtoCalled = true;
    return {
      question_type: "how_to_product",
      render_variant: "how_to",
      direct_answer: "可以先按部署步骤处理。",
      claims: [],
      next_actions: [],
      unknowns: [],
      escalation_needed: false
    };
  };

  try {
    const result = await runSupportSearchAgent({
      query: "ONES 支持哪些 Linux 发行版？",
      language: "zh",
      currentRound: 0,
      conversationHistory: [],
      adapter,
      idempotencyKey: "support-agent-canonicalize-capability-specialist",
      runtime: {
        deliveryMode: "async_job",
        overallTimeoutMs: 240000,
        requestStartedAtMs: Date.now()
      }
    });

    assert.equal(behaviorCalled, true);
    assert.equal(howtoCalled, false);
    assert.deepEqual(result.result.internal_diagnostics?.specialists_used, ["behavior-specialist"]);
    assert.match(result.result.answer, /Ubuntu 18\/20\/24.*Red Hat 8/);
    assert.equal(result.result.support_answer?.mode, "grounded");
  } finally {
    env.LOCAL_DOCS_COM_PATH = originalLocalDocsPath;
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("runSupportSearchAgent grounds free-form planner deployment taxonomy instead of tripping strict policy fallback", async () => {
  const rootDir = await createFixtureRoot();
  const originalLocalDocsPath = env.LOCAL_DOCS_COM_PATH;
  env.LOCAL_DOCS_COM_PATH = rootDir;

  await writeFixture(
    rootDir,
    "deploy-docs/prepare/deployment-requirements.md",
    `---
title: "ONES 私有部署环境要求"
---

# ONES 私有部署环境要求

## 操作系统要求

只支持 Linux 4.* 以上内核的操作系统，最佳实践为 Ubuntu 22.04 server，支持 64 位 Ubuntu 18/20/24、64 位 Red Hat 8.0 及以上，不再支持 CentOS 7 系列。
`
  );

  const adapter = createAdapter({});
  adapter.planSupportExecution = async () => ({
    route: {
      question_type: "capability_confirmation",
      user_goal: "确认 ONES 支持的 Linux 发行版范围",
      answer_contract: "基于官方文档给出受支持的 Linux 发行版清单，并注明版本范围、安装/部署前提及是否区分服务端与客户端支持。",
      specialist_agent: "behavior-specialist",
      routing_confidence: 0.95
    },
    caseFrame: {
      goal: "确认 ONES 支持哪些 Linux 发行版",
      symptom: "用户需要了解 ONES 的 Linux 兼容性/支持范围",
      object: "Linux 发行版支持列表",
      action_type: "support_matrix_lookup",
      deployment_model: "private_deployment",
      product_area: "部署安装与系统兼容性",
      constraints: [
        "需要以官方文档中的兼容性/环境要求为准",
        "优先查找安装部署、系统要求、支持矩阵类文档",
        "需要区分是否为服务端部署支持，而非泛指浏览器访问端"
      ],
      missing_critical_info: [],
      retrieval_queries: [
        "ONES Linux 发行版 支持",
        "ONES 部署环境 Linux 要求",
        "ONES 安装 文档 操作系统 支持"
      ],
      query_plan: {
        concept_queries: ["兼容性要求 操作系统 支持矩阵", "部署环境 前置条件 系统要求"],
        object_queries: ["Linux 发行版", "私有部署 服务端 操作系统"],
        behavior_queries: ["支持哪些发行版", "最低版本/推荐版本"]
      },
      question_type: "capability_confirmation",
      specialist_agent: "behavior-specialist",
      answer_contract: "基于官方文档给出受支持的 Linux 发行版清单，并注明版本范围、安装/部署前提及是否区分服务端与客户端支持。",
      routing_confidence: 0.95,
      required_doc_kinds: ["产品部署文档", "安装指南", "系统要求/环境要求", "兼容性或支持矩阵"]
    },
    evidencePlan: {
      query_plan: {
        concept_queries: ["兼容性要求 操作系统 支持矩阵", "部署环境 前置条件 系统要求"],
        object_queries: ["Linux 发行版", "私有部署 服务端 操作系统"],
        behavior_queries: ["支持哪些发行版", "最低版本/推荐版本"]
      },
      evidence_priority: ["官方部署安装文档中的系统要求章节", "官方兼容性/支持矩阵文档"],
      required_doc_kinds: ["产品部署文档", "安装指南", "系统要求/环境要求", "兼容性或支持矩阵"],
      retrieval_rounds: 2,
      allow_refinement: true,
      stop_after_grounded_evidence: true
    }
  });

  adapter.writeBehaviorSpecialistAnswer = async () => ({
    question_type: "capability_confirmation",
    render_variant: "behavior",
    direct_answer: "现有文档已说明受支持的 Linux 发行版范围。",
    claims: [
      {
        text: "ONES 私有部署支持 Ubuntu 18/20/24 和 Red Hat 8.0 及以上，不再支持 CentOS 7。",
        kind: "verified_fact",
        evidence_ids: [],
        authority: "canonical"
      }
    ],
    next_actions: ["部署前确认服务器操作系统版本。"],
    unknowns: [],
    escalation_needed: false
  });

  try {
    const result = await runSupportSearchAgent({
      query: "ONES 支持哪些 Linux 发行版？",
      language: "zh",
      currentRound: 0,
      conversationHistory: [],
      adapter,
      idempotencyKey: "support-agent-live-taxonomy-normalization",
      runtime: {
        deliveryMode: "async_job",
        overallTimeoutMs: 240000,
        requestStartedAtMs: Date.now()
      }
    });

    assert.equal(result.result.retrieval_status, "grounded");
    assert.equal(result.result.unresolved_reason_code, null);
    assert.equal(result.caseFrame.product_area, "deployment");
    assert.match(result.result.answer, /Ubuntu 18\/20\/24.*Red Hat 8/);
    assert.equal(result.result.references.length > 0, true);
    assert.equal(String(result.result.references[0]?.supportMetadata?.product_area ?? ""), "deployment");
  } finally {
    env.LOCAL_DOCS_COM_PATH = originalLocalDocsPath;
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("runSupportSearchAgent recovers a grounded capability answer for product availability questions when behavior drafts are generic", async () => {
  const rootDir = await createFixtureRoot();
  const originalLocalDocsPath = env.LOCAL_DOCS_COM_PATH;
  env.LOCAL_DOCS_COM_PATH = rootDir;

  await writeFixture(
    rootDir,
    "docs/admin/account-integration/third-party-integration/azure-ad-and-ones.mdx",
    `---
title: "Azure AD & ONES.com"
---

# Azure AD & ONES.com

Microsoft Azure AD integration is available only in ONES.com Cloud.
`
  );

  const adapter = createAdapter({
    routeOverride: {
      question_type: "capability_confirmation",
      specialist_agent: "behavior-specialist",
      answer_contract: "State the documented product availability first."
    },
    evidencePlanOverride: {
      required_doc_kinds: ["product_guide", "rules"],
      retrieval_rounds: 1,
      allow_refinement: false
    }
  });
  adapter.planSupportCase = async (input) => ({
    goal: input.query,
    symptom: input.query,
    object: "Azure AD integration",
    action_type: "capability_confirmation",
    deployment_model: "private_deployment",
    product_area: "integrations",
    constraints: [],
    missing_critical_info: [],
    retrieval_queries: ["Azure AD integration", "ONES.com Cloud", "private deployment"],
    query_plan: {
      concept_queries: ["Azure AD integration", "product availability"],
      object_queries: ["Azure AD integration", "ONES.com Cloud"],
      behavior_queries: ["available only", "supported"]
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

  try {
    const result = await runSupportSearchAgent({
      query: "私有部署支持 Azure AD 集成吗？",
      language: "zh",
      currentRound: 0,
      conversationHistory: [],
      adapter,
      idempotencyKey: "support-agent-capability-salvage-product-availability"
    });

    assert.match(result.result.answer, /Azure AD.*ONES\.com Cloud/);
    assert.ok(["grounded", "partial"].includes(String(result.result.support_answer?.mode ?? "")));
    assert.equal(result.result.citations.length > 0, true);
    assert.match(result.result.citations[0]?.title ?? "", /Azure AD & ONES\.com/i);
  } finally {
    env.LOCAL_DOCS_COM_PATH = originalLocalDocsPath;
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("runSupportSearchAgent omits retired selector stages from the live orchestration trace", async () => {
  const adapter = createAdapter({
    verification: {
      verdict: "unsupported",
      missing_info: ["the exact object or scenario"]
    }
  });

  const result = await runSupportSearchAgent({
    query: "which scope is needed to create an issue comment",
    language: "en",
    currentRound: 0,
    conversationHistory: [],
    adapter,
    idempotencyKey: "support-agent-selector-stage-trace"
  });

  const trace = result.result.internal_diagnostics?.orchestration_trace ?? [];
  assert.equal(trace.some((item) => item.stage === "support-evidence-selector"), false);
});

test("AI topology excludes retired citation post-processing stages from the live support runtime", () => {
  const topology = getAiTopology();
  assert.equal(topology.supportStages.stages.some((stage) => stage.stage === "support-citation-binder"), false);
  assert.equal(topology.supportStages.stages.some((stage) => stage.stage === "citation-curator"), false);
  assert.equal(topology.supportStages.stages.some((stage) => stage.stage === "support-citation-selector"), false);
});

test("AI topology only exposes support-main when single-agent runtime is enabled or explicitly configured", () => {
  const mutableEnv = env as {
    FEATURE_SUPPORT_AGENT_SINGLE_AGENT_RUNTIME?: boolean;
    OPENCLAW_AGENT_ID_SUPPORT_MAIN?: string;
  };
  const originalSingleAgentRuntime = mutableEnv.FEATURE_SUPPORT_AGENT_SINGLE_AGENT_RUNTIME;
  const originalSupportMainAgentId = mutableEnv.OPENCLAW_AGENT_ID_SUPPORT_MAIN;

  try {
    mutableEnv.FEATURE_SUPPORT_AGENT_SINGLE_AGENT_RUNTIME = false;
    mutableEnv.OPENCLAW_AGENT_ID_SUPPORT_MAIN = "";

    const defaultTopology = getAiTopology();
    assert.equal(defaultTopology.supportStages.stages.some((stage) => stage.stage === "support-main"), false);

    mutableEnv.OPENCLAW_AGENT_ID_SUPPORT_MAIN = "support-main";
    const explicitBindingTopology = getAiTopology();
    assert.equal(explicitBindingTopology.supportStages.stages.some((stage) => stage.stage === "support-main"), true);

    mutableEnv.OPENCLAW_AGENT_ID_SUPPORT_MAIN = "";
    mutableEnv.FEATURE_SUPPORT_AGENT_SINGLE_AGENT_RUNTIME = true;
    const singleAgentTopology = getAiTopology();
    assert.equal(singleAgentTopology.supportStages.stages.some((stage) => stage.stage === "support-main"), true);
  } finally {
    mutableEnv.FEATURE_SUPPORT_AGENT_SINGLE_AGENT_RUNTIME = originalSingleAgentRuntime;
    mutableEnv.OPENCLAW_AGENT_ID_SUPPORT_MAIN = originalSupportMainAgentId;
  }
});

test("AI runtime readiness for supervisor-domain checks only active planner and specialist agents", () => {
  const topology = getAiTopology();
  const executionAgentId = topology.searchStages.find((stage) => stage.stage === "execution")?.agentId ?? "";
  const readiness = getAiRuntimeReadinessProfile({
    supervisorDomainAvailable: true,
    supportMainAvailable: true,
    customerAnswerComposerAvailable: true
  });

  assert.equal(readiness.requiredAgents.includes("search-retrieval"), true);
  assert.equal(readiness.requiredAgents.includes("search-clarify"), true);
  assert.equal(readiness.requiredAgents.includes(executionAgentId), true);
  assert.equal(readiness.requiredAgents.includes("support-planner"), true);
  assert.equal(readiness.requiredAgents.includes("support-api-specialist"), true);
  assert.equal(readiness.requiredAgents.includes("support-howto-specialist"), true);
  assert.equal(readiness.requiredAgents.includes("support-behavior-specialist"), true);
  assert.equal(readiness.requiredAgents.includes("support-troubleshooting-specialist"), true);
  assert.equal(readiness.requiredAgents.includes("support-router"), false);
  assert.equal(readiness.requiredAgents.includes("support-evidence-planner"), false);
  assert.equal(readiness.requiredAgents.includes("support-evidence-judge"), false);
  assert.equal(readiness.requiredAgents.includes("support-answer-composer"), false);
  assert.equal(readiness.requiredAgents.includes("support-main"), false);
});

test("retired support-citation-binder still resolves to the stage-level fallback when explicitly addressed", () => {
  const binding = resolveStageSpecificAgent("support-citation-binder");

  assert.equal(binding.agentId, "support-citation-curator");
});

test("runSupportSearchAgent recovers grounded API field claims from project list evidence when specialist claims are empty", async () => {
  const rootDir = await createFixtureRoot();
  const originalLocalDocsPath = env.LOCAL_DOCS_COM_PATH;
  env.LOCAL_DOCS_COM_PATH = rootDir;

  await writeFixture(
    rootDir,
    "i18n/zh-Hans/docusaurus-plugin-content-docs-open-docs/current/openapi/api/get-team-projects.api.mdx",
    `---
title: "获取团队下项目列表"
---

<MethodEndpoint
  method={"get"}
  path={"/project/projects"}
>
</MethodEndpoint>

<ParamsItem param={{"name":"teamID","in":"query","description":"团队ID","required":true,"schema":{"type":"string"}}} />

<SchemaItem
  collapsible={false}
  name={"id"}
  required={false}
  schemaName={"string"}
  schema={{"type":"string","description":"项目ID"}}
>
</SchemaItem>
`
  );

  const adapter = createAdapter({
    routeOverride: {
      question_type: "api_field_lookup",
      specialist_agent: "api-specialist"
    }
  });

  try {
    const result = await runSupportSearchAgent({
      query: "获取项目列表的API怎样拿到项目标识？",
      language: "zh",
      currentRound: 0,
      conversationHistory: [],
      adapter,
      idempotencyKey: "support-agent-project-id-recovery"
    });

    assert.notEqual(result.result.support_answer?.mode, "handoff");
    assert.match(result.result.answer, /GET \/project\/projects/);
    assert.match(result.result.answer, /项目ID|字段 id/i);
    assert.ok((result.result.internal_diagnostics?.claim_graph ?? []).length > 0);
    assert.ok(result.result.citations.length >= 1);
  } finally {
    env.LOCAL_DOCS_COM_PATH = originalLocalDocsPath;
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("runSupportSearchAgent recovers grounded API option facts from field options evidence when specialist claims are empty", async () => {
  const rootDir = await createFixtureRoot();
  const originalLocalDocsPath = env.LOCAL_DOCS_COM_PATH;
  env.LOCAL_DOCS_COM_PATH = rootDir;

  await writeFixture(
    rootDir,
    "i18n/zh-Hans/docusaurus-plugin-content-docs-open-docs/current/openapi/api/get-field-options.api.mdx",
    `---
title: "获取属性选项"
---

<MethodEndpoint
  method={"post"}
  path={"/field/options"}
>
</MethodEndpoint>

- 获取成员列表：返回包含 uuid、name、avatar 的用户信息
- 获取项目列表：返回包含 uuid、name、status 的项目信息

<SchemaItem
  collapsible={false}
  name={"field_uuid"}
  required={true}
  schemaName={"string"}
  schema={{"type":"string","description":"属性UUID"}}
>
</SchemaItem>
`
  );

  const adapter = createAdapter({
    routeOverride: {
      question_type: "api_field_lookup",
      specialist_agent: "api-specialist"
    }
  });

  try {
    const result = await runSupportSearchAgent({
      query: "哪个接口可以获取负责人的选项值",
      language: "zh",
      currentRound: 0,
      conversationHistory: [],
      adapter,
      idempotencyKey: "support-agent-field-options-recovery"
    });

    assert.notEqual(result.result.support_answer?.mode, "handoff");
    assert.match(result.result.answer, /POST \/field\/options/);
    assert.match(result.result.answer, /uuid|name|avatar/i);
    assert.ok((result.result.internal_diagnostics?.claim_graph ?? []).length > 0);
    assert.ok(result.result.citations.length >= 1);
  } finally {
    env.LOCAL_DOCS_COM_PATH = originalLocalDocsPath;
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("runSupportSearchAgent only displays claim-linked citations even when unrelated references are retrieved", async () => {
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
  await writeFixture(
    rootDir,
    "docs/admin/set-up-your-team/advanced-settings/notes-for-modifying-the-baseurl.mdx",
    `---
title: "Notes for modifying the baseURL"
---

# Notes for modifying the baseURL

This note mentions ONESQL ORDER BY GROUP BY only as unrelated glossary text.
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
    }
  });
  const originalVerify = adapter.verifySupportAnswer;
  adapter.verifySupportAnswer = async (input, idempotencyKey, runtime) => {
    const cited = [...input.evidenceBundle.primary, ...input.evidenceBundle.supplemental].find((item) =>
      /execute onesql query/i.test(item.title)
    );
    const verifiedId = cited ? [resolveSearchReferenceEvidenceId(cited)] : [];
    return {
      ...(await originalVerify(input, idempotencyKey, runtime)),
      verdict: "verified",
      unsupported_claims: [],
      missing_info: [],
      verified_citation_ids: verifiedId,
      display_citation_ids: verifiedId,
      verified_claims: ["ONESQL supports ORDER BY and GROUP BY in the query syntax."],
      claim_to_citation_map: [
        {
          text: "ONESQL supports ORDER BY and GROUP BY in the query syntax.",
          kind: "verified_fact",
          verdict: "verified",
          citation_ids: verifiedId
        }
      ]
    };
  };

  try {
    const result = await runSupportSearchAgent({
      query: "does ONESQL support ORDER BY and GROUP BY?",
      language: "en",
      currentRound: 0,
      conversationHistory: [],
      adapter,
      idempotencyKey: "support-agent-claim-linked-citations"
    });

    assert.equal(result.result.references.length >= 1, true);
    assert.equal(result.result.citations.length, 1);
    assert.match(result.result.citations[0].title, /Execute ONESQL query/i);
    assert.doesNotMatch(result.result.citations[0].title, /baseURL/i);
  } finally {
    env.LOCAL_DOCS_COM_PATH = originalLocalDocsPath;
    await rm(rootDir, { recursive: true, force: true });
  }
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

    assert.equal(result.result.citations.length, 0);
    assert.notEqual(result.result.support_answer?.mode, "grounded");
  } finally {
    env.LOCAL_DOCS_COM_PATH = originalLocalDocsPath;
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("runSupportSearchAgent rewrites partial direct answer from surviving claims instead of raw writer draft", async () => {
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

The retrieved OpenAPI reference explicitly mentions ORDER BY and GROUP BY in the ONESQL query syntax.
`
  );

  const adapter = createAdapter({
    writerAnswer: {
      direct_answer: "ONESQL definitely supports ORDER BY everywhere and the UI should always rewrite Group By into the query text.",
      claims: [
        {
          text: "The retrieved OpenAPI reference explicitly mentions ORDER BY and GROUP BY in the ONESQL query syntax.",
          kind: "verified_fact",
          evidence_ids: [],
          authority: "canonical"
        },
        {
          text: "The UI should always rewrite Group By into the query text.",
          kind: "verified_fact",
          evidence_ids: [],
          authority: "canonical"
        }
      ]
    }
  });
  adapter.verifySupportAnswer = async (input) => {
    const cited = [...input.evidenceBundle.primary, ...input.evidenceBundle.supplemental][0];
    const verifiedId = cited ? [resolveSearchReferenceEvidenceId(cited)] : [];
    return {
      verdict: "partial",
      summary: "Only the syntax-reference claim is supported.",
      unsupported_claims: ["The UI should always rewrite Group By into the query text."],
      missing_info: ["whether the UI is expected to rewrite grouped builder settings into text"],
      verified_citation_ids: verifiedId,
      display_citation_ids: verifiedId,
      verified_claims: ["The retrieved OpenAPI reference explicitly mentions ORDER BY and GROUP BY in the ONESQL query syntax."],
      claim_to_citation_map: [
        {
          text: "The retrieved OpenAPI reference explicitly mentions ORDER BY and GROUP BY in the ONESQL query syntax.",
          kind: "verified_fact",
          verdict: "verified",
          citation_ids: verifiedId
        },
        {
          text: "The UI should always rewrite Group By into the query text.",
          kind: "verified_fact",
          verdict: "unsupported",
          citation_ids: []
        }
      ]
    };
  };

  try {
    const result = await runSupportSearchAgent({
      query: "does ONESQL support ORDER BY and does Group By rewrite the query text?",
      language: "en",
      currentRound: 0,
      conversationHistory: [],
      adapter,
      idempotencyKey: "support-agent-partial-answer-surviving-claims"
    });

    assert.match(result.result.answer, /ORDER BY and GROUP BY/i);
    assert.doesNotMatch(result.result.answer, /rewrite Group By into the query text/i);
    assert.equal(result.result.support_answer?.mode, "partial");
  } finally {
    env.LOCAL_DOCS_COM_PATH = originalLocalDocsPath;
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("runSupportSearchAgent reanchors tangential verifier citations onto the most relevant evidence", async () => {
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

The ONESQL syntax reference discusses ORDER BY and GROUP BY clauses.
`
  );
  await writeFixture(
    rootDir,
    "docs/admin/set-up-your-team/advanced-settings/notes-for-modifying-the-baseurl.mdx",
    `---
title: "Notes for modifying the baseURL"
---

# Notes for modifying the baseURL

This page is unrelated to ONESQL semantics.
`
  );

  const adapter = createAdapter({
    writerAnswer: {
      direct_answer: "The ONESQL syntax reference discusses ORDER BY and GROUP BY clauses.",
      claims: [
        {
          text: "The ONESQL syntax reference discusses ORDER BY and GROUP BY clauses.",
          kind: "verified_fact",
          evidence_ids: [],
          authority: "canonical"
        }
      ]
    }
  });
  adapter.verifySupportAnswer = async (input) => {
    const wrong = [...input.evidenceBundle.primary, ...input.evidenceBundle.supplemental].find((item) => /baseurl/i.test(item.title));
    const wrongId = wrong ? [resolveSearchReferenceEvidenceId(wrong)] : [];
    return {
      verdict: "verified",
      summary: "The verifier returned a weak tangential citation.",
      unsupported_claims: [],
      missing_info: [],
      verified_citation_ids: wrongId,
      display_citation_ids: wrongId,
      verified_claims: ["The ONESQL syntax reference discusses ORDER BY and GROUP BY clauses."],
      claim_to_citation_map: [
        {
          text: "The ONESQL syntax reference discusses ORDER BY and GROUP BY clauses.",
          kind: "verified_fact",
          verdict: "verified",
          citation_ids: wrongId
        }
      ]
    };
  };
  try {
    const result = await runSupportSearchAgent({
      query: "does ONESQL support ORDER BY and GROUP BY?",
      language: "en",
      currentRound: 0,
      conversationHistory: [],
      adapter,
      idempotencyKey: "support-agent-binder-overrides-tangential-citation"
    });

    assert.equal(result.result.citations.length, 1);
    assert.match(result.result.citations[0].title, /Execute ONESQL query/i);
    assert.doesNotMatch(result.result.citations[0].title, /baseURL/i);
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
    assert.equal(adapter.calls.includes("selectSupportEvidence"), false);
    assert.equal(adapter.calls.includes("writeTroubleshootingSpecialistAnswer"), true);
    assert.equal(adapter.calls.includes("judgeSupportAnswer"), true);
    assert.equal(adapter.calls.includes("curateSupportCitations") || adapter.calls.includes("selectDisplayCitations"), false);
    assert.equal(adapter.calls.includes("composeCustomerAnswer"), false);
    assert.equal(adapter.calls.includes("writeTriageInsight"), false);
    assert.equal(adapter.calls.includes("verifyTriageInsight"), false);
    assert.equal(result.analyzeOutput.action, "resolve");
    assert.equal(typeof result.analyzeOutput.reply, "string");
  } finally {
    env.LOCAL_DOCS_COM_PATH = originalLocalDocsPath;
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("runSupportSearchAgent records explicit stage statuses for fallback diagnostics", async () => {
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
    const result = await runSupportSearchAgent({
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
    });

    const stageTrace = result.result.internal_diagnostics?.stage_trace ?? [];
    const routeTrace = stageTrace.find((item) => item.stage === "route");
    const evidencePlanTrace = stageTrace.find((item) => item.stage === "evidence_plan");
    const retrievalTrace = stageTrace.find((item) => item.stage === "retrieval");

    assert.ok(routeTrace);
    assert.ok(evidencePlanTrace);
    assert.ok(retrievalTrace);
    assert.equal(routeTrace?.status, "fallback");
    assert.equal(evidencePlanTrace?.status, "fallback");
    assert.equal(retrievalTrace?.status, "completed");
    assert.equal(typeof routeTrace?.duration_ms, "number");
    assert.equal(typeof retrievalTrace?.reference_count, "number");
  } finally {
    env.LOCAL_DOCS_COM_PATH = originalLocalDocsPath;
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("runSupportSearchAgent skips legacy evidence and case planner fallback after unified planner failure in interactive mode", async () => {
  const originalLocalDocsPath = env.LOCAL_DOCS_COM_PATH;
  const rootDir = await createFixtureRoot();
  env.LOCAL_DOCS_COM_PATH = rootDir;
  const adapter = createStageRecordingAdapter();
  adapter.planSupportExecution = async () => {
    adapter.calls.push("planSupportExecution");
    throw new Error("unified planner failed");
  };

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
    const result = await runSupportSearchAgent({
      query: "GitHub callback page not found after authorization",
      language: "en",
      currentRound: 0,
      conversationHistory: [],
      adapter,
      idempotencyKey: "support-agent-unified-planner-interactive-fallback",
      runtime: {
        deliveryMode: "interactive",
        overallTimeoutMs: 22000,
        requestStartedAtMs: Date.now(),
        allowMultiPassRetrieval: false,
        allowRefinement: false
      }
    });

    const stageTrace = result.result.internal_diagnostics?.stage_trace ?? [];
    assert.equal(adapter.calls.includes("planSupportExecution"), true);
    assert.equal(adapter.calls.includes("routeSupportQuestion"), true);
    assert.equal(adapter.calls.includes("planSupportEvidence"), false);
    assert.equal(adapter.calls.includes("planSupportCase"), false);
    assert.equal(result.result.retrieval_status, "grounded");
    assert.equal(stageTrace.find((item) => item.stage === "evidence_plan")?.status, "skipped");
    assert.equal(stageTrace.find((item) => item.stage === "case_plan")?.status, "skipped");
  } finally {
    env.LOCAL_DOCS_COM_PATH = originalLocalDocsPath;
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("runSupportSearchAgent rejects ambiguous bare document ids when multiple evidence ids share one document", async () => {
  const adapter = createAdapter({
    routeOverride: {
      question_type: "why_behavior",
      specialist_agent: "behavior-specialist"
    }
  });
  const sharedDocumentId = "doc:deploy-capacity";
  const rootEvidenceId = "chunk:deploy-capacity-root";
  const detailEvidenceId = "chunk:deploy-capacity-detail";
  const references: SearchReference[] = [
    {
      documentId: sharedDocumentId,
      evidenceId: rootEvidenceId,
      title: "Deployment capacity",
      snippet: "General deployment overview.",
      sourceUrl: "https://docs.ones.com/deploy/capacity",
      path: "deploy-docs/docs/capacity.mdx",
      headingPath: "ROOT",
      authority: "canonical_visible",
      sourceType: "github_kb",
      score: 0.95,
      retrievedAt: "2026-04-08T08:00:00.000Z"
    },
    {
      documentId: sharedDocumentId,
      evidenceId: detailEvidenceId,
      title: "Deployment capacity",
      snippet: "Capacity expansion is supported when the cluster has spare nodes.",
      sourceUrl: "https://docs.ones.com/deploy/capacity#capacity-expansion",
      path: "deploy-docs/docs/capacity.mdx",
      headingPath: "Capacity expansion",
      authority: "canonical_visible",
      sourceType: "github_kb",
      score: 0.94,
      retrievedAt: "2026-04-08T08:00:00.000Z"
    }
  ];
  const orchestrator = {
    normalizeQuery(query: string) {
      return query.trim().toLowerCase();
    },
    async collectEvidence() {
      return {
        query: "Does private deployment support capacity expansion?",
        answer: "",
        confidence: 0.94,
        references,
        retrievalStatus: "grounded" as const,
        unresolvedReasonCode: null,
        resolvedQueries: ["private deployment capacity expansion"],
        fallbackUsed: false
      };
    },
    combineEvidenceCollections<T>(items: T[]) {
      return items[0];
    },
    async refineEvidence() {
      return null;
    }
  };

  adapter.selectSupportEvidence = async () => ({
    primary_ids: [rootEvidenceId],
    supplemental_ids: [detailEvidenceId],
    rejected_ids: []
  });
  adapter.writeBehaviorSpecialistAnswer = async () => ({
    question_type: "why_behavior",
    render_variant: "behavior",
    direct_answer: "Capacity expansion is supported in private deployment when spare nodes are available.",
    claims: [
      {
        text: "Capacity expansion is supported in private deployment when spare nodes are available.",
        kind: "verified_fact",
        evidence_ids: [sharedDocumentId],
        authority: "canonical"
      }
    ],
    next_actions: ["Check whether the target cluster has spare nodes."],
    unknowns: [],
    escalation_needed: false
  });
  adapter.judgeSupportAnswer = async () => ({
    verdict: "verified",
    summary: "The behavior is documented.",
    unsupported_claims: [],
    missing_info: [],
    verified_citation_ids: [sharedDocumentId],
    display_citation_ids: [sharedDocumentId],
    verified_claims: ["Capacity expansion is supported in private deployment when spare nodes are available."],
    claim_to_citation_map: [
      {
        text: "Capacity expansion is supported in private deployment when spare nodes are available.",
        kind: "verified_fact",
        verdict: "verified",
        citation_ids: [sharedDocumentId]
      }
    ]
  });
  adapter.bindSupportCitations = async () => {
    throw new Error("binder should not rescue ambiguous document ids in this regression test");
  };

  const result = await coreRunSupportSearchAgent({
    query: "Does private deployment support capacity expansion?",
    language: "en",
    currentRound: 0,
    conversationHistory: [],
    adapter,
    orchestrator: orchestrator as never,
    runtime: {
      intent: "retrieval",
      sessionKey: "support-agent-ambiguous-document-id",
      disableLocalDocs: true,
      allowMultiPassRetrieval: false,
      allowRefinement: false
    },
    idempotencyKey: "support-agent-ambiguous-document-id"
  });

  assert.deepEqual(result.verification.verified_citation_ids, []);
  assert.equal(result.result.citations.length, 0);
  assert.equal(
    result.result.references.some((item) => resolveSearchReferenceEvidenceId(item) === detailEvidenceId),
    true
  );
  assert.equal(result.result.support_answer?.mode === "grounded", false);
});

test("runSupportSearchAgent single-agent runtime uses support-main plan plus draft stages and only keeps provided-evidence citations", async () => {
  const originalSingleAgentRuntime = (env as { FEATURE_SUPPORT_AGENT_SINGLE_AGENT_RUNTIME?: boolean })
    .FEATURE_SUPPORT_AGENT_SINGLE_AGENT_RUNTIME;
  (env as { FEATURE_SUPPORT_AGENT_SINGLE_AGENT_RUNTIME?: boolean }).FEATURE_SUPPORT_AGENT_SINGLE_AGENT_RUNTIME = true;

  const adapter = createAdapter({}) as OpenClawAdapter & {
    planSupportMainAgent?: (
      input: {
        contextType: "search" | "triage";
        language: "zh" | "en";
        query: string;
      },
      idempotencyKey: string,
      runtime?: OpenClawRuntimeContext
    ) => Promise<unknown>;
    draftSupportMainAgent?: (
      input: {
        contextType: "search" | "triage";
        language: "zh" | "en";
        query: string;
        providedEvidence: Array<{
          reference_id: string;
          evidence_id: string;
          sourceUrl: string;
        }>;
      },
      idempotencyKey: string,
      runtime?: OpenClawRuntimeContext
    ) => Promise<unknown>;
  };
  let observedProvidedEvidence: Array<{ reference_id: string; evidence_id: string; sourceUrl: string }> = [];

  adapter.routeSupportQuestion = async () => {
    throw new Error("legacy route stage must not run in single-agent mode");
  };
  adapter.planSupportEvidence = async () => {
    throw new Error("legacy evidence planner must not run in single-agent mode");
  };
  adapter.planSupportCase = async () => {
    throw new Error("legacy case planner must not run in single-agent mode");
  };
  adapter.writeApiSpecialistAnswer = async () => {
    throw new Error("legacy specialist must not run in single-agent mode");
  };
  adapter.judgeSupportAnswer = async () => {
    throw new Error("legacy verifier must not run in single-agent mode");
  };
  adapter.composeCustomerAnswer = async () => {
    throw new Error("legacy answer composer must not run in single-agent mode");
  };
  adapter.planSupportMainAgent = async (_input, _idempotencyKey, _runtime) => ({
    route: {
      question_type: "api_scope_auth",
      user_goal: "Find the required scope for the issue comment API.",
      answer_contract: "Return the exact scope first.",
      specialist_agent: "api-specialist",
      routing_confidence: 0.96
    },
    caseFrame: {
      goal: "Find the required scope for the issue comment API.",
      symptom: "Scope lookup",
      object: "issue comment API",
      action_type: "lookup",
      deployment_model: "shared",
      product_area: "openapi",
      constraints: [],
      missing_critical_info: [],
      retrieval_queries: ["issue comment api scope"]
    },
    retrievalQueries: ["issue comment api scope"]
  });
  adapter.draftSupportMainAgent = async (input, _idempotencyKey, _runtime) => {
    observedProvidedEvidence = input.providedEvidence;
    return {
      draftAnswer: {
      question_type: "api_scope_auth",
      render_variant: "api",
      direct_answer: "The issue comment API requires the documented comment scope.",
      claims: [
        {
          text: "The issue comment API requires write:project.",
          kind: "verified_fact",
          reference_ids: [input.providedEvidence[0]?.reference_id ?? ""],
          authority: "canonical"
        },
        {
          text: "The issue comment API also requires admin:workspace.",
          kind: "verified_fact",
          reference_ids: ["ref-nonexistent-scope"],
          authority: "canonical"
        }
      ],
      next_actions: ["Use write:project in the access token."],
      unknowns: [],
      escalation_needed: false,
      auth_scope: ["write:project"]
      }
    };
  };

  const validationReference: SearchReference = {
    documentId: "doc:add-issue-comment",
    evidenceId: "chunk:comment-scope",
    title: "Add issue comment",
    snippet: "Scope: write:project",
    sourceUrl: "https://docs.ones.com/openapi/add-issue-comment",
    path: "open-docs/docs/openapi/api/add-issue-comment.api.mdx",
    headingPath: "Permissions",
    authority: "canonical_visible",
    sourceType: "github_kb",
    score: 0.97,
    retrievedAt: "2026-04-08T12:00:00.000Z"
  };

  const orchestrator = {
    normalizeQuery(query: string) {
      return query.trim().toLowerCase();
    },
    async collectEvidence(input: { query?: string; queries?: string[] }) {
      return {
        query: input.query ?? input.queries?.[0] ?? "",
        answer: "",
        confidence: 0.97,
        references: [validationReference],
        retrievalStatus: "grounded" as const,
        unresolvedReasonCode: null,
        resolvedQueries: input.queries ?? [],
        fallbackUsed: false
      };
    },
    combineEvidenceCollections<T>(items: T[]) {
      return items[0];
    },
    async refineEvidence() {
      throw new Error("single-agent validation should not require refinement in this test");
    }
  };

  try {
    const result = await coreRunSupportSearchAgent({
      query: "What scope is required for the issue comment API?",
      language: "en",
      currentRound: 0,
      conversationHistory: [],
      adapter,
      orchestrator: orchestrator as never,
      idempotencyKey: "support-single-agent-bypass"
    });

    assert.deepEqual(result.verification.verified_citation_ids, ["chunk:comment-scope"]);
    assert.deepEqual(result.result.citations.map((item) => item.id), ["chunk:comment-scope"]);
    assert.deepEqual(result.result.internal_diagnostics?.claim_graph?.map((item) => item.text), [
      "The issue comment API requires write:project."
    ]);
    assert.equal(observedProvidedEvidence.length, 1);
    assert.equal(observedProvidedEvidence[0]?.evidence_id, "chunk:comment-scope");
    assert.equal(observedProvidedEvidence[0]?.sourceUrl, validationReference.sourceUrl);
    assert.equal((result.result.internal_diagnostics as { runtime_mode?: string } | undefined)?.runtime_mode, "single_agent");
    assert.equal(
      result.result.internal_diagnostics?.orchestration_trace?.some((item) => item.stage === "support_main_plan"),
      true
    );
    assert.equal(
      result.result.internal_diagnostics?.orchestration_trace?.some((item) => item.stage === "support_main_draft"),
      true
    );
    assert.equal(
      result.result.internal_diagnostics?.orchestration_trace?.some((item) => item.stage === "router"),
      false
    );
  } finally {
    (env as { FEATURE_SUPPORT_AGENT_SINGLE_AGENT_RUNTIME?: boolean }).FEATURE_SUPPORT_AGENT_SINGLE_AGENT_RUNTIME =
      originalSingleAgentRuntime;
  }
});

test("runSupportSearchAgent uses support-main execution when support-main is explicitly configured even without the feature flag", async () => {
  const mutableEnv = env as {
    FEATURE_SUPPORT_AGENT_SINGLE_AGENT_RUNTIME?: boolean;
    OPENCLAW_AGENT_ID_SUPPORT_MAIN?: string;
  };
  const originalSingleAgentRuntime = mutableEnv.FEATURE_SUPPORT_AGENT_SINGLE_AGENT_RUNTIME;
  const originalSupportMainAgentId = mutableEnv.OPENCLAW_AGENT_ID_SUPPORT_MAIN;
  mutableEnv.FEATURE_SUPPORT_AGENT_SINGLE_AGENT_RUNTIME = false;
  mutableEnv.OPENCLAW_AGENT_ID_SUPPORT_MAIN = "support-main";

  const adapter = createAdapter({}) as OpenClawAdapter & {
    planSupportMainAgent?: (
      input: {
        contextType: "search" | "triage";
        language: "zh" | "en";
        query: string;
      },
      idempotencyKey: string,
      runtime?: OpenClawRuntimeContext
    ) => Promise<unknown>;
    draftSupportMainAgent?: (
      input: {
        contextType: "search" | "triage";
        language: "zh" | "en";
        query: string;
        providedEvidence: Array<{
          reference_id: string;
          evidence_id: string;
          sourceUrl: string;
        }>;
      },
      idempotencyKey: string,
      runtime?: OpenClawRuntimeContext
    ) => Promise<unknown>;
  };

  adapter.routeSupportQuestion = async () => {
    throw new Error("legacy route stage must not run when support-main is explicitly configured");
  };
  adapter.planSupportEvidence = async () => {
    throw new Error("legacy evidence planner must not run when support-main is explicitly configured");
  };
  adapter.planSupportCase = async () => {
    throw new Error("legacy case planner must not run when support-main is explicitly configured");
  };
  adapter.writeApiSpecialistAnswer = async () => {
    throw new Error("legacy specialist must not run when support-main is explicitly configured");
  };
  adapter.judgeSupportAnswer = async () => {
    throw new Error("legacy verifier must not run when support-main is explicitly configured");
  };
  adapter.composeCustomerAnswer = async () => {
    throw new Error("legacy answer composer must not run when support-main is explicitly configured");
  };
  adapter.planSupportMainAgent = async () => ({
    route: {
      question_type: "capability_confirmation",
      user_goal: "Confirm whether private deployment capacity expansion is supported.",
      answer_contract: "Answer directly and cite the published support knowledge.",
      specialist_agent: "behavior-specialist",
      routing_confidence: 0.95
    },
    caseFrame: {
      goal: "Confirm whether private deployment capacity expansion is supported.",
      symptom: "Capability confirmation",
      object: "private deployment capacity expansion",
      action_type: "lookup",
      deployment_model: "private_deployment",
      product_area: "deployment",
      constraints: [],
      missing_critical_info: [],
      retrieval_queries: ["private deployment capacity expansion support"]
    },
    retrievalQueries: ["private deployment capacity expansion support"]
  });
  adapter.draftSupportMainAgent = async (input) => ({
    draftAnswer: {
      question_type: "capability_confirmation",
      render_variant: "behavior",
      direct_answer: "Private deployment supports capacity expansion when the deployment plan and operating conditions match the documented guidance.",
      claims: [
        {
          text: "The published deployment guidance confirms private deployment capacity expansion support.",
          kind: "verified_fact",
          reference_ids: [input.providedEvidence[0]?.reference_id ?? ""],
          authority: "canonical"
        }
      ],
      next_actions: ["Check the current deployment mode and operating constraints against the documented guidance."],
      unknowns: [],
      escalation_needed: false
    }
  });

  const validationReference: SearchReference = {
    documentId: "doc:private-deployment-capacity",
    evidenceId: "chunk:private-deployment-capacity",
    title: "Private deployment capacity expansion",
    snippet: "Private deployment supports capacity expansion under the documented operating guidance.",
    sourceUrl: "https://docs.ones.com/private-deployment/capacity-expansion",
    path: "docs/private-deployment/capacity-expansion.mdx",
    headingPath: "Capacity expansion",
    authority: "canonical_visible",
    sourceType: "github_kb",
    score: 0.98,
    retrievedAt: "2026-04-08T12:30:00.000Z"
  };

  const orchestrator = {
    normalizeQuery(query: string) {
      return query.trim().toLowerCase();
    },
    async collectEvidence() {
      return {
        query: "private deployment capacity expansion support",
        answer: "",
        confidence: 0.98,
        references: [validationReference],
        retrievalStatus: "grounded" as const,
        unresolvedReasonCode: null,
        resolvedQueries: ["private deployment capacity expansion support"],
        fallbackUsed: false
      };
    },
    combineEvidenceCollections<T>(items: T[]) {
      return items[0];
    },
    async refineEvidence() {
      throw new Error("single-agent validation should not require refinement in this test");
    }
  };

  try {
    const result = await coreRunSupportSearchAgent({
      query: "私有化部署是否支持容量扩容？",
      language: "zh",
      currentRound: 0,
      conversationHistory: [],
      adapter,
      orchestrator: orchestrator as never,
      idempotencyKey: "support-single-agent-explicit-binding"
    });

    assert.equal((result.result.internal_diagnostics as { runtime_mode?: string } | undefined)?.runtime_mode, "single_agent");
    assert.equal(
      result.result.internal_diagnostics?.orchestration_trace?.some((item) => item.stage === "support_main_plan"),
      true
    );
    assert.equal(
      result.result.internal_diagnostics?.orchestration_trace?.some((item) => item.stage === "router"),
      false
    );
    assert.deepEqual(result.verification.verified_citation_ids, ["chunk:private-deployment-capacity"]);
  } finally {
    mutableEnv.FEATURE_SUPPORT_AGENT_SINGLE_AGENT_RUNTIME = originalSingleAgentRuntime;
    mutableEnv.OPENCLAW_AGENT_ID_SUPPORT_MAIN = originalSupportMainAgentId;
  }
});

test("runSupportSearchAgent single-agent canonicalizes free-form planner metadata before retrieval", async () => {
  const mutableEnv = env as {
    FEATURE_SUPPORT_AGENT_SINGLE_AGENT_RUNTIME?: boolean;
    OPENCLAW_AGENT_ID_SUPPORT_MAIN?: string;
  };
  const originalSingleAgentRuntime = mutableEnv.FEATURE_SUPPORT_AGENT_SINGLE_AGENT_RUNTIME;
  const originalSupportMainAgentId = mutableEnv.OPENCLAW_AGENT_ID_SUPPORT_MAIN;
  mutableEnv.FEATURE_SUPPORT_AGENT_SINGLE_AGENT_RUNTIME = true;
  mutableEnv.OPENCLAW_AGENT_ID_SUPPORT_MAIN = "support-main";

  const adapter = createAdapter({}) as OpenClawAdapter & {
    planSupportMainAgent?: (
      input: {
        contextType: "search" | "triage";
        language: "zh" | "en";
        query: string;
      },
      idempotencyKey: string,
      runtime?: OpenClawRuntimeContext
    ) => Promise<unknown>;
    draftSupportMainAgent?: (
      input: {
        contextType: "search" | "triage";
        language: "zh" | "en";
        query: string;
        providedEvidence: Array<{
          reference_id: string;
          evidence_id: string;
          sourceUrl: string;
        }>;
      },
      idempotencyKey: string,
      runtime?: OpenClawRuntimeContext
    ) => Promise<unknown>;
  };
  let observedCaseFrame: SupportCaseFrame | undefined;

  adapter.planSupportMainAgent = async () => ({
    route: {
      question_type: "capability_confirmation",
      user_goal: "确认私有化部署是否支持容量扩容",
      answer_contract: "直接回答是否支持以及适用边界。",
      specialist_agent: "behavior-specialist",
      routing_confidence: 0.94
    },
    caseFrame: {
      goal: "判断 ONES 私有化部署是否支持容量扩容",
      symptom: "用户咨询私有化部署场景下的容量扩展能力",
      object: "ONES 私有化部署",
      action_type: "容量扩容咨询",
      deployment_model: "私有化部署",
      product_area: "部署与运维/容量规划",
      constraints: [],
      missing_critical_info: [],
      retrieval_queries: [
        "ONES 私有化部署 容量扩容 是否支持",
        "ONES 私有化部署 扩容 指南"
      ],
      required_doc_kinds: ["私有化部署文档", "运维手册", "系统架构说明", "版本发布说明"]
    },
    retrievalQueries: ["ONES 私有化部署 容量扩容 是否支持", "ONES 私有化部署 扩容 指南"]
  });
  adapter.draftSupportMainAgent = async (input) => ({
    draftAnswer: {
      question_type: "capability_confirmation",
      render_variant: "behavior",
      direct_answer: "私有化部署支持容量扩容，具体边界取决于部署架构与资源条件。",
      claims: [
        {
          text: "私有化部署支持容量扩容，具体边界取决于部署架构与资源条件。",
          kind: "verified_fact",
          reference_ids: [input.providedEvidence[0]?.reference_id ?? ""],
          authority: "canonical"
        }
      ],
      next_actions: ["核对部署架构和资源规划约束。"],
      unknowns: [],
      escalation_needed: false
    }
  });

  const validationReference: SearchReference = {
    documentId: "doc:deployment-flow",
    evidenceId: "chunk:deployment-flow",
    title: "ONES 私有部署说明",
    snippet: "私有化部署支持在满足架构和资源条件时进行扩容。",
    sourceUrl: "https://docs.ones.com/zh-Hans/deploy/prepare/deployment-flow",
    path: "deploy/prepare/deployment-flow",
    headingPath: "扩容",
    authority: "canonical_visible",
    sourceType: "github_kb",
    score: 0.96,
    retrievedAt: "2026-04-08T14:00:00.000Z"
  };

  const orchestrator = {
    normalizeQuery(query: string) {
      return query.trim().toLowerCase();
    },
    async collectEvidence(input: { caseFrame?: SupportCaseFrame }) {
      observedCaseFrame = input.caseFrame;
      return {
        query: "ONES 私有化部署 容量扩容 是否支持",
        answer: "",
        confidence: 0.96,
        references: [validationReference],
        retrievalStatus: "grounded" as const,
        unresolvedReasonCode: null,
        resolvedQueries: ["ONES 私有化部署 容量扩容 是否支持"],
        fallbackUsed: false
      };
    },
    combineEvidenceCollections<T>(items: T[]) {
      return items[0];
    },
    async refineEvidence() {
      throw new Error("single-agent validation should not require refinement in this test");
    }
  };

  try {
    await coreRunSupportSearchAgent({
      query: "私有化部署是否支持容量扩容？",
      language: "zh",
      currentRound: 0,
      conversationHistory: [],
      adapter,
      orchestrator: orchestrator as never,
      idempotencyKey: "support-single-agent-canonicalization"
    });

    assert.equal(observedCaseFrame?.product_area, "deployment");
    assert.deepEqual(observedCaseFrame?.required_doc_kinds, ["deployment_runbook", "product_guide", "rules"]);
  } finally {
    mutableEnv.FEATURE_SUPPORT_AGENT_SINGLE_AGENT_RUNTIME = originalSingleAgentRuntime;
    mutableEnv.OPENCLAW_AGENT_ID_SUPPORT_MAIN = originalSupportMainAgentId;
  }
});

test("runSupportSearchAgent single-agent falls back capability questions away from troubleshooting routing", async () => {
  const mutableEnv = env as {
    FEATURE_SUPPORT_AGENT_SINGLE_AGENT_RUNTIME?: boolean;
    OPENCLAW_AGENT_ID_SUPPORT_MAIN?: string;
  };
  const originalSingleAgentRuntime = mutableEnv.FEATURE_SUPPORT_AGENT_SINGLE_AGENT_RUNTIME;
  const originalSupportMainAgentId = mutableEnv.OPENCLAW_AGENT_ID_SUPPORT_MAIN;
  mutableEnv.FEATURE_SUPPORT_AGENT_SINGLE_AGENT_RUNTIME = true;
  mutableEnv.OPENCLAW_AGENT_ID_SUPPORT_MAIN = "support-main";

  const adapter = createAdapter({}) as OpenClawAdapter & {
    planSupportMainAgent?: (
      input: {
        contextType: "search" | "triage";
        language: "zh" | "en";
        query: string;
      },
      idempotencyKey: string,
      runtime?: OpenClawRuntimeContext
    ) => Promise<unknown>;
    draftSupportMainAgent?: (
      input: {
        contextType: "search" | "triage";
        language: "zh" | "en";
        query: string;
        route: SupportQuestionRoute;
        providedEvidence: Array<{
          reference_id: string;
          evidence_id: string;
          sourceUrl: string;
        }>;
      },
      idempotencyKey: string,
      runtime?: OpenClawRuntimeContext
    ) => Promise<unknown>;
  };
  let observedRoute: SupportQuestionRoute | undefined;

  adapter.planSupportMainAgent = async () => ({
    route: {
      question_type: "troubleshooting",
      user_goal: "确认私有化部署是否支持容量扩容",
      answer_contract: "直接回答是否支持。",
      specialist_agent: "troubleshooting-specialist",
      routing_confidence: 0.93
    },
    caseFrame: {
      goal: "判断 ONES 私有化部署是否支持容量扩容",
      symptom: "用户咨询私有化部署场景下的容量扩展能力",
      object: "ONES 私有化部署",
      action_type: "容量扩容咨询",
      deployment_model: "私有化部署",
      product_area: "部署与运维/容量规划",
      constraints: [],
      missing_critical_info: [],
      retrieval_queries: ["ONES 私有化部署 容量扩容 是否支持"],
      required_doc_kinds: ["私有化部署文档", "安装部署指南", "版本发布说明"]
    },
    retrievalQueries: ["ONES 私有化部署 容量扩容 是否支持"]
  });
  adapter.draftSupportMainAgent = async (input) => {
    observedRoute = input.route;
    return {
      draftAnswer: {
        question_type: input.route.question_type,
        render_variant: "behavior",
        direct_answer:
          input.route.question_type === "capability_confirmation"
            ? "支持，但需要结合部署架构和资源条件判断具体扩容方式。"
            : "我只能确认一个局部排查事实。",
        claims: [
          {
            text:
              input.route.question_type === "capability_confirmation"
                ? "已发布部署文档表明私有化部署支持容量相关扩展，但需要结合架构和资源条件评估。"
                : "已发布部署文档只说明了某个局部资源要求。",
            kind: "verified_fact",
            reference_ids: [input.providedEvidence[0]?.reference_id ?? ""],
            authority: "canonical"
          }
        ],
        next_actions: ["核对部署架构和资源条件。"],
        unknowns: [],
        escalation_needed: false
      }
    };
  };

  const validationReference: SearchReference = {
    documentId: "doc:deployment-capacity",
    evidenceId: "chunk:deployment-capacity",
    title: "部署扩展要求",
    snippet: "私有化部署支持容量相关扩展，但需要结合部署架构和资源条件评估。",
    sourceUrl: "https://docs.ones.com/zh-Hans/deploy/prepare/deployment-requirements",
    path: "deploy/prepare/deployment-requirements",
    headingPath: "部署扩展要求",
    authority: "canonical_visible",
    sourceType: "github_kb",
    score: 0.97,
    retrievedAt: "2026-04-08T15:00:00.000Z"
  };

  const orchestrator = {
    normalizeQuery(query: string) {
      return query.trim().toLowerCase();
    },
    async collectEvidence() {
      return {
        query: "ONES 私有化部署 容量扩容 是否支持",
        answer: "",
        confidence: 0.97,
        references: [validationReference],
        retrievalStatus: "grounded" as const,
        unresolvedReasonCode: null,
        resolvedQueries: ["ONES 私有化部署 容量扩容 是否支持"],
        fallbackUsed: false
      };
    },
    combineEvidenceCollections<T>(items: T[]) {
      return items[0];
    },
    async refineEvidence() {
      throw new Error("single-agent validation should not require refinement in this test");
    }
  };

  try {
    const result = await coreRunSupportSearchAgent({
      query: "私有化部署是否支持容量扩容？",
      language: "zh",
      currentRound: 0,
      conversationHistory: [],
      adapter,
      orchestrator: orchestrator as never,
      idempotencyKey: "support-single-agent-route-fallback"
    });

    assert.equal(observedRoute?.question_type, "capability_confirmation");
    assert.equal(observedRoute?.specialist_agent, "behavior-specialist");
    assert.match(result.result.answer, /支持/);
    assert.equal(
      (result.result.internal_diagnostics as { route?: SupportQuestionRoute } | undefined)?.route?.question_type,
      "capability_confirmation"
    );
  } finally {
    mutableEnv.FEATURE_SUPPORT_AGENT_SINGLE_AGENT_RUNTIME = originalSingleAgentRuntime;
    mutableEnv.OPENCLAW_AGENT_ID_SUPPORT_MAIN = originalSupportMainAgentId;
  }
});

test("runSupportSearchAgent single-agent keeps broad partial capability answers instead of collapsing to one narrow claim", async () => {
  const mutableEnv = env as {
    FEATURE_SUPPORT_AGENT_SINGLE_AGENT_RUNTIME?: boolean;
    OPENCLAW_AGENT_ID_SUPPORT_MAIN?: string;
  };
  const originalSingleAgentRuntime = mutableEnv.FEATURE_SUPPORT_AGENT_SINGLE_AGENT_RUNTIME;
  const originalSupportMainAgentId = mutableEnv.OPENCLAW_AGENT_ID_SUPPORT_MAIN;
  mutableEnv.FEATURE_SUPPORT_AGENT_SINGLE_AGENT_RUNTIME = true;
  mutableEnv.OPENCLAW_AGENT_ID_SUPPORT_MAIN = "support-main";

  const adapter = createAdapter({}) as OpenClawAdapter & {
    planSupportMainAgent?: (
      input: {
        contextType: "search" | "triage";
        language: "zh" | "en";
        query: string;
      },
      idempotencyKey: string,
      runtime?: OpenClawRuntimeContext
    ) => Promise<unknown>;
    draftSupportMainAgent?: (
      input: {
        contextType: "search" | "triage";
        language: "zh" | "en";
        query: string;
        providedEvidence: Array<{
          reference_id: string;
          evidence_id: string;
          sourceUrl: string;
        }>;
      },
      idempotencyKey: string,
      runtime?: OpenClawRuntimeContext
    ) => Promise<unknown>;
  };

  adapter.planSupportMainAgent = async () => ({
    route: {
      question_type: "capability_confirmation",
      user_goal: "确认私有化部署是否支持容量扩容",
      answer_contract: "先直接回答是否支持，再说明当前文档能直接确认的范围与限制。",
      specialist_agent: "behavior-specialist",
      routing_confidence: 0.96
    },
    caseFrame: {
      goal: "确认私有化部署是否支持容量扩容",
      symptom: "能力确认咨询",
      object: "私有化部署容量扩容",
      action_type: "capability_confirmation",
      deployment_model: "private_deployment",
      product_area: "deployment",
      constraints: [],
      missing_critical_info: [],
      retrieval_queries: ["ONES 私有化部署 容量扩容 是否支持"],
      required_doc_kinds: ["deployment_runbook", "product_guide", "troubleshooting"]
    },
    retrievalQueries: ["ONES 私有化部署 容量扩容 是否支持"]
  });
  adapter.draftSupportMainAgent = async (input) => ({
    draftAnswer: {
      question_type: "capability_confirmation",
      render_variant: "behavior",
      direct_answer:
        "当前文档可以确认私有化部署在存储与资源规划层面具备扩容前提，但未看到所有组件统一扩容流程的直接说明。",
      claims: [
        {
          text: "文档要求根据使用量配置合适的磁盘空间，说明私有化部署需要按规模规划容量。",
          kind: "verified_fact",
          reference_ids: [input.providedEvidence[0]?.reference_id ?? ""],
          authority: "canonical"
        },
        {
          text: "文档建议物理机磁盘使用 LVM 管理，便于扩容。",
          kind: "verified_fact",
          reference_ids: [input.providedEvidence[0]?.reference_id ?? ""],
          authority: "canonical"
        },
        {
          text: "现有证据可以支持私有化部署在存储与资源规划层面具备扩容前提，但未覆盖所有组件统一扩容流程。",
          kind: "grounded_inference",
          reference_ids: [input.providedEvidence[0]?.reference_id ?? ""],
          authority: "assistive"
        }
      ],
      next_actions: ["先确认要扩的是磁盘/存储，还是计算与节点资源。"],
      unknowns: ["当前文档未覆盖所有组件的统一扩容步骤。"],
      escalation_needed: false,
      most_likely_explanation:
        "从当前文档看，私有化部署至少在存储与资源规划层面具备扩容前提，但仍需按具体对象确认边界。",
      confirmed_facts: [
        "文档要求根据使用量配置合适的磁盘空间。",
        "文档建议物理机磁盘使用 LVM 管理，便于扩容。"
      ],
      what_to_check_next: ["继续核对具体扩容对象对应的部署与运维文档。"]
    }
  });

  const validationReference: SearchReference = {
    documentId: "doc:storage-requirements",
    evidenceId: "chunk:storage-requirements",
    title: "存储资源要求",
    snippet:
      "根据使用量配置合适的磁盘空间；如果是物理机磁盘，使用 LVM 管理，便于扩容；单机版数据量达到 500G 及以上时推荐外置 OSS 或 NFS 存储。",
    sourceUrl: "https://docs.ones.com/zh-Hans/deploy/prepare/deployment-requirements",
    path: "deploy-docs/prepare/deployment-requirements.md",
    headingPath: "ONES 私有部署环境要求 > 存储资源要求",
    authority: "canonical_visible",
    sourceType: "github_kb",
    score: 0.98,
    retrievedAt: "2026-04-08T18:40:57.615Z"
  };

  const orchestrator = {
    normalizeQuery(query: string) {
      return query.trim().toLowerCase();
    },
    async collectEvidence() {
      return {
        query: "ONES 私有化部署 容量扩容 是否支持",
        answer: "",
        confidence: 0.98,
        references: [validationReference],
        retrievalStatus: "grounded" as const,
        unresolvedReasonCode: null,
        resolvedQueries: ["ONES 私有化部署 容量扩容 是否支持"],
        fallbackUsed: false
      };
    },
    combineEvidenceCollections<T>(items: T[]) {
      return items[0];
    },
    async refineEvidence() {
      throw new Error("single-agent validation should not require refinement in this test");
    }
  };

  try {
    const result = await coreRunSupportSearchAgent({
      query: "私有化部署是否支持容量扩容？",
      language: "zh",
      currentRound: 0,
      conversationHistory: [],
      adapter,
      orchestrator: orchestrator as never,
      idempotencyKey: "support-single-agent-broad-capability-answer"
    });

    assert.match(result.result.answer, /存储与资源规划层面具备扩容前提/);
    assert.ok(result.verification.verified_claims.length >= 2);
    assert.ok((result.result.internal_diagnostics?.claim_graph?.length ?? 0) >= 2);
    assert.equal(result.result.support_answer?.render_variant, "behavior");
  } finally {
    mutableEnv.FEATURE_SUPPORT_AGENT_SINGLE_AGENT_RUNTIME = originalSingleAgentRuntime;
    mutableEnv.OPENCLAW_AGENT_ID_SUPPORT_MAIN = originalSupportMainAgentId;
  }
});

test("runSupportSearchAgent prefers the supervisor-domain runtime over support-main and keeps verification local", async () => {
  const mutableEnv = env as {
    FEATURE_SUPPORT_AGENT_SINGLE_AGENT_RUNTIME?: boolean;
    OPENCLAW_AGENT_ID_SUPPORT_MAIN?: string;
  };
  const originalSingleAgentRuntime = mutableEnv.FEATURE_SUPPORT_AGENT_SINGLE_AGENT_RUNTIME;
  const originalSupportMainAgentId = mutableEnv.OPENCLAW_AGENT_ID_SUPPORT_MAIN;
  mutableEnv.FEATURE_SUPPORT_AGENT_SINGLE_AGENT_RUNTIME = true;
  mutableEnv.OPENCLAW_AGENT_ID_SUPPORT_MAIN = "support-main";

  const adapter = createAdapter({}) as OpenClawAdapter & {
    planSupportDispatch?: (
      input: {
        contextType: "search" | "triage";
        language: "zh" | "en";
        query: string;
      },
      idempotencyKey: string,
      runtime?: OpenClawRuntimeContext
    ) => Promise<unknown>;
    writeOpenApiDomainAnswer?: (
      input: OpenClawSupportSpecialistInput,
      idempotencyKey: string,
      runtime?: OpenClawRuntimeContext
    ) => Promise<SpecialistDraftAnswer>;
    planSupportMainAgent?: (...args: unknown[]) => Promise<unknown>;
    draftSupportMainAgent?: (...args: unknown[]) => Promise<unknown>;
  };

  adapter.planSupportMainAgent = async () => {
    throw new Error("support-main fallback must not run when supervisor-domain runtime is available");
  };
  adapter.draftSupportMainAgent = async () => {
    throw new Error("support-main draft must not run when supervisor-domain runtime is available");
  };
  adapter.routeSupportQuestion = async () => {
    throw new Error("legacy router must not run when supervisor-domain runtime is available");
  };
  adapter.planSupportEvidence = async () => {
    throw new Error("legacy evidence planner must not run when supervisor-domain runtime is available");
  };
  adapter.planSupportCase = async () => {
    throw new Error("legacy case planner must not run when supervisor-domain runtime is available");
  };
  adapter.judgeSupportAnswer = async () => {
    throw new Error("judge stage must not run in supervisor-domain runtime");
  };
  adapter.composeCustomerAnswer = async () => {
    throw new Error("answer composer must not run in supervisor-domain runtime");
  };
  adapter.planSupportDispatch = async (input) => ({
    primaryDomain: "openapi",
    route: {
      question_type: "api_scope_auth",
      user_goal: input.query,
      answer_contract: "Return the exact scope first.",
      specialist_agent: "api-specialist",
      routing_confidence: 0.96,
      primary_domain: "openapi"
    },
    caseFrame: {
      goal: "Find the required scope for the issue comment API.",
      symptom: "Scope lookup",
      object: "issue comment API",
      action_type: "lookup",
      deployment_model: "shared",
      product_area: "openapi",
      constraints: [],
      missing_critical_info: [],
      retrieval_queries: ["issue comment api scope"],
      question_type: "api_scope_auth",
      specialist_agent: "api-specialist",
      answer_contract: "Return the exact scope first.",
      routing_confidence: 0.96,
      primary_domain: "openapi",
      required_doc_kinds: ["openapi/api", "permissions"]
    },
    retrievalQueries: ["issue comment api scope"]
  });
  adapter.writeOpenApiDomainAnswer = async (input) => ({
    question_type: "api_scope_auth",
    render_variant: "api",
    direct_answer: "The issue comment API requires write:project.",
    claims: [
      {
        text: "The issue comment API requires write:project.",
        kind: "verified_fact",
        evidence_ids: input.evidenceBundle.primary.map((item) => resolveSearchReferenceEvidenceId(item)).slice(0, 1),
        authority: "canonical"
      },
      {
        text: "The issue comment API also requires admin:workspace.",
        kind: "verified_fact",
        evidence_ids: [],
        authority: "canonical"
      }
    ],
    next_actions: ["Use write:project in the access token."],
    unknowns: [],
    escalation_needed: false,
    auth_scope: ["write:project"]
  });

  const validationReference: SearchReference = {
    documentId: "doc:add-issue-comment",
    evidenceId: "chunk:comment-scope",
    title: "Add issue comment",
    snippet: "Scope: write:project",
    sourceUrl: "https://docs.ones.com/openapi/add-issue-comment",
    path: "open-docs/docs/openapi/api/add-issue-comment.api.mdx",
    headingPath: "Permissions",
    authority: "canonical_visible",
    sourceType: "github_kb",
    score: 0.97,
    retrievedAt: "2026-04-09T04:00:00.000Z"
  };

  const orchestrator = {
    normalizeQuery(query: string) {
      return query.trim().toLowerCase();
    },
    async collectEvidence(input: { query?: string; queries?: string[] }) {
      return {
        query: input.query ?? input.queries?.[0] ?? "",
        answer: "",
        confidence: 0.97,
        references: [validationReference],
        retrievalStatus: "grounded" as const,
        unresolvedReasonCode: null,
        resolvedQueries: input.queries ?? [],
        fallbackUsed: false
      };
    },
    combineEvidenceCollections<T>(items: T[]) {
      return items[0];
    },
    async refineEvidence() {
      throw new Error("supervisor-domain runtime must not refine evidence");
    }
  };

  try {
    const result = await coreRunSupportSearchAgent({
      query: "What scope is required for the issue comment API?",
      language: "en",
      currentRound: 0,
      conversationHistory: [],
      adapter,
      orchestrator: orchestrator as never,
      idempotencyKey: "support-supervisor-domain-openapi"
    });

    assert.equal((result.result.internal_diagnostics as { runtime_mode?: string } | undefined)?.runtime_mode, "supervisor_domain");
    assert.equal(
      ((result.result.internal_diagnostics as { route?: { primary_domain?: string } } | undefined)?.route?.primary_domain),
      "openapi"
    );
    assert.deepEqual(result.verification.verified_citation_ids, ["chunk:comment-scope"]);
    assert.deepEqual(result.result.citations.map((item) => item.id), ["chunk:comment-scope"]);
    assert.equal(result.stageTimings.retrieval_extra.status, "skipped");
    assert.deepEqual(
      (result.result.internal_diagnostics as { stage_budget?: Record<string, unknown> } | undefined)?.stage_budget,
      {
        retrieval_rounds: 1,
        allow_refinement: false,
        stop_after_grounded_evidence: false,
        specialist_budget: 1
      }
    );
    assert.equal(
      result.result.internal_diagnostics?.orchestration_trace?.some((item) => item.stage === "support_main_plan"),
      false
    );
    assert.match(result.result.answer, /write:project/);
    assert.doesNotMatch(result.result.answer, /admin:workspace/);
  } finally {
    mutableEnv.FEATURE_SUPPORT_AGENT_SINGLE_AGENT_RUNTIME = originalSingleAgentRuntime;
    mutableEnv.OPENCLAW_AGENT_ID_SUPPORT_MAIN = originalSupportMainAgentId;
  }
});

test("runSupportSearchAgent supervisor-domain runtime supports deployment answers with one retrieval pass", async () => {
  const mutableEnv = env as {
    FEATURE_SUPPORT_AGENT_SINGLE_AGENT_RUNTIME?: boolean;
    OPENCLAW_AGENT_ID_SUPPORT_MAIN?: string;
  };
  const originalSingleAgentRuntime = mutableEnv.FEATURE_SUPPORT_AGENT_SINGLE_AGENT_RUNTIME;
  const originalSupportMainAgentId = mutableEnv.OPENCLAW_AGENT_ID_SUPPORT_MAIN;
  mutableEnv.FEATURE_SUPPORT_AGENT_SINGLE_AGENT_RUNTIME = true;
  mutableEnv.OPENCLAW_AGENT_ID_SUPPORT_MAIN = "support-main";

  const adapter = createAdapter({}) as OpenClawAdapter & {
    planSupportDispatch?: (
      input: {
        contextType: "search" | "triage";
        language: "zh" | "en";
        query: string;
      },
      idempotencyKey: string,
      runtime?: OpenClawRuntimeContext
    ) => Promise<unknown>;
    writeDeploymentDomainAnswer?: (
      input: OpenClawSupportSpecialistInput,
      idempotencyKey: string,
      runtime?: OpenClawRuntimeContext
    ) => Promise<SpecialistDraftAnswer>;
    planSupportMainAgent?: (...args: unknown[]) => Promise<unknown>;
    draftSupportMainAgent?: (...args: unknown[]) => Promise<unknown>;
  };

  adapter.planSupportMainAgent = async () => {
    throw new Error("support-main fallback must not run when supervisor-domain runtime is available");
  };
  adapter.draftSupportMainAgent = async () => {
    throw new Error("support-main draft must not run when supervisor-domain runtime is available");
  };
  adapter.routeSupportQuestion = async () => {
    throw new Error("legacy router must not run when supervisor-domain runtime is available");
  };
  adapter.planSupportEvidence = async () => {
    throw new Error("legacy evidence planner must not run when supervisor-domain runtime is available");
  };
  adapter.planSupportCase = async () => {
    throw new Error("legacy case planner must not run when supervisor-domain runtime is available");
  };
  adapter.judgeSupportAnswer = async () => {
    throw new Error("judge stage must not run in supervisor-domain runtime");
  };
  adapter.composeCustomerAnswer = async () => {
    throw new Error("answer composer must not run in supervisor-domain runtime");
  };
  adapter.planSupportDispatch = async (input) => ({
    primaryDomain: "deployment",
    route: {
      question_type: "config_setup",
      user_goal: input.query,
      answer_contract: "Give the direct recovery steps first.",
      specialist_agent: "howto-specialist",
      routing_confidence: 0.94,
      primary_domain: "deployment"
    },
    caseFrame: {
      goal: "Reset the administrator password in a private deployment.",
      symptom: "Administrator password reset is blocked.",
      object: "administrator password reset",
      action_type: "recovery",
      deployment_model: "private_deployment",
      product_area: "deployment",
      constraints: [],
      missing_critical_info: [],
      retrieval_queries: ["private deployment administrator password reset"],
      question_type: "config_setup",
      specialist_agent: "howto-specialist",
      answer_contract: "Give the direct recovery steps first.",
      routing_confidence: 0.94,
      primary_domain: "deployment",
      required_doc_kinds: ["deployment_runbook", "product_guide"]
    },
    retrievalQueries: ["private deployment administrator password reset"]
  });
  adapter.writeDeploymentDomainAnswer = async (input) => ({
    question_type: "config_setup",
    render_variant: "how_to",
    direct_answer: "Use the documented private-deployment recovery path to reset the administrator password.",
    claims: [
      {
        text: "The deployment recovery guide documents the administrator password reset path.",
        kind: "verified_fact",
        evidence_ids: input.evidenceBundle.primary.map((item) => resolveSearchReferenceEvidenceId(item)).slice(0, 1),
        authority: "canonical"
      }
    ],
    next_actions: ["Use the private-deployment recovery path."],
    unknowns: [],
    escalation_needed: false,
    steps: ["Open the deployment recovery flow.", "Reset the administrator password from the host-side recovery path."],
    prerequisites: ["Administrator host access"],
    limits_or_notes: ["Do not rely on email reset when SMTP is unavailable."]
  });

  const validationReference: SearchReference = {
    documentId: "doc:deployment-reset",
    evidenceId: "chunk:deployment-reset",
    title: "Deployment recovery",
    snippet: "Use the deployment recovery path to reset the administrator password.",
    sourceUrl: "https://docs.ones.com/private-deployment/recovery",
    path: "docs/private-deployment/recovery.mdx",
    headingPath: "Administrator recovery",
    authority: "canonical_visible",
    sourceType: "github_kb",
    score: 0.98,
    retrievedAt: "2026-04-09T04:20:00.000Z"
  };

  const orchestrator = {
    normalizeQuery(query: string) {
      return query.trim().toLowerCase();
    },
    async collectEvidence(input: { query?: string; queries?: string[] }) {
      return {
        query: input.query ?? input.queries?.[0] ?? "",
        answer: "",
        confidence: 0.98,
        references: [validationReference],
        retrievalStatus: "grounded" as const,
        unresolvedReasonCode: null,
        resolvedQueries: input.queries ?? [],
        fallbackUsed: false
      };
    },
    combineEvidenceCollections<T>(items: T[]) {
      return items[0];
    },
    async refineEvidence() {
      throw new Error("supervisor-domain runtime must not refine evidence");
    }
  };

  try {
    const result = await coreRunSupportSearchAgent({
      query: "私有化部署下如何重置管理员密码？",
      language: "zh",
      currentRound: 0,
      conversationHistory: [],
      adapter,
      orchestrator: orchestrator as never,
      idempotencyKey: "support-supervisor-domain-deployment"
    });

    assert.equal((result.result.internal_diagnostics as { runtime_mode?: string } | undefined)?.runtime_mode, "supervisor_domain");
    assert.equal(
      ((result.result.internal_diagnostics as { route?: { primary_domain?: string } } | undefined)?.route?.primary_domain),
      "deployment"
    );
    assert.equal(result.result.support_answer?.render_variant, "how_to");
    assert.equal(result.stageTimings.retrieval_extra.status, "skipped");
    assert.match(result.result.answer, /重置管理员密码|recovery path/);
    assert.deepEqual(result.result.citations.map((item) => item.id), ["chunk:deployment-reset"]);
  } finally {
    mutableEnv.FEATURE_SUPPORT_AGENT_SINGLE_AGENT_RUNTIME = originalSingleAgentRuntime;
    mutableEnv.OPENCLAW_AGENT_ID_SUPPORT_MAIN = originalSupportMainAgentId;
  }
});

test("runSupportSearchAgent supervisor-domain runtime recovers implicit assignee-update API questions onto openapi evidence", async () => {
  const rootDir = await createFixtureRoot();
  const originalLocalDocsPath = env.LOCAL_DOCS_COM_PATH;
  env.LOCAL_DOCS_COM_PATH = rootDir;

  await writeFixture(
    rootDir,
    "open-docs/docs/openapi/api/04-update-a-issue.api.mdx",
    `---
id: 04-update-a-issue
title: "Update a issue"
---

# Update a issue

<MethodEndpoint
  method={"put"}
  path={"/project/issues/{issueID}"}
>
</MethodEndpoint>

Use this operation to update an issue.

<SchemaItem
  collapsible={false}
  name={"assignee"}
  required={false}
  schemaName={"string"}
  schema={{"type":"string","description":"The assignee user UUID."}}
>
</SchemaItem>
`
  );

  await writeFixture(
    rootDir,
    "docs/ones-project/issues/assign-issues.mdx",
    `---
title: "Assign issues"
---

# Assign issues

Use the UI to reassign issues from the issue detail page.
`
  );

  const mutableEnv = env as {
    FEATURE_SUPPORT_AGENT_SINGLE_AGENT_RUNTIME?: boolean;
    OPENCLAW_AGENT_ID_SUPPORT_MAIN?: string;
  };
  const originalSingleAgentRuntime = mutableEnv.FEATURE_SUPPORT_AGENT_SINGLE_AGENT_RUNTIME;
  const originalSupportMainAgentId = mutableEnv.OPENCLAW_AGENT_ID_SUPPORT_MAIN;
  mutableEnv.FEATURE_SUPPORT_AGENT_SINGLE_AGENT_RUNTIME = true;
  mutableEnv.OPENCLAW_AGENT_ID_SUPPORT_MAIN = "support-main";

  const adapter = createAdapter({}) as OpenClawAdapter & {
    planSupportDispatch?: (
      input: {
        contextType: "search" | "triage";
        language: "zh" | "en";
        query: string;
      },
      idempotencyKey: string,
      runtime?: OpenClawRuntimeContext
    ) => Promise<unknown>;
    writeOpenApiDomainAnswer?: (
      input: OpenClawSupportSpecialistInput,
      idempotencyKey: string,
      runtime?: OpenClawRuntimeContext
    ) => Promise<SpecialistDraftAnswer>;
    writeDocsDomainAnswer?: (
      input: OpenClawSupportSpecialistInput,
      idempotencyKey: string,
      runtime?: OpenClawRuntimeContext
    ) => Promise<SpecialistDraftAnswer>;
    planSupportMainAgent?: (...args: unknown[]) => Promise<unknown>;
    draftSupportMainAgent?: (...args: unknown[]) => Promise<unknown>;
  };

  adapter.planSupportMainAgent = async () => {
    throw new Error("support-main fallback must not run when supervisor-domain runtime is available");
  };
  adapter.draftSupportMainAgent = async () => {
    throw new Error("support-main draft must not run when supervisor-domain runtime is available");
  };
  adapter.routeSupportQuestion = async () => {
    throw new Error("legacy router must not run when supervisor-domain runtime is available");
  };
  adapter.planSupportEvidence = async () => {
    throw new Error("legacy evidence planner must not run when supervisor-domain runtime is available");
  };
  adapter.planSupportCase = async () => {
    throw new Error("legacy case planner must not run when supervisor-domain runtime is available");
  };
  adapter.judgeSupportAnswer = async () => {
    throw new Error("judge stage must not run in supervisor-domain runtime");
  };
  adapter.composeCustomerAnswer = async () => {
    throw new Error("answer composer must not run in supervisor-domain runtime");
  };
  adapter.planSupportDispatch = async (input) => ({
    primaryDomain: "docs",
    route: {
      question_type: "how_to_product",
      user_goal: input.query,
      answer_contract: "Give the direct product steps first.",
      specialist_agent: "howto-specialist",
      routing_confidence: 0.74,
      primary_domain: "docs"
    },
    caseFrame: {
      goal: input.query,
      symptom: "Need the right update path for issue assignee changes.",
      object: "issue assignee update",
      action_type: "how_to",
      deployment_model: "shared",
      product_area: "general",
      constraints: [],
      missing_critical_info: [],
      retrieval_queries: ["how to update assignee of an issue"],
      question_type: "how_to_product",
      specialist_agent: "howto-specialist",
      answer_contract: "Give the direct product steps first.",
      routing_confidence: 0.74,
      primary_domain: "docs",
      required_doc_kinds: ["product_guide"]
    },
    retrievalQueries: ["how to update assignee of an issue"]
  });
  adapter.writeOpenApiDomainAnswer = async () => ({
    question_type: "api_endpoint_lookup",
    render_variant: "api",
    direct_answer: "",
    claims: [],
    next_actions: [],
    unknowns: ["the exact endpoint"],
    escalation_needed: false
  });
  adapter.writeDocsDomainAnswer = async () => ({
    question_type: "how_to_product",
    render_variant: "how_to",
    direct_answer: "Please follow the product guide to assign issues.",
    claims: [],
    next_actions: [],
    unknowns: ["whether this should be done by API or UI"],
    escalation_needed: false
  });

  const validationReference: SearchReference = {
    documentId: "doc:update-issue",
    evidenceId: "chunk:update-issue-assignee",
    title: "Update a issue",
    snippet: "PUT /project/issues/{issueID}. The assignee field updates the assignee user UUID.",
    sourceUrl: "https://docs.ones.com/openapi/update-issue",
    path: "open-docs/docs/openapi/api/04-update-a-issue.api.mdx",
    headingPath: "ROOT",
    authority: "canonical_visible",
    sourceType: "local_docs",
    score: 0.98,
    retrievedAt: "2026-04-09T05:10:00.000Z"
  };

  const orchestrator = {
    normalizeQuery(query: string) {
      return query.trim().toLowerCase();
    },
    async collectEvidence(input: { query?: string; queries?: string[] }) {
      return {
        query: input.query ?? input.queries?.[0] ?? "",
        answer: "",
        confidence: 0.98,
        references: [validationReference],
        retrievalStatus: "grounded" as const,
        unresolvedReasonCode: null,
        resolvedQueries: input.queries ?? [],
        fallbackUsed: false
      };
    },
    combineEvidenceCollections<T>(items: T[]) {
      return items[0];
    },
    async refineEvidence() {
      throw new Error("supervisor-domain runtime must not refine evidence for this regression");
    }
  };

  try {
    const result = await coreRunSupportSearchAgent({
      query: "how to update assignee of an issue",
      language: "en",
      currentRound: 0,
      conversationHistory: [],
      adapter,
      orchestrator: orchestrator as never,
      idempotencyKey: "support-supervisor-domain-implicit-api-assignee"
    });

    assert.equal((result.result.internal_diagnostics as { runtime_mode?: string } | undefined)?.runtime_mode, "supervisor_domain");
    assert.equal(result.caseFrame.specialist_agent, "api-specialist");
    assert.equal(String(result.caseFrame.question_type ?? ""), "api_endpoint_lookup");
    assert.equal(
      ((result.result.internal_diagnostics as { route?: { primary_domain?: string } } | undefined)?.route?.primary_domain),
      "openapi"
    );
    assert.equal(result.result.support_answer?.render_variant, "api");
    assert.notEqual(result.result.support_answer?.mode, "handoff");
    assert.match(result.result.answer, /PUT \/project\/issues\/\{issueID\}/);
    assert.match(result.result.answer, /assignee/i);
    assert.ok(result.result.references.some((reference) => /04-update-a-issue\.api\.mdx/.test(reference.path ?? "")));
    assert.ok(result.result.citations.length >= 1);
  } finally {
    mutableEnv.FEATURE_SUPPORT_AGENT_SINGLE_AGENT_RUNTIME = originalSingleAgentRuntime;
    mutableEnv.OPENCLAW_AGENT_ID_SUPPORT_MAIN = originalSupportMainAgentId;
    env.LOCAL_DOCS_COM_PATH = originalLocalDocsPath;
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("runSupportSearchAgent supervisor-domain runtime keeps docs troubleshooting answers diagnostic without local judge stages", async () => {
  const mutableEnv = env as {
    FEATURE_SUPPORT_AGENT_SINGLE_AGENT_RUNTIME?: boolean;
    OPENCLAW_AGENT_ID_SUPPORT_MAIN?: string;
  };
  const originalSingleAgentRuntime = mutableEnv.FEATURE_SUPPORT_AGENT_SINGLE_AGENT_RUNTIME;
  const originalSupportMainAgentId = mutableEnv.OPENCLAW_AGENT_ID_SUPPORT_MAIN;
  mutableEnv.FEATURE_SUPPORT_AGENT_SINGLE_AGENT_RUNTIME = true;
  mutableEnv.OPENCLAW_AGENT_ID_SUPPORT_MAIN = "support-main";

  const adapter = createAdapter({}) as OpenClawAdapter & {
    planSupportDispatch?: (
      input: {
        contextType: "search" | "triage";
        language: "zh" | "en";
        query: string;
      },
      idempotencyKey: string,
      runtime?: OpenClawRuntimeContext
    ) => Promise<unknown>;
    writeDocsDomainAnswer?: (
      input: OpenClawSupportSpecialistInput,
      idempotencyKey: string,
      runtime?: OpenClawRuntimeContext
    ) => Promise<SpecialistDraftAnswer>;
    planSupportMainAgent?: (...args: unknown[]) => Promise<unknown>;
    draftSupportMainAgent?: (...args: unknown[]) => Promise<unknown>;
  };

  adapter.planSupportMainAgent = async () => {
    throw new Error("support-main fallback must not run when supervisor-domain runtime is available");
  };
  adapter.draftSupportMainAgent = async () => {
    throw new Error("support-main draft must not run when supervisor-domain runtime is available");
  };
  adapter.routeSupportQuestion = async () => {
    throw new Error("legacy router must not run when supervisor-domain runtime is available");
  };
  adapter.planSupportEvidence = async () => {
    throw new Error("legacy evidence planner must not run when supervisor-domain runtime is available");
  };
  adapter.planSupportCase = async () => {
    throw new Error("legacy case planner must not run when supervisor-domain runtime is available");
  };
  adapter.judgeSupportAnswer = async () => {
    throw new Error("judge stage must not run in supervisor-domain runtime");
  };
  adapter.composeCustomerAnswer = async () => {
    throw new Error("answer composer must not run in supervisor-domain runtime");
  };
  adapter.planSupportDispatch = async (input) => ({
    primaryDomain: "docs",
    route: {
      question_type: "troubleshooting",
      user_goal: input.query,
      answer_contract: "Start with the most likely documented cause and the checks to run now.",
      specialist_agent: "troubleshooting-specialist",
      routing_confidence: 0.92,
      primary_domain: "docs"
    },
    caseFrame: {
      goal: "Diagnose the failing GitHub callback flow.",
      symptom: "GitHub callback fails after OAuth setup.",
      object: "GitHub callback",
      action_type: "troubleshooting",
      deployment_model: "shared",
      product_area: "integrations",
      constraints: [],
      missing_critical_info: [],
      retrieval_queries: ["github callback troubleshooting"],
      question_type: "troubleshooting",
      specialist_agent: "troubleshooting-specialist",
      answer_contract: "Start with the most likely documented cause and the checks to run now.",
      routing_confidence: 0.92,
      primary_domain: "docs",
      required_doc_kinds: ["troubleshooting", "product_guide"]
    },
    retrievalQueries: ["github callback troubleshooting"]
  });
  adapter.writeDocsDomainAnswer = async (input) => ({
    question_type: "troubleshooting",
    render_variant: "troubleshooting",
    direct_answer: "The most likely documented cause is a callback URL mismatch.",
    claims: [
      {
        text: "The callback troubleshooting guide says callback URL mismatch causes the integration to fail.",
        kind: "verified_fact",
        evidence_ids: input.evidenceBundle.primary.map((item) => resolveSearchReferenceEvidenceId(item)).slice(0, 1),
        authority: "canonical"
      }
    ],
    next_actions: ["Compare the redirect URI in ONES with the callback URL registered in the provider."],
    unknowns: [],
    escalation_needed: false,
    most_likely_causes: ["Callback URL mismatch between ONES and the provider registration."],
    recommended_checks: ["Compare the redirect URI in ONES with the provider-side callback URL."],
    required_followup_info: ["The exact redirect URI configured in ONES and in the provider console."],
    when_to_handoff: "Escalate only if both callback URLs match and the issue still reproduces."
  });

  const validationReference: SearchReference = {
    documentId: "doc:github-callback-troubleshooting",
    evidenceId: "chunk:callback-mismatch",
    title: "GitHub callback troubleshooting",
    snippet: "Callback URL mismatch causes the integration to fail. Compare the configured redirect URI with the provider callback URL.",
    sourceUrl: "https://docs.ones.com/integrations/github/callback-troubleshooting",
    path: "docs/integrations/github/callback-troubleshooting.mdx",
    headingPath: "Most common cause",
    authority: "canonical_visible",
    sourceType: "github_kb",
    score: 0.98,
    retrievedAt: "2026-04-10T05:30:00.000Z"
  };

  const orchestrator = {
    normalizeQuery(query: string) {
      return query.trim().toLowerCase();
    },
    async collectEvidence(input: { query?: string; queries?: string[] }) {
      return {
        query: input.query ?? input.queries?.[0] ?? "",
        answer: "",
        confidence: 0.98,
        references: [validationReference],
        retrievalStatus: "grounded" as const,
        unresolvedReasonCode: null,
        resolvedQueries: input.queries ?? [],
        fallbackUsed: false
      };
    },
    combineEvidenceCollections<T>(items: T[]) {
      return items[0];
    },
    async refineEvidence() {
      throw new Error("supervisor-domain runtime must not refine evidence");
    }
  };

  try {
    const result = await coreRunSupportSearchAgent({
      query: "GitHub callback keeps failing after OAuth setup",
      language: "en",
      currentRound: 0,
      conversationHistory: [],
      adapter,
      orchestrator: orchestrator as never,
      idempotencyKey: "support-supervisor-domain-docs-troubleshooting"
    });

    assert.equal((result.result.internal_diagnostics as { runtime_mode?: string } | undefined)?.runtime_mode, "supervisor_domain");
    assert.equal(
      ((result.result.internal_diagnostics as { route?: { primary_domain?: string } } | undefined)?.route?.primary_domain),
      "docs"
    );
    assert.equal(result.result.support_answer?.render_variant, "troubleshooting");
    assert.match(result.result.answer, /callback URL mismatch/i);
    assert.deepEqual(result.result.citations.map((item) => item.id), ["chunk:callback-mismatch"]);
    assert.equal(result.stageTimings.retrieval_extra.status, "skipped");
    assert.ok(
      result.result.support_answer?.sections.some(
        (section) =>
          section.kind === "bullet_list" &&
          section.title === "Checks to run now" &&
          section.items.includes("Compare the redirect URI in ONES with the provider-side callback URL.")
      )
    );
    assert.ok(
      result.result.support_answer?.sections.some(
        (section) =>
          section.kind === "bullet_list" &&
          section.title === "Still needed" &&
          section.items.includes("The exact redirect URI configured in ONES and in the provider console.")
      )
    );
  } finally {
    mutableEnv.FEATURE_SUPPORT_AGENT_SINGLE_AGENT_RUNTIME = originalSingleAgentRuntime;
    mutableEnv.OPENCLAW_AGENT_ID_SUPPORT_MAIN = originalSupportMainAgentId;
  }
});

test("runSupportSearchAgent supervisor-domain runtime canonicalizes freeform docs troubleshooting taxonomy before evidence filtering", async () => {
  const mutableEnv = env as {
    FEATURE_SUPPORT_AGENT_SINGLE_AGENT_RUNTIME?: boolean;
    OPENCLAW_AGENT_ID_SUPPORT_MAIN?: string;
  };
  const originalSingleAgentRuntime = mutableEnv.FEATURE_SUPPORT_AGENT_SINGLE_AGENT_RUNTIME;
  const originalSupportMainAgentId = mutableEnv.OPENCLAW_AGENT_ID_SUPPORT_MAIN;
  mutableEnv.FEATURE_SUPPORT_AGENT_SINGLE_AGENT_RUNTIME = true;
  mutableEnv.OPENCLAW_AGENT_ID_SUPPORT_MAIN = "support-main";

  const adapter = createAdapter({}) as OpenClawAdapter & {
    planSupportDispatch?: (
      input: {
        contextType: "search" | "triage";
        language: "zh" | "en";
        query: string;
      },
      idempotencyKey: string,
      runtime?: OpenClawRuntimeContext
    ) => Promise<unknown>;
    writeDocsDomainAnswer?: (
      input: OpenClawSupportSpecialistInput,
      idempotencyKey: string,
      runtime?: OpenClawRuntimeContext
    ) => Promise<SpecialistDraftAnswer>;
    planSupportMainAgent?: (...args: unknown[]) => Promise<unknown>;
    draftSupportMainAgent?: (...args: unknown[]) => Promise<unknown>;
  };

  adapter.planSupportMainAgent = async () => {
    throw new Error("support-main fallback must not run when supervisor-domain runtime is available");
  };
  adapter.draftSupportMainAgent = async () => {
    throw new Error("support-main draft must not run when supervisor-domain runtime is available");
  };
  adapter.routeSupportQuestion = async () => {
    throw new Error("legacy router must not run when supervisor-domain runtime is available");
  };
  adapter.planSupportEvidence = async () => {
    throw new Error("legacy evidence planner must not run when supervisor-domain runtime is available");
  };
  adapter.planSupportCase = async () => {
    throw new Error("legacy case planner must not run when supervisor-domain runtime is available");
  };
  adapter.judgeSupportAnswer = async () => {
    throw new Error("judge stage must not run in supervisor-domain runtime");
  };
  adapter.composeCustomerAnswer = async () => {
    throw new Error("answer composer must not run in supervisor-domain runtime");
  };
  adapter.planSupportDispatch = async () => ({
    primaryDomain: "docs",
    route: {
      question_type: "troubleshooting",
      user_goal: "learn how to capture a HAR file for troubleshooting",
      answer_contract:
        "Provide concise step-by-step instructions for generating a HAR file in a browser for support troubleshooting, including where to open DevTools, how to record/export the HAR, and basic privacy caution before sharing.",
      specialist_agent: "troubleshooting-specialist",
      routing_confidence: 0.98,
      primary_domain: "docs"
    },
    caseFrame: {
      goal: "Get instructions for capturing a HAR file to support troubleshooting.",
      symptom: "User asks how to obtain a HAR file and likely needs it for diagnosis.",
      object: "HAR file (HTTP Archive) captured from browser network activity",
      action_type: "collect_diagnostic_artifact",
      deployment_model: "unknown",
      product_area: "troubleshooting/support diagnostics",
      constraints: [
        "Must not answer directly here; only frame for retrieval.",
        "Need published-doc guidance, ideally browser-based and support-oriented."
      ],
      missing_critical_info: [],
      retrieval_queries: [
        "HAR file capture troubleshooting how to export browser network log for support",
        "collect HAR file Chrome DevTools export HTTP Archive troubleshooting"
      ],
      question_type: "troubleshooting",
      specialist_agent: "troubleshooting-specialist",
      answer_contract:
        "Provide concise step-by-step instructions for generating a HAR file in a browser for support troubleshooting, including where to open DevTools, how to record/export the HAR, and basic privacy caution before sharing.",
      routing_confidence: 0.98,
      primary_domain: "docs",
      required_doc_kinds: ["troubleshooting guide", "support diagnostic artifact guide", "browser/network debugging instructions"]
    },
    retrievalQueries: [
      "HAR file capture troubleshooting how to export browser network log for support",
      "collect HAR file Chrome DevTools export HTTP Archive troubleshooting",
      "how to get a har file for troubule shooting?"
    ]
  });
  adapter.writeDocsDomainAnswer = async (input) => ({
    question_type: "troubleshooting",
    render_variant: "troubleshooting",
    direct_answer:
      input.evidenceBundle.primary.length > 0
        ? "Open your browser DevTools, reproduce the issue in the Network tab, then export the HAR before sharing it with support."
        : "I’m sorry, but there is still not enough verified evidence for a reliable final answer.",
    claims:
      input.evidenceBundle.primary.length > 0
        ? [
            {
              text: "The HAR capture guide says to record the issue in the browser Network tab and export the HAR file before sending it to support.",
              kind: "verified_fact",
              evidence_ids: input.evidenceBundle.primary.map((item) => resolveSearchReferenceEvidenceId(item)).slice(0, 1),
              authority: "canonical"
            }
          ]
        : [],
    next_actions: ["Share the exported HAR with support after checking whether sensitive data should be redacted."],
    unknowns: input.evidenceBundle.primary.length > 0 ? [] : ["No published HAR capture guidance found."],
    escalation_needed: input.evidenceBundle.primary.length === 0,
    most_likely_causes: [],
    recommended_checks: ["Open DevTools, use the Network tab, reproduce the issue, then export the HAR file."],
    required_followup_info: [],
    when_to_handoff: "Escalate only if the HAR export still cannot be generated after following the documented browser steps."
  });

  const validationReference: SearchReference = {
    documentId: "doc:har-capture",
    evidenceId: "chunk:har-capture",
    title: "Capture a HAR file for troubleshooting",
    snippet:
      "Open DevTools, switch to the Network tab, reproduce the issue, then use Save all as HAR with content before sharing it with support.",
    sourceUrl: "https://docs.ones.com/support/har-capture",
    path: "docs/support/har-capture.mdx",
    headingPath: "Capture steps",
    authority: "canonical_visible",
    sourceType: "github_kb",
    score: 0.97,
    retrievedAt: "2026-04-13T03:10:00.000Z",
    supportMetadata: {
      product_area: "general",
      deployment_model: "shared",
      evidence_kind: "procedure",
      doc_kind: "product_guide"
    }
  };

  let observedCaseFrame: SupportCaseFrame | undefined;
  const orchestrator = {
    normalizeQuery(query: string) {
      return query.trim().toLowerCase();
    },
    async collectEvidence(input: { caseFrame?: SupportCaseFrame; query?: string; queries?: string[] }) {
      observedCaseFrame = input.caseFrame;
      const normalizedDocKinds = [...(input.caseFrame?.required_doc_kinds ?? [])].sort();
      const canonicalized =
        input.caseFrame?.product_area === "general" &&
        JSON.stringify(normalizedDocKinds) === JSON.stringify(["product_guide", "troubleshooting"]);
      return {
        query: input.query ?? input.queries?.[0] ?? "",
        answer: "",
        confidence: canonicalized ? 0.97 : 0,
        references: canonicalized ? [validationReference] : [],
        retrievalStatus: canonicalized ? ("grounded" as const) : ("no_results" as const),
        unresolvedReasonCode: canonicalized ? null : ("NO_MATCHING_KB" as const),
        resolvedQueries: input.queries ?? [],
        fallbackUsed: false
      };
    },
    combineEvidenceCollections<T>(items: T[]) {
      return items[0];
    },
    async refineEvidence() {
      throw new Error("supervisor-domain runtime must not refine evidence");
    }
  };

  try {
    const result = await coreRunSupportSearchAgent({
      query: "how to get a har file for troubule shooting?",
      language: "en",
      currentRound: 0,
      conversationHistory: [],
      adapter,
      orchestrator: orchestrator as never,
      idempotencyKey: "support-supervisor-domain-docs-har-taxonomy",
      runtime: {
        deliveryMode: "async_job",
        overallTimeoutMs: 240000,
        requestStartedAtMs: Date.now()
      }
    });

    assert.equal(observedCaseFrame?.product_area, "general");
    assert.deepEqual([...(observedCaseFrame?.required_doc_kinds ?? [])].sort(), ["product_guide", "troubleshooting"]);
    assert.equal(result.result.retrieval_status, "grounded");
    assert.deepEqual(result.result.citations.map((item) => item.id), ["chunk:har-capture"]);
    assert.match(result.result.answer, /network tab/i);
  } finally {
    mutableEnv.FEATURE_SUPPORT_AGENT_SINGLE_AGENT_RUNTIME = originalSingleAgentRuntime;
    mutableEnv.OPENCLAW_AGENT_ID_SUPPORT_MAIN = originalSupportMainAgentId;
  }
});

test("runSupportSearchAgent supervisor-domain fallback planner keeps HAR troubleshooting on docs evidence instead of drifting to openapi noise", async () => {
  const mutableEnv = env as {
    FEATURE_SUPPORT_AGENT_SINGLE_AGENT_RUNTIME?: boolean;
    OPENCLAW_AGENT_ID_SUPPORT_MAIN?: string;
  };
  const originalSingleAgentRuntime = mutableEnv.FEATURE_SUPPORT_AGENT_SINGLE_AGENT_RUNTIME;
  const originalSupportMainAgentId = mutableEnv.OPENCLAW_AGENT_ID_SUPPORT_MAIN;
  mutableEnv.FEATURE_SUPPORT_AGENT_SINGLE_AGENT_RUNTIME = true;
  mutableEnv.OPENCLAW_AGENT_ID_SUPPORT_MAIN = "support-main";

  const adapter = createAdapter({}) as OpenClawAdapter & {
    planSupportDispatch?: (
      input: {
        contextType: "search" | "triage";
        language: "zh" | "en";
        query: string;
      },
      idempotencyKey: string,
      runtime?: OpenClawRuntimeContext
    ) => Promise<unknown>;
    writeDocsDomainAnswer?: (
      input: OpenClawSupportSpecialistInput,
      idempotencyKey: string,
      runtime?: OpenClawRuntimeContext
    ) => Promise<SpecialistDraftAnswer>;
    planSupportMainAgent?: (...args: unknown[]) => Promise<unknown>;
    draftSupportMainAgent?: (...args: unknown[]) => Promise<unknown>;
  };

  adapter.planSupportMainAgent = async () => {
    throw new Error("support-main fallback must not run when supervisor-domain runtime is available");
  };
  adapter.draftSupportMainAgent = async () => {
    throw new Error("support-main draft must not run when supervisor-domain runtime is available");
  };
  adapter.routeSupportQuestion = async () => {
    throw new Error("legacy router must not run when supervisor-domain runtime is available");
  };
  adapter.planSupportEvidence = async () => {
    throw new Error("legacy evidence planner must not run when supervisor-domain runtime is available");
  };
  adapter.planSupportCase = async () => {
    throw new Error("legacy case planner must not run when supervisor-domain runtime is available");
  };
  adapter.judgeSupportAnswer = async () => {
    throw new Error("judge stage must not run in supervisor-domain runtime");
  };
  adapter.planSupportDispatch = async () => {
    throw new Error("simulate planner fallback");
  };
  adapter.writeDocsDomainAnswer = async (input) => ({
    question_type: input.route.question_type,
    render_variant: "how_to",
    direct_answer: "Open your browser DevTools, keep the Network tab recording, reproduce the issue, then export the HAR file.",
    claims: [
      {
        text: "The HAR troubleshooting guide explains that you should record the issue in the browser Network tab and export the HAR file.",
        kind: "verified_fact",
        evidence_ids: input.evidenceBundle.primary.map((item) => resolveSearchReferenceEvidenceId(item)).slice(0, 1),
        authority: "canonical"
      }
    ],
    next_actions: [
      "Open DevTools and start recording in the Network tab.",
      "Reproduce the issue and export the HAR file."
    ],
    unknowns: [],
    escalation_needed: false,
    steps: [
      "Open DevTools and start recording in the Network tab.",
      "Reproduce the issue and export the HAR file."
    ]
  });

  const references: SearchReference[] = [
    {
      documentId: "doc:oauth-openapi-troubleshooting-1",
      evidenceId: "chunk:oauth-openapi-troubleshooting-1",
      title: "Troubleshooting",
      snippet: "OpenAPI 403: check app.oauth.scope and token settings.",
      sourceUrl: "https://docs.ones.com/developer/guide/getting-started/app-oauth",
      path: "open-docs/docs/guide/getting-started/access-openapi.mdx",
      headingPath: "Access Open API > Troubleshooting",
      authority: "canonical_visible",
      sourceType: "github_kb",
      score: 0.615,
      retrievedAt: "2026-04-13T07:42:48.172Z",
      supportMetadata: {
        product_area: "openapi",
        deployment_model: "shared",
        evidence_kind: "troubleshooting",
        doc_kind: "troubleshooting"
      }
    },
    {
      documentId: "doc:oauth-openapi-troubleshooting-2",
      evidenceId: "chunk:oauth-openapi-troubleshooting-2",
      title: "Troubleshooting",
      snippet: "OpenAPI 403: ensure token scope is configured correctly.",
      sourceUrl: "https://docs.ones.com/developer/guide/getting-started/app-websdk",
      path: "open-docs/docs/guide/getting-started/use-websdk.mdx",
      headingPath: "Use Web SDK > Troubleshooting",
      authority: "canonical_visible",
      sourceType: "github_kb",
      score: 0.407,
      retrievedAt: "2026-04-13T07:42:48.172Z",
      supportMetadata: {
        product_area: "openapi",
        deployment_model: "shared",
        evidence_kind: "troubleshooting",
        doc_kind: "troubleshooting"
      }
    },
    {
      documentId: "doc:extensions-troubleshooting",
      evidenceId: "chunk:extensions-troubleshooting",
      title: "Troubleshooting",
      snippet: "Common extension troubleshooting issues.",
      sourceUrl: "https://docs.ones.com/developer/guide/getting-started/app-extensions",
      path: "open-docs/docs/guide/getting-started/use-extensions.mdx",
      headingPath: "Use Extensions > Troubleshooting",
      authority: "canonical_visible",
      sourceType: "github_kb",
      score: 0.403,
      retrievedAt: "2026-04-13T07:42:48.172Z",
      supportMetadata: {
        product_area: "general",
        deployment_model: "shared",
        evidence_kind: "troubleshooting",
        doc_kind: "troubleshooting"
      }
    },
    {
      documentId: "doc:har-capture-live",
      evidenceId: "chunk:har-capture-live",
      title: "Capture a HAR file for troubleshooting",
      snippet: "Open DevTools, switch to the Network tab, reproduce the issue, then export the HAR file.",
      sourceUrl: "https://docs.ones.com/operations-toolkit/capture-a-har-file-for-troubleshooting",
      path: "docs/operations-toolkit/capture-a-har-file-for-troubleshooting.mdx",
      headingPath: "Capture a HAR file for troubleshooting",
      authority: "canonical_visible",
      sourceType: "github_kb",
      score: 0.61,
      retrievedAt: "2026-04-13T07:42:48.172Z",
      supportMetadata: {
        product_area: "general",
        deployment_model: "shared",
        evidence_kind: "troubleshooting",
        doc_kind: "troubleshooting"
      }
    }
  ];

  const orchestrator = {
    normalizeQuery(query: string) {
      return query.trim().toLowerCase();
    },
    async collectEvidence(input: { query?: string; queries?: string[] }) {
      return {
        query: input.query ?? input.queries?.[0] ?? "",
        answer: "",
        confidence: 0.62,
        references,
        retrievalStatus: "grounded" as const,
        unresolvedReasonCode: null,
        resolvedQueries: input.queries ?? [],
        fallbackUsed: false
      };
    },
    combineEvidenceCollections<T>(items: T[]) {
      return items[0];
    },
    async refineEvidence() {
      throw new Error("supervisor-domain runtime must not refine evidence");
    }
  };

  try {
    const result = await coreRunSupportSearchAgent({
      query: "how to get a har file for troubule shooting?",
      language: "en",
      currentRound: 0,
      conversationHistory: [],
      adapter,
      orchestrator: orchestrator as never,
      idempotencyKey: "support-supervisor-domain-har-fallback-live-regression",
      runtime: {
        deliveryMode: "async_job",
        overallTimeoutMs: 240000,
        requestStartedAtMs: Date.now()
      }
    });

    assert.equal(
      ((result.result.internal_diagnostics as { route?: { specialist_agent?: string } } | undefined)?.route?.specialist_agent),
      "howto-specialist"
    );
    assert.equal(
      ((result.result.internal_diagnostics as { route?: { primary_domain?: string } } | undefined)?.route?.primary_domain),
      "docs"
    );
    assert.equal(result.result.support_answer?.render_variant, "how_to");
    assert.deepEqual(result.result.citations.map((item) => item.id), ["chunk:har-capture-live"]);
    assert.match(result.result.answer, /network tab/i);
  } finally {
    mutableEnv.FEATURE_SUPPORT_AGENT_SINGLE_AGENT_RUNTIME = originalSingleAgentRuntime;
    mutableEnv.OPENCLAW_AGENT_ID_SUPPORT_MAIN = originalSupportMainAgentId;
  }
});

test("runSupportSearchAgent supervisor-domain runtime recovers a grounded HAR how-to answer when docs specialist and answer composer both fall back", async () => {
  const mutableEnv = env as {
    FEATURE_SUPPORT_AGENT_SINGLE_AGENT_RUNTIME?: boolean;
    OPENCLAW_AGENT_ID_SUPPORT_MAIN?: string;
    LOCAL_DOCS_COM_PATH?: string;
  };
  const originalSingleAgentRuntime = mutableEnv.FEATURE_SUPPORT_AGENT_SINGLE_AGENT_RUNTIME;
  const originalSupportMainAgentId = mutableEnv.OPENCLAW_AGENT_ID_SUPPORT_MAIN;
  const originalLocalDocsPath = mutableEnv.LOCAL_DOCS_COM_PATH;
  const originalFetch = globalThis.fetch;
  mutableEnv.FEATURE_SUPPORT_AGENT_SINGLE_AGENT_RUNTIME = true;
  mutableEnv.OPENCLAW_AGENT_ID_SUPPORT_MAIN = "support-main";
  mutableEnv.LOCAL_DOCS_COM_PATH = "";

  let observedFetchCount = 0;
  globalThis.fetch = (async (input: string | URL | { url?: string | URL }) => {
    const requestUrl =
      input instanceof URL
        ? input.toString()
        : typeof input === "string"
        ? input
        : input?.url instanceof URL
        ? input.url.toString()
        : String(input?.url ?? "");

    if (requestUrl === "https://docs.ones.com/operations-toolkit/capture-a-har-file-for-troubleshooting") {
      observedFetchCount += 1;
      return new Response(
        `<!doctype html>
        <html lang="en">
          <body>
            <main>
              <article>
                <h1>Capture a HAR file for troubleshooting</h1>
                <p>Follow the documented browser procedure to capture a HAR file before sending it to support.</p>
                <h2>Steps</h2>
                <ol>
                  <li>Open your browser DevTools.</li>
                  <li>Switch to the Network tab and keep recording enabled.</li>
                  <li>Reproduce the issue in the browser.</li>
                  <li>Use Save all as HAR with content to export the HAR file.</li>
                </ol>
                <h2>Notes</h2>
                <ul>
                  <li>Review the HAR file for sensitive data before sharing it with support.</li>
                </ul>
              </article>
            </main>
          </body>
        </html>`,
        {
          status: 200,
          headers: {
            "content-type": "text/html; charset=utf-8"
          }
        }
      );
    }

    throw new Error(`unexpected fetch in HAR recovery test: ${requestUrl}`);
  }) as typeof globalThis.fetch;

  const adapter = createAdapter({}) as OpenClawAdapter & {
    planSupportDispatch?: (
      input: {
        contextType: "search" | "triage";
        language: "zh" | "en";
        query: string;
      },
      idempotencyKey: string,
      runtime?: OpenClawRuntimeContext
    ) => Promise<unknown>;
    writeDocsDomainAnswer?: (
      input: OpenClawSupportSpecialistInput,
      idempotencyKey: string,
      runtime?: OpenClawRuntimeContext
    ) => Promise<SpecialistDraftAnswer>;
    composeCustomerAnswer?: (
      input: OpenClawSupportAnswerComposerInput,
      idempotencyKey: string,
      runtime?: OpenClawRuntimeContext
    ) => Promise<Omit<SupportAnswer, "mode">>;
    planSupportMainAgent?: (...args: unknown[]) => Promise<unknown>;
    draftSupportMainAgent?: (...args: unknown[]) => Promise<unknown>;
  };

  adapter.planSupportMainAgent = async () => {
    throw new Error("support-main fallback must not run when supervisor-domain runtime is available");
  };
  adapter.draftSupportMainAgent = async () => {
    throw new Error("support-main draft must not run when supervisor-domain runtime is available");
  };
  adapter.routeSupportQuestion = async () => {
    throw new Error("legacy router must not run when supervisor-domain runtime is available");
  };
  adapter.planSupportEvidence = async () => {
    throw new Error("legacy evidence planner must not run when supervisor-domain runtime is available");
  };
  adapter.planSupportCase = async () => {
    throw new Error("legacy case planner must not run when supervisor-domain runtime is available");
  };
  adapter.judgeSupportAnswer = async () => {
    throw new Error("judge stage must not run in supervisor-domain runtime");
  };
  adapter.planSupportDispatch = async () => {
    throw new Error("simulate planner fallback");
  };
  adapter.writeDocsDomainAnswer = async () => {
    throw new Error("simulate docs specialist timeout/fallback");
  };
  adapter.composeCustomerAnswer = async () => {
    throw new Error("simulate answer composer timeout/fallback");
  };

  const references: SearchReference[] = [
    {
      documentId: "doc:oauth-openapi-troubleshooting-1",
      evidenceId: "chunk:oauth-openapi-troubleshooting-1",
      title: "Troubleshooting",
      snippet: "OpenAPI 403: check app.oauth.scope and token settings.",
      sourceUrl: "https://docs.ones.com/developer/guide/getting-started/app-oauth",
      path: "open-docs/docs/guide/getting-started/access-openapi.mdx",
      headingPath: "Access Open API > Troubleshooting",
      authority: "canonical_visible",
      sourceType: "github_kb",
      score: 0.6148196721311475,
      retrievedAt: "2026-04-13T08:21:12.485Z",
      supportMetadata: {
        product_area: "openapi",
        deployment_model: "shared",
        evidence_kind: "troubleshooting",
        doc_kind: "troubleshooting"
      }
    },
    {
      documentId: "doc:oauth-openapi-troubleshooting-2",
      evidenceId: "chunk:oauth-openapi-troubleshooting-2",
      title: "Troubleshooting",
      snippet: "OpenAPI 403: ensure token scope is configured correctly.",
      sourceUrl: "https://docs.ones.com/developer/guide/getting-started/app-websdk",
      path: "open-docs/docs/guide/getting-started/use-websdk.mdx",
      headingPath: "Use Web SDK > Troubleshooting",
      authority: "canonical_visible",
      sourceType: "github_kb",
      score: 0.4067741935483871,
      retrievedAt: "2026-04-13T08:21:12.485Z",
      supportMetadata: {
        product_area: "openapi",
        deployment_model: "shared",
        evidence_kind: "troubleshooting",
        doc_kind: "troubleshooting"
      }
    },
    {
      documentId: "doc:extensions-troubleshooting",
      evidenceId: "chunk:extensions-troubleshooting",
      title: "Troubleshooting",
      snippet: "Common extension troubleshooting issues.",
      sourceUrl: "https://docs.ones.com/developer/guide/getting-started/app-extensions",
      path: "open-docs/docs/guide/getting-started/use-extensions.mdx",
      headingPath: "Use Extensions > Troubleshooting",
      authority: "canonical_visible",
      sourceType: "github_kb",
      score: 0.40285714285714286,
      retrievedAt: "2026-04-13T08:21:12.485Z",
      supportMetadata: {
        product_area: "general",
        deployment_model: "shared",
        evidence_kind: "troubleshooting",
        doc_kind: "troubleshooting"
      }
    },
    {
      documentId: "doc:har-capture-live",
      evidenceId: "chunk:har-capture-live",
      title: "捕获故障排除的 HAR 文件",
      snippet:
        "当使用 ONES.com 系统遇到问题时，技术支持团队可能会要求您获取浏览器生成的 HAR（HTTP Archive）文件，以帮助识别问题的根本原因。以下是捕获 HAR 文件的分步说明。",
      sourceUrl: "https://docs.ones.com/operations-toolkit/capture-a-har-file-for-troubleshooting",
      path: "docs/operations-toolkit/capture-a-har-file-for-troubleshooting.mdx",
      headingPath: "捕获故障排除的 HAR 文件",
      authority: "canonical_visible",
      sourceType: "github_kb",
      score: 0.6098783712321523,
      retrievedAt: "2026-04-13T08:21:12.485Z",
      supportMetadata: {
        product_area: "general",
        deployment_model: "shared",
        evidence_kind: "troubleshooting",
        doc_kind: "troubleshooting"
      }
    }
  ];

  const orchestrator = {
    normalizeQuery(query: string) {
      return query.trim().toLowerCase();
    },
    async collectEvidence(input: { query?: string; queries?: string[] }) {
      return {
        query: input.query ?? input.queries?.[0] ?? "",
        answer: "",
        confidence: 0.68,
        references,
        retrievalStatus: "grounded" as const,
        unresolvedReasonCode: null,
        resolvedQueries: input.queries ?? [],
        fallbackUsed: false
      };
    },
    combineEvidenceCollections<T>(items: T[]) {
      return items[0];
    },
    async refineEvidence() {
      throw new Error("supervisor-domain runtime must not refine evidence");
    }
  };

  try {
    const result = await coreRunSupportSearchAgent({
      query: "how to get a har file for troubule shooting?",
      language: "en",
      currentRound: 0,
      conversationHistory: [],
      adapter,
      orchestrator: orchestrator as never,
      idempotencyKey: "support-supervisor-domain-har-fallback-recovers-grounded-howto",
      runtime: {
        deliveryMode: "async_job",
        overallTimeoutMs: 240000,
        requestStartedAtMs: Date.now()
      }
    });

    assert.equal(observedFetchCount, 1);
    assert.equal(
      ((result.result.internal_diagnostics as { route?: { specialist_agent?: string } } | undefined)?.route?.specialist_agent),
      "howto-specialist"
    );
    assert.equal(result.result.support_answer?.mode, "grounded");
    assert.equal(result.result.support_answer?.render_variant, "how_to");
    assert.equal(result.result.citations.some((item) => item.id === "chunk:har-capture-live"), true);
    assert.match(result.result.answer, /network tab|export the har file|save all as har/i);
    assert.notEqual(result.result.state, "TICKET_HANDOFF_RECOMMENDED");
  } finally {
    mutableEnv.FEATURE_SUPPORT_AGENT_SINGLE_AGENT_RUNTIME = originalSingleAgentRuntime;
    mutableEnv.OPENCLAW_AGENT_ID_SUPPORT_MAIN = originalSupportMainAgentId;
    mutableEnv.LOCAL_DOCS_COM_PATH = originalLocalDocsPath;
    globalThis.fetch = originalFetch;
  }
});

test("runSupportSearchAgent supervisor-domain runtime strips docs-shell headings and unrelated notes from recovered HAR how-to answers", async () => {
  const mutableEnv = env as {
    FEATURE_SUPPORT_AGENT_SINGLE_AGENT_RUNTIME?: boolean;
    OPENCLAW_AGENT_ID_SUPPORT_MAIN?: string;
    LOCAL_DOCS_COM_PATH?: string;
  };
  const originalSingleAgentRuntime = mutableEnv.FEATURE_SUPPORT_AGENT_SINGLE_AGENT_RUNTIME;
  const originalSupportMainAgentId = mutableEnv.OPENCLAW_AGENT_ID_SUPPORT_MAIN;
  const originalLocalDocsPath = mutableEnv.LOCAL_DOCS_COM_PATH;
  const originalFetch = globalThis.fetch;
  mutableEnv.FEATURE_SUPPORT_AGENT_SINGLE_AGENT_RUNTIME = true;
  mutableEnv.OPENCLAW_AGENT_ID_SUPPORT_MAIN = "support-main";
  mutableEnv.LOCAL_DOCS_COM_PATH = "";

  let observedFetchCount = 0;
  globalThis.fetch = (async (input: string | URL | { url?: string | URL }) => {
    const requestUrl =
      input instanceof URL
        ? input.toString()
        : typeof input === "string"
        ? input
        : input?.url instanceof URL
        ? input.url.toString()
        : String(input?.url ?? "");

    if (requestUrl === "https://docs.ones.com/operations-toolkit/capture-a-har-file-for-troubleshooting") {
      observedFetchCount += 1;
      return new Response(
        `<!doctype html>
        <html lang="en">
          <body>
            <main>
              <article>
                <nav>
                  <ul>
                    <li>OPERATIONS TOOLKIT</li>
                    <li>Capture a HAR file for troubleshooting</li>
                  </ul>
                </nav>
                <h1>Capture a HAR file for troubleshooting</h1>
                <p>Use the documented browser flow to capture a HAR file before sending it to support.</p>
                <h2>Steps to capture HAR file</h2>
                <div class="alert alert--info">
                  <div>info</div>
                  <p>This guide uses Google Chrome as an example. Steps for other browsers may vary slightly, but the process is generally similar.</p>
                </div>
                <h4>1. Open the browser where the issue occurred</h4>
                <p>Ensure you are using the same browser where the issue occurred.</p>
                <h4>2. Prepare the necessary account, project, and issues</h4>
                <p>Make sure you are logged into the account, project, and module where the issue occurred so you can reproduce it consistently.</p>
                <h4>3. Reproduce the issue in inspect mode</h4>
                <ul>
                  <li>Open Inspect Mode in your browser.</li>
                  <li>Perform the steps on the page to reproduce the issue.</li>
                  <li>After reproducing the issue, export and save the HAR file.</li>
                </ul>
                <p>Provide the generated HAR file to ONES technical support.</p>
              </article>
            </main>
          </body>
        </html>`,
        {
          status: 200,
          headers: {
            "content-type": "text/html; charset=utf-8"
          }
        }
      );
    }

    throw new Error(`unexpected fetch in HAR contamination test: ${requestUrl}`);
  }) as typeof globalThis.fetch;

  const adapter = createAdapter({}) as OpenClawAdapter & {
    planSupportDispatch?: (
      input: {
        contextType: "search" | "triage";
        language: "zh" | "en";
        query: string;
      },
      idempotencyKey: string,
      runtime?: OpenClawRuntimeContext
    ) => Promise<unknown>;
    writeDocsDomainAnswer?: (
      input: OpenClawSupportSpecialistInput,
      idempotencyKey: string,
      runtime?: OpenClawRuntimeContext
    ) => Promise<SpecialistDraftAnswer>;
    composeCustomerAnswer?: (
      input: OpenClawSupportAnswerComposerInput,
      idempotencyKey: string,
      runtime?: OpenClawRuntimeContext
    ) => Promise<Omit<SupportAnswer, "mode">>;
    planSupportMainAgent?: (...args: unknown[]) => Promise<unknown>;
    draftSupportMainAgent?: (...args: unknown[]) => Promise<unknown>;
  };

  adapter.planSupportMainAgent = async () => {
    throw new Error("support-main fallback must not run when supervisor-domain runtime is available");
  };
  adapter.draftSupportMainAgent = async () => {
    throw new Error("support-main draft must not run when supervisor-domain runtime is available");
  };
  adapter.routeSupportQuestion = async () => {
    throw new Error("legacy router must not run when supervisor-domain runtime is available");
  };
  adapter.planSupportEvidence = async () => {
    throw new Error("legacy evidence planner must not run when supervisor-domain runtime is available");
  };
  adapter.planSupportCase = async () => {
    throw new Error("legacy case planner must not run when supervisor-domain runtime is available");
  };
  adapter.judgeSupportAnswer = async () => {
    throw new Error("judge stage must not run in supervisor-domain runtime");
  };
  adapter.planSupportDispatch = async () => {
    throw new Error("simulate planner fallback");
  };
  adapter.writeDocsDomainAnswer = async () => {
    throw new Error("simulate docs specialist timeout/fallback");
  };
  adapter.composeCustomerAnswer = async () => {
    throw new Error("simulate answer composer timeout/fallback");
  };

  const references: SearchReference[] = [
    {
      documentId: "doc:har-capture-live-clean",
      evidenceId: "chunk:har-capture-live-clean",
      title: "Capture a HAR file for troubleshooting",
      snippet: "Documented browser flow for capturing and exporting a HAR file for support.",
      sourceUrl: "https://docs.ones.com/operations-toolkit/capture-a-har-file-for-troubleshooting",
      path: "docs/operations-toolkit/capture-a-har-file-for-troubleshooting.mdx",
      headingPath: "Capture a HAR file for troubleshooting",
      authority: "canonical_visible",
      sourceType: "github_kb",
      score: 0.71,
      retrievedAt: "2026-04-14T01:20:00.000Z",
      supportMetadata: {
        product_area: "general",
        deployment_model: "shared",
        evidence_kind: "troubleshooting",
        doc_kind: "troubleshooting"
      }
    },
    {
      documentId: "doc:manhour-validator-common-issues",
      evidenceId: "chunk:manhour-validator-common-issues",
      title: "Common Issues",
      snippet: "Note: Validation always fails after field type changes until the extension configuration is updated.",
      sourceUrl: "https://kb.ones.internal/developer/guide/extensions/manhour-validator",
      path: "open-docs/docs/abilities/extensions/manhour-validator.mdx",
      headingPath: "Common Issues",
      authority: "canonical_visible",
      sourceType: "github_kb",
      score: 0.68,
      retrievedAt: "2026-04-14T01:20:00.000Z",
      supportMetadata: {
        product_area: "general",
        deployment_model: "shared",
        evidence_kind: "troubleshooting",
        doc_kind: "troubleshooting"
      }
    }
  ];

  const orchestrator = {
    normalizeQuery(query: string) {
      return query.trim().toLowerCase();
    },
    async collectEvidence(input: { query?: string; queries?: string[] }) {
      return {
        query: input.query ?? input.queries?.[0] ?? "",
        answer: "",
        confidence: 0.7,
        references,
        retrievalStatus: "grounded" as const,
        unresolvedReasonCode: null,
        resolvedQueries: input.queries ?? [],
        fallbackUsed: false
      };
    },
    combineEvidenceCollections<T>(items: T[]) {
      return items[0];
    },
    async refineEvidence() {
      throw new Error("supervisor-domain runtime must not refine evidence");
    }
  };

  try {
    const result = await coreRunSupportSearchAgent({
      query: "how to get a har file for troubule shooting?",
      language: "en",
      currentRound: 0,
      conversationHistory: [],
      adapter,
      orchestrator: orchestrator as never,
      idempotencyKey: "support-supervisor-domain-har-fallback-strips-meta-and-unrelated-notes",
      runtime: {
        deliveryMode: "async_job",
        overallTimeoutMs: 240000,
        requestStartedAtMs: Date.now()
      }
    });

    assert.equal(
      ((result.result.internal_diagnostics as { route?: { specialist_agent?: string } } | undefined)?.route?.specialist_agent),
      "howto-specialist"
    );
    assert.equal(result.result.citations.map((item) => item.id).includes("chunk:har-capture-live-clean"), true);
    assert.match(result.result.answer, /inspect mode|devtools/i);
    assert.match(result.result.answer, /network tab|export (and save )?the har file/i);
    assert.doesNotMatch(result.result.answer, /operations toolkit/i);
    assert.doesNotMatch(result.result.answer, /\binfo\b/i);
    assert.doesNotMatch(result.result.answer, /validation always fails/i);
    assert.notEqual(result.result.state, "TICKET_HANDOFF_RECOMMENDED");
  } finally {
    mutableEnv.FEATURE_SUPPORT_AGENT_SINGLE_AGENT_RUNTIME = originalSingleAgentRuntime;
    mutableEnv.OPENCLAW_AGENT_ID_SUPPORT_MAIN = originalSupportMainAgentId;
    mutableEnv.LOCAL_DOCS_COM_PATH = originalLocalDocsPath;
    globalThis.fetch = originalFetch;
  }
});

test("runSupportSearchAgent supervisor-domain runtime recovers grounded deployment sizing requirements from published deploy docs when specialist and composer both fall back", async () => {
  const mutableEnv = env as {
    FEATURE_SUPPORT_AGENT_SINGLE_AGENT_RUNTIME?: boolean;
    OPENCLAW_AGENT_ID_SUPPORT_MAIN?: string;
    LOCAL_DOCS_COM_PATH?: string;
  };
  const originalSingleAgentRuntime = mutableEnv.FEATURE_SUPPORT_AGENT_SINGLE_AGENT_RUNTIME;
  const originalSupportMainAgentId = mutableEnv.OPENCLAW_AGENT_ID_SUPPORT_MAIN;
  const originalLocalDocsPath = mutableEnv.LOCAL_DOCS_COM_PATH;
  const originalFetch = globalThis.fetch;
  mutableEnv.FEATURE_SUPPORT_AGENT_SINGLE_AGENT_RUNTIME = true;
  mutableEnv.OPENCLAW_AGENT_ID_SUPPORT_MAIN = "support-main";
  mutableEnv.LOCAL_DOCS_COM_PATH = "";

  globalThis.fetch = (async (input: string | URL | { url?: string | URL }) => {
    const requestUrl =
      input instanceof URL
        ? input.toString()
        : typeof input === "string"
        ? input
        : input?.url instanceof URL
        ? input.url.toString()
        : String(input?.url ?? "");

    if (requestUrl === "https://docs.ones.com/zh-Hans/deploy/prepare/deployment-requirements") {
      return new Response(
        `<!doctype html>
        <html lang="en">
          <body>
            <main>
              <article>
                <h1>ONES private deployment requirements</h1>
                <p>This page contains the deployment sizing reference for private deployment environments.</p>
                <h2>Per-node resource requirements</h2>
                <table>
                  <thead>
                    <tr>
                      <th>Users</th>
                      <th>CPU</th>
                      <th>Memory</th>
                      <th>Disk</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr>
                      <td>50</td>
                      <td>4 cores</td>
                      <td>8 GB</td>
                      <td>200 GB</td>
                    </tr>
                    <tr>
                      <td>200</td>
                      <td>8 cores</td>
                      <td>16 GB</td>
                      <td>500 GB</td>
                    </tr>
                    <tr>
                      <td>500+</td>
                      <td>16 cores</td>
                      <td>32 GB</td>
                      <td>1 TB</td>
                    </tr>
                  </tbody>
                </table>
              </article>
            </main>
          </body>
        </html>`,
        {
          status: 200,
          headers: {
            "content-type": "text/html; charset=utf-8"
          }
        }
      );
    }

    throw new Error(`unexpected fetch in deployment sizing recovery test: ${requestUrl}`);
  }) as typeof globalThis.fetch;

  const adapter = createAdapter({}) as OpenClawAdapter & {
    planSupportDispatch?: (
      input: {
        contextType: "search" | "triage";
        language: "zh" | "en";
        query: string;
      },
      idempotencyKey: string,
      runtime?: OpenClawRuntimeContext
    ) => Promise<unknown>;
    writeDeploymentDomainAnswer?: (
      input: OpenClawSupportSpecialistInput,
      idempotencyKey: string,
      runtime?: OpenClawRuntimeContext
    ) => Promise<SpecialistDraftAnswer>;
    composeCustomerAnswer?: (
      input: OpenClawSupportAnswerComposerInput,
      idempotencyKey: string,
      runtime?: OpenClawRuntimeContext
    ) => Promise<Omit<SupportAnswer, "mode">>;
    planSupportMainAgent?: (...args: unknown[]) => Promise<unknown>;
    draftSupportMainAgent?: (...args: unknown[]) => Promise<unknown>;
  };

  adapter.planSupportMainAgent = async () => {
    throw new Error("support-main fallback must not run when supervisor-domain runtime is available");
  };
  adapter.draftSupportMainAgent = async () => {
    throw new Error("support-main draft must not run when supervisor-domain runtime is available");
  };
  adapter.routeSupportQuestion = async () => {
    throw new Error("legacy router must not run when supervisor-domain runtime is available");
  };
  adapter.planSupportEvidence = async () => {
    throw new Error("legacy evidence planner must not run when supervisor-domain runtime is available");
  };
  adapter.planSupportCase = async () => {
    throw new Error("legacy case planner must not run when supervisor-domain runtime is available");
  };
  adapter.judgeSupportAnswer = async () => {
    throw new Error("judge stage must not run in supervisor-domain runtime");
  };
  adapter.planSupportDispatch = async (input) => ({
    primaryDomain: "deployment",
    route: {
      question_type: "capability_confirmation",
      user_goal: input.query,
      answer_contract: "State the documented per-node resource requirements first.",
      specialist_agent: "behavior-specialist",
      routing_confidence: 0.96,
      primary_domain: "deployment"
    },
    caseFrame: {
      goal: "Understand the documented per-node resource requirements by deployment size.",
      symptom: "Need a grounded deployment sizing answer from published docs.",
      object: "per-node CPU, memory, and disk requirements",
      action_type: "capability_confirmation",
      deployment_model: "private_deployment",
      product_area: "deployment",
      constraints: [],
      missing_critical_info: [],
      retrieval_queries: ["deployment node cpu memory disk requirements"],
      question_type: "capability_confirmation",
      specialist_agent: "behavior-specialist",
      answer_contract: "State the documented per-node resource requirements first.",
      routing_confidence: 0.96,
      primary_domain: "deployment",
      required_doc_kinds: ["deployment_runbook", "product_guide"]
    },
    retrievalQueries: ["deployment node cpu memory disk requirements"]
  });
  adapter.writeDeploymentDomainAnswer = async () => {
    throw new Error("simulate deployment specialist timeout/fallback");
  };
  adapter.composeCustomerAnswer = async () => {
    throw new Error("simulate answer composer timeout/fallback");
  };

  const references: SearchReference[] = [
    {
      documentId: "doc:deployment-overview",
      evidenceId: "chunk:deployment-overview",
      title: "ONES private deployment requirements",
      snippet: "This page contains the planning reference for private deployment environments.",
      sourceUrl: "https://docs.ones.com/zh-Hans/deploy/prepare/deployment-requirements",
      path: "deploy-docs/prepare/deployment-requirements.md",
      headingPath: "ONES private deployment requirements",
      authority: "canonical_visible",
      sourceType: "github_kb",
      score: 0.58,
      retrievedAt: "2026-04-13T10:20:00.000Z",
      supportMetadata: {
        product_area: "deployment",
        deployment_model: "private_deployment",
        evidence_kind: "constraint",
        doc_kind: "deployment_runbook"
      }
    },
    {
      documentId: "doc:deployment-node-requirements",
      evidenceId: "chunk:deployment-node-requirements",
      title: "Per-node resource requirements",
      snippet: "Sizing matrix for deployment planning across user bands.",
      sourceUrl: "https://docs.ones.com/zh-Hans/deploy/prepare/deployment-requirements",
      path: "deploy-docs/prepare/deployment-requirements.md",
      headingPath: "ONES private deployment requirements > Per-node resource requirements",
      authority: "canonical_visible",
      sourceType: "github_kb",
      score: 0.82,
      retrievedAt: "2026-04-13T10:20:00.000Z",
      supportMetadata: {
        product_area: "deployment",
        deployment_model: "private_deployment",
        evidence_kind: "constraint",
        doc_kind: "deployment_runbook"
      }
    }
  ];

  const orchestrator = {
    normalizeQuery(query: string) {
      return query.trim().toLowerCase();
    },
    async collectEvidence(input: { query?: string; queries?: string[] }) {
      return {
        query: input.query ?? input.queries?.[0] ?? "",
        answer: "",
        confidence: 0.73,
        references,
        retrievalStatus: "grounded" as const,
        unresolvedReasonCode: null,
        resolvedQueries: input.queries ?? [],
        fallbackUsed: false
      };
    },
    combineEvidenceCollections<T>(items: T[]) {
      return items[0];
    },
    async refineEvidence() {
      throw new Error("supervisor-domain runtime must not refine evidence");
    }
  };

  try {
    const result = await coreRunSupportSearchAgent({
      query: "CPU, memory, and disk requirements per node (50 / 200 / 500+ users)?",
      language: "en",
      currentRound: 0,
      conversationHistory: [],
      adapter,
      orchestrator: orchestrator as never,
      idempotencyKey: "support-supervisor-domain-deployment-sizing-recovers-grounded-answer",
      runtime: {
        deliveryMode: "async_job",
        overallTimeoutMs: 240000,
        requestStartedAtMs: Date.now()
      }
    });

    assert.equal(
      ((result.result.internal_diagnostics as { route?: { specialist_agent?: string } } | undefined)?.route?.specialist_agent),
      "behavior-specialist"
    );
    assert.equal(result.result.support_answer?.mode, "grounded");
    assert.equal(result.result.support_answer?.render_variant, "behavior");
    assert.equal(result.result.citations.some((item) => item.id === "chunk:deployment-node-requirements"), true);
    assert.match(result.result.answer, /50/i);
    assert.match(result.result.answer, /4 cores/i);
    assert.match(result.result.answer, /8 gb/i);
    assert.match(result.result.answer, /200 gb/i);
    assert.match(result.result.answer, /500\+/i);
    assert.match(result.result.answer, /1 tb/i);
    assert.notEqual(result.result.state, "TICKET_HANDOFF_RECOMMENDED");
  } finally {
    mutableEnv.FEATURE_SUPPORT_AGENT_SINGLE_AGENT_RUNTIME = originalSingleAgentRuntime;
    mutableEnv.OPENCLAW_AGENT_ID_SUPPORT_MAIN = originalSupportMainAgentId;
    mutableEnv.LOCAL_DOCS_COM_PATH = originalLocalDocsPath;
    globalThis.fetch = originalFetch;
  }
});

test("runSupportSearchAgent supervisor-domain runtime corrects deployment sizing queries away from troubleshooting when evidence is a requirements matrix", async () => {
  const mutableEnv = env as {
    FEATURE_SUPPORT_AGENT_SINGLE_AGENT_RUNTIME?: boolean;
    OPENCLAW_AGENT_ID_SUPPORT_MAIN?: string;
    LOCAL_DOCS_COM_PATH?: string;
  };
  const originalSingleAgentRuntime = mutableEnv.FEATURE_SUPPORT_AGENT_SINGLE_AGENT_RUNTIME;
  const originalSupportMainAgentId = mutableEnv.OPENCLAW_AGENT_ID_SUPPORT_MAIN;
  const originalLocalDocsPath = mutableEnv.LOCAL_DOCS_COM_PATH;
  const originalFetch = globalThis.fetch;
  mutableEnv.FEATURE_SUPPORT_AGENT_SINGLE_AGENT_RUNTIME = true;
  mutableEnv.OPENCLAW_AGENT_ID_SUPPORT_MAIN = "support-main";
  mutableEnv.LOCAL_DOCS_COM_PATH = "";

  let observedFetchCount = 0;
  globalThis.fetch = (async (input: string | URL | { url?: string | URL }) => {
    const requestUrl =
      input instanceof URL
        ? input.toString()
        : typeof input === "string"
        ? input
        : input?.url instanceof URL
        ? input.url.toString()
        : String(input?.url ?? "");

    if (requestUrl === "https://docs.ones.com/zh-Hans/deploy/prepare/deployment-requirements") {
      observedFetchCount += 1;
      return new Response(
        `<!doctype html>
        <html lang="en">
          <body>
            <main>
              <article>
                <h1>ONES private deployment requirements</h1>
                <p>This page contains the deployment sizing reference for private deployment environments.</p>
                <h2>Per-node resource requirements</h2>
                <table>
                  <thead>
                    <tr>
                      <th>Users</th>
                      <th>CPU</th>
                      <th>Memory</th>
                      <th>Disk</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr>
                      <td>50</td>
                      <td>4 cores</td>
                      <td>8 GB</td>
                      <td>200 GB</td>
                    </tr>
                    <tr>
                      <td>200</td>
                      <td>8 cores</td>
                      <td>16 GB</td>
                      <td>500 GB</td>
                    </tr>
                    <tr>
                      <td>500+</td>
                      <td>16 cores</td>
                      <td>32 GB</td>
                      <td>1 TB</td>
                    </tr>
                  </tbody>
                </table>
              </article>
            </main>
          </body>
        </html>`,
        {
          status: 200,
          headers: {
            "content-type": "text/html; charset=utf-8"
          }
        }
      );
    }

    throw new Error(`unexpected fetch in deployment sizing correction test: ${requestUrl}`);
  }) as typeof globalThis.fetch;

  const adapter = createAdapter({}) as OpenClawAdapter & {
    planSupportDispatch?: (
      input: {
        contextType: "search" | "triage";
        language: "zh" | "en";
        query: string;
      },
      idempotencyKey: string,
      runtime?: OpenClawRuntimeContext
    ) => Promise<unknown>;
    writeDocsDomainAnswer?: (
      input: OpenClawSupportSpecialistInput,
      idempotencyKey: string,
      runtime?: OpenClawRuntimeContext
    ) => Promise<SpecialistDraftAnswer>;
    writeDeploymentDomainAnswer?: (
      input: OpenClawSupportSpecialistInput,
      idempotencyKey: string,
      runtime?: OpenClawRuntimeContext
    ) => Promise<SpecialistDraftAnswer>;
    composeCustomerAnswer?: (
      input: OpenClawSupportAnswerComposerInput,
      idempotencyKey: string,
      runtime?: OpenClawRuntimeContext
    ) => Promise<Omit<SupportAnswer, "mode">>;
    planSupportMainAgent?: (...args: unknown[]) => Promise<unknown>;
    draftSupportMainAgent?: (...args: unknown[]) => Promise<unknown>;
  };

  adapter.planSupportMainAgent = async () => {
    throw new Error("support-main fallback must not run when supervisor-domain runtime is available");
  };
  adapter.draftSupportMainAgent = async () => {
    throw new Error("support-main draft must not run when supervisor-domain runtime is available");
  };
  adapter.routeSupportQuestion = async () => {
    throw new Error("legacy router must not run when supervisor-domain runtime is available");
  };
  adapter.planSupportEvidence = async () => {
    throw new Error("legacy evidence planner must not run when supervisor-domain runtime is available");
  };
  adapter.planSupportCase = async () => {
    throw new Error("legacy case planner must not run when supervisor-domain runtime is available");
  };
  adapter.judgeSupportAnswer = async () => {
    throw new Error("judge stage must not run in supervisor-domain runtime");
  };
  adapter.planSupportDispatch = async (input) => ({
    primaryDomain: "docs",
    route: {
      question_type: "troubleshooting",
      user_goal: input.query,
      answer_contract: "Give the likely cause and the next troubleshooting checks first.",
      specialist_agent: "troubleshooting-specialist",
      routing_confidence: 0.79,
      primary_domain: "docs"
    },
    caseFrame: {
      goal: input.query,
      symptom: input.query,
      object: "unspecified",
      action_type: "troubleshooting",
      deployment_model: "unknown",
      product_area: "general",
      constraints: [],
      missing_critical_info: [],
      retrieval_queries: [input.query],
      question_type: "troubleshooting",
      specialist_agent: "troubleshooting-specialist",
      answer_contract: "Give the likely cause and the next troubleshooting checks first.",
      routing_confidence: 0.79,
      primary_domain: "docs"
    },
    retrievalQueries: [input.query]
  });
  adapter.writeDocsDomainAnswer = async () => {
    throw new Error("simulate docs specialist timeout/fallback");
  };
  adapter.writeDeploymentDomainAnswer = async () => {
    throw new Error("simulate deployment specialist timeout/fallback");
  };
  adapter.composeCustomerAnswer = async () => {
    throw new Error("simulate answer composer timeout/fallback");
  };

  const references: SearchReference[] = [
    {
      documentId: "doc:k3s-node-handler",
      evidenceId: "chunk:k3s-node-handler",
      title: "k3s node handler troubleshooting",
      snippet: "Use this guide when a node handler fails to start or crashes in a private deployment cluster.",
      sourceUrl: "https://docs.ones.com/zh-Hans/deploy/troubleshooting/infra/k3s-node-handler",
      path: "deploy-docs/troubleshooting/infra/k3s-node-handler.md",
      headingPath: "k3s node handler troubleshooting",
      authority: "canonical_visible",
      sourceType: "github_kb",
      score: 0.84,
      retrievedAt: "2026-04-14T01:40:00.000Z",
      supportMetadata: {
        product_area: "deployment",
        deployment_model: "private_deployment",
        evidence_kind: "troubleshooting",
        doc_kind: "troubleshooting"
      }
    },
    {
      documentId: "doc:deployment-overview",
      evidenceId: "chunk:deployment-overview",
      title: "ONES private deployment requirements",
      snippet: "This page contains the planning reference for private deployment environments.",
      sourceUrl: "https://docs.ones.com/zh-Hans/deploy/prepare/deployment-requirements",
      path: "deploy-docs/prepare/deployment-requirements.md",
      headingPath: "ONES private deployment requirements",
      authority: "canonical_visible",
      sourceType: "github_kb",
      score: 0.58,
      retrievedAt: "2026-04-14T01:40:00.000Z",
      supportMetadata: {
        product_area: "deployment",
        deployment_model: "private_deployment",
        evidence_kind: "constraint",
        doc_kind: "deployment_runbook"
      }
    },
    {
      documentId: "doc:deployment-node-requirements",
      evidenceId: "chunk:deployment-node-requirements",
      title: "Per-node resource requirements",
      snippet: "Sizing matrix for deployment planning across user bands.",
      sourceUrl: "https://docs.ones.com/zh-Hans/deploy/prepare/deployment-requirements",
      path: "deploy-docs/prepare/deployment-requirements.md",
      headingPath: "ONES private deployment requirements > Per-node resource requirements",
      authority: "canonical_visible",
      sourceType: "github_kb",
      score: 0.82,
      retrievedAt: "2026-04-14T01:40:00.000Z",
      supportMetadata: {
        product_area: "deployment",
        deployment_model: "private_deployment",
        evidence_kind: "constraint",
        doc_kind: "deployment_runbook"
      }
    }
  ];

  const orchestrator = {
    normalizeQuery(query: string) {
      return query.trim().toLowerCase();
    },
    async collectEvidence(input: { query?: string; queries?: string[] }) {
      return {
        query: input.query ?? input.queries?.[0] ?? "",
        answer: "",
        confidence: 0.76,
        references,
        retrievalStatus: "grounded" as const,
        unresolvedReasonCode: null,
        resolvedQueries: input.queries ?? [],
        fallbackUsed: false
      };
    },
    combineEvidenceCollections<T>(items: T[]) {
      return items[0];
    },
    async refineEvidence() {
      throw new Error("supervisor-domain runtime must not refine evidence");
    }
  };

  try {
    const result = await coreRunSupportSearchAgent({
      query: "CPU, memory, and disk requirements per node (50 / 200 / 500+ users)?",
      language: "en",
      currentRound: 0,
      conversationHistory: [],
      adapter,
      orchestrator: orchestrator as never,
      idempotencyKey: "support-supervisor-domain-deployment-sizing-corrects-troubleshooting-misroute",
      runtime: {
        deliveryMode: "async_job",
        overallTimeoutMs: 240000,
        requestStartedAtMs: Date.now()
      }
    });

    assert.equal(
      ((result.result.internal_diagnostics as { route?: { specialist_agent?: string } } | undefined)?.route?.specialist_agent),
      "behavior-specialist"
    );
    assert.equal(
      ((result.result.internal_diagnostics as { route?: { primary_domain?: string } } | undefined)?.route?.primary_domain),
      "deployment"
    );
    assert.ok(result.result.case_frame);
    assert.equal(result.result.case_frame.product_area, "deployment");
    assert.equal(result.result.citations.some((item) => item.id === "chunk:deployment-node-requirements"), true);
    assert.match(result.result.answer, /50/i);
    assert.match(result.result.answer, /4 cores/i);
    assert.match(result.result.answer, /8 gb/i);
    assert.match(result.result.answer, /500\+/i);
    assert.match(result.result.answer, /1 tb/i);
    assert.notEqual(result.result.state, "TICKET_HANDOFF_RECOMMENDED");
  } finally {
    mutableEnv.FEATURE_SUPPORT_AGENT_SINGLE_AGENT_RUNTIME = originalSingleAgentRuntime;
    mutableEnv.OPENCLAW_AGENT_ID_SUPPORT_MAIN = originalSupportMainAgentId;
    mutableEnv.LOCAL_DOCS_COM_PATH = originalLocalDocsPath;
    globalThis.fetch = originalFetch;
  }
});

test("runSupportSearchAgent supervisor-domain runtime preserves coherent deployment dispatch without forcing an API route from lexical overlap", async () => {
  const mutableEnv = env as {
    FEATURE_SUPPORT_AGENT_SINGLE_AGENT_RUNTIME?: boolean;
    OPENCLAW_AGENT_ID_SUPPORT_MAIN?: string;
  };
  const originalSingleAgentRuntime = mutableEnv.FEATURE_SUPPORT_AGENT_SINGLE_AGENT_RUNTIME;
  const originalSupportMainAgentId = mutableEnv.OPENCLAW_AGENT_ID_SUPPORT_MAIN;
  mutableEnv.FEATURE_SUPPORT_AGENT_SINGLE_AGENT_RUNTIME = true;
  mutableEnv.OPENCLAW_AGENT_ID_SUPPORT_MAIN = "support-main";

  const adapter = createAdapter({}) as OpenClawAdapter & {
    planSupportDispatch?: (
      input: {
        contextType: "search" | "triage";
        language: "zh" | "en";
        query: string;
      },
      idempotencyKey: string,
      runtime?: OpenClawRuntimeContext
    ) => Promise<unknown>;
    writeDeploymentDomainAnswer?: (
      input: OpenClawSupportSpecialistInput,
      idempotencyKey: string,
      runtime?: OpenClawRuntimeContext
    ) => Promise<SpecialistDraftAnswer>;
    planSupportMainAgent?: (...args: unknown[]) => Promise<unknown>;
    draftSupportMainAgent?: (...args: unknown[]) => Promise<unknown>;
  };

  adapter.planSupportMainAgent = async () => {
    throw new Error("support-main fallback must not run when supervisor-domain runtime is available");
  };
  adapter.draftSupportMainAgent = async () => {
    throw new Error("support-main draft must not run when supervisor-domain runtime is available");
  };
  adapter.routeSupportQuestion = async () => {
    throw new Error("legacy router must not run when supervisor-domain runtime is available");
  };
  adapter.planSupportEvidence = async () => {
    throw new Error("legacy evidence planner must not run when supervisor-domain runtime is available");
  };
  adapter.planSupportCase = async () => {
    throw new Error("legacy case planner must not run when supervisor-domain runtime is available");
  };
  adapter.judgeSupportAnswer = async () => {
    throw new Error("judge stage must not run in supervisor-domain runtime");
  };
  adapter.planSupportDispatch = async (input) => ({
    primaryDomain: "deployment",
    route: {
      question_type: "how_to_product",
      user_goal: input.query,
      answer_contract: "Give the private deployment recovery steps first.",
      specialist_agent: "howto-specialist",
      routing_confidence: 0.94,
      primary_domain: "deployment"
    },
    caseFrame: {
      goal: "Recover administrator access in private deployment.",
      symptom: "The administrator password needs to be reset when SMTP-based token delivery is unavailable.",
      object: "administrator password reset",
      action_type: "how_to",
      deployment_model: "private_deployment",
      product_area: "deployment",
      constraints: [],
      missing_critical_info: [],
      retrieval_queries: ["private deployment administrator password reset"],
      question_type: "how_to_product",
      specialist_agent: "howto-specialist",
      answer_contract: "Give the private deployment recovery steps first.",
      routing_confidence: 0.94,
      primary_domain: "deployment",
      required_doc_kinds: ["deployment_runbook", "troubleshooting"]
    },
    retrievalQueries: ["private deployment administrator password reset"]
  });
  adapter.writeDeploymentDomainAnswer = async (input) => ({
    question_type: "how_to_product",
    render_variant: "how_to",
    direct_answer: "Use the private deployment password-reset procedure directly. Do not treat this as an OAuth API call.",
    claims: [
      {
        text: "The private deployment password-reset guide documents a direct administrator recovery procedure.",
        kind: "verified_fact",
        evidence_ids: input.evidenceBundle.primary.map((item) => resolveSearchReferenceEvidenceId(item)).slice(0, 1),
        authority: "canonical"
      }
    ],
    next_actions: [
      "Run the documented private deployment password-reset procedure.",
      "Verify administrator access after the reset completes."
    ],
    unknowns: [],
    escalation_needed: false,
    steps: [
      "Run the documented private deployment password-reset procedure.",
      "Verify administrator access after the reset completes."
    ],
    prerequisites: ["You need operator access to the private deployment environment."],
    limits_or_notes: ["Use the deployment recovery flow when SMTP delivery is unavailable."]
  });

  const deploymentReference: SearchReference = {
    documentId: "doc:private-deployment-admin-reset",
    evidenceId: "chunk:private-deployment-admin-reset",
    title: "Reset administrator password in private deployment",
    snippet:
      "When SMTP-based delivery is unavailable, use the private deployment recovery procedure to reset the administrator password directly in the deployment environment.",
    sourceUrl: "https://docs.ones.com/private-deployment/reset-administrator-password",
    path: "docs/private-deployment/reset-administrator-password.mdx",
    headingPath: "Recovery procedure",
    authority: "canonical_visible",
    sourceType: "github_kb",
    score: 0.97,
    retrievedAt: "2026-04-13T09:10:00.000Z"
  };

  const orchestrator = {
    normalizeQuery(query: string) {
      return query.trim().toLowerCase();
    },
    async collectEvidence(input: { query?: string; queries?: string[] }) {
      return {
        query: input.query ?? input.queries?.[0] ?? "",
        answer: "",
        confidence: 0.97,
        references: [deploymentReference],
        retrievalStatus: "grounded" as const,
        unresolvedReasonCode: null,
        resolvedQueries: input.queries ?? [],
        fallbackUsed: false
      };
    },
    combineEvidenceCollections<T>(items: T[]) {
      return items[0];
    },
    async refineEvidence() {
      throw new Error("supervisor-domain runtime must not refine evidence");
    }
  };

  try {
    const result = await coreRunSupportSearchAgent({
      query: "How do I reset the administrator password when OAuth token delivery is unavailable in private deployment?",
      language: "en",
      currentRound: 0,
      conversationHistory: [],
      adapter,
      orchestrator: orchestrator as never,
      idempotencyKey: "support-supervisor-domain-deployment-admin-reset"
    });

    assert.equal((result.result.internal_diagnostics as { runtime_mode?: string } | undefined)?.runtime_mode, "supervisor_domain");
    assert.equal(
      ((result.result.internal_diagnostics as { route?: { primary_domain?: string; specialist_agent?: string } } | undefined)?.route
        ?.primary_domain),
      "deployment"
    );
    assert.equal(
      ((result.result.internal_diagnostics as { route?: { primary_domain?: string; specialist_agent?: string } } | undefined)?.route
        ?.specialist_agent),
      "howto-specialist"
    );
    assert.equal(result.result.support_answer?.render_variant, "how_to");
    assert.match(result.result.answer, /private deployment password-reset procedure/i);
    assert.equal(result.result.references[0]?.path, "docs/private-deployment/reset-administrator-password.mdx");
  } finally {
    mutableEnv.FEATURE_SUPPORT_AGENT_SINGLE_AGENT_RUNTIME = originalSingleAgentRuntime;
    mutableEnv.OPENCLAW_AGENT_ID_SUPPORT_MAIN = originalSupportMainAgentId;
  }
});

test("runSupportSearchAgent supervisor-domain runtime uses the customer answer composer for grounded answers when budget is available", async () => {
  const mutableEnv = env as {
    FEATURE_SUPPORT_AGENT_SINGLE_AGENT_RUNTIME?: boolean;
    OPENCLAW_AGENT_ID_SUPPORT_MAIN?: string;
  };
  const originalSingleAgentRuntime = mutableEnv.FEATURE_SUPPORT_AGENT_SINGLE_AGENT_RUNTIME;
  const originalSupportMainAgentId = mutableEnv.OPENCLAW_AGENT_ID_SUPPORT_MAIN;
  mutableEnv.FEATURE_SUPPORT_AGENT_SINGLE_AGENT_RUNTIME = true;
  mutableEnv.OPENCLAW_AGENT_ID_SUPPORT_MAIN = "support-main";

  let composed = false;

  const adapter = createAdapter({}) as OpenClawAdapter & {
    planSupportDispatch?: (
      input: {
        contextType: "search" | "triage";
        language: "zh" | "en";
        query: string;
      },
      idempotencyKey: string,
      runtime?: OpenClawRuntimeContext
    ) => Promise<unknown>;
    writeDocsDomainAnswer?: (
      input: OpenClawSupportSpecialistInput,
      idempotencyKey: string,
      runtime?: OpenClawRuntimeContext
    ) => Promise<SpecialistDraftAnswer>;
    planSupportMainAgent?: (...args: unknown[]) => Promise<unknown>;
    draftSupportMainAgent?: (...args: unknown[]) => Promise<unknown>;
  };

  adapter.planSupportMainAgent = async () => {
    throw new Error("support-main fallback must not run when supervisor-domain runtime is available");
  };
  adapter.draftSupportMainAgent = async () => {
    throw new Error("support-main draft must not run when supervisor-domain runtime is available");
  };
  adapter.routeSupportQuestion = async () => {
    throw new Error("legacy router must not run when supervisor-domain runtime is available");
  };
  adapter.planSupportEvidence = async () => {
    throw new Error("legacy evidence planner must not run when supervisor-domain runtime is available");
  };
  adapter.planSupportCase = async () => {
    throw new Error("legacy case planner must not run when supervisor-domain runtime is available");
  };
  adapter.judgeSupportAnswer = async () => {
    throw new Error("judge stage must not run in supervisor-domain runtime");
  };
  adapter.planSupportDispatch = async (input) => ({
    primaryDomain: "docs",
    route: {
      question_type: "how_to_product",
      user_goal: input.query,
      answer_contract: "Give the direct troubleshooting artifact collection steps first.",
      specialist_agent: "howto-specialist",
      routing_confidence: 0.93,
      primary_domain: "docs"
    },
    caseFrame: {
      goal: "Explain how to collect a HAR file.",
      symptom: "The customer needs a HAR file for troubleshooting.",
      object: "HAR file collection",
      action_type: "how_to",
      deployment_model: "shared",
      product_area: "general",
      constraints: [],
      missing_critical_info: [],
      retrieval_queries: ["HAR file troubleshooting collection"],
      question_type: "how_to_product",
      specialist_agent: "howto-specialist",
      answer_contract: "Give the direct troubleshooting artifact collection steps first.",
      routing_confidence: 0.93,
      primary_domain: "docs",
      required_doc_kinds: ["product_guide", "troubleshooting"]
    },
    retrievalQueries: ["HAR file troubleshooting collection"]
  });
  adapter.writeDocsDomainAnswer = async (input) => ({
    question_type: "how_to_product",
    render_variant: "how_to",
    direct_answer: "You can collect a HAR file directly from the browser network panel.",
    claims: [
      {
        text: "The troubleshooting guide documents how to collect a HAR file from the browser network panel.",
        kind: "verified_fact",
        evidence_ids: input.evidenceBundle.primary.map((item) => resolveSearchReferenceEvidenceId(item)).slice(0, 1),
        authority: "canonical"
      }
    ],
    next_actions: ["Open DevTools and keep the Network tab recording.", "Export the HAR file after reproducing the issue."],
    unknowns: [],
    escalation_needed: false,
    steps: ["Open DevTools and keep the Network tab recording.", "Export the HAR file after reproducing the issue."]
  });
  adapter.composeCustomerAnswer = async (input) => {
    composed = true;
    return {
      question_type: input.route.question_type,
      render_variant: "how_to",
      direct_answer: "Collect the HAR file from the browser network panel while reproducing the issue.",
      sections: [
        {
          kind: "bullet_list",
          title: "Steps",
          items: ["Open DevTools and start recording in Network.", "Reproduce the issue and export the HAR file."]
        }
      ],
      why: ["The troubleshooting guide explicitly documents HAR collection from the browser network panel."],
      what_to_do_now: ["Open DevTools and start recording in Network.", "Reproduce the issue and export the HAR file."],
      still_need_to_confirm: []
    };
  };

  const harReference: SearchReference = {
    documentId: "doc:har-file-troubleshooting",
    evidenceId: "chunk:har-file-troubleshooting",
    title: "Collect a HAR file for troubleshooting",
    snippet: "Open the browser network panel, reproduce the problem, and export the HAR file for support analysis.",
    sourceUrl: "https://docs.ones.com/support/collect-har-file",
    path: "docs/support/collect-har-file.mdx",
    headingPath: "Browser network capture",
    authority: "canonical_visible",
    sourceType: "github_kb",
    score: 0.99,
    retrievedAt: "2026-04-13T09:30:00.000Z"
  };

  const orchestrator = {
    normalizeQuery(query: string) {
      return query.trim().toLowerCase();
    },
    async collectEvidence(input: { query?: string; queries?: string[] }) {
      return {
        query: input.query ?? input.queries?.[0] ?? "",
        answer: "",
        confidence: 0.99,
        references: [harReference],
        retrievalStatus: "grounded" as const,
        unresolvedReasonCode: null,
        resolvedQueries: input.queries ?? [],
        fallbackUsed: false
      };
    },
    combineEvidenceCollections<T>(items: T[]) {
      return items[0];
    },
    async refineEvidence() {
      throw new Error("supervisor-domain runtime must not refine evidence");
    }
  };

  try {
    const result = await coreRunSupportSearchAgent({
      query: "How do I collect a HAR file for troubleshooting?",
      language: "en",
      currentRound: 0,
      conversationHistory: [],
      adapter,
      orchestrator: orchestrator as never,
      idempotencyKey: "support-supervisor-domain-answer-composer",
      runtime: {
        deliveryMode: "async_job",
        overallTimeoutMs: 240000,
        requestStartedAtMs: Date.now()
      }
    });

    assert.equal(composed, true);
    assert.equal(result.result.support_answer?.render_variant, "how_to");
    assert.match(result.result.answer, /Collect the HAR file from the browser network panel/i);
    assert.ok(
      result.result.support_answer?.sections.some(
        (section) => section.kind === "bullet_list" && section.title === "Steps"
      )
    );
  } finally {
    mutableEnv.FEATURE_SUPPORT_AGENT_SINGLE_AGENT_RUNTIME = originalSingleAgentRuntime;
    mutableEnv.OPENCLAW_AGENT_ID_SUPPORT_MAIN = originalSupportMainAgentId;
  }
});

test("runSupportSearchAgent supervisor-domain runtime keeps deployment architecture answers on the behavior contract", async () => {
  const mutableEnv = env as {
    FEATURE_SUPPORT_AGENT_SINGLE_AGENT_RUNTIME?: boolean;
    OPENCLAW_AGENT_ID_SUPPORT_MAIN?: string;
  };
  const originalSingleAgentRuntime = mutableEnv.FEATURE_SUPPORT_AGENT_SINGLE_AGENT_RUNTIME;
  const originalSupportMainAgentId = mutableEnv.OPENCLAW_AGENT_ID_SUPPORT_MAIN;
  mutableEnv.FEATURE_SUPPORT_AGENT_SINGLE_AGENT_RUNTIME = true;
  mutableEnv.OPENCLAW_AGENT_ID_SUPPORT_MAIN = "support-main";

  const adapter = createAdapter({}) as OpenClawAdapter & {
    planSupportDispatch?: (
      input: {
        contextType: "search" | "triage";
        language: "zh" | "en";
        query: string;
      },
      idempotencyKey: string,
      runtime?: OpenClawRuntimeContext
    ) => Promise<unknown>;
    writeDeploymentDomainAnswer?: (
      input: OpenClawSupportSpecialistInput,
      idempotencyKey: string,
      runtime?: OpenClawRuntimeContext
    ) => Promise<SpecialistDraftAnswer>;
    planSupportMainAgent?: (...args: unknown[]) => Promise<unknown>;
    draftSupportMainAgent?: (...args: unknown[]) => Promise<unknown>;
  };

  adapter.planSupportMainAgent = async () => {
    throw new Error("support-main fallback must not run when supervisor-domain runtime is available");
  };
  adapter.draftSupportMainAgent = async () => {
    throw new Error("support-main draft must not run when supervisor-domain runtime is available");
  };
  adapter.routeSupportQuestion = async () => {
    throw new Error("legacy router must not run when supervisor-domain runtime is available");
  };
  adapter.planSupportEvidence = async () => {
    throw new Error("legacy evidence planner must not run when supervisor-domain runtime is available");
  };
  adapter.planSupportCase = async () => {
    throw new Error("legacy case planner must not run when supervisor-domain runtime is available");
  };
  adapter.judgeSupportAnswer = async () => {
    throw new Error("judge stage must not run in supervisor-domain runtime");
  };
  adapter.composeCustomerAnswer = async () => {
    throw new Error("answer composer must not run in supervisor-domain runtime");
  };
  adapter.planSupportDispatch = async (input) => ({
    primaryDomain: "deployment",
    route: {
      question_type: "capability_confirmation",
      user_goal: input.query,
      answer_contract: "State the documented architecture first.",
      specialist_agent: "behavior-specialist",
      routing_confidence: 0.95,
      primary_domain: "deployment"
    },
    caseFrame: {
      goal: "Understand whether self-hosted deployment supports isolated service chains.",
      symptom: "Need a documented architecture conclusion.",
      object: "self-hosted deployment topology",
      action_type: "capability_confirmation",
      deployment_model: "private_deployment",
      product_area: "deployment",
      constraints: [],
      missing_critical_info: [],
      retrieval_queries: ["self-hosted deployment architecture isolation"],
      question_type: "capability_confirmation",
      specialist_agent: "behavior-specialist",
      answer_contract: "State the documented architecture first.",
      routing_confidence: 0.95,
      primary_domain: "deployment",
      required_doc_kinds: ["deployment_runbook", "product_guide"]
    },
    retrievalQueries: ["self-hosted deployment architecture isolation"]
  });
  adapter.writeDeploymentDomainAnswer = async (input) => ({
    question_type: "capability_confirmation",
    render_variant: "behavior",
    direct_answer:
      "The current deployment docs support this conclusion first: ONES self-hosted deployment is documented as a unified topology by default.",
    claims: [
      {
        text: "The deployment architecture guide describes ONES self-hosted deployment as a unified topology by default.",
        kind: "verified_fact",
        evidence_ids: input.evidenceBundle.primary.map((item) => resolveSearchReferenceEvidenceId(item)).slice(0, 1),
        authority: "canonical"
      }
    ],
    next_actions: ["Plan capacity assuming a unified topology first."],
    unknowns: [],
    escalation_needed: false,
    most_likely_explanation:
      "The current deployment docs describe a unified topology rather than separately deployable backend chains for requirements and issues.",
    confirmed_facts: ["ONES self-hosted deployment is documented as a unified topology by default."],
    what_to_check_next: ["Check whether database or storage externalization is documented for the target environment."]
  });

  const validationReference: SearchReference = {
    documentId: "doc:deployment-architecture",
    evidenceId: "chunk:deployment-architecture",
    title: "Deployment architecture",
    snippet:
      "ONES self-hosted deployment uses a unified topology by default. Some infrastructure components can be externalized depending on the deployment plan.",
    sourceUrl: "https://docs.ones.com/private-deployment/architecture",
    path: "docs/private-deployment/architecture.mdx",
    headingPath: "Topology",
    authority: "canonical_visible",
    sourceType: "github_kb",
    score: 0.99,
    retrievedAt: "2026-04-10T06:00:00.000Z"
  };

  const orchestrator = {
    normalizeQuery(query: string) {
      return query.trim().toLowerCase();
    },
    async collectEvidence(input: { query?: string; queries?: string[] }) {
      return {
        query: input.query ?? input.queries?.[0] ?? "",
        answer: "",
        confidence: 0.99,
        references: [validationReference],
        retrievalStatus: "grounded" as const,
        unresolvedReasonCode: null,
        resolvedQueries: input.queries ?? [],
        fallbackUsed: false
      };
    },
    combineEvidenceCollections<T>(items: T[]) {
      return items[0];
    },
    async refineEvidence() {
      throw new Error("supervisor-domain runtime must not refine evidence");
    }
  };

  try {
    const result = await coreRunSupportSearchAgent({
      query: "Can requirements and issues use isolated backend services in self-hosted deployment?",
      language: "en",
      currentRound: 0,
      conversationHistory: [],
      adapter,
      orchestrator: orchestrator as never,
      idempotencyKey: "support-supervisor-domain-deployment-behavior"
    });

    assert.equal((result.result.internal_diagnostics as { runtime_mode?: string } | undefined)?.runtime_mode, "supervisor_domain");
    assert.equal(
      ((result.result.internal_diagnostics as { route?: { primary_domain?: string } } | undefined)?.route?.primary_domain),
      "deployment"
    );
    assert.equal(result.caseFrame.specialist_agent, "behavior-specialist");
    assert.equal(result.result.support_answer?.render_variant, "behavior");
    assert.match(result.result.answer, /unified topology/i);
    assert.deepEqual(result.result.citations.map((item) => item.id), ["chunk:deployment-architecture"]);
    assert.equal(result.stageTimings.retrieval_extra.status, "skipped");
    assert.ok(
      result.result.support_answer?.sections.some(
        (section) =>
          section.kind === "bullet_list" &&
          section.title === "Confirmed facts" &&
          section.items.includes(
            "The deployment architecture guide describes ONES self-hosted deployment as a unified topology by default."
          )
      )
    );
    assert.ok(
      result.result.support_answer?.sections.some(
        (section) =>
          section.kind === "bullet_list" &&
          section.title === "What to watch" &&
          section.items.includes("Check whether database or storage externalization is documented for the target environment.")
      )
    );
  } finally {
    mutableEnv.FEATURE_SUPPORT_AGENT_SINGLE_AGENT_RUNTIME = originalSingleAgentRuntime;
    mutableEnv.OPENCLAW_AGENT_ID_SUPPORT_MAIN = originalSupportMainAgentId;
  }
});
