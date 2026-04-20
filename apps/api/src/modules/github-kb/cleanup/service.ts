import type { KbBuild, KbKnowledgeSpace, KbPublication, KbServingVersion } from "../types.js";
import * as repo from "../repository.js";
import { summarizeServingCompatibilityMetadata } from "../release/service.js";
import {
  aggregateCleanupAssessments,
  classifyCleanupBuild,
  resolveProtectedBuilds,
  type CleanupBuildAssessment,
  type CleanupCandidateReason,
  type CleanupProtectedReason
} from "./classifier.js";
import * as cleanupRepo from "./repository.js";

const DEFAULT_STALE_AGE_HOURS = 72;

type ScopeKey = `${KbKnowledgeSpace}::${string}::${string}`;

interface CleanupScopeState {
  key: ScopeKey;
  knowledgeSpace: KbKnowledgeSpace;
  repoId: string;
  branch: string;
  publication: KbPublication | null;
  serving: KbServingVersion | null;
  publicationScopeCount: number;
  rollbackBuild: KbBuild | null;
  latestValidatedUnderReview: KbBuild | null;
  builds: Array<
    CleanupBuildAssessment & {
      artifactSummary: Awaited<ReturnType<typeof repo.getBuildArtifactSummary>>;
      validationSnapshot: Awaited<ReturnType<typeof repo.getBuildValidationSnapshot>>;
      existingCleanupHints: string[];
      publicationStatus: "published" | "not_currently_published" | "not_published";
    }
  >;
}

function scopeKey(knowledgeSpace: KbKnowledgeSpace, repoId: string, branch: string): ScopeKey {
  return `${knowledgeSpace}::${repoId}::${branch}`;
}

function buildDescriptor(build: KbBuild) {
  return {
    buildId: build.id,
    buildVersion: build.build_version,
    knowledgeSpace: build.knowledge_space,
    repoId: build.repo_id,
    branch: build.branch,
    status: build.status,
    validationPassed: build.validation_passed,
    updatedAt: build.updated_at
  };
}

function mapReasons<T extends CleanupCandidateReason | CleanupProtectedReason>(
  builds: Array<CleanupScopeState["builds"][number]>,
  selectReasons: (build: CleanupScopeState["builds"][number]) => T[]
) {
  const grouped: Partial<Record<T, Array<ReturnType<typeof buildDescriptor>>>> = {};
  for (const build of builds) {
    for (const reason of selectReasons(build)) {
      grouped[reason] = [...(grouped[reason] ?? []), buildDescriptor(build.build)];
    }
  }
  return grouped;
}

function buildExistingCleanupHints(input: {
  build: KbBuild;
  publication: KbPublication | null;
  validationSnapshot: Awaited<ReturnType<typeof repo.getBuildValidationSnapshot>>;
  artifactSummary: Awaited<ReturnType<typeof repo.getBuildArtifactSummary>>;
}): string[] {
  const hints: string[] = [];
  if (!input.publication && (input.build.status === "failed" || input.build.status === "abandoned")) {
    hints.push("terminal_build_without_publication");
  }
  if (input.publication && input.publication.published_build_version !== input.build.build_version) {
    hints.push("superseded_by_newer_publication");
  }
  if (input.validationSnapshot.duplicatePaths > 0) {
    hints.push("duplicate_path_anomaly_present");
  }
  if (input.validationSnapshot.crossBuildMemorySources > 0 || input.validationSnapshot.missingChunkDocuments > 0) {
    hints.push("cross_build_or_orphan_linkage_present");
  }
  if (input.build.status === "abandoned" && input.artifactSummary.embeddingSummary.chunkEmbeddings.ready > 0) {
    hints.push("stale_chunk_embeddings_for_abandoned_build");
  }
  return hints;
}

