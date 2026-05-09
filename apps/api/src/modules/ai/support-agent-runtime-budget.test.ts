import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
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
import { SearchOrchestrator } from "./search-orchestrator.js";
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
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "support-agent-budget-test-"));
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

function createBudgetProbeAdapter(observedTimeoutMs: {
  evidenceSelection?: number;
  specialist?: number;
  answerComposer?: number;
}): OpenClawAdapter {
  const verifiedClaim = "可以通过迁移工具执行 rebuild indexes 任务来重建索引。";
  const evidenceId = "local:docs/import-data-into-ones/rebuild-indexes-after-migration.mdx:root";
  const verifiedResult: SupportVerificationResult = {
    verdict: "verified",
    summary: "The rebuild-indexes procedure is documented.",
    unsupported_claims: [],
    missing_info: [],
    verified_citation_ids: [evidenceId],
    display_citation_ids: [evidenceId],
    verified_claims: [verifiedClaim],
    claim_to_citation_map: [
      {
        text: verifiedClaim,
        kind: "verified_fact",
        verdict: "verified",
        citation_ids: [evidenceId]
      }
    ]
  };
  const specialistDraft: SpecialistDraftAnswer = {
    question_type: "how_to_product",
    render_variant: "how_to",
    direct_answer: "要重建索引，可以直接执行迁移工具里的 rebuild indexes 任务。",
    claims: [
      {
        text: verifiedClaim,
        kind: "verified_fact",
        evidence_ids: [evidenceId],
        authority: "canonical"
      }
    ],
    next_actions: ["执行 rebuild indexes。", "确认最新索引任务执行完成。"],
    steps: ["打开迁移工具。", "执行 rebuild indexes 任务。", "确认最新索引任务执行完成。"],
    unknowns: [],
    escalation_needed: false
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
        intent: "feature_usage",
        route: "kb_guidance",
        confidence: 0.9,
        reasoning: ""
      };
    },
    async planSupportCase(input: OpenClawSupportPlannerInput): Promise<SupportCaseFrame> {
      return {
        goal: input.query,
        symptom: input.query,
        object: "rebuild indexes",
        action_type: "how_to",
        deployment_model: "shared",
        product_area: "general",
        constraints: [],
        missing_critical_info: [],
        retrieval_queries: [input.query],
        query_plan: {
          concept_queries: [input.query],
          object_queries: ["rebuild indexes"],
          behavior_queries: ["how to rebuild indexes"]
        },
        question_type: "how_to_product",
        specialist_agent: "howto-specialist",
        answer_contract: "Give direct steps first.",
        routing_confidence: 0.92,
        required_doc_kinds: ["product_guide"]
      };
    },
    async routeSupportQuestion(input: OpenClawSupportRouterInput): Promise<SupportQuestionRoute> {
      return {
        question_type: "how_to_product",
        user_goal: input.query,
        answer_contract: "Give direct steps first.",
        specialist_agent: "howto-specialist",
        routing_confidence: 0.92,
        specialist_budget: 1
      };
    },
    async planSupportEvidence(input: OpenClawSupportEvidencePlannerInput): Promise<SupportEvidencePlan> {
      return {
        query_plan: {
          concept_queries: [input.query],
          object_queries: ["rebuild indexes"],
          behavior_queries: ["how to rebuild indexes"]
        },
        evidence_priority: ["product guide"],
        required_doc_kinds: ["product_guide"],
        retrieval_rounds: 2,
        allow_refinement: true,
        stop_after_grounded_evidence: false
      };
    },
    async selectSupportEvidence(input: OpenClawSupportEvidenceSelectorInput, _idempotencyKey: string, runtime?: OpenClawRuntimeContext) {
      observedTimeoutMs.evidenceSelection = runtime?.timeoutMs;
      return {
        primary_ids: input.references.slice(0, 3).map((item) => item.documentId),
        supplemental_ids: input.references.slice(3, 5).map((item) => item.documentId),
        rejected_ids: input.references.slice(5).map((item) => item.documentId)
      };
    },
    async writeSupportAnswer(_input: OpenClawSupportWriterInput): Promise<DraftSupportAnswer> {
      return {
        direct_answer: specialistDraft.direct_answer,
        claims: specialistDraft.claims,
        next_actions: specialistDraft.next_actions,
        unknowns: [],
        escalation_needed: false
      };
    },
    async writeApiSpecialistAnswer(_input: OpenClawSupportSpecialistInput): Promise<SpecialistDraftAnswer> {
      return specialistDraft;
    },
    async writeHowToSpecialistAnswer(
      _input: OpenClawSupportSpecialistInput,
      _idempotencyKey: string,
      runtime?: OpenClawRuntimeContext
    ): Promise<SpecialistDraftAnswer> {
      observedTimeoutMs.specialist = runtime?.timeoutMs;
      return specialistDraft;
    },
    async writeBehaviorSpecialistAnswer(_input: OpenClawSupportSpecialistInput): Promise<SpecialistDraftAnswer> {
      return specialistDraft;
    },
    async writeTroubleshootingSpecialistAnswer(_input: OpenClawSupportSpecialistInput): Promise<SpecialistDraftAnswer> {
      return specialistDraft;
    },
    async judgeSupportAnswer(_input: OpenClawSupportVerifierInput): Promise<SupportVerificationResult> {
      return verifiedResult;
    },
    async verifySupportAnswer(_input: OpenClawSupportVerifierInput): Promise<SupportVerificationResult> {
      return verifiedResult;
    },
    async composeCustomerAnswer(input, _idempotencyKey: string, runtime?: OpenClawRuntimeContext) {
      observedTimeoutMs.answerComposer = runtime?.timeoutMs;
      return {
        question_type: input.route.question_type,
        render_variant: "how_to" as const,
        direct_answer: input.supportedClaims[0]?.text ?? verifiedClaim,
        sections: [],
        why: [],
        what_to_do_now: input.nextActions,
        still_need_to_confirm: input.unknowns
      };
    },
    async writeTriageInsight(): Promise<TriageSupportInsight> {
      return {
        direct_answer: verifiedClaim,
        recommended_action: "resolve",
        customer_reply: verifiedClaim,
        customer_reply_policy: "send_now",
        support_summary: verifiedClaim,
        verified_evidence: ["Rebuild indexes after migration"],
        risk_flags: [],
        missing_info: [],
        verifier_verdict: "verified"
      };
    },
    async verifyTriageInsight(): Promise<SupportVerificationResult> {
      return verifiedResult;
    },
    async healthCheck() {
      return {
        ok: true,
        mode: "mock" as const,
        configuredAgents: [],
        reachableAgents: []
      };
    }
  };
}

