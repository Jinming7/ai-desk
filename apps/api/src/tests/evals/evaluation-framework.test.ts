import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { loadAnswerGoldenDataset } from "../../modules/ai/evals/dataset-loader.js";
import { scoreAnswerCase, summarizeAnswerResults } from "../../modules/ai/evals/answer-evaluator.js";
import { evaluateAcceptanceGates } from "../../modules/ai/evals/gates.js";
import { scoreRetrievalCase, summarizeRetrievalResults } from "../../modules/ai/evals/retrieval-evaluator.js";
import { scoreRuntimeScenarioCase, summarizeRuntimeResults } from "../../modules/ai/evals/runtime-evaluator.js";
import { summarizeBuildValidationFixtures } from "../../modules/github-kb/evals/build-validation-summarizer.js";
import { buildLiveBuildValidationFixtureCase, mapRetrievalObservation, resolveEvaluationMode } from "../ai-support-agent.business-eval.js";

test("loadAnswerGoldenDataset accepts envelope datasets and preserves version metadata", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "support-eval-loader-"));
  const datasetPath = path.join(root, "golden.json");
  await writeFile(
    datasetPath,
    JSON.stringify(
      {
        version: "2026-04-01",
        cases: [
          {
            id: "api_scope_answer",
            query: "What scope is required to create an issue comment?",
            answerLanguage: "en",
            expectedAnswerType: "api",
            requiredClaims: ["issues:write"],
            minimumNextSteps: ["Confirm the token includes issues:write."],
            minimumCitationCount: 1,
            forbiddenHallucinations: ["admin:all"]
          }
        ]
      },
      null,
      2
    ),
    "utf8"
  );

  const loaded = await loadAnswerGoldenDataset(datasetPath);
  assert.equal(loaded.version, "2026-04-01");
  assert.equal(loaded.cases[0]?.id, "api_scope_answer");
});

test("retrieval evaluator gives full credit to exact top-3 matches and penalizes wrong-family over-ranking", () => {
  const success = scoreRetrievalCase({
    datasetCase: {
      id: "exact_top3",
      query: "How do I fix GitHub callback 404?",
      answerLanguage: "en",
      conversation: [],
      expectedPrimaryFamily: "runbook_file",
      acceptablePaths: ["docs/integrations/github-callback.md"],
      acceptableArtifactIds: [],
      acceptableCitationTargets: [],
      expectedExactSignals: ["callback"],
      forbiddenFamilies: ["openapi_spec"],
      requireGroundableCandidate: true,
      expectKbUnavailable: false
    },
    observed: {
      retrievalStatus: "grounded",
      publicationScopedRead: true,
      resolvedQueries: ["github callback 404"],
      candidates: [
        {
          artifactId: "docs/integrations/github-callback.md",
          path: "docs/integrations/github-callback.md",
          citationTarget: "docs/integrations/github-callback.md#redirect-uri",
          family: "runbook_file",
          groundable: true,
          exactSignalMatches: ["callback"]
        }
      ]
    }
  });

  const penalized = scoreRetrievalCase({
    datasetCase: {
      id: "wrong_family_top3",
      query: "What scope is required to create an issue comment?",
      answerLanguage: "en",
      conversation: [],
      expectedPrimaryFamily: "openapi_spec",
      acceptablePaths: ["open-docs/openapi/comments.md"],
      acceptableArtifactIds: [],
      acceptableCitationTargets: [],
      expectedExactSignals: ["scope"],
      forbiddenFamilies: ["config_file"],
      requireGroundableCandidate: true,
      expectKbUnavailable: false
    },
    observed: {
      retrievalStatus: "grounded",
      publicationScopedRead: true,
      resolvedQueries: ["issue comment scope"],
      candidates: [
        {
          artifactId: "docs/config/oauth.md",
          path: "docs/config/oauth.md",
          citationTarget: "docs/config/oauth.md#redirect",
          family: "config_file",
          groundable: true,
          exactSignalMatches: []
        },
        {
          artifactId: "open-docs/openapi/comments.md",
          path: "open-docs/openapi/comments.md",
          citationTarget: "open-docs/openapi/comments.md#issue-comment",
          family: "openapi_spec",
          groundable: true,
          exactSignalMatches: ["scope"]
        }
      ]
    }
  });

  const summary = summarizeRetrievalResults([success, penalized]);
  assert.equal(success.scoreLabel, "exact_top_3");
  assert.equal(penalized.wrongFamilyOverRanking, true);
  assert.equal(summary.metrics.retrieval_hit_at_3, 1);
  assert.equal(summary.metrics.wrong_family_top_3_rate, 0.5);
});

