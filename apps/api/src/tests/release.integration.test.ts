import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";
import type { AddressInfo } from "node:net";
import "./helpers/fetch-polyfill.js";
import { app } from "../app.js";
import { pool } from "../db/client.js";
import { env, isSafeTestDatabaseUrl } from "../config/env.js";
import { buildRolloutDecision, compareShadowObservations } from "../modules/ai/release/service.js";
import * as githubRepo from "../modules/github-kb/repository.js";
import { buildKbRollbackRunbook, previewKbPromotion } from "../modules/github-kb/release/service.js";
import { formatLocalDbBlockedMessage, probeLocalDbReadiness } from "./helpers/local-db-readiness.js";

const originalHybridRetrievalFlag = env.FEATURE_SUPPORT_AGENT_HYBRID_RETRIEVAL;
const originalRuntimeTighteningFlag = env.FEATURE_SUPPORT_AGENT_RUNTIME_TIGHTENING;

async function createRegistration() {
  const suffix = randomUUID().replace(/-/g, "").slice(0, 12);
  const repoOwner = `acme-release-${suffix}`;
  const repoName = `ticket-kb-${suffix}`;
  return githubRepo.upsertRepoRegistration({
    repoOwner,
    repoName,
    repoUrl: `mock://${repoOwner}/${repoName}`,
    defaultBranch: "main",
    includePaths: ["docs/*.md", "docs/**/*.md"],
    excludePaths: [],
    pollingIntervalSeconds: 60,
    createdBy: "test"
  });
}

async function createBuild(input: {
  repoId: string;
  knowledgeSpace: "support-prod" | "support-preview" | "support-local" | "support-shadow" | "support-eval";
  buildVersion: string;
  targetHead: string;
  status: "validated" | "published" | "superseded";
}) {
  const build = await githubRepo.ensureBuild({
    knowledgeSpace: input.knowledgeSpace,
    repoId: input.repoId,
    branch: "main",
    buildVersion: input.buildVersion,
    targetHead: input.targetHead,
    buildKind: "full",
    requestedBy: "test",
    requestedFromEnv: "local",
    sourceSnapshotTotal: 1
  });
  const updated = await githubRepo.updateBuildStatus({
    buildId: build.id,
    status: input.status,
    validationPassed: true,
    validationSummary: { checks: [] },
    finished: true
  });
  assert.ok(updated);
  return updated;
}

async function seedPublishedScope() {
  const registration = await createRegistration();
  const previousBuild = await createBuild({
    repoId: registration.id,
    knowledgeSpace: "support-local",
    buildVersion: "build-prev",
    targetHead: "sha-prev",
    status: "superseded"
  });
  const currentBuild = await createBuild({
    repoId: registration.id,
    knowledgeSpace: "support-local",
    buildVersion: "build-current",
    targetHead: "sha-current",
    status: "published"
  });
  await githubRepo.upsertPublication({
    knowledgeSpace: "support-local",
    repoId: registration.id,
    branch: "main",
    publishedBuildVersion: currentBuild.build_version,
    publishedHead: currentBuild.target_head,
    publishedBy: "test",
    publishedFromEnv: "local"
  });
  await githubRepo.upsertServingVersion({
    repoId: registration.id,
    branch: "main",
    activeBuildVersion: currentBuild.build_version,
    activeHead: currentBuild.target_head
  });
  return { registration, previousBuild, currentBuild };
}

async function requestJson(pathname: string, options: RequestInit = {}) {
  const response = await fetch(pathname, options);
  const json = (await response.json()) as Record<string, unknown>;
  return { status: response.status, json };
}

function resetReleaseFlags() {
  env.FEATURE_SUPPORT_AGENT_HYBRID_RETRIEVAL = originalHybridRetrievalFlag;
  env.FEATURE_SUPPORT_AGENT_RUNTIME_TIGHTENING = originalRuntimeTighteningFlag;
}

async function withAppHarness<T>(fn: (context: { baseUrl: string }) => Promise<T>): Promise<T> {
  resetReleaseFlags();
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const { port } = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    return await fn({ baseUrl });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    resetReleaseFlags();
  }
}

