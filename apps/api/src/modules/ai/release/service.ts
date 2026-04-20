import { env } from "../../../config/env.js";
import { evaluateAcceptanceGates } from "../evals/gates.js";
import type { AnswerEvaluationSummary, BuildValidationEvaluationSummary, EvaluationMode, RetrievalEvaluationSummary, RuntimeEvaluationSummary } from "../evals/types.js";

export interface SupportReleaseFlagSnapshot {
  FEATURE_SUPPORT_AGENT_HYBRID_RETRIEVAL: boolean;
  FEATURE_SUPPORT_AGENT_RUNTIME_TIGHTENING: boolean;
}

export interface SupportShadowObservation {
  requestId: string;
  retrievalStatus: "grounded" | "no_results" | "kb_unavailable";
  route?: string | null;
  specialistFamily?: string | null;
  answerMode?: "grounded" | "partial" | "clarification" | "handoff" | null;
  citationCount: number;
  unresolvedReasonCode?: string | null;
  unsupportedClaimCount: number;
  latencyMs: number;
  stageTrace: Array<{
    stage: string;
    status: "completed" | "fallback" | "skipped";
    durationMs: number;
  }>;
}

export interface ShadowComparisonThresholds {
  immediateKbUnavailableFalsePositiveRate: number;
  immediateCitationDisappearanceRate: number;
  immediateStageFailureRate: number;
  fastRetrievalRegressionRate: number;
  fastAnswerModeMismatchRate: number;
  fastClarificationIncreaseRate: number;
}

export interface RolloutDecisionInput {
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
  verificationSuites?: ReleaseVerificationSuite[];
}

export interface ReleaseVerificationSuite {
  name: string;
  kind: "db_backed" | "offline";
  requiredForRollout: boolean;
  status: "passed" | "failed" | "skipped" | "blocked" | "not_run";
  reason?: string | null;
}

const DEFAULT_SHADOW_THRESHOLDS: ShadowComparisonThresholds = {
  immediateKbUnavailableFalsePositiveRate: 0.1,
  immediateCitationDisappearanceRate: 0.1,
  immediateStageFailureRate: 0.1,
  fastRetrievalRegressionRate: 0.15,
  fastAnswerModeMismatchRate: 0.15,
  fastClarificationIncreaseRate: 0.15
};

function uniqueStrings(values: Array<string | null | undefined>): string[] {
  const seen = new Set<string>();
  const items: string[] = [];
  for (const value of values) {
    const normalized = String(value ?? "").trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    items.push(normalized);
  }
  return items;
}

function countStageFailures(observation: SupportShadowObservation): number {
  return observation.stageTrace.filter((entry) => entry.status !== "completed").length;
}

function resolveThresholds(
  input: Partial<ShadowComparisonThresholds> | undefined
): ShadowComparisonThresholds {
  return {
    immediateKbUnavailableFalsePositiveRate:
      input?.immediateKbUnavailableFalsePositiveRate ?? DEFAULT_SHADOW_THRESHOLDS.immediateKbUnavailableFalsePositiveRate,
    immediateCitationDisappearanceRate:
      input?.immediateCitationDisappearanceRate ?? DEFAULT_SHADOW_THRESHOLDS.immediateCitationDisappearanceRate,
    immediateStageFailureRate: input?.immediateStageFailureRate ?? DEFAULT_SHADOW_THRESHOLDS.immediateStageFailureRate,
    fastRetrievalRegressionRate: input?.fastRetrievalRegressionRate ?? DEFAULT_SHADOW_THRESHOLDS.fastRetrievalRegressionRate,
    fastAnswerModeMismatchRate:
      input?.fastAnswerModeMismatchRate ?? DEFAULT_SHADOW_THRESHOLDS.fastAnswerModeMismatchRate,
    fastClarificationIncreaseRate:
      input?.fastClarificationIncreaseRate ?? DEFAULT_SHADOW_THRESHOLDS.fastClarificationIncreaseRate
  };
}

function safeRate(numerator: number, denominator: number): number {
  return denominator > 0 ? Number((numerator / denominator).toFixed(4)) : 0;
}

export function resolveSupportHybridRetrievalFlag(): boolean {
  // Hybrid retrieval is now the only supported retrieval path. Keep the flag
  // surface for release/rollback compatibility, but do not revive false mode.
  return true;
}

export function getSupportReleaseFlagSnapshot(): SupportReleaseFlagSnapshot {
  return {
    FEATURE_SUPPORT_AGENT_HYBRID_RETRIEVAL: resolveSupportHybridRetrievalFlag(),
    FEATURE_SUPPORT_AGENT_RUNTIME_TIGHTENING: env.FEATURE_SUPPORT_AGENT_RUNTIME_TIGHTENING
  };
}

