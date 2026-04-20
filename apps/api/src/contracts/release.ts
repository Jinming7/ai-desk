import { z } from "zod";

const kbKnowledgeSpaceSchema = z.enum(["support-prod", "support-preview", "support-local", "support-shadow", "support-eval"]);
const supportAnswerModeSchema = z.enum(["grounded", "partial", "clarification", "handoff"]);
const retrievalStatusSchema = z.enum(["grounded", "no_results", "kb_unavailable"]);
const stageStatusSchema = z.enum(["completed", "fallback", "skipped"]);

export const kbReleaseStatusQuerySchema = z.object({
  repoId: z.string().uuid().optional(),
  branch: z.string().min(1).optional(),
  knowledgeSpace: kbKnowledgeSpaceSchema.optional(),
  includeBuildDetails: z.coerce.boolean().default(false)
});

export const kbPromotionDryRunSchema = z.object({
  buildId: z.string().uuid(),
  actor: z.string().min(1).default("internal_operator"),
  operatorOverride: z.coerce.boolean().default(false),
  targetKnowledgeSpace: kbKnowledgeSpaceSchema.optional(),
  evaluationRecorded: z.coerce.boolean().default(false),
  shadowValidationStable: z.coerce.boolean().default(false),
  rollbackReviewed: z.coerce.boolean().default(false)
});

const rollbackFlagStateSchema = z.object({
  FEATURE_SUPPORT_AGENT_HYBRID_RETRIEVAL: z.boolean(),
  FEATURE_SUPPORT_AGENT_RUNTIME_TIGHTENING: z.boolean()
});

export const kbRollbackRunbookSchema = z.object({
  repoId: z.string().uuid(),
  branch: z.string().min(1),
  knowledgeSpace: kbKnowledgeSpaceSchema,
  actor: z.string().min(1).default("internal_operator"),
  priorFlagState: rollbackFlagStateSchema.optional()
});

const supportStageTraceObservationSchema = z.object({
  stage: z.string().min(1),
  status: stageStatusSchema,
  durationMs: z.coerce.number().int().min(0)
});

const shadowObservationSchema = z.object({
  requestId: z.string().min(1),
  retrievalStatus: retrievalStatusSchema,
  route: z.string().min(1).nullable().optional(),
  specialistFamily: z.string().min(1).nullable().optional(),
  answerMode: supportAnswerModeSchema.nullable().optional(),
  citationCount: z.coerce.number().int().min(0),
  unresolvedReasonCode: z.string().min(1).nullable().optional(),
  unsupportedClaimCount: z.coerce.number().int().min(0).default(0),
  latencyMs: z.coerce.number().int().min(0),
  stageTrace: z.array(supportStageTraceObservationSchema).default([])
});

export const aiShadowComparisonSchema = z.object({
  baseline: z.array(shadowObservationSchema).min(1),
  candidate: z.array(shadowObservationSchema).min(1),
  thresholds: z
    .object({
      immediateKbUnavailableFalsePositiveRate: z.coerce.number().min(0).max(1).default(0.1),
      immediateCitationDisappearanceRate: z.coerce.number().min(0).max(1).default(0.1),
      immediateStageFailureRate: z.coerce.number().min(0).max(1).default(0.1),
      fastRetrievalRegressionRate: z.coerce.number().min(0).max(1).default(0.15),
      fastAnswerModeMismatchRate: z.coerce.number().min(0).max(1).default(0.15),
      fastClarificationIncreaseRate: z.coerce.number().min(0).max(1).default(0.15)
    })
    .default({
      immediateKbUnavailableFalsePositiveRate: 0.1,
      immediateCitationDisappearanceRate: 0.1,
      immediateStageFailureRate: 0.1,
      fastRetrievalRegressionRate: 0.15,
      fastAnswerModeMismatchRate: 0.15,
      fastClarificationIncreaseRate: 0.15
    })
});

const buildSummarySchema = z.object({
  metrics: z.object({
    build_success_rate: z.number(),
    build_validation_pass_rate: z.number(),
    duplicate_active_path_rate: z.number(),
    artifact_count_delta_by_family: z.record(z.string(), z.number()),
    citation_count_delta: z.number(),
    memory_entry_count_delta: z.number(),
    embedding_missing_rate: z.number(),
    cross_build_reference_violation_count: z.number()
  }),
  publishable: z.boolean(),
  failures: z.array(z.string())
});

const retrievalSummarySchema = z.object({
  metrics: z.object({
    retrieval_hit_at_1: z.number(),
    retrieval_hit_at_3: z.number(),
    retrieval_hit_at_5: z.number(),
    retrieval_hit_at_10: z.number(),
    family_hit_at_3: z.number(),
    exact_signal_capture_rate: z.number(),
    wrong_family_top_3_rate: z.number(),
    groundable_candidate_rate: z.number(),
    kb_unavailable_false_positive_rate: z.number(),
    publication_scoped_read_rate: z.number()
  }),
  scoreCounts: z.record(z.string(), z.number()),
  failures: z.array(z.string())
});

const runtimeSummarySchema = z.object({
  metrics: z.object({
    route_accuracy: z.number(),
    specialist_selection_accuracy: z.number(),
    clarification_precision: z.number(),
    clarification_recall: z.number(),
    stage_timeout_rate: z.number(),
    stage_fallback_rate: z.number(),
    stage_contract_violation_count: z.number(),
    verification_overturn_rate: z.number()
  }),
  failures: z.array(z.string())
});

const answerSummarySchema = z.object({
  metrics: z.object({
    answer_mode_accuracy: z.number(),
    direct_answer_correctness: z.number(),
    customer_actionability_score: z.number(),
    citation_presence_rate: z.number(),
    hallucination_rate: z.number(),
    handoff_appropriateness: z.number(),
    minimum_missing_info_quality: z.number()
  }),
  labelCounts: z.object({
    pass: z.number(),
    pass_with_minor_issue: z.number(),
    needs_improvement: z.number(),
    fail: z.number()
  }),
  failures: z.array(z.string())
});

export const aiReleaseDecisionSchema = z.object({
  buildSummary: buildSummarySchema,
  retrievalSummary: retrievalSummarySchema,
  runtimeSummary: runtimeSummarySchema,
  answerSummary: answerSummarySchema,
  baseline: z
    .object({
      retrievalSummary: retrievalSummarySchema.optional(),
      runtimeSummary: runtimeSummarySchema.optional(),
      answerSummary: answerSummarySchema.optional()
    })
    .optional(),
  requireBaselineForBehaviorChanges: z.coerce.boolean().default(true),
  executionMode: z.enum(["fast_local", "isolated_db", "shared_db_shadow", "production"]),
  shadowValidationStable: z.coerce.boolean().default(false),
  rollbackReady: z.coerce.boolean().default(false),
  diagnosticsAvailable: z.coerce.boolean().default(false),
  verificationSuites: z
    .array(
      z.object({
        name: z.string().min(1),
        kind: z.enum(["db_backed", "offline"]),
        requiredForRollout: z.coerce.boolean().default(true),
        status: z.enum(["passed", "failed", "skipped", "blocked", "not_run"]),
        reason: z.string().min(1).nullable().optional()
      })
    )
    .optional()
});