async function withDbHarness<T>(
  t: { skip: (reason?: string) => void },
  fn: (context: { baseUrl: string }) => Promise<T>
): Promise<T | undefined> {
  const readiness = await probeLocalDbReadiness({
    pool,
    databaseUrl: process.env.DATABASE_URL ?? env.DATABASE_URL,
    isSafeTestDatabaseUrl
  });
  if (readiness.kind === "blocked") {
    if (readiness.reason === "unsafe_database") {
      throw new Error(readiness.detail);
    }
    t.skip(formatLocalDbBlockedMessage("release.integration", readiness));
    return undefined;
  }

  return withAppHarness(fn);
}

after(async () => {
  resetReleaseFlags();
  await pool.end();
});

test("compareShadowObservations escalates immediate rollback when citations disappear and kb becomes unavailable", () => {
  const result = compareShadowObservations({
    baseline: [
      {
        requestId: "case-1",
        retrievalStatus: "grounded",
        route: "api_scope_auth",
        specialistFamily: "api",
        answerMode: "grounded",
        citationCount: 2,
        unsupportedClaimCount: 0,
        latencyMs: 150,
        stageTrace: [{ stage: "retrieval", status: "completed", durationMs: 60 }]
      }
    ],
    candidate: [
      {
        requestId: "case-1",
        retrievalStatus: "kb_unavailable",
        route: "api_scope_auth",
        specialistFamily: "api",
        answerMode: "handoff",
        citationCount: 0,
        unsupportedClaimCount: 2,
        latencyMs: 210,
        stageTrace: [{ stage: "retrieval", status: "fallback", durationMs: 95 }]
      }
    ]
  });

  assert.equal(result.rollbackRecommendation.class, "immediate");
  assert.equal(result.rollbackRecommendation.reasonCodes.includes("kb_unavailable_false_positive_spike"), true);
  assert.equal(result.rollbackRecommendation.reasonCodes.includes("citation_disappearance_spike"), true);
});

