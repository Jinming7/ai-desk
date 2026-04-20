import type { SupportAgentRuntimeStage } from "../types.js";
import type { RuntimeCaseScore, RuntimeEvaluationSummary, RuntimeObservation, RuntimeScenarioCase } from "./types.js";

const STAGE_ORDER: SupportAgentRuntimeStage[] = [
  "support_main",
  "support_main_plan",
  "domain_dispatch",
  "route",
  "evidence_plan",
  "case_plan",
  "retrieval",
  "retrieval_refine",
  "evidence_selection",
  "support_main_draft",
  "domain_specialist",
  "specialist",
  "generic_writer",
  "verification",
  "citation_binding",
  "citation_selection",
  "answer_composition"
];

function normalizeText(input: string | null | undefined): string {
  return String(input ?? "")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

function stageIndex(stage: string): number {
  return STAGE_ORDER.indexOf(stage as SupportAgentRuntimeStage);
}

function safeRate(numerator: number, denominator: number): number {
  return denominator > 0 ? numerator / denominator : 1;
}

export function scoreRuntimeScenarioCase(input: { datasetCase: RuntimeScenarioCase; observed: RuntimeObservation }): RuntimeCaseScore {
  const routeCorrect = !input.datasetCase.expectedRoute || normalizeText(input.datasetCase.expectedRoute) === normalizeText(input.observed.route);
  const specialistCorrect =
    !input.datasetCase.expectedSpecialistFamily ||
    normalizeText(input.datasetCase.expectedSpecialistFamily) === normalizeText(input.observed.specialistFamily);
  const clarificationCorrect =
    typeof input.datasetCase.expectClarification !== "boolean" || input.datasetCase.expectClarification === input.observed.clarificationNeeded;
  const answerModeCorrect =
    !input.datasetCase.expectedAnswerMode || input.datasetCase.expectedAnswerMode === input.observed.answerMode;
  const seenStages = new Set(input.observed.stageTrace.map((entry) => entry.stage));
  const contractViolations: string[] = [];
  const fallbackViolations: string[] = [];

  for (const required of input.datasetCase.requiredStages) {
    if (!seenStages.has(required)) {
      contractViolations.push(`missing_required_stage:${required}`);
    }
  }

  for (const forbidden of input.datasetCase.forbiddenStages) {
    if (seenStages.has(forbidden)) {
      contractViolations.push(`forbidden_stage_present:${forbidden}`);
    }
  }

  for (let index = 1; index < input.observed.stageTrace.length; index += 1) {
    const previous = input.observed.stageTrace[index - 1];
    const current = input.observed.stageTrace[index];
    if (stageIndex(previous.stage) > stageIndex(current.stage)) {
      contractViolations.push(`stage_order_violation:${previous.stage}->${current.stage}`);
    }
  }

  for (const entry of input.observed.stageTrace) {
    if (entry.status !== "fallback") continue;
    if (!input.datasetCase.allowedFallbackStages.includes(entry.stage)) {
      fallbackViolations.push(`unexpected_fallback:${entry.stage}`);
    }
  }

  for (const stage of input.observed.explicitFallbacks) {
    if (!input.datasetCase.allowedFallbackStages.includes(stage as SupportAgentRuntimeStage)) {
      fallbackViolations.push(`unexpected_explicit_fallback:${stage}`);
    }
  }

  const verificationOverturned =
    Boolean(input.observed.verificationVerdict) &&
    input.observed.verificationVerdict !== "verified" &&
    input.observed.answerMode === "grounded";

  return {
    datasetCase: input.datasetCase,
    observed: input.observed,
    routeCorrect,
    specialistCorrect,
    clarificationCorrect,
    answerModeCorrect,
    contractViolations,
    fallbackViolations,
    verificationOverturned
  };
}

export function summarizeRuntimeResults(results: RuntimeCaseScore[]): RuntimeEvaluationSummary {
  const total = Math.max(results.length, 1);
  const clarifyRelevant = results.filter((item) => typeof item.datasetCase.expectClarification === "boolean");
  const clarifyTP = clarifyRelevant.filter((item) => item.datasetCase.expectClarification && item.observed.clarificationNeeded).length;
  const clarifyFP = clarifyRelevant.filter((item) => !item.datasetCase.expectClarification && item.observed.clarificationNeeded).length;
  const clarifyFN = clarifyRelevant.filter((item) => item.datasetCase.expectClarification && !item.observed.clarificationNeeded).length;
  const fallbackCount = results.reduce(
    (sum, item) => sum + item.observed.stageTrace.filter((entry) => entry.status === "fallback").length + item.observed.explicitFallbacks.length,
    0
  );
  const traceCount = results.reduce((sum, item) => sum + item.observed.stageTrace.length, 0);
  const timeoutCount = results.reduce((sum, item) => sum + item.observed.timeoutStages.length, 0);

  return {
    metrics: {
      route_accuracy: safeRate(results.filter((item) => item.routeCorrect).length, total),
      specialist_selection_accuracy: safeRate(results.filter((item) => item.specialistCorrect).length, total),
      clarification_precision: safeRate(clarifyTP, clarifyTP + clarifyFP),
      clarification_recall: safeRate(clarifyTP, clarifyTP + clarifyFN),
      stage_timeout_rate: safeRate(timeoutCount, Math.max(traceCount, 1)),
      stage_fallback_rate: safeRate(fallbackCount, Math.max(traceCount, 1)),
      stage_contract_violation_count: results.reduce((sum, item) => sum + item.contractViolations.length + item.fallbackViolations.length, 0),
      verification_overturn_rate: safeRate(results.filter((item) => item.verificationOverturned).length, total)
    },
    failures: results.flatMap((item) => [
      ...item.contractViolations.map((failure) => `${item.datasetCase.id}:${failure}`),
      ...item.fallbackViolations.map((failure) => `${item.datasetCase.id}:${failure}`),
      ...(!item.routeCorrect ? [`${item.datasetCase.id}:route_mismatch`] : []),
      ...(!item.specialistCorrect ? [`${item.datasetCase.id}:specialist_mismatch`] : []),
      ...(!item.answerModeCorrect ? [`${item.datasetCase.id}:answer_mode_mismatch`] : [])
    ])
  };
}
