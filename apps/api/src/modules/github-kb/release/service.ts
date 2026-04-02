import { getAiTopology } from "../../ai/agent-router.js";
import { getSupportReleaseFlagSnapshot, type SupportReleaseFlagSnapshot } from "../../ai/release/service.js";
import * as repo from "../repository.js";
import { canPublishToKnowledgeSpace, resolveRequestedFromEnv, resolveRuntimeKnowledgeSpace } from "../runtime-space.js";
import type { KbBuild, KbKnowledgeSpace, KbPublication, KbServingVersion } from "../types.js";

type RollbackFlagState = SupportReleaseFlagSnapshot;

export function summarizeServingCompatibilityMetadata(input: {
  publication: KbPublication | null;
  serving: KbServingVersion | null;
  publicationScopeCount: number;
}) {
  if (!input.serving) return null;

  let comparisonToPublication: "consistent_with_publication" | "mismatch_with_publication" | "ambiguous_across_knowledge_spaces" | "no_publication_for_scope";
  let consistentWithPublication: boolean | null = null;

  if (input.publicationScopeCount > 1) {
    comparisonToPublication = "ambiguous_across_knowledge_spaces";
  } else if (!input.publication) {
    comparisonToPublication = "no_publication_for_scope";
  } else {
    consistentWithPublication = input.serving.active_build_version === input.publication.published_build_version;
    comparisonToPublication = consistentWithPublication ? "consistent_with_publication" : "mismatch_with_publication";
  }

  return {
    source: "compatibility_metadata" as const,
    scope: "repo_branch" as const,
    activeBuildVersion: input.serving.active_build_version,
    activeHead: input.serving.active_head,
    activatedAt: input.serving.activated_at,
    comparisonToPublication,
    consistentWithPublication
  };
}

function buildStatusRank(status: KbBuild["status"]): number {
  switch (status) {
    case "published":
      return 0;
    case "superseded":
      return 1;
    case "validated":
      return 2;
    case "built":
      return 3;
    default:
      return 9;
  }
}

function pickRollbackCandidate(builds: KbBuild[]): KbBuild | null {
  const eligible = builds
    .filter((build) => build.validation_passed && ["published", "superseded", "validated", "built"].includes(build.status))
    .sort((left, right) => {
      const rankDelta = buildStatusRank(left.status) - buildStatusRank(right.status);
      if (rankDelta !== 0) return rankDelta;
      return new Date(right.updated_at).getTime() - new Date(left.updated_at).getTime();
    });
  return eligible[0] ?? null;
}

async function resolveRollbackCandidate(input: {
  knowledgeSpace: KbKnowledgeSpace;
  repoId: string;
  branch: string;
  excludeBuildVersion?: string;
}): Promise<KbBuild | null> {
  const builds = await repo.listRecentBuildsForScope({
    knowledgeSpace: input.knowledgeSpace,
    repoId: input.repoId,
    branch: input.branch,
    excludeBuildVersion: input.excludeBuildVersion,
    limit: 12
  });
  return pickRollbackCandidate(builds);
}

function defaultRollbackFlagState(): RollbackFlagState {
  return {
    FEATURE_SUPPORT_AGENT_HYBRID_RETRIEVAL: false,
    FEATURE_SUPPORT_AGENT_RUNTIME_TIGHTENING: false
  };
}