test("internal ai release decision endpoint reports db-backed verification blockers and current feature flags", async () => {
  await withAppHarness(async ({ baseUrl }) => {
    env.FEATURE_SUPPORT_AGENT_HYBRID_RETRIEVAL = true;
    env.FEATURE_SUPPORT_AGENT_RUNTIME_TIGHTENING = true;

    const response = await requestJson(`${baseUrl}/api/v1/internal/ai/release/decision`, {
      method: "POST",
      headers: {
        authorization: "Bearer ",
        "content-type": "application/json",
        "x-portal-surface": "internal"
      },
      body: JSON.stringify({
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
            retrieval_hit_at_1: 0.9,
            retrieval_hit_at_3: 0.9,
            retrieval_hit_at_5: 0.9,
            retrieval_hit_at_10: 0.9,
            family_hit_at_3: 0.9,
            exact_signal_capture_rate: 0.9,
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
        baseline: {
          retrievalSummary: {
            metrics: {
              retrieval_hit_at_1: 0.9,
              retrieval_hit_at_3: 0.9,
              retrieval_hit_at_5: 0.9,
              retrieval_hit_at_10: 0.9,
              family_hit_at_3: 0.9,
              exact_signal_capture_rate: 0.9,
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
          }
        },
        executionMode: "production",
        shadowValidationStable: true,
        rollbackReady: true,
        diagnosticsAvailable: true,
        verificationSuites: [
          {
            name: "release.integration",
            kind: "db_backed",
            requiredForRollout: true,
            status: "failed",
            reason: "assertion_failed"
          }
        ]
      })
    });

    assert.equal(response.status, 200);
    const result = response.json.result as {
      decision: {
        releaseDecision: string;
        gates: {
          productionEnablementGate: {
            passed: boolean;
            reasons: string[];
          };
        };
      };
      blockingReasons: string[];
      verificationEvidence: {
        dbBacked: {
          status: string;
          ready: boolean;
          suites: Array<{ name: string; status: string; reason: string | null }>;
        };
      };
      featureFlags: {
        FEATURE_SUPPORT_AGENT_HYBRID_RETRIEVAL: boolean;
        FEATURE_SUPPORT_AGENT_RUNTIME_TIGHTENING: boolean;
      };
      recommendation: string;
    };

    assert.equal(result.decision.releaseDecision, "blocked");
    assert.equal(result.decision.gates.productionEnablementGate.passed, false);
    assert.equal(result.blockingReasons.includes("db_backed_verification_failed"), true);
    assert.equal(result.verificationEvidence.dbBacked.status, "blocked");
    assert.equal(result.verificationEvidence.dbBacked.ready, false);
    assert.equal(result.verificationEvidence.dbBacked.suites[0]?.name, "release.integration");
    assert.equal(result.featureFlags.FEATURE_SUPPORT_AGENT_HYBRID_RETRIEVAL, true);
    assert.equal(result.featureFlags.FEATURE_SUPPORT_AGENT_RUNTIME_TIGHTENING, true);
    assert.equal(result.recommendation, "hold_rollout_and_fix_blockers");
  });
});

test("internal ai shadow compare endpoint reports immediate rollback recommendation for citation disappearance and kb unavailable spike", async () => {
  await withAppHarness(async ({ baseUrl }) => {
    const response = await requestJson(`${baseUrl}/api/v1/internal/ai/release/shadow-compare`, {
      method: "POST",
      headers: {
        authorization: "Bearer ",
        "content-type": "application/json",
        "x-portal-surface": "internal"
      },
      body: JSON.stringify({
        baseline: [
          {
            requestId: "case-1",
            retrievalStatus: "grounded",
            route: "api_scope_auth",
            specialistFamily: "api",
            answerMode: "grounded",
            citationCount: 2,
            unsupportedClaimCount: 0,
            latencyMs: 150,
            stageTrace: [{ stage: "retrieval", status: "completed", durationMs: 60 }]
          }
        ],
        candidate: [
          {
            requestId: "case-1",
            retrievalStatus: "kb_unavailable",
            route: "api_scope_auth",
            specialistFamily: "api",
            answerMode: "handoff",
            citationCount: 0,
            unsupportedClaimCount: 2,
            latencyMs: 210,
            stageTrace: [{ stage: "retrieval", status: "fallback", durationMs: 95 }]
          }
        ]
      })
    });

    assert.equal(response.status, 200);
    const result = response.json.result as {
      metrics: {
        kbUnavailableFalsePositiveRate: number;
        citationDisappearanceRate: number;
      };
      rollbackRecommendation: {
        class: string;
        reasonCodes: string[];
      };
    };

    assert.equal(result.metrics.kbUnavailableFalsePositiveRate, 1);
    assert.equal(result.metrics.citationDisappearanceRate, 1);
    assert.equal(result.rollbackRecommendation.class, "immediate");
    assert.equal(result.rollbackRecommendation.reasonCodes.includes("kb_unavailable_false_positive_spike"), true);
    assert.equal(result.rollbackRecommendation.reasonCodes.includes("citation_disappearance_spike"), true);
  });
});

test("previewKbPromotion blocks promotion when rollout evidence is missing even if build is validated", async (t) => {
  await withDbHarness(t, async () => {
    const registration = await createRegistration();
    const rollbackBuild = await createBuild({
      repoId: registration.id,
      knowledgeSpace: "support-local",
      buildVersion: "build-old",
      targetHead: "sha-old",
      status: "superseded"
    });
    const candidateBuild = await createBuild({
      repoId: registration.id,
      knowledgeSpace: "support-local",
      buildVersion: "build-new",
      targetHead: "sha-new",
      status: "validated"
    });

    await githubRepo.upsertPublication({
      knowledgeSpace: "support-local",
      repoId: registration.id,
      branch: "main",
      publishedBuildVersion: rollbackBuild.build_version,
      publishedHead: rollbackBuild.target_head,
      publishedBy: "test",
      publishedFromEnv: "local"
    });

    const result = await previewKbPromotion({
      buildId: candidateBuild.id,
      actor: "internal_operator",
      evaluationRecorded: false,
      shadowValidationStable: false,
      rollbackReviewed: false
    });

    assert.equal(result.eligible, false);
    assert.equal(result.checks.find((item) => item.code === "evaluation_report_recorded")?.passed, false);
    assert.equal(result.rollbackTarget?.buildVersion, "build-old");
  });
});

test("buildKbRollbackRunbook falls back to safe flag defaults when prior flag state is missing", async (t) => {
  await withDbHarness(t, async () => {
    env.FEATURE_SUPPORT_AGENT_HYBRID_RETRIEVAL = true;
    env.FEATURE_SUPPORT_AGENT_RUNTIME_TIGHTENING = true;
    const { registration, previousBuild } = await seedPublishedScope();

    const result = await buildKbRollbackRunbook({
      repoId: registration.id,
      branch: "main",
      knowledgeSpace: "support-local",
      actor: "internal_operator"
    });

    assert.equal(result.rollbackPublicationTarget?.buildVersion, previousBuild.build_version);
    assert.deepEqual(result.recommendedRollbackFlagState, {
      FEATURE_SUPPORT_AGENT_HYBRID_RETRIEVAL: false,
      FEATURE_SUPPORT_AGENT_RUNTIME_TIGHTENING: false
    });
    assert.equal(result.warnings.includes("prior_flag_state_not_recorded_using_safe_defaults"), true);
  });
});

test("internal release status endpoint reports current publication, rollback target, and feature flags", async (t) => {
  await withDbHarness(t, async ({ baseUrl }) => {
    env.FEATURE_SUPPORT_AGENT_HYBRID_RETRIEVAL = true;
    const { registration, previousBuild, currentBuild } = await seedPublishedScope();

    const response = await requestJson(
      `${baseUrl}/api/v1/internal/kb/release/status?repoId=${registration.id}&branch=main&knowledgeSpace=support-local`,
      {
        headers: {
          authorization: "Bearer ",
          "x-portal-surface": "internal"
        }
      }
    );

    assert.equal(response.status, 200);
    const result = response.json.result as {
      featureFlags: { FEATURE_SUPPORT_AGENT_HYBRID_RETRIEVAL: boolean };
      scopes: Array<{
        publication: { publishedBuildVersion: string };
        rollback: { publicationTarget: { buildVersion: string } };
      }>;
    };
    const scope = result.scopes[0];
    assert.equal(scope.publication.publishedBuildVersion, currentBuild.build_version);
    assert.equal(scope.rollback.publicationTarget.buildVersion, previousBuild.build_version);
    assert.equal(result.featureFlags.FEATURE_SUPPORT_AGENT_HYBRID_RETRIEVAL, true);
  });
});

test("internal release status returns requested scope diagnostics even when publication does not exist", async (t) => {
  await withDbHarness(t, async ({ baseUrl }) => {
    const registration = await createRegistration();

    const response = await requestJson(
      `${baseUrl}/api/v1/internal/kb/release/status?repoId=${registration.id}&branch=main&knowledgeSpace=support-shadow`,
      {
        headers: {
          authorization: "Bearer ",
          "x-portal-surface": "internal"
        }
      }
    );

    assert.equal(response.status, 200);
    const result = response.json.result as {
      scopes: Array<{
        knowledgeSpace: string;
        repoId: string;
        branch: string;
        publication: null;
        currentBuild: null;
        rollback: { publicationTarget: null; warnings: string[] };
      }>;
    };
    assert.equal(result.scopes.length, 1);
    assert.equal(result.scopes[0].knowledgeSpace, "support-shadow");
    assert.equal(result.scopes[0].repoId, registration.id);
    assert.equal(result.scopes[0].branch, "main");
    assert.equal(result.scopes[0].publication, null);
    assert.equal(result.scopes[0].currentBuild, null);
    assert.equal(result.scopes[0].rollback.publicationTarget, null);
    assert.equal(result.scopes[0].rollback.warnings.includes("no_publication_for_scope"), true);
  });
});

test("internal release status keeps publication truth scoped by knowledge space when legacy serving metadata is ambiguous", async (t) => {
  await withDbHarness(t, async ({ baseUrl }) => {
    const registration = await createRegistration();
    const localRollback = await createBuild({
      repoId: registration.id,
      knowledgeSpace: "support-local",
      buildVersion: "build-local-prev",
      targetHead: "sha-local-prev",
      status: "superseded"
    });
    const localCurrent = await createBuild({
      repoId: registration.id,
      knowledgeSpace: "support-local",
      buildVersion: "build-local-current",
      targetHead: "sha-local-current",
      status: "published"
    });
    const previewRollback = await createBuild({
      repoId: registration.id,
      knowledgeSpace: "support-preview",
      buildVersion: "build-preview-prev",
      targetHead: "sha-preview-prev",
      status: "superseded"
    });
    const previewCurrent = await createBuild({
      repoId: registration.id,
      knowledgeSpace: "support-preview",
      buildVersion: "build-preview-current",
      targetHead: "sha-preview-current",
      status: "published"
    });

    await githubRepo.upsertPublication({
      knowledgeSpace: "support-local",
      repoId: registration.id,
      branch: "main",
      publishedBuildVersion: localCurrent.build_version,
      publishedHead: localCurrent.target_head,
      publishedBy: "test",
      publishedFromEnv: "local"
    });
    await githubRepo.upsertPublication({
      knowledgeSpace: "support-preview",
      repoId: registration.id,
      branch: "main",
      publishedBuildVersion: previewCurrent.build_version,
      publishedHead: previewCurrent.target_head,
      publishedBy: "test",
      publishedFromEnv: "preview"
    });
    await githubRepo.upsertServingVersion({
      repoId: registration.id,
      branch: "main",
      activeBuildVersion: localCurrent.build_version,
      activeHead: localCurrent.target_head
    });

    const response = await requestJson(`${baseUrl}/api/v1/internal/kb/release/status?repoId=${registration.id}&branch=main`, {
      headers: {
        authorization: "Bearer ",
        "x-portal-surface": "internal"
      }
    });

    assert.equal(response.status, 200);
    const result = response.json.result as {
      scopes: Array<{
        knowledgeSpace: string;
        publication: { publishedBuildVersion: string } | null;
        serving: {
          source: string;
          comparisonToPublication: string;
          consistentWithPublication: boolean | null;
        } | null;
        rollback: { publicationTarget: { buildVersion: string } | null };
      }>;
    };
    const localScope = result.scopes.find((scope) => scope.knowledgeSpace === "support-local");
    const previewScope = result.scopes.find((scope) => scope.knowledgeSpace === "support-preview");

    assert.ok(localScope);
    assert.ok(previewScope);
    assert.equal(localScope?.publication?.publishedBuildVersion, localCurrent.build_version);
    assert.equal(localScope?.rollback.publicationTarget?.buildVersion, localRollback.build_version);
    assert.equal(localScope?.serving?.source, "compatibility_metadata");
    assert.equal(localScope?.serving?.comparisonToPublication, "ambiguous_across_knowledge_spaces");
    assert.equal(localScope?.serving?.consistentWithPublication, null);
    assert.equal(previewScope?.publication?.publishedBuildVersion, previewCurrent.build_version);
    assert.equal(previewScope?.rollback.publicationTarget?.buildVersion, previewRollback.build_version);
    assert.equal(previewScope?.serving?.source, "compatibility_metadata");
    assert.equal(previewScope?.serving?.comparisonToPublication, "ambiguous_across_knowledge_spaces");
    assert.equal(previewScope?.serving?.consistentWithPublication, null);
  });
});

test("operator rollout preflight drill keeps release status, promotion preview, rollback runbook, release decision, and shadow compare mutually consistent", async (t) => {
  await withDbHarness(t, async ({ baseUrl }) => {
    env.FEATURE_SUPPORT_AGENT_HYBRID_RETRIEVAL = true;
    env.FEATURE_SUPPORT_AGENT_RUNTIME_TIGHTENING = false;

    const registration = await createRegistration();
    const previousBuild = await createBuild({
      repoId: registration.id,
      knowledgeSpace: "support-local",
      buildVersion: "build-prev-drill",
      targetHead: "sha-prev-drill",
      status: "superseded"
    });
    const currentBuild = await createBuild({
      repoId: registration.id,
      knowledgeSpace: "support-local",
      buildVersion: "build-current-drill",
      targetHead: "sha-current-drill",
      status: "published"
    });
    const candidateBuild = await createBuild({
      repoId: registration.id,
      knowledgeSpace: "support-local",
      buildVersion: "build-candidate-drill",
      targetHead: "sha-candidate-drill",
      status: "validated"
    });

    await githubRepo.upsertPublication({
      knowledgeSpace: "support-local",
      repoId: registration.id,
      branch: "main",
      publishedBuildVersion: currentBuild.build_version,
      publishedHead: currentBuild.target_head,
      publishedBy: "test",
      publishedFromEnv: "local"
    });
    await githubRepo.upsertServingVersion({
      repoId: registration.id,
      branch: "main",
      activeBuildVersion: currentBuild.build_version,
      activeHead: currentBuild.target_head
    });

    const releaseStatusResponse = await requestJson(
      `${baseUrl}/api/v1/internal/kb/release/status?repoId=${registration.id}&branch=main&knowledgeSpace=support-local`,
      {
        headers: {
          authorization: "Bearer ",
          "x-portal-surface": "internal"
        }
      }
    );
    assert.equal(releaseStatusResponse.status, 200);
    const releaseStatus = releaseStatusResponse.json.result as {
      featureFlags: {
        FEATURE_SUPPORT_AGENT_HYBRID_RETRIEVAL: boolean;
        FEATURE_SUPPORT_AGENT_RUNTIME_TIGHTENING: boolean;
      };
      scopes: Array<{
        publication: { publishedBuildVersion: string } | null;
        rollback: { publicationTarget: { buildVersion: string } | null };
      }>;
    };
    assert.equal(releaseStatus.scopes[0]?.publication?.publishedBuildVersion, currentBuild.build_version);
    assert.equal(releaseStatus.scopes[0]?.rollback.publicationTarget?.buildVersion, previousBuild.build_version);

    const promotePreviewResponse = await requestJson(`${baseUrl}/api/v1/internal/kb/publications/promote/dry-run`, {
      method: "POST",
      headers: {
        authorization: "Bearer ",
        "content-type": "application/json",
        "x-portal-surface": "internal"
      },
      body: JSON.stringify({
        buildId: candidateBuild.id,
        actor: "internal_operator",
        evaluationRecorded: true,
        shadowValidationStable: true,
        rollbackReviewed: true
      })
    });
    assert.equal(promotePreviewResponse.status, 200);
    const promotePreview = promotePreviewResponse.json.result as {
      eligible: boolean;
      rollbackTarget: { buildVersion: string } | null;
      action: { endpoint: string; body: { buildId: string } };
    };
    assert.equal(promotePreview.eligible, true);
    assert.equal(promotePreview.rollbackTarget?.buildVersion, currentBuild.build_version);
    assert.equal(promotePreview.action.endpoint, "/api/v1/internal/kb/publications/promote");
    assert.equal(promotePreview.action.body.buildId, candidateBuild.id);

    const rollbackRunbookResponse = await requestJson(`${baseUrl}/api/v1/internal/kb/release/rollback-runbook`, {
      method: "POST",
      headers: {
        authorization: "Bearer ",
        "content-type": "application/json",
        "x-portal-surface": "internal"
      },
      body: JSON.stringify({
        repoId: registration.id,
        branch: "main",
        knowledgeSpace: "support-local",
        actor: "internal_operator",
        priorFlagState: {
          FEATURE_SUPPORT_AGENT_HYBRID_RETRIEVAL: false,
          FEATURE_SUPPORT_AGENT_RUNTIME_TIGHTENING: false
        }
      })
    });
    assert.equal(rollbackRunbookResponse.status, 200);
    const rollbackRunbook = rollbackRunbookResponse.json.result as {
      currentPublication: { publishedBuildVersion: string } | null;
      rollbackPublicationTarget: { buildVersion: string } | null;
      recommendedRollbackFlagState: {
        FEATURE_SUPPORT_AGENT_HYBRID_RETRIEVAL: boolean;
        FEATURE_SUPPORT_AGENT_RUNTIME_TIGHTENING: boolean;
      };
    };
    assert.equal(rollbackRunbook.currentPublication?.publishedBuildVersion, currentBuild.build_version);
    assert.equal(rollbackRunbook.rollbackPublicationTarget?.buildVersion, previousBuild.build_version);
    assert.deepEqual(rollbackRunbook.recommendedRollbackFlagState, {
      FEATURE_SUPPORT_AGENT_HYBRID_RETRIEVAL: false,
      FEATURE_SUPPORT_AGENT_RUNTIME_TIGHTENING: false
    });

    const releaseDecisionResponse = await requestJson(`${baseUrl}/api/v1/internal/ai/release/decision`, {
      method: "POST",
      headers: {
        authorization: "Bearer ",
        "content-type": "application/json",
        "x-portal-surface": "internal"
      },
      body: JSON.stringify({
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
            retrieval_hit_at_1: 0.9,
            retrieval_hit_at_3: 0.9,
            retrieval_hit_at_5: 0.9,
            retrieval_hit_at_10: 0.9,
            family_hit_at_3: 0.9,
            exact_signal_capture_rate: 0.9,
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
        baseline: {
          retrievalSummary: {
            metrics: {
              retrieval_hit_at_1: 0.9,
              retrieval_hit_at_3: 0.9,
              retrieval_hit_at_5: 0.9,
              retrieval_hit_at_10: 0.9,
              family_hit_at_3: 0.9,
              exact_signal_capture_rate: 0.9,
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
          }
        },
        executionMode: "production",
        shadowValidationStable: true,
        rollbackReady: true,
        diagnosticsAvailable: true,
        verificationSuites: [
          {
            name: "release.integration",
            kind: "db_backed",
            requiredForRollout: true,
            status: "passed"
          },
          {
            name: "github-kb-cleanup.dry-run.integration",
            kind: "db_backed",
            requiredForRollout: true,
            status: "passed"
          },
          {
            name: "github-kb.integration",
            kind: "db_backed",
            requiredForRollout: true,
            status: "passed"
          }
        ]
      })
    });
    assert.equal(releaseDecisionResponse.status, 200);
    const releaseDecision = releaseDecisionResponse.json.result as {
      decision: { releaseDecision: string };
      featureFlags: {
        FEATURE_SUPPORT_AGENT_HYBRID_RETRIEVAL: boolean;
        FEATURE_SUPPORT_AGENT_RUNTIME_TIGHTENING: boolean;
      };
      recommendation: string;
      verificationEvidence: {
        dbBacked: { status: string; ready: boolean };
      };
    };
    assert.equal(releaseDecision.decision.releaseDecision, "ready");
    assert.equal(releaseDecision.verificationEvidence.dbBacked.status, "ready");
    assert.equal(releaseDecision.verificationEvidence.dbBacked.ready, true);
    assert.equal(releaseDecision.recommendation, "production_rollout_can_proceed");

    const shadowCompareResponse = await requestJson(`${baseUrl}/api/v1/internal/ai/release/shadow-compare`, {
      method: "POST",
      headers: {
        authorization: "Bearer ",
        "content-type": "application/json",
        "x-portal-surface": "internal"
      },
      body: JSON.stringify({
        baseline: [
          {
            requestId: "drill-1",
            retrievalStatus: "grounded",
            route: "troubleshooting",
            specialistFamily: "troubleshooting",
            answerMode: "grounded",
            citationCount: 2,
            unsupportedClaimCount: 0,
            latencyMs: 120,
            stageTrace: [{ stage: "retrieval", status: "completed", durationMs: 50 }]
          }
        ],
        candidate: [
          {
            requestId: "drill-1",
            retrievalStatus: "grounded",
            route: "troubleshooting",
            specialistFamily: "troubleshooting",
            answerMode: "grounded",
            citationCount: 2,
            unsupportedClaimCount: 0,
            latencyMs: 118,
            stageTrace: [{ stage: "retrieval", status: "completed", durationMs: 48 }]
          }
        ]
      })
    });
    assert.equal(shadowCompareResponse.status, 200);
    const shadowCompare = shadowCompareResponse.json.result as {
      rollbackRecommendation: { class: string; reasonCodes: string[] };
    };
    assert.equal(shadowCompare.rollbackRecommendation.class, "none");
    assert.deepEqual(shadowCompare.rollbackRecommendation.reasonCodes, []);

    assert.deepEqual(releaseStatus.featureFlags, releaseDecision.featureFlags);
  });
});

test("previewKbPromotion allows first non-production bootstrap without rollback target", async (t) => {
  await withDbHarness(t, async () => {
    const registration = await createRegistration();
    const candidateBuild = await createBuild({
      repoId: registration.id,
      knowledgeSpace: "support-local",
      buildVersion: "build-local-bootstrap",
      targetHead: "sha-local-bootstrap",
      status: "validated"
    });

    const result = await previewKbPromotion({
      buildId: candidateBuild.id,
      actor: "internal_operator",
      evaluationRecorded: true,
      shadowValidationStable: true,
      rollbackReviewed: true
    });

    assert.equal(result.eligible, true);
    const rollbackCheck = result.checks.find((item) => item.code === "rollback_target_known");
    assert.ok(rollbackCheck);
    assert.equal(rollbackCheck.passed, false);
    assert.notEqual(rollbackCheck.severity, "error");
  });
});

test("previewKbPromotion still requires rollback target for production scope", async (t) => {
  await withDbHarness(t, async () => {
    const registration = await createRegistration();
    const candidateBuild = await createBuild({
      repoId: registration.id,
      knowledgeSpace: "support-prod",
      buildVersion: "build-prod-bootstrap",
      targetHead: "sha-prod-bootstrap",
      status: "validated"
    });

    const result = await previewKbPromotion({
      buildId: candidateBuild.id,
      actor: "internal_operator",
      evaluationRecorded: true,
      shadowValidationStable: true,
      rollbackReviewed: true
    });

    assert.equal(result.eligible, false);
    const rollbackCheck = result.checks.find((item) => item.code === "rollback_target_known");
    assert.ok(rollbackCheck);
    assert.equal(rollbackCheck.passed, false);
    assert.equal(rollbackCheck.severity, "error");
  });
});

test("buildRolloutDecision exposes blocking reasons and rollout recommendation", () => {
  const result = buildRolloutDecision({
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
        retrieval_hit_at_1: 0.5,
        retrieval_hit_at_3: 0.5,
        retrieval_hit_at_5: 0.5,
        retrieval_hit_at_10: 0.5,
        family_hit_at_3: 0.5,
        exact_signal_capture_rate: 0.5,
        wrong_family_top_3_rate: 0,
        groundable_candidate_rate: 0.8,
        kb_unavailable_false_positive_rate: 0,
        publication_scoped_read_rate: 1
      },
      scoreCounts: {
        exact_top_3: 0,
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
    executionMode: "production",
    shadowValidationStable: false,
    rollbackReady: false,
    diagnosticsAvailable: false
  });

  assert.equal(result.decision.releaseDecision, "blocked");
  assert.equal(result.blockingReasons.includes("shadow_validation_not_stable"), true);
  assert.equal(result.blockingReasons.includes("rollback_not_ready"), true);
  assert.equal(result.recommendation, "hold_rollout_and_fix_blockers");
});

test("buildRolloutDecision marks rollout evidence as blocked when required DB-backed suites did not execute successfully", () => {
  const result = buildRolloutDecision({
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
        retrieval_hit_at_1: 0.9,
        retrieval_hit_at_3: 0.9,
        retrieval_hit_at_5: 0.9,
        retrieval_hit_at_10: 0.9,
        family_hit_at_3: 0.9,
        exact_signal_capture_rate: 0.9,
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
    executionMode: "production",
    shadowValidationStable: true,
    rollbackReady: true,
    diagnosticsAvailable: true,
    verificationSuites: [
      {
        name: "release.integration",
        kind: "db_backed",
        requiredForRollout: true,
        status: "blocked",
        reason: "db_unavailable"
      },
      {
        name: "github-kb.integration",
        kind: "db_backed",
        requiredForRollout: true,
        status: "skipped",
        reason: "db_unavailable"
      }
    ]
  });

  assert.equal(result.decision.releaseDecision, "blocked");
  assert.equal(result.blockingReasons.includes("db_backed_verification_blocked"), true);
  assert.equal(result.blockingReasons.includes("db_backed_verification_skipped"), true);
  assert.equal(result.verificationEvidence?.dbBacked.status, "blocked");
  assert.equal(result.verificationEvidence?.dbBacked.ready, false);
});

test("probeLocalDbReadiness reports schema_unavailable when the local database is reachable but required tables are missing", async () => {
  let queryCount = 0;
  const poolStub = {
    async query() {
      queryCount += 1;
      if (queryCount === 1) {
        return { rows: [] };
      }
      return {
        rows: [{ table_name: "kb_repo_registrations" }]
      };
    }
  } as unknown as Pick<typeof pool, "query">;
  const readiness = await probeLocalDbReadiness({
    pool: poolStub,
    databaseUrl: "postgresql://postgres:postgres@localhost:5432/nexusflow",
    isSafeTestDatabaseUrl,
    requiredTables: ["kb_repo_registrations", "kb_builds"]
  });

  assert.deepEqual(readiness, {
    kind: "blocked",
    reason: "schema_unavailable",
    detail: "missing tables: kb_builds"
  });
});