test("runtime evaluator flags contract violations when required stage is skipped or forbidden stage appears", () => {
  const result = scoreRuntimeScenarioCase({
    datasetCase: {
      id: "runtime_contract",
      query: "Why is the callback endpoint returning 404?",
      answerLanguage: "en",
      conversation: [{ role: "user", content: "This happens after GitHub OAuth." }],
      expectedRoute: "troubleshooting",
      expectedSpecialistFamily: "troubleshooting",
      expectClarification: false,
      expectedAnswerMode: "grounded",
      requiredStages: ["route", "evidence_plan", "retrieval", "verification", "answer_composition"],
      forbiddenStages: ["generic_writer"],
      allowedFallbackStages: ["citation_selection"]
    },
    observed: {
      route: "troubleshooting",
      specialistFamily: "troubleshooting",
      answerMode: "grounded",
      clarificationNeeded: false,
      stageTrace: [
        { stage: "route", status: "completed", duration_ms: 12 },
        { stage: "retrieval", status: "completed", duration_ms: 55 },
        { stage: "generic_writer", status: "completed", duration_ms: 8 }
      ],
      verificationVerdict: "verified",
      timeoutStages: [],
      explicitFallbacks: []
    }
  });

  const summary = summarizeRuntimeResults([result]);
  assert.equal(result.contractViolations.length > 0, true);
  assert.equal(summary.metrics.stage_contract_violation_count, result.contractViolations.length);
  assert.equal(summary.metrics.route_accuracy, 1);
  assert.equal(summary.metrics.specialist_selection_accuracy, 1);
});

test("answer evaluator fails unsupported grounded answers without required citations", () => {
  const passing = scoreAnswerCase({
    datasetCase: {
      id: "answer_pass",
      query: "What scope is required to create an issue comment?",
      answerLanguage: "en",
      conversation: [],
      expectedAnswerType: "api",
      requiredClaims: ["issues:write"],
      minimumNextSteps: ["Confirm the token includes issues:write."],
      minimumCitationCount: 1,
      requiredCitationTargets: ["open-docs/openapi/comments.md"],
      forbiddenHallucinations: ["admin:all"],
      requireDirectAnswer: true,
      maximumStillNeedToConfirm: 2
    },
    observed: {
      answerMode: "grounded",
      answerType: "api",
      directAnswer: "Use the issues:write scope to create an issue comment.",
      fullAnswerText: "Use the issues:write scope to create an issue comment.",
      whatToDoNow: ["Confirm the token includes issues:write."],
      stillNeedToConfirm: [],
      citations: [{ id: "c1", title: "Issue comment", source_url: "https://docs.ones.com/open-docs/openapi/comments.md" }],
      verificationVerdict: "verified",
      unsupportedClaims: []
    }
  });

  const failing = scoreAnswerCase({
    datasetCase: {
      id: "answer_fail",
      query: "Does ONESQL support ORDER BY and GROUP BY?",
      answerLanguage: "en",
      conversation: [],
      expectedAnswerType: "behavior",
      requiredClaims: ["supports ORDER BY", "supports GROUP BY"],
      minimumNextSteps: ["Run the query against a published ONESQL environment."],
      minimumCitationCount: 1,
      requiredCitationTargets: ["docs/onesql"],
      forbiddenHallucinations: ["admin:all"],
      requireDirectAnswer: true,
      maximumStillNeedToConfirm: 2
    },
    observed: {
      answerMode: "grounded",
      answerType: "behavior",
      directAnswer: "ONESQL definitely supports admin:all and advanced admin-only clauses.",
      fullAnswerText: "ONESQL definitely supports admin:all and advanced admin-only clauses.",
      whatToDoNow: [],
      stillNeedToConfirm: [],
      citations: [],
      verificationVerdict: "unsupported",
      unsupportedClaims: ["advanced admin-only clauses"]
    }
  });

  const summary = summarizeAnswerResults([passing, failing]);
  assert.equal(passing.label, "pass");
  assert.equal(failing.label, "fail");
  assert.equal(summary.metrics.citation_presence_rate, 0.5);
  assert.equal(summary.metrics.hallucination_rate, 0.5);
});

