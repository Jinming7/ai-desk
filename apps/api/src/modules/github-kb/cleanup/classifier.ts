import type { KbBuild } from "../types.js";

export type CleanupProtectedReason =
  | "current_published_build"
  | "rollback_retained_build"
  | "latest_validated_under_review";

export type CleanupCandidateReason =
  | "failed_without_publication"
  | "abandoned_without_publication"
  | "stale_partial_build"
  | "superseded_nonrollback_build"
  | "legacy_duplicate_active_rows"
  | "orphaned_child_rows";

export type CleanupDisposition = "protected" | "cleanup_candidate" | "operator_review" | "ignored";

export interface CleanupTableCounts {
  kb_documents: number;
  kb_chunks: number;
  kb_memory_entries: number;
  kb_memory_sources: number;
  kb_memory_aliases: number;
  kb_memory_signals: number;
  kb_memory_relations: number;
  kb_memory_profiles: number;
  kb_memory_citations: number;
  kb_openapi_operations: number;
  kb_code_symbols: number;
  kb_config_surfaces: number;
  kb_schema_objects: number;
  kb_test_behaviors: number;
  kb_citation_units: number;
}

export interface CleanupLegacyDuplicateCounts {
  kb_documents: number;
  kb_chunks: number;
  kb_memory_entries: number;
  kb_memory_profiles: number;
}

export interface CleanupOrphanedChildCounts {
  kb_memory_sources: number;
  kb_memory_citations: number;
  kb_memory_relations: number;
  total: number;
}

export interface ProtectedBuildResolution {
  currentPublishedBuildVersion: string | null;
  rollbackRetainedBuildVersion: string | null;
  latestValidatedUnderReviewBuildVersion: string | null;
  protectedReasonsByBuildVersion: Record<string, CleanupProtectedReason[]>;
}

export interface CleanupBuildAssessmentInput {
  build: KbBuild;
  protectedBuilds: ProtectedBuildResolution;
  currentPublishedBuildVersion: string | null;
  tableCounts: CleanupTableCounts;
  legacyDuplicateCounts: CleanupLegacyDuplicateCounts;
  orphanedChildCounts: CleanupOrphanedChildCounts;
  staleAgeHours: number;
  nowIso: string;
}

export interface CleanupBuildAssessment {
  build: KbBuild;
  disposition: CleanupDisposition;
  protectedReasons: CleanupProtectedReason[];
  directReasons: CleanupCandidateReason[];
  reviewReasons: CleanupCandidateReason[];
  candidateReasons: CleanupCandidateReason[];
  tableCounts: CleanupTableCounts;
  legacyDuplicateCounts: CleanupLegacyDuplicateCounts;
  orphanedChildCounts: CleanupOrphanedChildCounts;
}

const BUILD_TABLE_KEYS = [
  "kb_documents",
  "kb_chunks",
  "kb_memory_entries",
  "kb_memory_sources",
  "kb_memory_aliases",
  "kb_memory_signals",
  "kb_memory_relations",
  "kb_memory_profiles",
  "kb_memory_citations",
  "kb_openapi_operations",
  "kb_code_symbols",
  "kb_config_surfaces",
  "kb_schema_objects",
  "kb_test_behaviors",
  "kb_citation_units"
] as const satisfies ReadonlyArray<keyof CleanupTableCounts>;

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

function newestValidatedUnderReview(builds: KbBuild[], excludedBuildVersions: Set<string>): KbBuild | null {
  const eligible = builds
    .filter((build) => build.status === "validated" && build.validation_passed && !excludedBuildVersions.has(build.build_version))
    .sort((left, right) => new Date(right.updated_at).getTime() - new Date(left.updated_at).getTime());
  return eligible[0] ?? null;
}

function addProtectedReason(
  protectedReasonsByBuildVersion: Record<string, CleanupProtectedReason[]>,
  buildVersion: string | null,
  reason: CleanupProtectedReason
) {
  if (!buildVersion) return;
  const existing = protectedReasonsByBuildVersion[buildVersion] ?? [];
  if (!existing.includes(reason)) existing.push(reason);
  protectedReasonsByBuildVersion[buildVersion] = existing;
}

export function resolveProtectedBuilds(input: {
  builds: KbBuild[];
  currentPublishedBuildVersion: string | null;
}): ProtectedBuildResolution {
  const protectedReasonsByBuildVersion: Record<string, CleanupProtectedReason[]> = {};
  addProtectedReason(protectedReasonsByBuildVersion, input.currentPublishedBuildVersion, "current_published_build");

  const rollbackRetainedBuildVersion = input.currentPublishedBuildVersion
    ? pickRollbackCandidate(input.builds.filter((build) => build.build_version !== input.currentPublishedBuildVersion))?.build_version ?? null
    : null;
  addProtectedReason(protectedReasonsByBuildVersion, rollbackRetainedBuildVersion, "rollback_retained_build");

  const excluded = new Set<string>();
  if (input.currentPublishedBuildVersion) excluded.add(input.currentPublishedBuildVersion);
  if (rollbackRetainedBuildVersion) excluded.add(rollbackRetainedBuildVersion);

  const latestValidatedUnderReviewBuildVersion = newestValidatedUnderReview(input.builds, excluded)?.build_version ?? null;
  addProtectedReason(protectedReasonsByBuildVersion, latestValidatedUnderReviewBuildVersion, "latest_validated_under_review");

  return {
    currentPublishedBuildVersion: input.currentPublishedBuildVersion,
    rollbackRetainedBuildVersion,
    latestValidatedUnderReviewBuildVersion,
    protectedReasonsByBuildVersion
  };
}