async function buildScopeReleaseStatus(input: {
  knowledgeSpace: KbKnowledgeSpace;
  repoId: string;
  branch: string;
  includeBuildDetails: boolean;
}) {
  const [publication, publicationScopeCount, serving] = await Promise.all([
    repo.getPublication({
      knowledgeSpace: input.knowledgeSpace,
      repoId: input.repoId,
      branch: input.branch
    }),
    repo.countPublications({
      repoId: input.repoId,
      branch: input.branch
    }),
    repo.getServingVersion(input.repoId, input.branch)
  ]);
  const currentBuild =
    publication &&
    (await repo.getBuildByVersion({
      knowledgeSpace: input.knowledgeSpace,
      repoId: input.repoId,
      branch: input.branch,
      buildVersion: publication.published_build_version
    }));
  const rollbackCandidate = publication
    ? await resolveRollbackCandidate({
        knowledgeSpace: input.knowledgeSpace,
        repoId: input.repoId,
        branch: input.branch,
        excludeBuildVersion: publication.published_build_version
      })
    : null;

  const validationSnapshot =
    input.includeBuildDetails && currentBuild
      ? await repo.getBuildValidationSnapshot({
          knowledgeSpace: input.knowledgeSpace,
          repoId: input.repoId,
          branch: input.branch,
          buildVersion: currentBuild.build_version
        })
      : null;
  const artifactSummary =
    input.includeBuildDetails && currentBuild
      ? await repo.getBuildArtifactSummary({
          knowledgeSpace: input.knowledgeSpace,
          repoId: input.repoId,
          branch: input.branch,
          buildVersion: currentBuild.build_version
        })
      : null;

  return {
    knowledgeSpace: input.knowledgeSpace,
    repoId: input.repoId,
    branch: input.branch,
    publication: publication
      ? {
          publishedBuildVersion: publication.published_build_version,
          publishedHead: publication.published_head,
          publishedBy: publication.published_by,
          publishedFromEnv: publication.published_from_env,
          publishedAt: publication.published_at
        }
      : null,
    currentBuild: currentBuild
      ? {
          id: currentBuild.id,
          buildVersion: currentBuild.build_version,
          targetHead: currentBuild.target_head,
          status: currentBuild.status,
          validationPassed: currentBuild.validation_passed,
          requestedFromEnv: currentBuild.requested_from_env,
          updatedAt: currentBuild.updated_at
        }
      : null,
    serving: summarizeServingCompatibilityMetadata({
      publication,
      serving,
      publicationScopeCount
    }),
    rollback: {
      publicationTarget: rollbackCandidate
        ? {
            buildId: rollbackCandidate.id,
            buildVersion: rollbackCandidate.build_version,
            targetHead: rollbackCandidate.target_head,
            status: rollbackCandidate.status,
            validationPassed: rollbackCandidate.validation_passed
          }
        : null,
      kbRollbackReady: Boolean(publication && rollbackCandidate),
      retrievalRollbackReady: true,
      runtimeRollbackReady: true,
      warnings: [
        ...(publication ? [] : ["no_publication_for_scope"]),
        ...(rollbackCandidate ? [] : ["no_prior_validated_publication_candidate"])
      ]
    },
    diagnostics:
      input.includeBuildDetails && currentBuild && validationSnapshot && artifactSummary
        ? {
            validationSnapshot,
            artifactSummary
          }
        : null
  };
}

function hasExactPublicationScope(
  publications: Array<{ knowledge_space: KbKnowledgeSpace; repo_id: string; branch: string }>,
  requestedScope: { knowledgeSpace: KbKnowledgeSpace; repoId: string; branch: string }
): boolean {
  return publications.some(
    (publication) =>
      publication.knowledge_space === requestedScope.knowledgeSpace &&
      publication.repo_id === requestedScope.repoId &&
      publication.branch === requestedScope.branch
  );
}

