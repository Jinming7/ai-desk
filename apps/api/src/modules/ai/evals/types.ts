import { z } from "zod";
import type { SupportAgentStageTraceEntry, SupportVerificationResult } from "../types.js";
import type { KbBuildStatus, KbKnowledgeSpace, KbSourceFamily } from "../../github-kb/types.js";

export type EvaluationMode = "fast_local" | "isolated_db" | "shared_db_shadow" | "production";
export type SupportedAnswerType = "api" | "how_to" | "behavior" | "troubleshooting" | "clarification" | "handoff";
export type RetrievalScoreLabel =
  | "exact_top_3"
  | "acceptable_family_top_3"
  | "low_credit_late_hit"
  | "wrong_family_penalty"
  | "no_useful_candidate";
export type AnswerRubricLabel = "pass" | "pass_with_minor_issue" | "needs_improvement" | "fail";

export const conversationTurnSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string().trim().min(1)
});

export const retrievalSeedCaseSchema = z.object({
  id: z.string().trim().min(1),
  query: z.string().trim().min(1),
  answerLanguage: z.enum(["zh", "en"]).default("en"),
  conversation: z.array(conversationTurnSchema).default([]),
  expectedPrimaryFamily: z.string().trim().min(1),
  acceptableArtifactIds: z.array(z.string().trim().min(1)).default([]),
  acceptablePaths: z.array(z.string().trim().min(1)).default([]),
  acceptableCitationTargets: z.array(z.string().trim().min(1)).default([]),
  expectedExactSignals: z.array(z.string().trim().min(1)).default([]),
  forbiddenFamilies: z.array(z.string().trim().min(1)).default([]),
  requireGroundableCandidate: z.boolean().default(true),
  expectKbUnavailable: z.boolean().default(false)
});

export const runtimeScenarioCaseSchema = z.object({
  id: z.string().trim().min(1),
  query: z.string().trim().min(1),
  answerLanguage: z.enum(["zh", "en"]).default("en"),
  conversation: z.array(conversationTurnSchema).default([]),
  expectedRoute: z.string().trim().min(1).optional(),
  expectedSpecialistFamily: z.string().trim().min(1).optional(),
  expectClarification: z.boolean().optional(),
  expectedAnswerMode: z.enum(["grounded", "partial", "clarification", "handoff"]).optional(),
  requiredStages: z
    .array(
      z.enum([
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
      ])
    )
    .default([]),
  forbiddenStages: z
    .array(
      z.enum([
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
      ])
    )
    .default([]),
  allowedFallbackStages: z
    .array(
      z.enum([
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
      ])
    )
    .default([])
});

export const answerGoldenCaseSchema = z.object({
  id: z.string().trim().min(1),
  query: z.string().trim().min(1),
  answerLanguage: z.enum(["zh", "en"]).default("en"),
  conversation: z.array(conversationTurnSchema).default([]),
  expectedAnswerType: z.enum(["api", "how_to", "behavior", "troubleshooting", "clarification", "handoff"]),
  requiredClaims: z.array(z.string().trim().min(1)).default([]),
  minimumNextSteps: z.array(z.string().trim().min(1)).default([]),
  minimumCitationCount: z.number().int().min(0).default(0),
  requiredCitationTargets: z.array(z.string().trim().min(1)).default([]),
  forbiddenHallucinations: z.array(z.string().trim().min(1)).default([]),
  requireDirectAnswer: z.boolean().default(true),
  maximumStillNeedToConfirm: z.number().int().min(0).default(2)
});

export const regressionReplayCaseSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("retrieval"),
    case: retrievalSeedCaseSchema
  }),
  z.object({
    kind: z.literal("runtime"),
    case: runtimeScenarioCaseSchema
  }),
  z.object({
    kind: z.literal("answer"),
    case: answerGoldenCaseSchema
  })
]);

export const buildValidationFixtureCaseSchema = z.object({
  id: z.string().trim().min(1),
  knowledgeSpace: z.enum(["support-prod", "support-preview", "support-local", "support-shadow", "support-eval"]),
  repoId: z.string().trim().min(1),
  branch: z.string().trim().min(1),
  buildVersion: z.string().trim().min(1),
  buildStatus: z.enum(["building", "built", "validated", "published", "failed", "abandoned", "superseded"]),
  buildSuccess: z.boolean(),
  validationPassed: z.boolean(),
  duplicateActivePathCount: z.number().int().min(0),
  artifactCountsByFamily: z.record(z.string(), z.number().min(0)),
  citationCount: z.number().min(0),
  memoryEntryCount: z.number().min(0),
  crossBuildReferenceViolationCount: z.number().int().min(0),
  embeddingEnabledFamilies: z.array(z.string().trim().min(1)).default([]),
  missingEmbeddingCount: z.number().int().min(0).default(0),
  previousArtifactCountsByFamily: z.record(z.string(), z.number().min(0)).default({}),
  previousCitationCount: z.number().min(0).optional(),
  previousMemoryEntryCount: z.number().min(0).optional()
});

export const datasetEnvelopeSchemas = {
  retrieval: z.object({
    version: z.string().trim().min(1).default("unversioned"),
    cases: z.array(retrievalSeedCaseSchema)
  }),
  runtime: z.object({
    version: z.string().trim().min(1).default("unversioned"),
    cases: z.array(runtimeScenarioCaseSchema)
  }),
  answer: z.object({
    version: z.string().trim().min(1).default("unversioned"),
    cases: z.array(answerGoldenCaseSchema)
  }),
  regression: z.object({
    version: z.string().trim().min(1).default("unversioned"),
    cases: z.array(regressionReplayCaseSchema)
  }),
  build: z.object({
    version: z.string().trim().min(1).default("unversioned"),
    cases: z.array(buildValidationFixtureCaseSchema)
  })
} as const;

