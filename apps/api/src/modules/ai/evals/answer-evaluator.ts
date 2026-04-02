import type { AnswerCaseScore, AnswerEvaluationSummary, AnswerObservation, AnswerRubricLabel, AnswerGoldenCase } from "./types.js";

function normalizeText(input: string | null | undefined): string {
  return String(input ?? "")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

function safeRate(numerator: number, denominator: number): number {
  return denominator > 0 ? numerator / denominator : 1;
}

function containsAll(text: string, expected: string[]): boolean {
  const normalizedText = normalizeText(text);
  return expected.every((item) => normalizedText.includes(normalizeText(item)));
}

function countPresent(items: string[], haystacks: string[]): number {
  const normalizedHaystacks = haystacks.map((item) => normalizeText(item)).filter(Boolean);
  return items.filter((item) => normalizedHaystacks.some((haystack) => haystack.includes(normalizeText(item)))).length;
}

function resolveLabel(failures: string[]): AnswerRubricLabel {
  if (
    failures.some((failure) =>
      /answer_type_mismatch|required_claims_missing|citation_requirement_failed|hallucination_detected|unsupported_claims_present|missing_direct_answer/.test(failure)
    )
  ) {
    return "fail";
  }
  if (failures.some((failure) => /minimum_next_steps_missing|still_need_to_confirm_not_minimal/.test(failure))) {
    return "needs_improvement";
  }
  if (failures.length > 0) return "pass_with_minor_issue";
  return "pass";
}

export function scoreAnswerCase(input: { datasetCase: AnswerGoldenCase; observed: AnswerObservation }): AnswerCaseScore {
  const fullAnswerText = normalizeText(`${input.observed.directAnswer}\n${input.observed.fullAnswerText}`);
  const citationSatisfied =
    input.observed.citations.length >= input.datasetCase.minimumCitationCount &&
    (input.datasetCase.requiredCitationTargets.length === 0 ||
      input.datasetCase.requiredCitationTargets.every((target) =>
        input.observed.citations.some((citation) => normalizeText(`${citation.title} ${citation.source_url}`).includes(normalizeText(target)))
      ));
  const requiredClaimsPresent = containsAll(fullAnswerText, input.datasetCase.requiredClaims);
  const nextStepHits = countPresent(input.datasetCase.minimumNextSteps, [
    ...input.observed.whatToDoNow,
    input.observed.directAnswer,
    input.observed.fullAnswerText
  ]);
  const actionabilityScore =
    input.datasetCase.minimumNextSteps.length > 0 ? nextStepHits / input.datasetCase.minimumNextSteps.length : input.observed.whatToDoNow.length > 0 ? 1 : 0;
  const hallucinationDetected =
    input.datasetCase.forbiddenHallucinations.some((item) => fullAnswerText.includes(normalizeText(item))) ||
    input.observed.unsupportedClaims.length > 0;
  const failures: string[] = [];

  if (
    input.datasetCase.expectedAnswerType === "handoff" ||
    input.datasetCase.expectedAnswerType === "clarification"
  ) {
    if (input.observed.answerMode !== input.datasetCase.expectedAnswerType) {
      failures.push("answer_type_mismatch");
    }
  } else if (input.observed.answerType && normalizeText(input.observed.answerType) !== normalizeText(input.datasetCase.expectedAnswerType)) {
    failures.push("answer_type_mismatch");
  }

  if (input.datasetCase.requireDirectAnswer && !normalizeText(input.observed.directAnswer)) {
    failures.push("missing_direct_answer");
  }
  if (!requiredClaimsPresent) {
    failures.push("required_claims_missing");
  }
  if (!citationSatisfied) {
    failures.push("citation_requirement_failed");
  }
  if (actionabilityScore < 1) {
    failures.push("minimum_next_steps_missing");
  }
  if (hallucinationDetected) {
    failures.push("hallucination_detected");
  }
  if (input.observed.unsupportedClaims.length > 0) {
    failures.push("unsupported_claims_present");
  }
  if (input.observed.stillNeedToConfirm.length > input.datasetCase.maximumStillNeedToConfirm) {
    failures.push("still_need_to_confirm_not_minimal");
  }

  return {
    datasetCase: input.datasetCase,
    observed: input.observed,
    label: resolveLabel(failures),
    failures,
    actionabilityScore,
    citationSatisfied,
    hallucinationDetected
  };
}

export function summarizeAnswerResults(results: AnswerCaseScore[]): AnswerEvaluationSummary {
  const total = Math.max(results.length, 1);
  const countLabel = (label: AnswerRubricLabel) => results.filter((item) => item.label === label).length;

  return {
    metrics: {
      answer_mode_accuracy: safeRate(
        results.filter((item) => !item.failures.includes("answer_type_mismatch")).length,
        total
      ),
      direct_answer_correctness: safeRate(
        results.filter((item) => !item.failures.includes("required_claims_missing") && !item.failures.includes("missing_direct_answer")).length,
        total
      ),
      customer_actionability_score: results.reduce((sum, item) => sum + item.actionabilityScore, 0) / total,
      citation_presence_rate: safeRate(results.filter((item) => item.citationSatisfied).length, total),
      hallucination_rate: safeRate(results.filter((item) => item.hallucinationDetected).length, total),
      handoff_appropriateness: safeRate(
        results.filter((item) => {
          if (item.datasetCase.expectedAnswerType === "handoff") return item.observed.answerMode === "handoff";
          return item.observed.answerMode !== "handoff";
        }).length,
        total
      ),
      minimum_missing_info_quality: safeRate(
        results.filter((item) => !item.failures.includes("still_need_to_confirm_not_minimal")).length,
        total
      )
    },
    labelCounts: {
      pass: countLabel("pass"),
      pass_with_minor_issue: countLabel("pass_with_minor_issue"),
      needs_improvement: countLabel("needs_improvement"),
      fail: countLabel("fail")
    },
    failures: results.flatMap((item) => item.failures.map((failure) => `${item.datasetCase.id}:${failure}`))
  };
}