function hoursSince(updatedAt: string, nowIso: string): number {
  const deltaMs = new Date(nowIso).getTime() - new Date(updatedAt).getTime();
  return deltaMs / (1000 * 60 * 60);
}

function isStalePartialBuild(build: KbBuild, nowIso: string, staleAgeHours: number): boolean {
  return ["building", "built"].includes(build.status) && hoursSince(build.updated_at, nowIso) >= staleAgeHours;
}

function totalLegacyDuplicates(counts: CleanupLegacyDuplicateCounts): number {
  return counts.kb_documents + counts.kb_chunks + counts.kb_memory_entries + counts.kb_memory_profiles;
}

function shouldReviewAsSuperseded(build: KbBuild, currentPublishedBuildVersion: string | null, protectedBuilds: ProtectedBuildResolution): boolean {
  if (!build.validation_passed) return false;
  if (protectedBuilds.latestValidatedUnderReviewBuildVersion === build.build_version) return false;
  if (currentPublishedBuildVersion && currentPublishedBuildVersion !== build.build_version) return true;
  return build.knowledge_space !== "support-prod" && build.status === "validated";
}

function isDeadBuildLineage(build: KbBuild, nowIso: string, staleAgeHours: number, currentPublishedBuildVersion: string | null): boolean {
  if (build.build_version === currentPublishedBuildVersion) return false;
  if (build.status === "failed" || build.status === "abandoned" || build.status === "superseded") return true;
  if (isStalePartialBuild(build, nowIso, staleAgeHours)) return true;
  return false;
}

export function classifyCleanupBuild(input: CleanupBuildAssessmentInput): CleanupBuildAssessment {
  const protectedReasons = input.protectedBuilds.protectedReasonsByBuildVersion[input.build.build_version] ?? [];
  if (protectedReasons.length > 0) {
    return {
      build: input.build,
      disposition: "protected",
      protectedReasons,
      directReasons: [],
      reviewReasons: [],
      candidateReasons: [],
      tableCounts: input.tableCounts,
      legacyDuplicateCounts: input.legacyDuplicateCounts,
      orphanedChildCounts: input.orphanedChildCounts
    };
  }

  const directReasons: CleanupCandidateReason[] = [];
  const reviewReasons: CleanupCandidateReason[] = [];

  if (input.build.status === "failed") {
    directReasons.push("failed_without_publication");
  }
  if (input.build.status === "abandoned") {
    directReasons.push("abandoned_without_publication");
  }
  if (isStalePartialBuild(input.build, input.nowIso, input.staleAgeHours)) {
    directReasons.push("stale_partial_build");
  }

  if (shouldReviewAsSuperseded(input.build, input.currentPublishedBuildVersion, input.protectedBuilds)) {
    reviewReasons.push("superseded_nonrollback_build");
  }

  if (
    totalLegacyDuplicates(input.legacyDuplicateCounts) > 0 &&
    (directReasons.length > 0 || isDeadBuildLineage(input.build, input.nowIso, input.staleAgeHours, input.currentPublishedBuildVersion) || reviewReasons.includes("superseded_nonrollback_build"))
  ) {
    reviewReasons.push("legacy_duplicate_active_rows");
  }

  if (input.orphanedChildCounts.total > 0) {
    reviewReasons.push("orphaned_child_rows");
  }

  return {
    build: input.build,
    disposition: directReasons.length > 0 ? "cleanup_candidate" : reviewReasons.length > 0 ? "operator_review" : "ignored",
    protectedReasons: [],
    directReasons,
    reviewReasons,
    candidateReasons: [...directReasons, ...reviewReasons],
    tableCounts: input.tableCounts,
    legacyDuplicateCounts: input.legacyDuplicateCounts,
    orphanedChildCounts: input.orphanedChildCounts
  };
}

function emptyTableCounts(): CleanupTableCounts {
  return {
    kb_documents: 0,
    kb_chunks: 0,
    kb_memory_entries: 0,
    kb_memory_sources: 0,
    kb_memory_aliases: 0,
    kb_memory_signals: 0,
    kb_memory_relations: 0,
    kb_memory_profiles: 0,
    kb_memory_citations: 0,
    kb_openapi_operations: 0,
    kb_code_symbols: 0,
    kb_config_surfaces: 0,
    kb_schema_objects: 0,
    kb_test_behaviors: 0,
    kb_citation_units: 0
  };
}

function sumTableCounts(target: CleanupTableCounts, source: CleanupTableCounts) {
  for (const key of BUILD_TABLE_KEYS) {
    target[key] += source[key];
  }
}

function groupByReason(assessments: CleanupBuildAssessment[]) {
  const grouped: Partial<Record<CleanupCandidateReason, string[]>> = {};
  for (const assessment of assessments) {
    for (const reason of assessment.candidateReasons) {
      grouped[reason] = [...(grouped[reason] ?? []), assessment.build.id];
    }
  }
  return grouped;
}

export function aggregateCleanupAssessments(assessments: CleanupBuildAssessment[]) {
  const directAssessments = assessments.filter((item) => item.disposition === "cleanup_candidate");
  const operatorAssessments = assessments.filter((item) => item.disposition === "operator_review");
  const directRows = emptyTableCounts();
  const operatorRows = emptyTableCounts();
  for (const assessment of directAssessments) sumTableCounts(directRows, assessment.tableCounts);
  for (const assessment of operatorAssessments) sumTableCounts(operatorRows, assessment.tableCounts);

  return {
    directCandidates: {
      totalBuilds: directAssessments.length,
      rowsByTable: directRows,
      buildIdsByReason: groupByReason(directAssessments)
    },
    operatorReview: {
      totalBuilds: operatorAssessments.length,
      rowsByTable: operatorRows,
      buildIdsByReason: groupByReason(operatorAssessments)
    }
  };
}