function sortBuilds(builds: KbBuild[]): KbBuild[] {
  return [...builds].sort((left, right) => {
    const timeDelta = new Date(right.updated_at).getTime() - new Date(left.updated_at).getTime();
    if (timeDelta !== 0) return timeDelta;
    return new Date(right.created_at).getTime() - new Date(left.created_at).getTime();
  });
}

function resolvePublicationStatus(
  publication: KbPublication | null,
  buildVersion: string
): "published" | "not_currently_published" | "not_published" {
  if (!publication) return "not_published";
  return publication.published_build_version === buildVersion ? "published" : "not_currently_published";
}

async function buildScopeState(input: {
  knowledgeSpace: KbKnowledgeSpace;
  repoId: string;
  branch: string;
  publication: KbPublication | null;
  publicationScopeCount: number;
  builds: KbBuild[];
  staleAgeHours: number;
  nowIso: string;
}): Promise<CleanupScopeState> {
  const serving = await repo.getServingVersion(input.repoId, input.branch);
  const protectedBuilds = resolveProtectedBuilds({
    builds: input.builds,
    currentPublishedBuildVersion: input.publication?.published_build_version ?? null
  });

  const rollbackBuild =
    protectedBuilds.rollbackRetainedBuildVersion == null
      ? null
      : input.builds.find((build) => build.build_version === protectedBuilds.rollbackRetainedBuildVersion) ?? null;
  const latestValidatedUnderReview =
    protectedBuilds.latestValidatedUnderReviewBuildVersion == null
      ? null
      : input.builds.find((build) => build.build_version === protectedBuilds.latestValidatedUnderReviewBuildVersion) ?? null;

  const builds = await Promise.all(
    sortBuilds(input.builds).map(async (build) => {
      const [tableCounts, legacyDuplicateCounts, orphanedChildCounts, artifactSummary, validationSnapshot] = await Promise.all([
        cleanupRepo.getBuildScopedTableCounts({
          knowledgeSpace: build.knowledge_space,
          repoId: build.repo_id,
          branch: build.branch,
          buildVersion: build.build_version
        }),
        cleanupRepo.getBuildLegacyDuplicateCounts({
          knowledgeSpace: build.knowledge_space,
          repoId: build.repo_id,
          branch: build.branch,
          buildVersion: build.build_version
        }),
        cleanupRepo.getBuildOrphanedChildCounts({
          knowledgeSpace: build.knowledge_space,
          repoId: build.repo_id,
          branch: build.branch,
          buildVersion: build.build_version
        }),
        repo.getBuildArtifactSummary({
          knowledgeSpace: build.knowledge_space,
          repoId: build.repo_id,
          branch: build.branch,
          buildVersion: build.build_version
        }),
        repo.getBuildValidationSnapshot({
          knowledgeSpace: build.knowledge_space,
          repoId: build.repo_id,
          branch: build.branch,
          buildVersion: build.build_version
        })
      ]);

      const assessment = classifyCleanupBuild({
        build,
        protectedBuilds,
        currentPublishedBuildVersion: input.publication?.published_build_version ?? null,
        tableCounts,
        legacyDuplicateCounts,
        orphanedChildCounts,
        staleAgeHours: input.staleAgeHours,
        nowIso: input.nowIso
      });

      return {
        ...assessment,
        artifactSummary,
        validationSnapshot,
        existingCleanupHints: buildExistingCleanupHints({
          build,
          publication: input.publication,
          validationSnapshot,
          artifactSummary
        }),
        publicationStatus: resolvePublicationStatus(input.publication, build.build_version)
      };
    })
  );

  return {
    key: scopeKey(input.knowledgeSpace, input.repoId, input.branch),
    knowledgeSpace: input.knowledgeSpace,
    repoId: input.repoId,
    branch: input.branch,
    publication: input.publication,
    serving,
    publicationScopeCount: input.publicationScopeCount,
    rollbackBuild,
    latestValidatedUnderReview,
    builds
  };
}