test("build validation summarizer blocks publication when cross-build violations exist", () => {
  const summary = summarizeBuildValidationFixtures([
    {
      id: "publishable-build",
      knowledgeSpace: "support-eval",
      repoId: "repo-1",
      branch: "master",
      buildVersion: "build-1",
      buildStatus: "validated",
      buildSuccess: true,
      validationPassed: true,
      duplicateActivePathCount: 0,
      artifactCountsByFamily: {
        doc_page: 10,
        openapi_spec: 1,
        code_file: 2
      },
      citationCount: 12,
      memoryEntryCount: 8,
      crossBuildReferenceViolationCount: 0,
      embeddingEnabledFamilies: ["doc_page"],
      missingEmbeddingCount: 0,
      previousArtifactCountsByFamily: {}
    },
    {
      id: "blocked-build",
      knowledgeSpace: "support-eval",
      repoId: "repo-1",
      branch: "master",
      buildVersion: "build-2",
      buildStatus: "failed",
      buildSuccess: false,
      validationPassed: false,
      duplicateActivePathCount: 2,
      artifactCountsByFamily: {
        doc_page: 8,
        openapi_spec: 1
      },
      citationCount: 9,
      memoryEntryCount: 4,
      crossBuildReferenceViolationCount: 3,
      embeddingEnabledFamilies: ["doc_page"],
      missingEmbeddingCount: 2,
      previousArtifactCountsByFamily: {}
    }
  ]);

  assert.equal(summary.metrics.build_success_rate, 0.5);
  assert.equal(summary.metrics.cross_build_reference_violation_count, 3);
  assert.equal(summary.publishable, false);
});

