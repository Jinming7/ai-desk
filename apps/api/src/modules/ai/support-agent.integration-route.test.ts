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
        object: "unspecified",
        action_type: "reset_access",
        deployment_model: "unknown",
        product_area: "openapi",
        constraints: [],
        missing_critical_info: [],
        retrieval_queries: [input.query],
        query_plan: {
          concept_queries: [input.query],
          object_queries: [input.query],
          behavior_queries: [input.query]
        }
      };
    },
    async routeSupportQuestion(input: OpenClawSupportRouterInput): Promise<SupportQuestionRoute> {
      return {
        question_type: "api_scope_auth",
        user_goal: input.query,
        answer_contract: "Provide the exact API answer first.",
        specialist_agent: "api-specialist",
        routing_confidence: 0.9
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

test("integration callback troubleshooting is not forced back onto api_scope_auth", async () => {
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
      throw new Error("integration route test should not refine evidence");
    }
  };

  try {
    const result = await runSupportSearchAgent({
      query: "GitHub 集成授权后回调页面显示 page not found，怎么排查？",
      language: "zh",
      currentRound: 0,
      conversationHistory: [],
      adapter: createFocusedAdapter(),
      orchestrator: orchestrator as never,
      idempotencyKey: "support-agent-focused-integration-callback-troubleshooting"
    });

    assert.equal(result.caseFrame.product_area, "integrations");
    assert.equal(result.caseFrame.question_type, "troubleshooting");
    assert.equal(result.caseFrame.specialist_agent, "troubleshooting-specialist");
    assert.equal(String(result.result.references[0]?.supportMetadata?.product_area ?? ""), "integrations");
    assert.match(result.result.references[0]?.snippet ?? "", /Redirect URI|回调|page not found/i);
  } finally {
    env.LOCAL_DOCS_COM_PATH = originalLocalDocsPath;
    await rm(rootDir, { recursive: true, force: true });
  }
});
