import assert from "node:assert/strict";
import { test } from "node:test";
import type { KbBuild } from "../../modules/github-kb/types.js";
import {
  aggregateCleanupAssessments,
  classifyCleanupBuild,
  resolveProtectedBuilds,
  type CleanupBuildAssessmentInput,
  type CleanupTableCounts
} from "../../modules/github-kb/cleanup/classifier.js";

function buildFixture(overrides: Partial<KbBuild> = {}): KbBuild {
  return {
    id: overrides.id ?? "build-id",
    knowledge_space: overrides.knowledge_space ?? "support-local",
    repo_id: overrides.repo_id ?? "repo-1",
    branch: overrides.branch ?? "main",
    build_version: overrides.build_version ?? "build-1",
    target_head: overrides.target_head ?? "sha-1",
    build_kind: overrides.build_kind ?? "full",
    requested_by: overrides.requested_by ?? "test",
    requested_from_env: overrides.requested_from_env ?? "local",
    status: overrides.status ?? "validated",
    source_snapshot_total: overrides.source_snapshot_total ?? 1,
    documents_built: overrides.documents_built ?? 0,
    chunks_built: overrides.chunks_built ?? 0,
    memory_entries_built: overrides.memory_entries_built ?? 0,
    embeddings_built: overrides.embeddings_built ?? 0,
    validation_passed: overrides.validation_passed ?? true,
    validation_summary_json: overrides.validation_summary_json ?? {},
    error_message: overrides.error_message ?? null,
    started_at: overrides.started_at ?? "2026-04-01T00:00:00.000Z",
    finished_at: overrides.finished_at ?? "2026-04-01T00:05:00.000Z",
    created_at: overrides.created_at ?? "2026-04-01T00:00:00.000Z",
    updated_at: overrides.updated_at ?? "2026-04-01T00:05:00.000Z"
  };
}

function tableCounts(overrides: Partial<CleanupTableCounts> = {}): CleanupTableCounts {
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
    kb_citation_units: 0,
    ...overrides
  };
}

function classify(input: Partial<CleanupBuildAssessmentInput> & { build: KbBuild }) {
  return classifyCleanupBuild({
    build: input.build,
    protectedBuilds:
      input.protectedBuilds ??
      resolveProtectedBuilds({
        builds: [input.build],
        currentPublishedBuildVersion: null
      }),
    currentPublishedBuildVersion: input.currentPublishedBuildVersion ?? null,
    tableCounts: input.tableCounts ?? tableCounts(),
    legacyDuplicateCounts: input.legacyDuplicateCounts ?? { kb_documents: 0, kb_chunks: 0, kb_memory_entries: 0, kb_memory_profiles: 0 },
    orphanedChildCounts:
      input.orphanedChildCounts ??
      { kb_memory_sources: 0, kb_memory_citations: 0, kb_memory_relations: 0, total: 0 },
    staleAgeHours: input.staleAgeHours ?? 72,
    nowIso: input.nowIso ?? "2026-04-01T12:00:00.000Z"
  });
}

test("protected current publication build is never classified as a cleanup candidate", () => {
  const current = buildFixture({
    id: "build-current",
    build_version: "build-current",
    status: "published"
  });

  const protectedBuilds = resolveProtectedBuilds({
    builds: [current],
    currentPublishedBuildVersion: "build-current"
  });

  const assessment = classify({
    build: current,
    protectedBuilds,
    currentPublishedBuildVersion: "build-current",
    legacyDuplicateCounts: { kb_documents: 3, kb_chunks: 2, kb_memory_entries: 1, kb_memory_profiles: 0 }
  });

  assert.equal(assessment.disposition, "protected");
  assert.deepEqual(assessment.protectedReasons, ["current_published_build"]);
  assert.deepEqual(assessment.candidateReasons, []);
});

test("failed non-published build is classified as a direct cleanup candidate", () => {
  const build = buildFixture({
    id: "build-failed",
    build_version: "build-failed",
    status: "failed",
    validation_passed: false
  });

  const assessment = classify({ build });

  assert.equal(assessment.disposition, "cleanup_candidate");
  assert.equal(assessment.candidateReasons.includes("failed_without_publication"), true);
});

test("rollback-retained build is excluded from cleanup", () => {
  const current = buildFixture({
    id: "build-current",
    build_version: "build-current",
    status: "published",
    updated_at: "2026-04-01T11:00:00.000Z"
  });
  const rollback = buildFixture({
    id: "build-rollback",
    build_version: "build-rollback",
    status: "superseded",
    updated_at: "2026-04-01T10:00:00.000Z"
  });
  const older = buildFixture({
    id: "build-older",
    build_version: "build-older",
    status: "superseded",
    updated_at: "2026-03-31T10:00:00.000Z"
  });

  const protectedBuilds = resolveProtectedBuilds({
    builds: [current, rollback, older],
    currentPublishedBuildVersion: current.build_version
  });
  const assessment = classify({
    build: rollback,
    protectedBuilds,
    currentPublishedBuildVersion: current.build_version
  });

  assert.equal(protectedBuilds.rollbackRetainedBuildVersion, rollback.build_version);
  assert.equal(assessment.disposition, "protected");
  assert.equal(assessment.protectedReasons.includes("rollback_retained_build"), true);
});

