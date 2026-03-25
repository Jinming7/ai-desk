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
import { runSupportSearchAgent } from "./support-agent.js";
import type {
  DraftSupportAnswer,
  SpecialistDraftAnswer,
  SupportCaseFrame,
  SupportEvidencePlan,
  SupportQuestionRoute,
  SupportVerificationResult,
  TriageSupportInsight
} from "./types.js";

async function createFixtureRoot(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "support-agent-test-"));
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
        primary_ids: input.references.slice(0, 3).map((item) => item.documentId),
        supplemental_ids: input.references.slice(3, 5).map((item) => item.documentId),
        rejected_ids: input.references.slice(5).map((item) => item.documentId)
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
    const verifiedId = cited?.documentId ? [cited.documentId] : [];
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
    assert.ok(result.result.support_answer?.what_to_do_now.includes("Request an OAuth token with the `write:project:issue-comment` scope."));
    assert.equal(result.result.unresolved_reason_code, null);
  } finally {
    env.LOCAL_DOCS_COM_PATH = originalLocalDocsPath;
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("runSupportSearchAgent uses fast multi-agent path for grounded how-to answers", async () => {
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
    assert.equal(displaySelectorCalled, true);
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
    assert.match(result.result.references[0]?.path ?? "", /open-docs\/docs\/openapi\/api\//);
    assert.doesNotMatch(result.result.answer, /sidebarposition|slug:\s*\/admin\/account-integration|AD 和 CAS|本地部署版本中可用/i);
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
    const verifiedId = cited?.documentId ? [cited.documentId] : [];
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
    assert.equal(result.stageTimings.writer.status, "skipped");
    assert.equal(diagnostics.specialist_skipped, true);
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

test("runSupportSearchAgent reports dedicated selector stages in orchestration trace instead of main fallback", async () => {
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
  const evidenceSelector = trace.find((item) => item.stage === "support-evidence-selector");
  assert.ok(evidenceSelector);
  assert.equal(evidenceSelector?.agent_id, "support-evidence-selector");
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
    const verifiedId = cited?.documentId ? [cited.documentId] : [];
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
    const verifiedId = cited?.documentId ? [cited.documentId] : [];
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

test("runSupportSearchAgent prefers citation binder output when verifier citations are tangential", async () => {
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
    const wrongId = wrong?.documentId ? [wrong.documentId] : [];
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
  adapter.bindSupportCitations = async (input) => {
    const right = [...input.evidenceBundle.primary, ...input.evidenceBundle.supplemental].find((item) => /execute onesql query/i.test(item.title));
    const rightId = right?.documentId ? [right.documentId] : [];
    return {
      verdict: "verified",
      summary: "The claim was rebound to the direct ONESQL syntax reference.",
      unsupported_claims: [],
      missing_info: [],
      verified_citation_ids: rightId,
      display_citation_ids: rightId,
      verified_claims: ["The ONESQL syntax reference discusses ORDER BY and GROUP BY clauses."],
      claim_to_citation_map: [
        {
          text: "The ONESQL syntax reference discusses ORDER BY and GROUP BY clauses.",
          kind: "verified_fact",
          verdict: "verified",
          citation_ids: rightId
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