test("runSupportSearchAgent gives async jobs wider specialist budgets while the active selector stays within its local cap", async () => {
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

  const observedTimeoutMs: {
    evidenceSelection?: number;
    specialist?: number;
    answerComposer?: number;
  } = {};

  try {
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
          query: "怎么重建索引",
          answer: "",
          confidence: 0.93,
          references: [
            {
              documentId: "local:docs/import-data-into-ones/rebuild-indexes-after-migration.mdx:root",
              title: "Rebuild indexes after migration",
              snippet: "Run the rebuild indexes task after migration.",
              sourceUrl: "https://docs.ones.com/import-data-into-ones/rebuild-indexes-after-migration",
              repoSourceUrl:
                "https://github.com/BangWork/docs-com/blob/main/docs/import-data-into-ones/rebuild-indexes-after-migration.mdx",
              repo: "BangWork/docs-com",
              branch: "main",
              path: "docs/import-data-into-ones/rebuild-indexes-after-migration.mdx",
              commitSha: "fixture",
              headingPath: "ROOT",
              supportMetadata: {
                authority: "canonical_visible",
                source_type: "local_docs"
              },
              authority: "canonical_visible" as const,
              sourceType: "local_docs" as const,
              score: 0.93,
              retrievedAt
            }
          ],
          retrievalStatus: "grounded" as const,
          unresolvedReasonCode: null,
          resolvedQueries: ["怎么重建索引"],
          fallbackUsed: false
        };
      }
    }
    const adapter = createBudgetProbeAdapter(observedTimeoutMs);
    await runSupportSearchAgent({
      query: "怎么重建索引",
      language: "zh",
      currentRound: 0,
      conversationHistory: [],
      adapter,
      orchestrator: new FixedEvidenceOrchestrator(adapter, {} as never),
      idempotencyKey: "support-agent-async-job-stage-budgets",
      runtime: {
        deliveryMode: "async_job",
        overallTimeoutMs: 240000,
        requestStartedAtMs: Date.now()
      }
    });

    const observedSummary = JSON.stringify(observedTimeoutMs);
    assert.equal((observedTimeoutMs.specialist ?? 0) >= 18_000, true, observedSummary);
    assert.equal(observedTimeoutMs.evidenceSelection, 12_000, observedSummary);
  } finally {
    env.LOCAL_DOCS_COM_PATH = originalLocalDocsPath;
    await rm(rootDir, { recursive: true, force: true });
  }
});