test("dry-run aggregation sums candidate row counts without counting protected builds", () => {
  const directCandidate = classify({
    build: buildFixture({
      id: "build-failed",
      build_version: "build-failed",
      status: "failed",
      validation_passed: false
    }),
    tableCounts: tableCounts({ kb_documents: 2, kb_chunks: 5 })
  });
  const operatorReview = classify({
    build: buildFixture({
      id: "build-review",
      build_version: "build-review",
      status: "superseded",
      updated_at: "2026-03-29T10:00:00.000Z"
    }),
    currentPublishedBuildVersion: "build-current",
    protectedBuilds: resolveProtectedBuilds({
      builds: [
        buildFixture({
          id: "build-current",
          build_version: "build-current",
          status: "published",
          updated_at: "2026-04-01T11:00:00.000Z"
        }),
        buildFixture({
          id: "build-rollback",
          build_version: "build-rollback",
          status: "superseded",
          updated_at: "2026-03-30T10:00:00.000Z"
        }),
        buildFixture({
          id: "build-review",
          build_version: "build-review",
          status: "superseded",
          updated_at: "2026-03-29T10:00:00.000Z"
        })
      ],
      currentPublishedBuildVersion: "build-current"
    }),
    tableCounts: tableCounts({ kb_documents: 4, kb_chunks: 7 })
  });
  const protectedBuild = classify({
    build: buildFixture({
      id: "build-current",
      build_version: "build-current",
      status: "published"
    }),
    currentPublishedBuildVersion: "build-current",
    protectedBuilds: resolveProtectedBuilds({
      builds: [
        buildFixture({
          id: "build-current",
          build_version: "build-current",
          status: "published"
        })
      ],
      currentPublishedBuildVersion: "build-current"
    }),
    tableCounts: tableCounts({ kb_documents: 99, kb_chunks: 99 })
  });

  const aggregate = aggregateCleanupAssessments([directCandidate, operatorReview, protectedBuild]);

  assert.equal(aggregate.directCandidates.totalBuilds, 1);
  assert.equal(aggregate.directCandidates.rowsByTable.kb_documents, 2);
  assert.equal(aggregate.directCandidates.rowsByTable.kb_chunks, 5);
  assert.equal(aggregate.operatorReview.totalBuilds, 1);
  assert.equal(aggregate.operatorReview.rowsByTable.kb_documents, 4);
  assert.equal(aggregate.operatorReview.rowsByTable.kb_chunks, 7);
});

test("legacy duplicate rows are only proposed when tied to dead builds", () => {
  const protectedValidated = buildFixture({
    id: "build-under-review",
    build_version: "build-under-review",
    status: "validated",
    updated_at: "2026-04-01T11:00:00.000Z"
  });
  const deadSuperseded = buildFixture({
    id: "build-dead",
    build_version: "build-dead",
    status: "superseded",
    updated_at: "2026-03-29T11:00:00.000Z"
  });
  const protectedBuilds = resolveProtectedBuilds({
    builds: [protectedValidated, deadSuperseded],
    currentPublishedBuildVersion: null
  });

  const protectedAssessment = classify({
    build: protectedValidated,
    protectedBuilds,
    legacyDuplicateCounts: { kb_documents: 1, kb_chunks: 1, kb_memory_entries: 1, kb_memory_profiles: 0 }
  });
  const deadAssessment = classify({
    build: deadSuperseded,
    protectedBuilds,
    legacyDuplicateCounts: { kb_documents: 1, kb_chunks: 0, kb_memory_entries: 0, kb_memory_profiles: 0 }
  });

  assert.equal(protectedAssessment.candidateReasons.includes("legacy_duplicate_active_rows"), false);
  assert.equal(deadAssessment.candidateReasons.includes("legacy_duplicate_active_rows"), true);
});

test("cleanup classification does not use is_active as serving truth", () => {
  const current = buildFixture({
    id: "build-current",
    build_version: "build-current",
    status: "published"
  });
  const failed = buildFixture({
    id: "build-failed",
    build_version: "build-failed",
    status: "failed",
    validation_passed: false
  });
  const protectedBuilds = resolveProtectedBuilds({
    builds: [current, failed],
    currentPublishedBuildVersion: current.build_version
  });

  const currentAssessment = classify({
    build: current,
    protectedBuilds,
    currentPublishedBuildVersion: current.build_version,
    legacyDuplicateCounts: { kb_documents: 8, kb_chunks: 8, kb_memory_entries: 8, kb_memory_profiles: 8 }
  });
  const failedAssessment = classify({
    build: failed,
    protectedBuilds,
    currentPublishedBuildVersion: current.build_version
  });

  assert.equal(currentAssessment.disposition, "protected");
  assert.equal(failedAssessment.disposition, "cleanup_candidate");
  assert.equal(failedAssessment.candidateReasons.includes("failed_without_publication"), true);
});
