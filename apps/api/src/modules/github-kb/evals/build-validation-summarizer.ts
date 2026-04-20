import type { BuildValidationEvaluationSummary, BuildValidationFixtureCase, BuildValidationFixtureScore } from "../../ai/evals/types.js";

function safeDivide(numerator: number, denominator: number): number {
  return denominator > 0 ? numerator / denominator : 0;
}

function relativeDelta(current: number, previous: number | undefined): number {
  if (typeof previous !== "number") return 0;
  if (previous === 0) return current === 0 ? 0 : 1;
  return Math.abs(current - previous) / previous;
}

function scoreFixture(datasetCase: BuildValidationFixtureCase): BuildValidationFixtureScore {
  const artifactCountsByFamily = datasetCase.artifactCountsByFamily ?? {};
  const previousArtifactCountsByFamily = datasetCase.previousArtifactCountsByFamily ?? {};
  const embeddingEnabledFamilies = datasetCase.embeddingEnabledFamilies ?? [];
  const totalDocuments = artifactCountsByFamily.doc_page ?? 0;
  const duplicateActivePathRate = safeDivide(datasetCase.duplicateActivePathCount, Math.max(totalDocuments, 1));
  const artifactCountDeltaByFamily = Object.fromEntries(
    Object.entries(artifactCountsByFamily).map(([family, current]) => [
      family,
      relativeDelta(current, previousArtifactCountsByFamily[family])
    ])
  );
  const citationCountDelta = relativeDelta(datasetCase.citationCount, datasetCase.previousCitationCount);
  const memoryEntryCountDelta = relativeDelta(datasetCase.memoryEntryCount, datasetCase.previousMemoryEntryCount);
  const expectedEmbeddings = Math.max(embeddingEnabledFamilies.length, 1);
  const embeddingMissingRate = safeDivide(datasetCase.missingEmbeddingCount, expectedEmbeddings);
  const failures: string[] = [];
  if (!datasetCase.buildSuccess) failures.push("build_not_successful");
  if (!datasetCase.validationPassed) failures.push("validation_not_passed");
  if (datasetCase.crossBuildReferenceViolationCount > 0) failures.push("cross_build_reference_violation_count_gt_zero");
  if (datasetCase.duplicateActivePathCount > 0) failures.push("duplicate_active_paths_present");
  if (datasetCase.missingEmbeddingCount > 0) failures.push("missing_embeddings_present");

  return {
    datasetCase,
    duplicateActivePathRate,
    artifactCountDeltaByFamily,
    citationCountDelta,
    memoryEntryCountDelta,
    embeddingMissingRate,
    crossBuildReferenceViolationCount: datasetCase.crossBuildReferenceViolationCount,
    publishable: failures.length === 0,
    failures
  };
}

export function summarizeBuildValidationFixtures(fixtures: BuildValidationFixtureCase[]): BuildValidationEvaluationSummary {
  const scores = fixtures.map(scoreFixture);
  const total = Math.max(scores.length, 1);
  const aggregateArtifactDeltas = new Map<string, number>();

  for (const score of scores) {
    for (const [family, delta] of Object.entries(score.artifactCountDeltaByFamily)) {
      aggregateArtifactDeltas.set(family, Math.max(aggregateArtifactDeltas.get(family) ?? 0, delta));
    }
  }

  return {
    metrics: {
      build_success_rate: scores.filter((item) => item.datasetCase.buildSuccess).length / total,
      build_validation_pass_rate: scores.filter((item) => item.datasetCase.validationPassed).length / total,
      duplicate_active_path_rate: scores.reduce((sum, item) => sum + item.duplicateActivePathRate, 0) / total,
      artifact_count_delta_by_family: Object.fromEntries(aggregateArtifactDeltas),
      citation_count_delta: scores.reduce((sum, item) => sum + item.citationCountDelta, 0) / total,
      memory_entry_count_delta: scores.reduce((sum, item) => sum + item.memoryEntryCountDelta, 0) / total,
      embedding_missing_rate: scores.reduce((sum, item) => sum + item.embeddingMissingRate, 0) / total,
      cross_build_reference_violation_count: scores.reduce((sum, item) => sum + item.crossBuildReferenceViolationCount, 0)
    },
    publishable: scores.every((item) => item.publishable),
    failures: scores.flatMap((item) => item.failures.map((failure) => `${item.datasetCase.id}:${failure}`))
  };
}