export function compareShadowObservations(input: {
  baseline: SupportShadowObservation[];
  candidate: SupportShadowObservation[];
  thresholds?: Partial<ShadowComparisonThresholds>;
}) {
  const thresholds = resolveThresholds(input.thresholds);
  const baselineById = new Map<string, SupportShadowObservation>();
  const candidateById = new Map<string, SupportShadowObservation>();

  for (const item of input.baseline) {
    if (baselineById.has(item.requestId)) {
      throw new Error(`Duplicate baseline requestId: ${item.requestId}`);
    }
    baselineById.set(item.requestId, item);
  }
  for (const item of input.candidate) {
    if (candidateById.has(item.requestId)) {
      throw new Error(`Duplicate candidate requestId: ${item.requestId}`);
    }
    candidateById.set(item.requestId, item);
  }

  const matchedRequestIds = Array.from(baselineById.keys()).filter((requestId) => candidateById.has(requestId));
  if (matchedRequestIds.length === 0) {
    throw new Error("Shadow comparison requires at least one matched requestId");
  }

  let retrievalRegressions = 0;
  let citationDisappearances = 0;
  let routeChanges = 0;
  let answerModeChanges = 0;
  let clarificationIncreases = 0;
  let kbUnavailableFalsePositives = 0;
  let stageFailureSpikes = 0;
  let unsupportedClaimSpikes = 0;
  let specialistChanges = 0;
  let slowerResponses = 0;
  let cumulativeLatencyDeltaMs = 0;

  const comparisons = matchedRequestIds.map((requestId) => {
    const baseline = baselineById.get(requestId)!;
    const candidate = candidateById.get(requestId)!;
    const retrievalChanged = baseline.retrievalStatus !== candidate.retrievalStatus;
    const citationDisappeared = baseline.citationCount > 0 && candidate.citationCount === 0;
    const routeChanged = String(baseline.route ?? "") !== String(candidate.route ?? "");
    const answerModeChanged = String(baseline.answerMode ?? "") !== String(candidate.answerMode ?? "");
    const clarificationIncreased =
      baseline.answerMode !== "clarification" && candidate.answerMode === "clarification";
    const kbUnavailableFalsePositive =
      baseline.retrievalStatus !== "kb_unavailable" && candidate.retrievalStatus === "kb_unavailable";
    const stageFailureSpike = countStageFailures(candidate) > countStageFailures(baseline);
    const unsupportedClaimSpike = candidate.unsupportedClaimCount > baseline.unsupportedClaimCount;
    const specialistChanged = String(baseline.specialistFamily ?? "") !== String(candidate.specialistFamily ?? "");
    const latencyDeltaMs = candidate.latencyMs - baseline.latencyMs;
    const slowerResponse = latencyDeltaMs > 0;

    retrievalRegressions += retrievalChanged ? 1 : 0;
    citationDisappearances += citationDisappeared ? 1 : 0;
    routeChanges += routeChanged ? 1 : 0;
    answerModeChanges += answerModeChanged ? 1 : 0;
    clarificationIncreases += clarificationIncreased ? 1 : 0;
    kbUnavailableFalsePositives += kbUnavailableFalsePositive ? 1 : 0;
    stageFailureSpikes += stageFailureSpike ? 1 : 0;
    unsupportedClaimSpikes += unsupportedClaimSpike ? 1 : 0;
    specialistChanges += specialistChanged ? 1 : 0;
    slowerResponses += slowerResponse ? 1 : 0;
    cumulativeLatencyDeltaMs += latencyDeltaMs;

    return {
      requestId,
      retrievalChanged,
      citationDisappeared,
      routeChanged,
      answerModeChanged,
      clarificationIncreased,
      kbUnavailableFalsePositive,
      stageFailureSpike,
      unsupportedClaimSpike,
      specialistChanged,
      latencyDeltaMs,
      baseline,
      candidate
    };
  });

  const matchedTotal = matchedRequestIds.length;
  const metrics = {
    matchedRequestCount: matchedTotal,
    baselineOnlyRequestIds: Array.from(baselineById.keys()).filter((requestId) => !candidateById.has(requestId)),
    candidateOnlyRequestIds: Array.from(candidateById.keys()).filter((requestId) => !baselineById.has(requestId)),
    retrievalRegressionRate: safeRate(retrievalRegressions, matchedTotal),
    citationDisappearanceRate: safeRate(citationDisappearances, matchedTotal),
    routeChangeRate: safeRate(routeChanges, matchedTotal),
    answerModeChangeRate: safeRate(answerModeChanges, matchedTotal),
    clarificationIncreaseRate: safeRate(clarificationIncreases, matchedTotal),
    kbUnavailableFalsePositiveRate: safeRate(kbUnavailableFalsePositives, matchedTotal),
    stageFailureSpikeRate: safeRate(stageFailureSpikes, matchedTotal),
    unsupportedClaimSpikeRate: safeRate(unsupportedClaimSpikes, matchedTotal),
    specialistChangeRate: safeRate(specialistChanges, matchedTotal),
    slowerResponseRate: safeRate(slowerResponses, matchedTotal),
    averageLatencyDeltaMs: Number((cumulativeLatencyDeltaMs / matchedTotal).toFixed(2))
  };

  const immediateTriggers = uniqueStrings([
    metrics.kbUnavailableFalsePositiveRate >= thresholds.immediateKbUnavailableFalsePositiveRate
      ? "kb_unavailable_false_positive_spike"
      : null,
    metrics.citationDisappearanceRate >= thresholds.immediateCitationDisappearanceRate ? "citation_disappearance_spike" : null,
    metrics.stageFailureSpikeRate >= thresholds.immediateStageFailureRate ? "stage_failure_spike" : null
  ]);

  const fastTriggers = uniqueStrings([
    metrics.retrievalRegressionRate >= thresholds.fastRetrievalRegressionRate ? "retrieval_regression_above_threshold" : null,
    metrics.answerModeChangeRate >= thresholds.fastAnswerModeMismatchRate ? "answer_mode_mismatch_spike" : null,
    metrics.clarificationIncreaseRate >= thresholds.fastClarificationIncreaseRate ? "clarification_increase_spike" : null,
    metrics.unsupportedClaimSpikeRate > 0 ? "unsupported_claim_spike" : null,
    metrics.specialistChangeRate > 0 ? "specialist_routing_changed" : null
  ]);

  const rollbackRecommendation =
    immediateTriggers.length > 0
      ? {
          class: "immediate" as const,
          reasonCodes: immediateTriggers,
          summary: "Shadow comparison crossed immediate rollback thresholds."
        }
      : fastTriggers.length > 0
      ? {
          class: "fast" as const,
          reasonCodes: fastTriggers,
          summary: "Shadow comparison indicates measurable regressions that warrant fast rollback readiness."
        }
      : {
          class: "none" as const,
          reasonCodes: [] as string[],
          summary: "Shadow comparison stayed within the configured rollback thresholds."
        };

  return {
    thresholds,
    metrics,
    rollbackRecommendation,
    comparisons
  };
}

