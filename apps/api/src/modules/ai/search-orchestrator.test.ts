import assert from "node:assert/strict";
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
  OpenClawSupportEvidencePlannerInput,
  OpenClawSupportEvidenceSelectorInput,
  OpenClawSupportPlannerInput,
  OpenClawSupportRouterInput,
  OpenClawSupportSpecialistInput,
  OpenClawSupportVerifierInput,
  OpenClawSupportWriterInput
} from "../../infrastructure/openclaw/types.js";
import {
  resolveSearchReferenceEvidenceId,
  type DraftSupportAnswer,
  type SpecialistDraftAnswer,
  type SupportCaseFrame,
  type SupportEvidencePlan,
  type SupportQuestionRoute,
  type SupportVerificationResult,
  type TriageSupportInsight
} from "./types.js";
import { SearchOrchestrator } from "./search-orchestrator.js";

async function createFixtureRoot(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "search-orchestrator-test-"));
}

async function writeFixture(rootDir: string, relativePath: string, content: string): Promise<void> {
  const filePath = path.join(rootDir, relativePath);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, content, "utf8");
}

function createAdapter(searchKnowledgeCalls: { count: number }): OpenClawAdapter {
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
      searchKnowledgeCalls.count += 1;
      throw new Error("searchKnowledge should not be called when local docs already matched");
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
        object: "issue_comment",
        action_type: "how_to",
        deployment_model: "shared",
        product_area: "openapi",
        constraints: [],
        missing_critical_info: [],
        retrieval_queries: [input.query]
      };
    },
    async routeSupportQuestion(input: OpenClawSupportRouterInput): Promise<SupportQuestionRoute> {
      return {
        question_type: "api_endpoint_lookup",
        user_goal: input.query,
        answer_contract: "Provide the exact API answer first.",
        specialist_agent: "api-specialist",
        routing_confidence: 0.9
      };
    },
    async planSupportEvidence(input: OpenClawSupportEvidencePlannerInput): Promise<SupportEvidencePlan> {
      return {
        query_plan: {
          concept_queries: [input.query],
          object_queries: [input.query],
          behavior_queries: [input.query]
        },
        evidence_priority: [],
        required_doc_kinds: ["openapi/api"]
      };
    },
    async writeSupportAnswer(
      _input: OpenClawSupportWriterInput,
      _idempotencyKey: string,
      _runtime?: OpenClawRuntimeContext
    ): Promise<DraftSupportAnswer> {
      return {
        direct_answer: "",
        claims: [],
        next_actions: [],
        unknowns: [],
        escalation_needed: false
      };
    },
    async writeApiSpecialistAnswer(_input: OpenClawSupportSpecialistInput): Promise<SpecialistDraftAnswer> {
      return {
        question_type: "api_endpoint_lookup",
        render_variant: "api",
        direct_answer: "",
        claims: [],
        next_actions: [],
        unknowns: [],
        escalation_needed: false
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
    async judgeSupportAnswer(input: OpenClawSupportVerifierInput, _idempotencyKey: string, _runtime?: OpenClawRuntimeContext): Promise<SupportVerificationResult> {
      return this.verifySupportAnswer(input, "", _runtime);
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
    async verifySupportAnswer(
      _input: OpenClawSupportVerifierInput,
      _idempotencyKey: string,
      _runtime?: OpenClawRuntimeContext
    ): Promise<SupportVerificationResult> {
      return {
        verdict: "verified",
        summary: "",
        unsupported_claims: [],
        missing_info: [],
        verified_citation_ids: [],
        display_citation_ids: [],
        verified_claims: [],
        claim_to_citation_map: []
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
        render_variant: "api",
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

test("collectEvidence does not promote local docs into primary evidence when github kb has no matching document", async () => {
  const rootDir = await createFixtureRoot();
  const originalLocalDocsPath = env.LOCAL_DOCS_COM_PATH;
  const searchKnowledgeCalls = { count: 0 };
  try {
    env.LOCAL_DOCS_COM_PATH = rootDir;
    await writeFixture(
      rootDir,
      "open-docs/docs/openapi/api/issue-comment.info.mdx",
      `---
id: issue-comment
title: "Issue Comment"
---

# Issue Comment

## Authentication

Scopes:

- write:project:issue-comment: Add, edit, delete issue comments
- read:project:issue-comment: Access issue comment
`
    );

    const orchestrator = new SearchOrchestrator(createAdapter(searchKnowledgeCalls));
    const result = await orchestrator.collectEvidence({
      queries: ["What scope is required to create an issue comment via OpenAPI?"],
      idempotencyKey: "search-orchestrator-local-first",
      answerLanguage: "en",
      runtime: {
        intent: "retrieval",
        sessionKey: "search-orchestrator-disable-local-docs",
        disableLocalDocs: true
      }
    });

    assert.equal(searchKnowledgeCalls.count, 0);
    assert.equal(result.references.length, 0);
    assert.equal(result.retrievalStatus, "kb_unavailable");
  } finally {
    env.LOCAL_DOCS_COM_PATH = originalLocalDocsPath;
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("search keeps explicit kb retrieval failures as kb_unavailable", async () => {
  const searchKnowledgeCalls = { count: 0 };
  const orchestrator = new SearchOrchestrator(createAdapter(searchKnowledgeCalls));

  const result = await orchestrator.search("simulate_support_agent_failure", "search-orchestrator-kb-unavailable");

  assert.equal(result.references.length, 0);
  assert.equal(result.retrievalStatus, "kb_unavailable");
  assert.equal(result.unresolvedReasonCode, "KB_RETRIEVAL_UNAVAILABLE");
});