test("acceptance gates stop rollout when answer quality regresses or baseline is missing for behavior changes", () => {
  const decision = evaluateAcceptanceGates({
    buildSummary: {
      metrics: {
        build_success_rate: 1,
        build_validation_pass_rate: 1,
        duplicate_active_path_rate: 0,
        artifact_count_delta_by_family: {},
        citation_count_delta: 0,
        memory_entry_count_delta: 0,
        embedding_missing_rate: 0,
        cross_build_reference_violation_count: 0
      },
      publishable: true,
      failures: []
    },
    retrievalSummary: {
      metrics: {
        retrieval_hit_at_1: 0.8,
        retrieval_hit_at_3: 0.9,
        retrieval_hit_at_5: 0.9,
        retrieval_hit_at_10: 0.9,
        family_hit_at_3: 1,
        exact_signal_capture_rate: 1,
        wrong_family_top_3_rate: 0,
        groundable_candidate_rate: 1,
        kb_unavailable_false_positive_rate: 0,
        publication_scoped_read_rate: 1
      },
      scoreCounts: {
        exact_top_3: 1,
        acceptable_family_top_3: 0,
        low_credit_late_hit: 0,
        wrong_family_penalty: 0,
        no_useful_candidate: 0
      },
      failures: []
    },
    runtimeSummary: {
      metrics: {
        route_accuracy: 1,
        specialist_selection_accuracy: 1,
        clarification_precision: 1,
        clarification_recall: 1,
        stage_timeout_rate: 0,
        stage_fallback_rate: 0,
        stage_contract_violation_count: 0,
        verification_overturn_rate: 0
      },
      failures: []
    },
    answerSummary: {
      metrics: {
        answer_mode_accuracy: 0.8,
        direct_answer_correctness: 0.8,
        customer_actionability_score: 0.9,
        citation_presence_rate: 0.8,
        hallucination_rate: 0.2,
        handoff_appropriateness: 1,
        minimum_missing_info_quality: 1
      },
      labelCounts: {
        pass: 1,
        pass_with_minor_issue: 0,
        needs_improvement: 0,
        fail: 1
      },
      failures: ["golden-answer-regression"]
    },
    baseline: {
      retrievalSummary: {
        metrics: {
          retrieval_hit_at_1: 0.8,
          retrieval_hit_at_3: 0.92,
          retrieval_hit_at_5: 0.92,
          retrieval_hit_at_10: 0.92,
          family_hit_at_3: 1,
          exact_signal_capture_rate: 1,
          wrong_family_top_3_rate: 0,
          groundable_candidate_rate: 1,
          kb_unavailable_false_positive_rate: 0,
          publication_scoped_read_rate: 1
        },
        scoreCounts: {
          exact_top_3: 1,
          acceptable_family_top_3: 0,
          low_credit_late_hit: 0,
          wrong_family_penalty: 0,
          no_useful_candidate: 0
        },
        failures: []
      },
      runtimeSummary: {
        metrics: {
          route_accuracy: 1,
          specialist_selection_accuracy: 1,
          clarification_precision: 1,
          clarification_recall: 1,
          stage_timeout_rate: 0,
          stage_fallback_rate: 0,
          stage_contract_violation_count: 0,
          verification_overturn_rate: 0
        },
        failures: []
      },
      answerSummary: {
        metrics: {
          answer_mode_accuracy: 0.95,
          direct_answer_correctness: 0.95,
          customer_actionability_score: 0.95,
          citation_presence_rate: 0.95,
          hallucination_rate: 0,
          handoff_appropriateness: 1,
          minimum_missing_info_quality: 1
        },
        labelCounts: {
          pass: 2,
          pass_with_minor_issue: 0,
          needs_improvement: 0,
          fail: 0
        },
        failures: []
      }
    },
    requireBaselineForBehaviorChanges: true,
    executionMode: "production",
    shadowValidationStable: false,
    rollbackReady: true,
    diagnosticsAvailable: true
  });

  assert.equal(decision.gates.answerQualityGate.passed, false);
  assert.equal(decision.gates.productionEnablementGate.passed, false);
  assert.equal(decision.releaseDecision, "blocked");
});

test("retrieval gate blocks obviously broken retrieval even without baseline", () => {
  const decision = evaluateAcceptanceGates({
    buildSummary: {
      metrics: {
        build_success_rate: 1,
        build_validation_pass_rate: 1,
        duplicate_active_path_rate: 0,
        artifact_count_delta_by_family: {},
        citation_count_delta: 0,
        memory_entry_count_delta: 0,
        embedding_missing_rate: 0,
        cross_build_reference_violation_count: 0
      },
      publishable: true,
      failures: []
    },
    retrievalSummary: {
      metrics: {
        retrieval_hit_at_1: 0,
        retrieval_hit_at_3: 0,
        retrieval_hit_at_5: 0,
        retrieval_hit_at_10: 0,
        family_hit_at_3: 0,
        exact_signal_capture_rate: 0.8,
        wrong_family_top_3_rate: 0,
        groundable_candidate_rate: 0,
        kb_unavailable_false_positive_rate: 1,
        publication_scoped_read_rate: 0
      },
      scoreCounts: {
        exact_top_3: 0,
        acceptable_family_top_3: 0,
        low_credit_late_hit: 0,
        wrong_family_penalty: 0,
        no_useful_candidate: 5
      },
      failures: [
        "case-1:kb_unavailable_false_positive",
        "case-1:no_groundable_candidate",
        "case-1:no_useful_candidate"
      ]
    },
    runtimeSummary: {
      metrics: {
        route_accuracy: 1,
        specialist_selection_accuracy: 1,
        clarification_precision: 1,
        clarification_recall: 1,
        stage_timeout_rate: 0,
        stage_fallback_rate: 0,
        stage_contract_violation_count: 0,
        verification_overturn_rate: 0
      },
      failures: []
    },
    answerSummary: {
      metrics: {
        answer_mode_accuracy: 1,
        direct_answer_correctness: 1,
        customer_actionability_score: 1,
        citation_presence_rate: 1,
        hallucination_rate: 0,
        handoff_appropriateness: 1,
        minimum_missing_info_quality: 1
      },
      labelCounts: {
        pass: 1,
        pass_with_minor_issue: 0,
        needs_improvement: 0,
        fail: 0
      },
      failures: []
    },
    executionMode: "fast_local",
    shadowValidationStable: false,
    rollbackReady: true,
    diagnosticsAvailable: true
  });

  assert.equal(decision.gates.retrievalChangeGate.passed, false);
  assert.equal(decision.gates.retrievalChangeGate.reasons.includes("retrieval_hit_at_3_zero"), true);
  assert.equal(decision.gates.retrievalChangeGate.reasons.includes("groundable_candidate_rate_zero"), true);
  assert.equal(decision.gates.retrievalChangeGate.reasons.includes("kb_unavailable_false_positive_rate_high"), true);
});