export async function getKnowledgeBaseCleanupDryRunReport(input?: {
  repoId?: string;
  branch?: string;
  knowledgeSpace?: KbKnowledgeSpace;
  staleAgeHours?: number;
}) {
  const staleAgeHours = Math.max(1, input?.staleAgeHours ?? DEFAULT_STALE_AGE_HOURS);
  const nowIso = new Date().toISOString();
  const [builds, publications] = await Promise.all([
    cleanupRepo.listBuilds({
      repoId: input?.repoId,
      branch: input?.branch,
      knowledgeSpace: input?.knowledgeSpace
    }),
    repo.listPublications({
      repoId: input?.repoId,
      branch: input?.branch,
      knowledgeSpace: input?.knowledgeSpace
    })
  ]);

  const publicationByScope = new Map<ScopeKey, KbPublication>();
  for (const publication of publications) {
    publicationByScope.set(scopeKey(publication.knowledge_space, publication.repo_id, publication.branch), publication);
  }

  const groupedBuilds = new Map<ScopeKey, KbBuild[]>();
  for (const build of builds) {
    const key = scopeKey(build.knowledge_space, build.repo_id, build.branch);
    groupedBuilds.set(key, [...(groupedBuilds.get(key) ?? []), build]);
  }

  if (input?.repoId && input?.branch && input?.knowledgeSpace) {
    const requestedKey = scopeKey(input.knowledgeSpace, input.repoId, input.branch);
    if (!groupedBuilds.has(requestedKey)) groupedBuilds.set(requestedKey, []);
  }

  const scopes = await Promise.all(
    [...groupedBuilds.entries()].map(async ([key, scopeBuilds]) => {
      const [knowledgeSpace, repoId, branch] = key.split("::") as [KbKnowledgeSpace, string, string];
      const publicationScopeCount = await repo.countPublications({ repoId, branch });
      return buildScopeState({
        knowledgeSpace,
        repoId,
        branch,
        publication: publicationByScope.get(key) ?? null,
        publicationScopeCount,
        builds: scopeBuilds,
        staleAgeHours,
        nowIso
      });
    })
  );

  const allAssessments = scopes.flatMap((scope) => scope.builds);
  const aggregate = aggregateCleanupAssessments(allAssessments);
  const protectedBuilds = scopes.flatMap((scope) =>
    scope.builds
      .filter((build) => build.disposition === "protected")
      .map((build) => ({
        ...buildDescriptor(build.build),
        reasons: build.protectedReasons
      }))
  );

  const warnings: string[] = [];
  const blockers: string[] = [];
  for (const scope of scopes) {
    if (!scope.publication) {
      warnings.push(`no publication for ${scope.knowledgeSpace}/${scope.repoId}/${scope.branch}`);
    }
    if (scope.publication && !scope.builds.some((build) => build.build.build_version === scope.publication?.published_build_version)) {
      blockers.push(`published build row missing for ${scope.knowledgeSpace}/${scope.repoId}/${scope.branch}`);
    }
  }
  if (scopes.length === 0) {
    warnings.push("no builds found for the requested cleanup scope");
  }

  return {
    generatedAt: nowIso,
    mode: "dry_run",
    defaults: {
      staleAgeHours,
      applyEnabled: false
    },
    requestedScope: {
      repoId: input?.repoId ?? null,
      branch: input?.branch ?? null,
      knowledgeSpace: input?.knowledgeSpace ?? null
    },
    scopes: scopes.map((scope) => ({
      knowledgeSpace: scope.knowledgeSpace,
      repoId: scope.repoId,
      branch: scope.branch,
      publication: scope.publication
        ? {
            publishedBuildVersion: scope.publication.published_build_version,
            publishedHead: scope.publication.published_head,
            publishedAt: scope.publication.published_at,
            publishedBy: scope.publication.published_by,
            publishedFromEnv: scope.publication.published_from_env
          }
        : null,
      serving: summarizeServingCompatibilityMetadata({
        publication: scope.publication,
        serving: scope.serving,
        publicationScopeCount: scope.publicationScopeCount
      }),
      rollback: {
        publicationTarget: scope.rollbackBuild
          ? {
              buildId: scope.rollbackBuild.id,
              buildVersion: scope.rollbackBuild.build_version,
              targetHead: scope.rollbackBuild.target_head,
              status: scope.rollbackBuild.status
            }
          : null,
        warnings: scope.rollbackBuild ? [] : ["no_prior_validated_publication_candidate"]
      },
      latestValidatedUnderReview: scope.latestValidatedUnderReview
        ? {
            buildId: scope.latestValidatedUnderReview.id,
            buildVersion: scope.latestValidatedUnderReview.build_version,
            targetHead: scope.latestValidatedUnderReview.target_head,
            status: scope.latestValidatedUnderReview.status
          }
        : null,
      builds: scope.builds.map((build) => ({
        ...buildDescriptor(build.build),
        disposition: build.disposition,
        protectedReasons: build.protectedReasons,
        candidateReasons: build.candidateReasons,
        directReasons: build.directReasons,
        reviewReasons: build.reviewReasons,
        publicationStatus: build.publicationStatus,
        existingCleanupHints: build.existingCleanupHints,
        rowCountsByTable: build.tableCounts,
        legacyDuplicateCounts: build.legacyDuplicateCounts,
        orphanedChildCounts: build.orphanedChildCounts,
        artifactSummary: build.artifactSummary,
        validationSnapshot: build.validationSnapshot
      }))
    })),
    protectedBuilds,
    cleanupCandidates: {
      directByReason: scopes.reduce<Partial<Record<CleanupCandidateReason, Array<ReturnType<typeof buildDescriptor>>>>>(
        (acc, scope) => {
          const grouped = mapReasons(
            scope.builds.filter((build) => build.disposition === "cleanup_candidate"),
            (build) => build.candidateReasons
          );
          for (const [reason, descriptors] of Object.entries(grouped) as Array<[CleanupCandidateReason, Array<ReturnType<typeof buildDescriptor>>]>) {
            acc[reason] = [...(acc[reason] ?? []), ...descriptors];
          }
          return acc;
        },
        {}
      ),
      operatorReviewByReason: scopes.reduce<Partial<Record<CleanupCandidateReason, Array<ReturnType<typeof buildDescriptor>>>>>(
        (acc, scope) => {
          const grouped = mapReasons(
            scope.builds.filter((build) => build.disposition === "operator_review"),
            (build) => build.candidateReasons
          );
          for (const [reason, descriptors] of Object.entries(grouped) as Array<[CleanupCandidateReason, Array<ReturnType<typeof buildDescriptor>>]>) {
            acc[reason] = [...(acc[reason] ?? []), ...descriptors];
          }
          return acc;
        },
        {}
      )
    },
    aggregate,
    proposedDeletionSummary: {
      directEligibleBuilds: aggregate.directCandidates.totalBuilds,
      directEligibleRowsByTable: aggregate.directCandidates.rowsByTable,
      operatorReviewBuilds: aggregate.operatorReview.totalBuilds,
      operatorReviewRowsByTable: aggregate.operatorReview.rowsByTable
    },
    warnings,
    blockers,
    operatorRunbook: {
      mode: "dry_run_only",
      preconditions: [
        "publication-based serving must already be the runtime truth",
        "current published build, rollback-retained build, and latest validated build under review remain protected",
        "destructive apply stays disabled until operators review this inventory"
      ],
      recommendedExecutionOrder: [
        "review protected builds and current publication snapshot",
        "verify direct cleanup candidates are non-published failed, abandoned, or stale partial builds",
        "review operator-review buckets before any destructive stage",
        "only then design chunked, resumable build-scoped apply execution"
      ],
      applyStatus: "disabled_by_default"
    }
  };
}
