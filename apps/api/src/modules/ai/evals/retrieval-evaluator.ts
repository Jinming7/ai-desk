import type {
  RetrievalCaseScore,
  RetrievalEvaluationSummary,
  RetrievalObservation,
  RetrievalScoreLabel,
  RetrievalSeedCase
} from "./types.js";

function normalizeText(input: string | null | undefined): string {
  return String(input ?? "")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

function includesNormalized(haystack: string, needles: string[]): boolean {
  const normalizedHaystack = normalizeText(haystack);
  return needles.some((needle) => normalizedHaystack.includes(normalizeText(needle)));
}

function buildExactMatchers(datasetCase: RetrievalSeedCase): string[] {
  return [...datasetCase.acceptableArtifactIds, ...datasetCase.acceptablePaths, ...datasetCase.acceptableCitationTargets]
    .map((item) => normalizeText(item))
    .filter(Boolean);
}

function findExactHitRank(datasetCase: RetrievalSeedCase, observed: RetrievalObservation): number | null {
  const exactMatchers = buildExactMatchers(datasetCase);
  if (!exactMatchers.length) return null;
  for (let index = 0; index < observed.candidates.length; index += 1) {
    const candidate = observed.candidates[index];
    const values = [candidate.artifactId, candidate.path, candidate.citationTarget].map((item) => normalizeText(item));
    if (values.some((value) => exactMatchers.includes(value))) {
      return index + 1;
    }
  }
  return null;
}

function findFamilyHitRank(datasetCase: RetrievalSeedCase, observed: RetrievalObservation): number | null {
  const family = normalizeText(datasetCase.expectedPrimaryFamily);
  for (let index = 0; index < observed.candidates.length; index += 1) {
    if (normalizeText(observed.candidates[index]?.family) === family) {
      return index + 1;
    }
  }
  return null;
}

function detectWrongFamilyOverRanking(datasetCase: RetrievalSeedCase, observed: RetrievalObservation, exactHitRank: number | null): boolean {
  const forbidden = datasetCase.forbiddenFamilies.map((item) => normalizeText(item)).filter(Boolean);
  if (!forbidden.length) return false;
  const top3 = observed.candidates.slice(0, 3);
  const wrongFamilyInTop3 = top3.some((candidate) => forbidden.includes(normalizeText(candidate.family)));
  if (!wrongFamilyInTop3) return false;
  return exactHitRank === null || exactHitRank > 1;
}

function resolveScoreLabel(input: {
  exactHitRank: number | null;
  familyHitRank: number | null;
  wrongFamilyOverRanking: boolean;
  groundableCandidateAvailable: boolean;
}): RetrievalScoreLabel {
  if (input.wrongFamilyOverRanking) return "wrong_family_penalty";
  if (input.exactHitRank !== null && input.exactHitRank <= 3) return "exact_top_3";
  if (input.familyHitRank !== null && input.familyHitRank <= 3) return "acceptable_family_top_3";
  if ((input.exactHitRank !== null && input.exactHitRank <= 10) || (input.familyHitRank !== null && input.familyHitRank <= 10)) {
    return "low_credit_late_hit";
  }
  if (input.groundableCandidateAvailable) return "low_credit_late_hit";
  return "no_useful_candidate";
}

export function scoreRetrievalCase(input: { datasetCase: RetrievalSeedCase; observed: RetrievalObservation }): RetrievalCaseScore {
  const exactHitRank = findExactHitRank(input.datasetCase, input.observed);
  const familyHitRank = findFamilyHitRank(input.datasetCase, input.observed);
  const wrongFamilyOverRanking = detectWrongFamilyOverRanking(input.datasetCase, input.observed, exactHitRank);
  const exactSignalCaptured =
    input.datasetCase.expectedExactSignals.length === 0 ||
    input.observed.candidates.some((candidate) =>
      candidate.exactSignalMatches.some((match) =>
        input.datasetCase.expectedExactSignals.some((expected) => normalizeText(expected) === normalizeText(match))
      )
    ) ||
    input.observed.resolvedQueries.some((query) => includesNormalized(query, input.datasetCase.expectedExactSignals));
  const groundableCandidateAvailable =
    !input.datasetCase.requireGroundableCandidate || input.observed.candidates.some((candidate) => candidate.groundable);
  const kbUnavailableFalsePositive = !input.datasetCase.expectKbUnavailable && input.observed.retrievalStatus === "kb_unavailable";
  const publicationScopedRead = Boolean(input.observed.publicationScopedRead);
  const scoreLabel = resolveScoreLabel({
    exactHitRank,
    familyHitRank,
    wrongFamilyOverRanking,
    groundableCandidateAvailable
  });

  const failures: string[] = [];
  if (kbUnavailableFalsePositive) failures.push("kb_unavailable_false_positive");
  if (!publicationScopedRead) failures.push("publication_scoped_read_missing");
  if (!exactSignalCaptured) failures.push("exact_signal_not_captured");
  if (!groundableCandidateAvailable) failures.push("no_groundable_candidate");
  if (scoreLabel === "wrong_family_penalty") failures.push("wrong_family_over_ranked");
  if (scoreLabel === "no_useful_candidate") failures.push("no_useful_candidate");

  return {
    datasetCase: input.datasetCase,
    observed: input.observed,
    scoreLabel,
    exactHitRank,
    familyHitRank,
    wrongFamilyOverRanking,
    exactSignalCaptured,
    groundableCandidateAvailable,
    kbUnavailableFalsePositive,
    publicationScopedRead,
    failures
  };
}

function safeRate(numerator: number, denominator: number): number {
  return denominator > 0 ? numerator / denominator : 1;
}

export function summarizeRetrievalResults(results: RetrievalCaseScore[]): RetrievalEvaluationSummary {
  const total = Math.max(results.length, 1);
  const countScore = (label: RetrievalScoreLabel) => results.filter((item) => item.scoreLabel === label).length;
  const exactSignalDenominator = results.filter((item) => item.datasetCase.expectedExactSignals.length > 0).length;

  return {
    metrics: {
      retrieval_hit_at_1: safeRate(results.filter((item) => item.exactHitRank !== null && item.exactHitRank <= 1).length, total),
      retrieval_hit_at_3: safeRate(results.filter((item) => item.exactHitRank !== null && item.exactHitRank <= 3).length, total),
      retrieval_hit_at_5: safeRate(results.filter((item) => item.exactHitRank !== null && item.exactHitRank <= 5).length, total),
      retrieval_hit_at_10: safeRate(results.filter((item) => item.exactHitRank !== null && item.exactHitRank <= 10).length, total),
      family_hit_at_3: safeRate(results.filter((item) => item.familyHitRank !== null && item.familyHitRank <= 3).length, total),
      exact_signal_capture_rate: safeRate(results.filter((item) => item.exactSignalCaptured).length, Math.max(exactSignalDenominator, 1)),
      wrong_family_top_3_rate: safeRate(results.filter((item) => item.wrongFamilyOverRanking).length, total),
      groundable_candidate_rate: safeRate(results.filter((item) => item.groundableCandidateAvailable).length, total),
      kb_unavailable_false_positive_rate: safeRate(results.filter((item) => item.kbUnavailableFalsePositive).length, total),
      publication_scoped_read_rate: safeRate(results.filter((item) => item.publicationScopedRead).length, total)
    },
    scoreCounts: {
      exact_top_3: countScore("exact_top_3"),
      acceptable_family_top_3: countScore("acceptable_family_top_3"),
      low_credit_late_hit: countScore("low_credit_late_hit"),
      wrong_family_penalty: countScore("wrong_family_penalty"),
      no_useful_candidate: countScore("no_useful_candidate")
    },
    failures: results.flatMap((item) => item.failures.map((failure) => `${item.datasetCase.id}:${failure}`))
  };
}

