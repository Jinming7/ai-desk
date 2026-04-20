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
      const caseFrame = await this.planSupportCase({
        contextType: input.contextType,
        language: input.language,
        query: input.query,
        conversationHistory: input.conversationHistory
      }, "", undefined);
      const evidence = await this.planSupportEvidence({
        contextType: input.contextType,
        language: input.language,
        query: input.query,
        route,
        conversationHistory: input.conversationHistory
      }, "", undefined);
      const primaryDomain =
        route.primary_domain ??
        caseFrame.primary_domain ??
        (caseFrame.product_area as "openapi" | "deployment" | "integrations" | "product" | "troubleshooting" | undefined) ??
        "product";
      return {
        primaryDomain,
        route: {
          ...route,
          primary_domain: primaryDomain
        },
        caseFrame: {
          ...caseFrame,
          primary_domain: primaryDomain,
          required_doc_kinds: caseFrame.required_doc_kinds ?? evidence.required_doc_kinds
        },
        retrievalQueries: [
          ...new Set([
            input.query,
            ...(caseFrame.retrieval_queries ?? []),
            ...(evidence.query_plan?.concept_queries ?? []),
            ...(evidence.query_plan?.object_queries ?? []),
            ...(evidence.query_plan?.behavior_queries ?? [])
          ])
        ].filter(Boolean)
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
    async planSupportDispatch(input: Parameters<NonNullable<OpenClawAdapter["planSupportDispatch"]>>[0]) {
      record("planSupportDispatch");
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
      const caseFrame = await this.planSupportCase({
        contextType: input.contextType,
        language: input.language,
        query: input.query,
        conversationHistory: input.conversationHistory
      }, "", undefined);
      const evidence = await this.planSupportEvidence({
        contextType: input.contextType,
        language: input.language,
        query: input.query,
        route,
        conversationHistory: input.conversationHistory
      }, "", undefined);
      const primaryDomain = "integrations" as const;
      return {
        primaryDomain,
        route: {
          ...route,
          primary_domain: primaryDomain
        },
        caseFrame: {
          ...caseFrame,
          primary_domain: primaryDomain,
          required_doc_kinds: caseFrame.required_doc_kinds ?? evidence.required_doc_kinds
        },
        retrievalQueries: Array.from(
          new Set([
            input.query,
            ...(caseFrame.retrieval_queries ?? []),
            ...(evidence.query_plan?.concept_queries ?? []),
            ...(evidence.query_plan?.object_queries ?? []),
            ...(evidence.query_plan?.behavior_queries ?? [])
          ])
        )
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
      /support dispatch unavailable: supervisor contract invalid/
    );
  } finally {
    env.LOCAL_DOCS_COM_PATH = originalLocalDocsPath;
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("runSupportSearchAgent fails closed after unified planner failure in interactive mode", async () => {
  const originalLocalDocsPath = env.LOCAL_DOCS_COM_PATH;
  const rootDir = await createFixtureRoot();
  env.LOCAL_DOCS_COM_PATH = rootDir;
  const adapter = createStageRecordingAdapter();
  adapter.planSupportDispatch = async () => {
    adapter.calls.push("planSupportDispatch");
    throw new Error("unified dispatch failed");
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
    await assert.rejects(
      runSupportSearchAgent({
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
      }),
      /support dispatch unavailable: supervisor contract invalid/
    );

    assert.equal(adapter.calls.includes("planSupportDispatch"), true);
    assert.equal(adapter.calls.includes("routeSupportQuestion"), false);
    assert.equal(adapter.calls.includes("planSupportEvidence"), false);
    assert.equal(adapter.calls.includes("planSupportCase"), false);
  } finally {
    env.LOCAL_DOCS_COM_PATH = originalLocalDocsPath;
    await rm(rootDir, { recursive: true, force: true });
  }
});







test("runSupportSearchAgent prefers the supervisor-domain runtime over support-main and keeps judge/composer in the main chain", async () => {
  const mutableEnv = env as {
    FEATURE_SUPPORT_AGENT_SINGLE_AGENT_RUNTIME?: boolean;
    OPENCLAW_AGENT_ID_SUPPORT_MAIN?: string;
  };
  const originalSingleAgentRuntime = mutableEnv.FEATURE_SUPPORT_AGENT_SINGLE_AGENT_RUNTIME;
  const originalSupportMainAgentId = mutableEnv.OPENCLAW_AGENT_ID_SUPPORT_MAIN;
  mutableEnv.FEATURE_SUPPORT_AGENT_SINGLE_AGENT_RUNTIME = true;
  mutableEnv.OPENCLAW_AGENT_ID_SUPPORT_MAIN = "support-main";
  let judgeCalled = false;
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
  adapter.judgeSupportAnswer = async () => ({
    verdict: "partial",
    summary: "The main scope is grounded and the unsupported extra scope must be removed.",
    unsupported_claims: ["The issue comment API also requires admin:workspace."],
    missing_info: [],
    verified_citation_ids: ["chunk:comment-scope"],
    display_citation_ids: ["chunk:comment-scope"],
    verified_claims: ["The issue comment API requires write:project."],
    claim_to_citation_map: [
      {
        text: "The issue comment API requires write:project.",
        kind: "verified_fact",
        verdict: "verified",
        citation_ids: ["chunk:comment-scope"]
      }
    ]
  });
  adapter.composeCustomerAnswer = async () => ({
    mode: "grounded",
    question_type: "api_scope_auth",
    render_variant: "api",
    direct_answer: "The issue comment API requires write:project.",
    why: [],
    sections: [],
    what_to_do_now: ["Use write:project in the access token."],
    still_need_to_confirm: []
  });
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
    retrievedAt: "2026-04-09T04:00:00.000Z",
    supportMetadata: {
      product_area: "openapi",
      evidence_kind: "api_operation",
      doc_kind: "openapi/api",
      permissions: ["write:project"]
    }
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
    assert.equal(
      result.result.internal_diagnostics?.orchestration_trace?.some((item) => item.stage === "evidence-judge"),
      true
    );
    assert.equal(
      result.result.internal_diagnostics?.orchestration_trace?.some((item) => item.stage === "answer-composer"),
      true
    );
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
  let judgeCalled = false;
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
  adapter.judgeSupportAnswer = async (input) => {
    judgeCalled = true;
    const citationIds = input.evidenceBundle.primary.map((item) => resolveSearchReferenceEvidenceId(item)).slice(0, 1);
    return {
      verdict: "verified",
      summary: "verified",
      unsupported_claims: [],
      missing_info: [],
      verified_citation_ids: citationIds,
      display_citation_ids: citationIds,
      verified_claims: (input.draftSupportAnswer?.claims ?? []).map((item) => item.text),
      claim_to_citation_map: (input.draftSupportAnswer?.claims ?? []).map((item) => ({
        text: item.text,
        kind: item.kind,
        verdict: "verified",
        citation_ids: citationIds
      }))
    };
  };
  adapter.composeCustomerAnswer = async (input) => {
    composed = true;
    return {
      question_type: input.route.question_type,
      render_variant: "how_to",
      direct_answer: "Use the documented private-deployment recovery path to reset the administrator password.",
      sections: [],
      why: input.supportedClaims.map((item) => item.text),
      what_to_do_now: input.nextActions.slice(0, 4),
      still_need_to_confirm: input.unknowns.slice(0, 4)
    };
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
    assert.equal(judgeCalled, true);
    assert.equal(composed, true);
    assert.equal(result.result.support_answer?.render_variant, "how_to");
    assert.equal(result.stageTimings.retrieval_extra.status, "skipped");
    assert.match(result.result.answer, /重置管理员密码|recovery path/);
    assert.deepEqual(result.result.citations.map((item) => item.id), ["chunk:deployment-reset"]);
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
  let judgeCalled = false;

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
  adapter.judgeSupportAnswer = async (input) => {
    judgeCalled = true;
    const citationIds = input.evidenceBundle.primary.map((item) => resolveSearchReferenceEvidenceId(item)).slice(0, 1);
    return {
      verdict: "verified",
      summary: "verified",
      unsupported_claims: [],
      missing_info: [],
      verified_citation_ids: citationIds,
      display_citation_ids: citationIds,
      verified_claims: (input.draftSupportAnswer?.claims ?? []).map((item) => item.text),
      claim_to_citation_map: (input.draftSupportAnswer?.claims ?? []).map((item) => ({
        text: item.text,
        kind: item.kind,
        verdict: "verified",
        citation_ids: citationIds
      }))
    };
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

    assert.equal(judgeCalled, true);
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
  let judgeCalled = false;
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
  adapter.judgeSupportAnswer = async (input) => {
    judgeCalled = true;
    const citationIds = input.evidenceBundle.primary.map((item) => resolveSearchReferenceEvidenceId(item)).slice(0, 1);
    return {
      verdict: "verified",
      summary: "verified",
      unsupported_claims: [],
      missing_info: [],
      verified_citation_ids: citationIds,
      display_citation_ids: citationIds,
      verified_claims: (input.draftSupportAnswer?.claims ?? []).map((item) => item.text),
      claim_to_citation_map: (input.draftSupportAnswer?.claims ?? []).map((item) => ({
        text: item.text,
        kind: item.kind,
        verdict: "verified",
        citation_ids: citationIds
      }))
    };
  };
  adapter.composeCustomerAnswer = async (input) => {
    composed = true;
    return {
      question_type: input.route.question_type,
      render_variant: "behavior",
      direct_answer: "The documented self-hosted topology remains unified by default, with some components externalizable.",
      sections: [],
      why: input.supportedClaims.map((item) => item.text),
      what_to_do_now: input.nextActions.slice(0, 4),
      still_need_to_confirm: input.unknowns.slice(0, 4)
    };
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
    assert.equal(judgeCalled, true);
    assert.equal(composed, true);
    assert.equal(result.caseFrame.specialist_agent, "behavior-specialist");
    assert.equal(result.result.support_answer?.render_variant, "behavior");
    assert.match(result.result.answer, /unified/i);
    assert.deepEqual(result.result.citations.map((item) => item.id), ["chunk:deployment-architecture"]);
    assert.equal(result.stageTimings.retrieval_extra.status, "skipped");
    assert.ok(
      result.result.support_answer?.sections.some(
        (section) =>
          section.kind === "bullet_list" &&
          section.title === "Confirmed facts" &&
          section.items.some((item) => /unified/i.test(item))
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
