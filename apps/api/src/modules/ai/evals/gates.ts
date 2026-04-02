import type { AnswerEvaluationSummary, BuildValidationEvaluationSummary, EvaluationMode, RetrievalEvaluationSummary, RuntimeEvaluationSummary } from "./types.js";

type GateResult = {
  passed: boolean;
  reasons: string[];
};

export interface AcceptanceGateDecision {
  releaseDecision: "ready" | "blocked";
  gates: {
    kbBuildGate: GateResult;
    retrievalChangeGate: GateResult;
    runtimeContractGate: GateResult;
    answerQualityGate: GateResult;
    productionEnablementGate: GateResult;
  };
}

interface GateInput {
  buildSummary: BuildValidationEvaluationSummary;
  retrievalSummary: RetrievalEvaluationSummary;
  runtimeSummary: RuntimeEvaluationSummary;
  answerSummary: AnswerEvaluationSummary;
  baseline?: {
    retrievalSummary?: RetrievalEvaluationSummary;
    runtimeSummary?: RuntimeEvaluationSummary;
    answerSummary?: AnswerEvaluationSummary;
  };
  requireBaselineForBehaviorChanges?: boolean;
  executionMode: EvaluationMode;
  shadowValidationStable: boolean;
  rollbackReady: boolean;
  diagnosticsAvailable: boolean;
}

interface GateThresholds {
  retrievalHitAt3RegressionTolerance: number;
  wrongFamilyRegressionTolerance: number;
  kbUnavailableFalsePositiveTolerance: number;
  citationPresenceRegressionTolerance: number;
  hallucinationRegressionTolerance: number;
}

const DEFAULT_THRESHOLDS: GateThresholds = {
  retrievalHitAt3RegressionTolerance: 0.02,
  wrongFamilyRegressionTolerance: 0.01,
  kbUnavailableFalsePositiveTolerance: 0.01,
  citationPresenceRegressionTolerance: 0.01,
  hallucinationRegressionTolerance: 0.01
};

function buildGate(passed: boolean, reasons: string[]): GateResult {
  return { passed, reasons };
}