export async function getKbReleaseStatus(input?: {
  repoId?: string;
  branch?: string;
  knowledgeSpace?: KbKnowledgeSpace;
  includeBuildDetails?: boolean;
}) {
  const requestedFromEnv = resolveRequestedFromEnv();
  const topology = getAiTopology();
  const featureFlags = getSupportReleaseFlagSnapshot();
  const publications = await repo.listPublications({
    repoId: input?.repoId,
    branch: input?.branch,
    knowledgeSpace: input?.knowledgeSpace
  });
  const requestedScope =
    input?.repoId && input?.branch && input?.knowledgeSpace
      ? {
          knowledgeSpace: input.knowledgeSpace,
          repoId: input.repoId,
          branch: input.branch
        }
      : null;
  const scopeRequests = publications.map((publication) => ({
    knowledgeSpace: publication.knowledge_space,
    repoId: publication.repo_id,
    branch: publication.branch
  }));
  if (requestedScope && !hasExactPublicationScope(publications, requestedScope)) {
    scopeRequests.push(requestedScope);
  }

  const scopes = await Promise.all(
    scopeRequests.map((scope) =>
      buildScopeReleaseStatus({
        knowledgeSpace: scope.knowledgeSpace,
        repoId: scope.repoId,
        branch: scope.branch,
        includeBuildDetails: Boolean(input?.includeBuildDetails)
      })
    )
  );

  return {
    environment: {
      requestedFromEnv,
      runtimeKnowledgeSpace: resolveRuntimeKnowledgeSpace()
    },
    featureFlags,
    supportRuntime: {
      topologyHash: topology.topologyHash,
      multiAgentReady: topology.multiAgentReady,
      configuredAgents: topology.configuredAgents
    },
    requestedScope: input
      ? {
          repoId: input.repoId ?? null,
          branch: input.branch ?? null,
          knowledgeSpace: input.knowledgeSpace ?? null
        }
      : null,
    scopes
  };
}

export async function previewKbPromotion(input: {
  buildId: string;
  actor: string;
  evaluationRecorded: boolean;
  shadowValidationStable: boolean;
  rollbackReviewed: boolean;
}) {
  const build = await repo.getBuildById(input.buildId);
  if (!build) {
    throw new Error(`Build not found: ${input.buildId}`);
  }

  const requestedFromEnv = resolveRequestedFromEnv();
  const currentPublication = await repo.getPublication({
    knowledgeSpace: build.knowledge_space,
    repoId: build.repo_id,
    branch: build.branch
  });
  const rollbackCandidate = await resolveRollbackCandidate({
    knowledgeSpace: build.knowledge_space,
    repoId: build.repo_id,
    branch: build.branch,
    excludeBuildVersion: build.build_version
  });
  const rollbackTargetSeverity = build.knowledge_space === "support-prod" ? ("error" as const) : ("warn" as const);
  const checks = [
    {
      code: "build_validation_passed",
      passed: build.validation_passed,
      severity: "error" as const,
      message: build.validation_passed ? "build has already passed validation" : "build has not passed validation"
    },
    {
      code: "build_status_ready",
      passed: build.status === "validated" || build.status === "published",
      severity: "error" as const,
      message:
        build.status === "validated" || build.status === "published"
          ? `build status ${build.status} is promotion-ready`
          : `build status ${build.status} is not promotion-ready`
    },
    {
      code: "publication_authority_matches_space",
      passed: canPublishToKnowledgeSpace(requestedFromEnv, build.knowledge_space),
      severity: "error" as const,
      message: canPublishToKnowledgeSpace(requestedFromEnv, build.knowledge_space)
        ? `environment ${requestedFromEnv} may publish to ${build.knowledge_space}`
        : `environment ${requestedFromEnv} may not publish to ${build.knowledge_space}`
    },
    {
      code: "rollback_target_known",
      passed: Boolean(rollbackCandidate),
      severity: rollbackTargetSeverity,
      message: rollbackCandidate ? "rollback target is known" : "rollback target is unknown"
    },
    {
      code: "evaluation_report_recorded",
      passed: input.evaluationRecorded,
      severity: "error" as const,
      message: input.evaluationRecorded ? "evaluation evidence was confirmed" : "evaluation evidence was not confirmed"
    },
    {
      code: "shadow_validation_stable",
      passed: build.knowledge_space === "support-prod" ? input.shadowValidationStable : true,
      severity: build.knowledge_space === "support-prod" ? ("error" as const) : ("info" as const),
      message:
        build.knowledge_space === "support-prod"
          ? input.shadowValidationStable
            ? "shadow validation was confirmed stable"
            : "shadow validation was not confirmed stable for production rollout"
          : "shadow validation is not required for non-production promotion"
    },
    {
      code: "rollback_reviewed",
      passed: input.rollbackReviewed,
      severity: build.knowledge_space === "support-prod" ? ("error" as const) : ("warn" as const),
      message: input.rollbackReviewed ? "rollback procedure was reviewed" : "rollback procedure was not reviewed"
    },
    {
      code: "build_not_already_current",
      passed: currentPublication?.published_build_version !== build.build_version,
      severity: "warn" as const,
      message:
        currentPublication?.published_build_version === build.build_version
          ? "target build is already the active publication"
          : "target build differs from the active publication"
    }
  ];

  const eligible = checks.every((check) => check.passed || check.severity !== "error");
  return {
    eligible,
    requestedFromEnv,
    build: {
      id: build.id,
      knowledgeSpace: build.knowledge_space,
      repoId: build.repo_id,
      branch: build.branch,
      buildVersion: build.build_version,
      status: build.status,
      validationPassed: build.validation_passed
    },
    currentPublication: currentPublication
      ? {
          publishedBuildVersion: currentPublication.published_build_version,
          publishedAt: currentPublication.published_at,
          publishedFromEnv: currentPublication.published_from_env
        }
      : null,
    rollbackTarget: rollbackCandidate
      ? {
          buildId: rollbackCandidate.id,
          buildVersion: rollbackCandidate.build_version,
          targetHead: rollbackCandidate.target_head,
          status: rollbackCandidate.status
        }
      : null,
    checks,
    action: {
      method: "POST",
      endpoint: "/api/v1/internal/kb/publications/promote",
      body: {
        buildId: build.id,
        actor: input.actor
      }
    }
  };
}