export type RetrievalSeedCase = z.infer<typeof retrievalSeedCaseSchema>;
export type RuntimeScenarioCase = z.infer<typeof runtimeScenarioCaseSchema>;
export type AnswerGoldenCase = z.infer<typeof answerGoldenCaseSchema>;
export type RegressionReplayCase = z.infer<typeof regressionReplayCaseSchema>;
export type BuildValidationFixtureCase = z.infer<typeof buildValidationFixtureCaseSchema>;

export type DatasetEnvelope<TCase> = {
  version: string;
  cases: TCase[];
};

export interface EvaluatedRetrievalCandidate {
  artifactId?: string;
  path?: string;
  citationTarget?: string;
  family: string;
  groundable: boolean;
  exactSignalMatches: string[];
}

export interface RetrievalObservation {
  retrievalStatus: "grounded" | "no_results" | "kb_unavailable";
  publicationScopedRead: boolean;
  resolvedQueries: string[];
  candidates: EvaluatedRetrievalCandidate[];
}

export interface RetrievalCaseScore {
  datasetCase: RetrievalSeedCase;
  observed: RetrievalObservation;
  scoreLabel: RetrievalScoreLabel;
  exactHitRank: number | null;
  familyHitRank: number | null;
  wrongFamilyOverRanking: boolean;
  exactSignalCaptured: boolean;
  groundableCandidateAvailable: boolean;
  kbUnavailableFalsePositive: boolean;
  publicationScopedRead: boolean;
  failures: string[];
}

export interface RetrievalEvaluationSummary {
  metrics: {
    retrieval_hit_at_1: number;
    retrieval_hit_at_3: number;
    retrieval_hit_at_5: number;
    retrieval_hit_at_10: number;
    family_hit_at_3: number;
    exact_signal_capture_rate: number;
    wrong_family_top_3_rate: number;
    groundable_candidate_rate: number;
    kb_unavailable_false_positive_rate: number;
    publication_scoped_read_rate: number;
  };
  scoreCounts: Record<RetrievalScoreLabel, number>;
  failures: string[];
}

export interface RuntimeObservation {
  route?: string;
  specialistFamily?: string | null;
  answerMode?: "grounded" | "partial" | "clarification" | "handoff";
  clarificationNeeded: boolean;
  stageTrace: SupportAgentStageTraceEntry[];
  verificationVerdict?: SupportVerificationResult["verdict"];
  timeoutStages: string[];
  explicitFallbacks: string[];
}

export interface RuntimeCaseScore {
  datasetCase: RuntimeScenarioCase;
  observed: RuntimeObservation;
  routeCorrect: boolean;
  specialistCorrect: boolean;
  clarificationCorrect: boolean;
  answerModeCorrect: boolean;
  contractViolations: string[];
  fallbackViolations: string[];
  verificationOverturned: boolean;
}

export interface RuntimeEvaluationSummary {
  metrics: {
    route_accuracy: number;
    specialist_selection_accuracy: number;
    clarification_precision: number;
    clarification_recall: number;
    stage_timeout_rate: number;
    stage_fallback_rate: number;
    stage_contract_violation_count: number;
    verification_overturn_rate: number;
  };
  failures: string[];
}

export interface AnswerCitationObservation {
  id: string;
  title: string;
  source_url: string;
}

export interface AnswerObservation {
  answerMode?: "grounded" | "partial" | "clarification" | "handoff";
  answerType?: SupportedAnswerType | string | null;
  directAnswer: string;
  fullAnswerText: string;
  whatToDoNow: string[];
  stillNeedToConfirm: string[];
  citations: AnswerCitationObservation[];
  verificationVerdict?: SupportVerificationResult["verdict"];
  unsupportedClaims: string[];
}

export interface AnswerCaseScore {
  datasetCase: AnswerGoldenCase;
  observed: AnswerObservation;
  label: AnswerRubricLabel;
  failures: string[];
  actionabilityScore: number;
  citationSatisfied: boolean;
  hallucinationDetected: boolean;
}

export interface AnswerEvaluationSummary {
  metrics: {
    answer_mode_accuracy: number;
    direct_answer_correctness: number;
    customer_actionability_score: number;
    citation_presence_rate: number;
    hallucination_rate: number;
    handoff_appropriateness: number;
    minimum_missing_info_quality: number;
  };
  labelCounts: Record<AnswerRubricLabel, number>;
  failures: string[];
}

export interface BuildValidationFixtureScore {
  datasetCase: BuildValidationFixtureCase;
  duplicateActivePathRate: number;
  artifactCountDeltaByFamily: Record<string, number>;
  citationCountDelta: number;
  memoryEntryCountDelta: number;
  embeddingMissingRate: number;
  crossBuildReferenceViolationCount: number;
  publishable: boolean;
  failures: string[];
}

export interface BuildValidationEvaluationSummary {
  metrics: {
    build_success_rate: number;
    build_validation_pass_rate: number;
    duplicate_active_path_rate: number;
    artifact_count_delta_by_family: Record<string, number>;
    citation_count_delta: number;
    memory_entry_count_delta: number;
    embedding_missing_rate: number;
    cross_build_reference_violation_count: number;
  };
  publishable: boolean;
  failures: string[];
}

export type SourceFamilyMetricKey = KbSourceFamily | string;
export type BuildFixtureStatus = KbBuildStatus;
export type BuildFixtureKnowledgeSpace = KbKnowledgeSpace;
