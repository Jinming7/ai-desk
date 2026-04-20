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
import { runSupportSearchAgent } from "./support-agent.js";
import type {
  DraftSupportAnswer,
  SearchReference,
  SpecialistDraftAnswer,
  SupportCaseFrame,
  SupportEvidencePlan,
  SupportQuestionRoute,
  SupportVerificationResult
} from "./types.js";

async function createFixtureRoot(): Promise<string> {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "support-agent-integration-route-"));
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

function createFocusedAdapter(): OpenClawAdapter {
  const buildSpecialistDraft = (): SpecialistDraftAnswer => ({
    question_type: "troubleshooting",
    render_variant: "troubleshooting",
    direct_answer: "最可能是集成回调配置不一致。",
    claims: [],
    next_actions: ["核对 Redirect URI、Webhook 回调地址和 baseURL。"],
    unknowns: [],
    escalation_needed: false
  });
  const buildVerifiedResult = (): SupportVerificationResult => ({
    verdict: "verified",
    summary: "verified",
    unsupported_claims: [],
    missing_info: [],
    verified_citation_ids: [],
    display_citation_ids: [],
    verified_claims: [],
    claim_to_citation_map: []
  });

  const adapter = {
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
      return { confidence: 0.4, hits: [] };
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
    async planSupportCase(input: OpenClawSupportPlannerInput): Promise<SupportCaseFrame> {
      return {
        goal: input.query,
        symptom: input.query,
        object: "GitHub callback",
        action_type: "troubleshooting",
        deployment_model: "shared",
        product_area: "integrations",
        constraints: [],
        missing_critical_info: [],
        retrieval_queries: [input.query],
        query_plan: {
          concept_queries: ["GitHub callback"],
          object_queries: ["Redirect URI"],
          behavior_queries: ["page not found"]
        },
        question_type: "troubleshooting",
        specialist_agent: "troubleshooting-specialist",
        answer_contract: "Start with the likely callback configuration cause and the checks to run now.",
        primary_domain: "integrations"
      };
    },
    async routeSupportQuestion(input: OpenClawSupportRouterInput): Promise<SupportQuestionRoute> {
      return {
        question_type: "troubleshooting",
        user_goal: input.query,
        answer_contract: "Start with the likely callback configuration cause and the checks to run now.",
        specialist_agent: "troubleshooting-specialist",
        routing_confidence: 0.9,
        primary_domain: "integrations"
      };
    },
    async planSupportEvidence(_input: OpenClawSupportEvidencePlannerInput): Promise<SupportEvidencePlan> {
      return {
        query_plan: {
          concept_queries: [],
          object_queries: [],
          behavior_queries: []
        },
        evidence_priority: [],
        required_doc_kinds: [],
        retrieval_rounds: 1,
        allow_refinement: true
      };
    },
    async planSupportDispatch(input: Parameters<NonNullable<OpenClawAdapter["planSupportDispatch"]>>[0]) {
      const route = await this.routeSupportQuestion({
        contextType: input.contextType,
        language: input.language,
        query: input.query,
        conversationHistory: input.conversationHistory
      });
      const caseFrame = await this.planSupportCase({
        contextType: input.contextType,
        language: input.language,
        query: input.query,
        conversationHistory: input.conversationHistory
      });
      const evidence = await this.planSupportEvidence({
        contextType: input.contextType,
        language: input.language,
        query: input.query,
        route,
        conversationHistory: input.conversationHistory
      });
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
    async selectSupportEvidence(input: OpenClawSupportEvidenceSelectorInput) {
      return {
        primary_ids: input.references.slice(0, 3).map((item) => item.documentId),
        supplemental_ids: input.references.slice(3, 5).map((item) => item.documentId),
        rejected_ids: input.references.slice(5).map((item) => item.documentId)
      };
    },
    async writeSupportAnswer(_input: OpenClawSupportWriterInput, _idempotencyKey: string, _runtime?: OpenClawRuntimeContext): Promise<DraftSupportAnswer> {
      return {
        direct_answer: "请先检查回调配置。",
        claims: [],
        next_actions: [],
        unknowns: [],
        escalation_needed: false
      };
    },
    async writeApiSpecialistAnswer(
      _input: OpenClawSupportSpecialistInput,
      _idempotencyKey: string,
      _runtime?: OpenClawRuntimeContext
    ): Promise<SpecialistDraftAnswer> {
      return buildSpecialistDraft();
    },
    async writeHowToSpecialistAnswer(
      _input: OpenClawSupportSpecialistInput,
      _idempotencyKey: string,
      _runtime?: OpenClawRuntimeContext
    ): Promise<SpecialistDraftAnswer> {
      return buildSpecialistDraft();
    },
    async writeBehaviorSpecialistAnswer(
      _input: OpenClawSupportSpecialistInput,
      _idempotencyKey: string,
      _runtime?: OpenClawRuntimeContext
    ): Promise<SpecialistDraftAnswer> {
      return buildSpecialistDraft();
    },
    async writeTroubleshootingSpecialistAnswer(
      _input: OpenClawSupportSpecialistInput,
      _idempotencyKey: string,
      _runtime?: OpenClawRuntimeContext
    ): Promise<SpecialistDraftAnswer> {
      return buildSpecialistDraft();
    },
    async judgeSupportAnswer(
      _input: OpenClawSupportVerifierInput,
      _idempotencyKey: string,
      _runtime?: OpenClawRuntimeContext
    ): Promise<SupportVerificationResult> {
      return buildVerifiedResult();
    },
    async verifySupportAnswer(
      _input: OpenClawSupportVerifierInput,
      _idempotencyKey: string,
      _runtime?: OpenClawRuntimeContext
    ): Promise<SupportVerificationResult> {
      return buildVerifiedResult();
    },
    async bindSupportCitations(
      _input: OpenClawSupportVerifierInput,
      _idempotencyKey: string,
      _runtime?: OpenClawRuntimeContext
    ) {
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
      _input: OpenClawSupportCitationSelectorInput,
      _idempotencyKey: string,
      _runtime?: OpenClawRuntimeContext
    ) {
      return { display_citation_ids: [] };
    },
    async curateSupportCitations(
      _input: OpenClawSupportCitationSelectorInput,
      _idempotencyKey: string,
      _runtime?: OpenClawRuntimeContext
    ) {
      return { display_citation_ids: [] };
    },
    async composeSupportAnswer(
      input: OpenClawSupportAnswerComposerInput,
      _idempotencyKey: string,
      _runtime?: OpenClawRuntimeContext
    ) {
      return {
        direct_answer: input.supportedClaims[0]?.text ?? "最可能是回调配置不一致。",
        why: input.supportedClaims.map((item) => item.text).slice(0, 3),
        what_to_do_now: input.nextActions.slice(0, 4),
        still_need_to_confirm: input.unknowns.slice(0, 4)
      };
    },
    async composeCustomerAnswer(
      input: OpenClawSupportAnswerComposerInput,
      _idempotencyKey: string,
      _runtime?: OpenClawRuntimeContext
    ) {
      return {
        question_type: input.route.question_type,
        render_variant: input.draftSupportAnswer?.render_variant ?? "troubleshooting",
        direct_answer: input.supportedClaims[0]?.text ?? input.draftSupportAnswer?.direct_answer ?? "最可能是回调配置不一致。",
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
    ) {
      return {
        direct_answer: "最可能是集成回调配置不一致。",
        recommended_action: "resolve",
        customer_reply: "请先核对 Redirect URI、Webhook 回调地址和 baseURL 是否一致。",
        customer_reply_policy: "send_now",
        support_summary: "callback config mismatch",
        verified_evidence: [],
        risk_flags: [],
        missing_info: [],
        verifier_verdict: "verified"
      };
    },
    async verifyTriageInsight(
      _input: OpenClawSupportVerifierInput,
      _idempotencyKey: string,
      _runtime?: OpenClawRuntimeContext
    ) {
      return buildVerifiedResult();
    },
    async healthCheck(): Promise<OpenClawHealthCheckResult> {
      return {
        ok: true,
        mode: "mock",
        detail: "ok",
        reachableAgents: [],
        unreachableAgents: []
      };
    }
  };
  return adapter as OpenClawAdapter;
}

test("supervisor-domain interactive runtime stays on planner dispatch instead of dropping to legacy routing", async () => {
  const mutableEnv = env as {
    FEATURE_SUPPORT_AGENT_SINGLE_AGENT_RUNTIME?: boolean;
    OPENCLAW_AGENT_ID_SUPPORT_MAIN?: string;
  };
  const originalSingleAgentRuntime = mutableEnv.FEATURE_SUPPORT_AGENT_SINGLE_AGENT_RUNTIME;
  const originalSupportMainAgentId = mutableEnv.OPENCLAW_AGENT_ID_SUPPORT_MAIN;
  mutableEnv.FEATURE_SUPPORT_AGENT_SINGLE_AGENT_RUNTIME = true;
  mutableEnv.OPENCLAW_AGENT_ID_SUPPORT_MAIN = "support-main";

  const orchestrator = {
    normalizeQuery(query: string) {
      return query.trim().toLowerCase();
    },
    async collectEvidence(input: { query?: string; queries?: string[] }) {
      return {
        query: input.query ?? input.queries?.[0] ?? "",
        answer: "",
        confidence: 0.4,
        references: [],
        retrievalStatus: "no_results" as const,
        unresolvedReasonCode: "NO_MATCHING_KB" as const,
        resolvedQueries: input.queries ?? [],
        fallbackUsed: false
      };
    },
    combineEvidenceCollections<T>(items: T[]) {
      return items[0];
    },
    async refineEvidence() {
      throw new Error("interactive dispatch budget test should not refine evidence");
    }
  };

  const adapter = createFocusedAdapter() as OpenClawAdapter & {
    dispatchCalls?: number;
    unifiedPlanCalls?: number;
    routeCalls?: number;
    planSupportDispatch?: (
      input: {
        contextType: "search" | "triage";
        language: "zh" | "en";
        query: string;
      },
      idempotencyKey: string,
      runtime?: OpenClawRuntimeContext
    ) => Promise<unknown>;
    planSupportExecution?: (...args: unknown[]) => Promise<unknown>;
  };

  adapter.planSupportDispatch = async (input) => {
    adapter.dispatchCalls = (adapter.dispatchCalls ?? 0) + 1;
    return {
      primaryDomain: "integrations",
      route: {
        question_type: "troubleshooting",
        user_goal: input.query,
        answer_contract: "Start with the likely callback configuration cause and the checks to run now.",
        specialist_agent: "troubleshooting-specialist",
        routing_confidence: 0.95,
        primary_domain: "integrations"
      },
      caseFrame: {
        goal: input.query,
        symptom: "授权回调页面 page not found",
        object: "GitHub OAuth callback",
        action_type: "troubleshooting",
        deployment_model: "shared",
        product_area: "integrations",
        constraints: [],
        missing_critical_info: [],
        retrieval_queries: [input.query],
        question_type: "troubleshooting",
        specialist_agent: "troubleshooting-specialist",
        answer_contract: "Start with the likely callback configuration cause and the checks to run now.",
        routing_confidence: 0.95,
        primary_domain: "integrations"
      },
      retrievalQueries: [input.query]
    };
  };
  adapter.planSupportExecution = async () => {
    adapter.unifiedPlanCalls = (adapter.unifiedPlanCalls ?? 0) + 1;
    throw new Error("interactive supervisor-domain runtime should not use the unified legacy planner");
  };
  const originalRouteSupportQuestion = adapter.routeSupportQuestion!.bind(adapter);
  adapter.routeSupportQuestion = async (input, idempotencyKey, runtime) => {
    adapter.routeCalls = (adapter.routeCalls ?? 0) + 1;
    return originalRouteSupportQuestion(input, idempotencyKey, runtime);
  };

  try {
    const result = await runSupportSearchAgent({
      query: "GitHub 集成授权后回调页面显示 page not found，怎么排查？",
      language: "zh",
      currentRound: 0,
      conversationHistory: [],
      adapter,
      orchestrator: orchestrator as never,
      idempotencyKey: "support-agent-supervisor-domain-interactive-dispatch-budget",
      runtime: {
        deliveryMode: "interactive",
        overallTimeoutMs: 22_000,
        requestStartedAtMs: Date.now()
      }
    });

    assert.equal(adapter.dispatchCalls ?? 0, 1);
    assert.equal(adapter.unifiedPlanCalls ?? 0, 0);
    assert.equal(adapter.routeCalls ?? 0, 0);
    assert.equal(result.caseFrame.product_area, "integrations");
    assert.equal(
      ((result.result.internal_diagnostics as { route?: { primary_domain?: string } } | undefined)?.route?.primary_domain),
      "integrations"
    );
  } finally {
    mutableEnv.FEATURE_SUPPORT_AGENT_SINGLE_AGENT_RUNTIME = originalSingleAgentRuntime;
    mutableEnv.OPENCLAW_AGENT_ID_SUPPORT_MAIN = originalSupportMainAgentId;
  }
});

test("supervisor-domain async planner failure fails closed instead of falling back to legacy routing", async () => {
  const mutableEnv = env as {
    FEATURE_SUPPORT_AGENT_SINGLE_AGENT_RUNTIME?: boolean;
    OPENCLAW_AGENT_ID_SUPPORT_MAIN?: string;
  };
  const originalSingleAgentRuntime = mutableEnv.FEATURE_SUPPORT_AGENT_SINGLE_AGENT_RUNTIME;
  const originalSupportMainAgentId = mutableEnv.OPENCLAW_AGENT_ID_SUPPORT_MAIN;
  mutableEnv.FEATURE_SUPPORT_AGENT_SINGLE_AGENT_RUNTIME = true;
  mutableEnv.OPENCLAW_AGENT_ID_SUPPORT_MAIN = "support-main";

  const validationReference: SearchReference = {
    documentId: "doc:github-public-gitlab",
    evidenceId: "chunk:integration-callback",
    title: "GitHub 和公共 GitLab",
    snippet: "如果授权完成后无法返回 ONES，或者回调页面显示 page not found，请检查 Redirect URI、Webhook 回调地址，以及 baseURL 配置是否一致。",
    sourceUrl: "https://docs.ones.com/integrations/github-public-gitlab",
    path: "docs/ones-devops/code-integration/github-and-public-gitlab.mdx",
    headingPath: "链接仓库",
    authority: "canonical_visible",
    sourceType: "local_docs",
    score: 0.98,
    retrievedAt: "2026-04-09T05:30:00.000Z",
    supportMetadata: {
      product_area: "integrations",
      evidence_kind: "integration_guidance"
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
      throw new Error("async planner fallback test should not refine evidence");
    }
  };

  const adapter = createFocusedAdapter() as OpenClawAdapter & {
    routeCalls?: number;
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
  };

  adapter.planSupportDispatch = async () => {
    throw new Error("planner timeout");
  };
  const originalRouteSupportQuestion = adapter.routeSupportQuestion!.bind(adapter);
  adapter.routeSupportQuestion = async (input, idempotencyKey, runtime) => {
    adapter.routeCalls = (adapter.routeCalls ?? 0) + 1;
    return originalRouteSupportQuestion(input, idempotencyKey, runtime);
  };
  adapter.planSupportEvidence = async () => ({
    query_plan: {
      concept_queries: ["GitHub OAuth callback"],
      object_queries: ["Redirect URI", "Webhook 回调地址"],
      behavior_queries: ["page not found"]
    },
    evidence_priority: ["product_guide", "troubleshooting"],
    required_doc_kinds: ["product_guide", "troubleshooting"],
    retrieval_rounds: 1,
    allow_refinement: false,
    stop_after_grounded_evidence: false
  });
  adapter.writeDocsDomainAnswer = async () => ({
    question_type: "troubleshooting",
    render_variant: "troubleshooting",
    direct_answer: "请先核对 GitHub OAuth 回调配置。",
    claims: [
      {
        text: "如果授权完成后无法返回 ONES，或者回调页面显示 page not found，请检查 Redirect URI、Webhook 回调地址，以及 baseURL 配置是否一致。",
        kind: "verified_fact",
        evidence_ids: ["chunk:integration-callback"],
        authority: "canonical"
      }
    ],
    next_actions: ["检查 GitHub OAuth App 的 Redirect URI、ONES 侧 Webhook 回调地址和当前环境 baseURL 是否一致。"],
    unknowns: [],
    escalation_needed: false,
    confirmed_facts: ["GitHub 回调 page not found 常见于 Redirect URI、Webhook 回调地址或 baseURL 不一致。"]
  });

  try {
    await assert.rejects(
      runSupportSearchAgent({
        query: "GitHub 集成授权后回调页面显示 page not found，怎么排查？",
        language: "zh",
        currentRound: 0,
        conversationHistory: [],
        adapter,
        orchestrator: orchestrator as never,
        idempotencyKey: "support-agent-supervisor-domain-ai-fallback-dispatch",
        runtime: {
          deliveryMode: "async_job",
          overallTimeoutMs: 240000,
          requestStartedAtMs: Date.now()
        }
      }),
      /support dispatch unavailable: supervisor contract invalid/
    );
    assert.equal(adapter.routeCalls ?? 0, 0);
  } finally {
    mutableEnv.FEATURE_SUPPORT_AGENT_SINGLE_AGENT_RUNTIME = originalSingleAgentRuntime;
    mutableEnv.OPENCLAW_AGENT_ID_SUPPORT_MAIN = originalSupportMainAgentId;
  }
});

test("supervisor-domain runtime does not fabricate a local integrations answer beyond the model draft", async () => {
  const mutableEnv = env as {
    FEATURE_SUPPORT_AGENT_SINGLE_AGENT_RUNTIME?: boolean;
    OPENCLAW_AGENT_ID_SUPPORT_MAIN?: string;
  };
  const originalSingleAgentRuntime = mutableEnv.FEATURE_SUPPORT_AGENT_SINGLE_AGENT_RUNTIME;
  const originalSupportMainAgentId = mutableEnv.OPENCLAW_AGENT_ID_SUPPORT_MAIN;
  mutableEnv.FEATURE_SUPPORT_AGENT_SINGLE_AGENT_RUNTIME = true;
  mutableEnv.OPENCLAW_AGENT_ID_SUPPORT_MAIN = "support-main";

  const validationReference: SearchReference = {
    documentId: "doc:github-public-gitlab",
    evidenceId: "chunk:integration-callback",
    title: "GitHub 和公共 GitLab",
    snippet: "如果授权完成后无法返回 ONES，或者回调页面显示 page not found，请检查 Redirect URI、Webhook 回调地址，以及 baseURL 配置是否一致。",
    sourceUrl: "https://docs.ones.com/integrations/github-public-gitlab",
    path: "docs/ones-devops/code-integration/github-and-public-gitlab.mdx",
    headingPath: "链接仓库",
    authority: "canonical_visible",
    sourceType: "local_docs",
    score: 0.98,
    retrievedAt: "2026-04-09T05:30:00.000Z",
    supportMetadata: {
      product_area: "integrations",
      evidence_kind: "integration_guidance"
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
      throw new Error("supervisor-domain integration test should not refine evidence");
    }
  };

  const adapter = createFocusedAdapter() as OpenClawAdapter & {
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
  adapter.planSupportDispatch = async (input) => ({
    primaryDomain: "integrations",
    route: {
      question_type: "troubleshooting",
      user_goal: input.query,
      answer_contract: "Start with the likely callback configuration cause and the checks to run now.",
      specialist_agent: "troubleshooting-specialist",
      routing_confidence: 0.95,
      primary_domain: "integrations"
    },
    caseFrame: {
      goal: input.query,
      symptom: "授权回调页面 page not found",
      object: "GitHub OAuth callback",
      action_type: "troubleshooting",
      deployment_model: "shared",
      product_area: "integrations",
      constraints: [],
      missing_critical_info: [],
      retrieval_queries: [input.query],
      question_type: "troubleshooting",
      specialist_agent: "troubleshooting-specialist",
      answer_contract: "Start with the likely callback configuration cause and the checks to run now.",
      routing_confidence: 0.95,
      primary_domain: "integrations"
    },
    retrievalQueries: [input.query]
  });
  adapter.writeDocsDomainAnswer = async () => ({
    question_type: "troubleshooting",
    render_variant: "troubleshooting",
    direct_answer: "请先核对 GitHub OAuth 回调配置。",
    claims: [],
    next_actions: ["检查 GitHub OAuth App 中填写的 Redirect URI 是否与你当前 ONES 环境配置一致。"],
    unknowns: [],
    escalation_needed: false
  });

  try {
    const result = await runSupportSearchAgent({
      query: "GitHub 集成授权后回调页面显示 page not found，怎么排查？",
      language: "zh",
      currentRound: 0,
      conversationHistory: [],
      adapter,
      orchestrator: orchestrator as never,
      idempotencyKey: "support-agent-supervisor-domain-no-local-draft-recovery",
      runtime: {
        deliveryMode: "async_job",
        overallTimeoutMs: 240000,
        requestStartedAtMs: Date.now()
      }
    });

    assert.equal(
      ((result.result.internal_diagnostics as { route?: { primary_domain?: string } } | undefined)?.route?.primary_domain),
      "integrations"
    );
    assert.match(result.result.answer, /回调配置/);
    assert.equal(/Redirect URI|Webhook|baseURL/i.test(result.result.answer), false);
    assert.deepEqual(
      (result.result.internal_diagnostics as { claim_graph?: unknown[] } | undefined)?.claim_graph ?? [],
      []
    );
  } finally {
    mutableEnv.FEATURE_SUPPORT_AGENT_SINGLE_AGENT_RUNTIME = originalSingleAgentRuntime;
    mutableEnv.OPENCLAW_AGENT_ID_SUPPORT_MAIN = originalSupportMainAgentId;
  }
});
