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
  OpenClawSupportEvidenceSelectorInput,
  OpenClawSupportPlannerInput,
  OpenClawSupportVerifierInput,
  OpenClawSupportWriterInput
} from "../../infrastructure/openclaw/types.js";
import { runSupportSearchAgent } from "./support-agent.js";
import type { DraftSupportAnswer, SupportCaseFrame, SupportVerificationResult, TriageSupportInsight } from "./types.js";

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