test("mapRetrievalObservation treats zero-hit retrieval without explicit status as no_results", () => {
  const observation = mapRetrievalObservation(
    {
      query: "Does ONESQL support ORDER BY and GROUP BY?",
      profile: "agent",
      answerLanguage: "en",
      answer: "The evaluation environment cannot reach the knowledge base right now.",
      resolvedQueries: ["Does ONESQL support ORDER BY and GROUP BY?"],
      confidence: 0,
      fallbackUsed: false,
      hits: []
    },
    ["onesql", "order by", "group by"]
  );

  assert.equal(observation.publicationScopedRead, false);
  assert.equal(observation.retrievalStatus, "no_results");
  assert.equal(observation.candidates.length, 0);
});

test("mapRetrievalObservation keeps explicit kb_unavailable status when the retrieval layer reports publication or substrate failure", () => {
  const observation = mapRetrievalObservation(
    {
      query: "Does ONESQL support ORDER BY and GROUP BY?",
      profile: "agent",
      answerLanguage: "en",
      answer: "The evaluation environment cannot reach the knowledge base right now.",
      resolvedQueries: ["Does ONESQL support ORDER BY and GROUP BY?"],
      confidence: 0,
      fallbackUsed: false,
      retrievalStatus: "kb_unavailable",
      hits: []
    },
    ["onesql", "order by", "group by"]
  );

  assert.equal(observation.publicationScopedRead, false);
  assert.equal(observation.retrievalStatus, "kb_unavailable");
  assert.equal(observation.candidates.length, 0);
});

test("resolveEvaluationMode defaults to isolated_db in NODE_ENV=test without an explicit override", () => {
  assert.equal(resolveEvaluationMode(null, "test"), "isolated_db");
  assert.equal(resolveEvaluationMode(undefined, "test"), "isolated_db");
  assert.equal(resolveEvaluationMode("production", "test"), "production");
  assert.equal(resolveEvaluationMode(null, "development"), "fast_local");
});

test("buildLiveBuildValidationFixtureCase summarizes a clean published build as publishable", () => {
  const summary = summarizeBuildValidationFixtures([
    buildLiveBuildValidationFixtureCase({
      build: {
        id: "build-1",
        knowledge_space: "support-local",
        repo_id: "repo-1",
        branch: "master",
        build_version: "build-1",
        status: "published",
        validation_passed: true
      },
      validationSnapshot: {
        duplicatePaths: 0,
        orphanChunks: 0,
        crossBuildMemorySources: 0,
        missingChunkDocuments: 0,
        totalDocuments: 4,
        totalChunks: 6,
        totalMemoryEntries: 4
      },
      artifactSummary: {
        artifactCountsByFamily: {
          doc_page: 4,
          openapi_spec: 1,
          chunks: 6,
          memory_entries: 4,
          citation_units: 4
        },
        embeddingSummary: {
          chunkEmbeddings: { total: 6, ready: 6, missing: 0 },
          citationEmbeddings: { total: 4, ready: 4, missing: 0 }
        }
      }
    })
  ]);

  assert.equal(summary.publishable, true);
  assert.equal(summary.metrics.build_success_rate, 1);
  assert.equal(summary.metrics.build_validation_pass_rate, 1);
  assert.equal(summary.metrics.cross_build_reference_violation_count, 0);
  assert.equal(summary.failures.length, 0);
});