export function buildRolloutDecision(input: RolloutDecisionInput) {
  const decision = evaluateAcceptanceGates({
    buildSummary: input.buildSummary,
    retrievalSummary: input.retrievalSummary,
    runtimeSummary: input.runtimeSummary,
    answerSummary: input.answerSummary,
    baseline: input.baseline,
    requireBaselineForBehaviorChanges: input.requireBaselineForBehaviorChanges,
    executionMode: input.executionMode,
    shadowValidationStable: input.shadowValidationStable,
    rollbackReady: input.rollbackReady,
    diagnosticsAvailable: input.diagnosticsAvailable
  });
  const requiredDbBackedSuites = (input.verificationSuites ?? []).filter((suite) => suite.kind === "db_backed" && suite.requiredForRollout);
  const verificationBlockingReasons = uniqueStrings(
    requiredDbBackedSuites.flatMap((suite) => {
      switch (suite.status) {
        case "blocked":
          return ["db_backed_verification_blocked"];
        case "skipped":
          return ["db_backed_verification_skipped"];
        case "not_run":
          return ["db_backed_verification_not_run"];
        case "failed":
          return ["db_backed_verification_failed"];
        default:
          return [];
      }
    })
  );
  const verificationEvidence = {
    dbBacked: {
      status: verificationBlockingReasons.length === 0 ? ("ready" as const) : ("blocked" as const),
      ready: verificationBlockingReasons.length === 0,
      requiredSuiteCount: requiredDbBackedSuites.length,
      suites: requiredDbBackedSuites.map((suite) => ({
        name: suite.name,
        status: suite.status,
        reason: suite.reason ?? null
      }))
    }
  };

  const blockingReasons = uniqueStrings([
    ...decision.gates.kbBuildGate.reasons,
    ...decision.gates.retrievalChangeGate.reasons,
    ...decision.gates.runtimeContractGate.reasons,
    ...decision.gates.answerQualityGate.reasons,
    ...decision.gates.productionEnablementGate.reasons,
    ...verificationBlockingReasons
  ]);
  const releaseDecision = decision.releaseDecision === "ready" && verificationBlockingReasons.length === 0 ? "ready" : "blocked";

  return {
    decision: {
      ...decision,
      releaseDecision,
      gates: {
        ...decision.gates,
        productionEnablementGate: {
          passed: decision.gates.productionEnablementGate.passed && verificationBlockingReasons.length === 0,
          reasons: uniqueStrings([...decision.gates.productionEnablementGate.reasons, ...verificationBlockingReasons])
        }
      }
    },
    blockingReasons,
    verificationEvidence,
    featureFlags: getSupportReleaseFlagSnapshot(),
    recommendation:
      releaseDecision === "ready"
        ? input.executionMode === "production"
          ? "production_rollout_can_proceed"
          : "controlled_rollout_can_proceed"
        : "hold_rollout_and_fix_blockers"
  };
}