export async function buildKbRollbackRunbook(input: {
  repoId: string;
  branch: string;
  knowledgeSpace: KbKnowledgeSpace;
  actor: string;
  priorFlagState?: RollbackFlagState;
}) {
  const currentPublication = await repo.getPublication({
    knowledgeSpace: input.knowledgeSpace,
    repoId: input.repoId,
    branch: input.branch
  });
  const currentFlags = getSupportReleaseFlagSnapshot();
  const targetFlags = input.priorFlagState ?? defaultRollbackFlagState();
  const rollbackCandidate = await resolveRollbackCandidate({
    knowledgeSpace: input.knowledgeSpace,
    repoId: input.repoId,
    branch: input.branch,
    excludeBuildVersion: currentPublication?.published_build_version
  });

  return {
    scope: {
      knowledgeSpace: input.knowledgeSpace,
      repoId: input.repoId,
      branch: input.branch
    },
    currentPublication: currentPublication
      ? {
          publishedBuildVersion: currentPublication.published_build_version,
          publishedHead: currentPublication.published_head,
          publishedAt: currentPublication.published_at
        }
      : null,
    rollbackPublicationTarget: rollbackCandidate
      ? {
          buildId: rollbackCandidate.id,
          buildVersion: rollbackCandidate.build_version,
          targetHead: rollbackCandidate.target_head,
          status: rollbackCandidate.status
        }
      : null,
    currentFlagState: currentFlags,
    priorFlagState: input.priorFlagState ?? null,
    recommendedRollbackFlagState: targetFlags,
    warnings: [
      ...(currentPublication ? [] : ["no_current_publication"]),
      ...(rollbackCandidate ? [] : ["no_prior_publication_candidate"]),
      ...(input.priorFlagState ? [] : ["prior_flag_state_not_recorded_using_safe_defaults"])
    ],
    actions: [
      {
        kind: "feature_flags",
        channel: "deployment_env",
        targetState: targetFlags,
        notes: "Apply these flag values through the deployment configuration channel before or alongside publication rollback."
      },
      ...(rollbackCandidate
        ? [
            {
              kind: "publication_repoint" as const,
              method: "POST",
              endpoint: "/api/v1/internal/kb/publications/promote",
              body: {
                buildId: rollbackCandidate.id,
                actor: input.actor
              }
            }
          ]
        : [])
    ],
    expectedHealthSignals: [
      rollbackCandidate ? `active publication returns build ${rollbackCandidate.build_version}` : "publication remains unchanged until a valid rollback target is chosen",
      `feature flags match ${JSON.stringify(targetFlags)}`,
      "release status endpoint reports a coherent published snapshot for the target scope",
      "shadow comparison no longer shows citation disappearance or kb_unavailable spikes"
    ]
  };
}