export function evaluateAcceptanceGates(input: GateInput): AcceptanceGateDecision {
  const thresholds = DEFAULT_THRESHOLDS;
  const kbReasons: string[] = [];
  if (!input.buildSummary.publishable) kbReasons.push("build_not_publishable");
  if (input.buildSummary.metrics.cross_build_reference_violation_count > 0) kbReasons.push("cross_build_reference_violation_count_gt_zero");
  if (input.buildSummary.metrics.embedding_missing_rate > 0) kbReasons.push("embedding_missing_rate_gt_zero");

  const retrievalReasons: string[] = [];
  if (input.requireBaselineForBehaviorChanges && !input.baseline?.retrievalSummary) {
    retrievalReasons.push("baseline_missing_for_retrieval_change");
  }
  if (input.retrievalSummary.metrics.retrieval_hit_at_3 === 0) {
    retrievalReasons.push("retrieval_hit_at_3_zero");
  }
  if (input.retrievalSummary.metrics.groundable_candidate_rate === 0) {
    retrievalReasons.push("groundable_candidate_rate_zero");
  }
  if (input.retrievalSummary.metrics.kb_unavailable_false_positive_rate >= 0.5) {
    retrievalReasons.push("kb_unavailable_false_positive_rate_high");
  }
  if (input.retrievalSummary.metrics.publication_scoped_read_rate < 1) {
    retrievalReasons.push("publication_scoped_reads_not_confirmed");
  }
  const baselineRetrieval = input.baseline?.retrievalSummary?.metrics;
  if (baselineRetrieval) {
    if (baselineRetrieval.retrieval_hit_at_3 - input.retrievalSummary.metrics.retrieval_hit_at_3 > thresholds.retrievalHitAt3RegressionTolerance) {
      retrievalReasons.push("retrieval_hit_at_3_regressed");
    }
    if (
      input.retrievalSummary.metrics.wrong_family_top_3_rate - baselineRetrieval.wrong_family_top_3_rate >
      thresholds.wrongFamilyRegressionTolerance
    ) {
      retrievalReasons.push("wrong_family_top_3_rate_regressed");
    }
    if (
      input.retrievalSummary.metrics.kb_unavailable_false_positive_rate - baselineRetrieval.kb_unavailable_false_positive_rate >
      thresholds.kbUnavailableFalsePositiveTolerance
    ) {
      retrievalReasons.push("kb_unavailable_false_positive_rate_regressed");
    }
  }

  const runtimeReasons: string[] = [];
  if (input.requireBaselineForBehaviorChanges && !input.baseline?.runtimeSummary) {
    runtimeReasons.push("baseline_missing_for_runtime_change");
  }
  if (input.runtimeSummary.metrics.stage_contract_violation_count > 0) {
    runtimeReasons.push("stage_contract_violation_count_gt_zero");
  }
  if (input.runtimeSummary.metrics.stage_timeout_rate > 0) {
    runtimeReasons.push("stage_timeout_rate_gt_zero");
  }

  const answerReasons: string[] = [];
  if (input.requireBaselineForBehaviorChanges && !input.baseline?.answerSummary) {
    answerReasons.push("baseline_missing_for_answer_change");
  }
  if (input.answerSummary.metrics.hallucination_rate > 0) {
    answerReasons.push("hallucination_rate_gt_zero");
  }
  if (input.answerSummary.labelCounts.fail > 0) {
    answerReasons.push("golden_answer_failures_present");
  }
  const baselineAnswer = input.baseline?.answerSummary?.metrics;
  if (baselineAnswer) {
    if (baselineAnswer.citation_presence_rate - input.answerSummary.metrics.citation_presence_rate > thresholds.citationPresenceRegressionTolerance) {
      answerReasons.push("citation_presence_rate_regressed");
    }
    if (input.answerSummary.metrics.hallucination_rate - baselineAnswer.hallucination_rate > thresholds.hallucinationRegressionTolerance) {
      answerReasons.push("hallucination_rate_regressed");
    }
  }

  const productionReasons: string[] = [];
  if (input.executionMode === "production") {
    if (!input.shadowValidationStable) productionReasons.push("shadow_validation_not_stable");
    if (!input.rollbackReady) productionReasons.push("rollback_not_ready");
    if (!input.diagnosticsAvailable) productionReasons.push("diagnostics_unavailable");
  }

  const kbBuildGate = buildGate(kbReasons.length === 0, kbReasons);
  const retrievalChangeGate = buildGate(retrievalReasons.length === 0, retrievalReasons);
  const runtimeContractGate = buildGate(runtimeReasons.length === 0, runtimeReasons);
  const answerQualityGate = buildGate(answerReasons.length === 0, answerReasons);
  const productionEnablementGate = buildGate(
    productionReasons.length === 0 && kbBuildGate.passed && retrievalChangeGate.passed && runtimeContractGate.passed && answerQualityGate.passed,
    [
      ...productionReasons,
      ...(!kbBuildGate.passed ? ["kb_build_gate_blocked"] : []),
      ...(!retrievalChangeGate.passed ? ["retrieval_change_gate_blocked"] : []),
      ...(!runtimeContractGate.passed ? ["runtime_contract_gate_blocked"] : []),
      ...(!answerQualityGate.passed ? ["answer_quality_gate_blocked"] : [])
    ]
  );

  const ready =
    kbBuildGate.passed &&
    retrievalChangeGate.passed &&
    runtimeContractGate.passed &&
    answerQualityGate.passed &&
    productionEnablementGate.passed;

  return {
    releaseDecision: ready ? "ready" : "blocked",
    gates: {
      kbBuildGate,
      retrievalChangeGate,
      runtimeContractGate,
      answerQualityGate,
      productionEnablementGate
    }
  };
}
