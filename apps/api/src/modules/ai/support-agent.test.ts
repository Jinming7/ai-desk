import assert from "node:assert/strict";
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
  OpenClawSupportPlannerInput,
  OpenClawSupportVerifierInput,
  OpenClawSupportWriterInput
} from "../../infrastructure/openclaw/types.js";
import { runSupportSearchAgent } from "./support-agent.js";
import type { DraftSupportAnswer, SupportCaseFrame, SupportVerificationResult, TriageSupportInsight } from "./types.js";

function createAdapter(options: {
  missingInfo?: string[];
  searchHits?: OpenClawSearchOutput["hits"];
  writerAnswer?: Partial<DraftSupportAnswer>;
  verification?: Partial<SupportVerificationResult>;
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
        retrieval_queries: [input.query]
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
        verified_claims: [],
        claim_to_citation_map: [],
        ...options.verification
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
        verified_claims: [],
        claim_to_citation_map: []
      };
    },
    async healthCheck() {
      return { ok: true as const, mode: "mock" as const };
    }
  };
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
    assert.equal(result.stageTimings.retrieval_extra.status, "skipped");
  } finally {
    env.LOCAL_DOCS_COM_PATH = originalLocalDocsPath;
  }
});

test("runSupportSearchAgent removes unsupported auxiliary claims without downgrading a supported core answer", async () => {
  const adapter = createAdapter({
    searchHits: [
      {
        id: "issue-comment-scope",
        title: "Issue Comment",
        snippet: "write:project:issue-comment: Add, edit, delete issue comments",
        score: 0.99,
        sourceUrl: "https://docs.ones.com/developer/openapi/api/issue-comment"
      }
    ],
    writerAnswer: {
      direct_answer: "The required OAuth scope is `write:project:issue-comment`.",
      claims: [
        {
          text: "The required OAuth scope is `write:project:issue-comment`.",
          kind: "verified_fact",
          evidence_ids: ["issue-comment-scope"],
          authority: "canonical"
        }
      ],
      next_actions: [
        "Request an OAuth token with the `write:project:issue-comment` scope.",
        "Call the API with that token in the Authorization header."
      ]
    },
    verification: {
      verdict: "partial",
      summary: "The core answer is supported, but the Authorization header detail is not explicitly shown.",
      unsupported_claims: ["Call the API with that token in the Authorization header."],
      verified_citation_ids: ["issue-comment-scope"],
      verified_claims: ["The required OAuth scope is `write:project:issue-comment`."],
      claim_to_citation_map: [
        {
          text: "The required OAuth scope is `write:project:issue-comment`.",
          kind: "verified_fact",
          verdict: "verified",
          citation_ids: ["issue-comment-scope"]
        }
      ]
    }
  });

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
  assert.deepEqual(result.result.support_answer?.what_to_do_now, ["Request an OAuth token with the `write:project:issue-comment` scope."]);
  assert.equal(result.result.unresolved_reason_code, null);
});
