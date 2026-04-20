import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { env } from "../../config/env.js";
import type {
  OpenClawAdapter,
  OpenClawAnalyzeOutput,
  OpenClawRuntimeContext,
  OpenClawSupportDispatchOutput
} from "../../infrastructure/openclaw/types.js";
import type {
  DraftSupportAnswer,
  SearchDialogState,
  SearchModeResult,
  SpecialistDraftAnswer,
  StructuredSearchAnswer,
  SupportAnswer,
  SupportAgentStageTiming,
  SupportAgentStageTraceEntry,
  SupportAgentStageTimings,
  SupportCaseFrame,
  SupportDomain,
  SupportEvidenceBundle,
  SupportEvidencePlan,
  SupportEvidenceSelection,
  SupportQuestionRoute,
  SupportVerificationResult,
  TriageSupportInsight
} from "./types.js";
import {
  resolveSupportExecutionPlan,
  type PlannerStageResult
} from "./support-execution-plan.js";
import { canonicalizeSupportDomain, resolveSupportDomainRegistryEntry } from "./support-contracts.js";
import { resolveSupportRuntimePolicy } from "./support-runtime-policy.js";
import { filterSupportEvidenceByPolicy, getSupportEvidenceProfile, matchesSupportEvidencePolicy } from "./support-evidence-policy.js";
import { fetchWithNodeCompat } from "../../utils/fetch-compat.js";
import { resolveSearchReferenceEvidenceId, type SearchReference } from "./types.js";
import { SearchOrchestrator } from "./search-orchestrator.js";
import { resolveStageSpecificAgent } from "./agent-router.js";

function uniqueStrings(input: Array<string | undefined | null>, limit = 6): string[] {
  const seen = new Set<string>();
  const values: string[] = [];
  for (const item of input) {
    const value = String(item ?? "").trim();
    if (!value || seen.has(value)) continue;
    seen.add(value);
    values.push(value);
    if (values.length >= limit) break;
  }
  return values;
}

function isPlaceholderSupportRetrievalSeed(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return normalized === "unspecified" || normalized === "unknown" || normalized === "general" || normalized === "shared";
}

function sanitizeSupportRetrievalSeeds(input: Array<string | undefined | null>, limit = 6): string[] {
  return uniqueStrings(input, limit).filter((item) => !isPlaceholderSupportRetrievalSeed(item));
}

function isGenericApiPlaceholderSeed(value: string): boolean {
  const normalized = value.trim().toLowerCase().replace(/\s+/g, " ");
  return normalized === "api" || normalized === "openapi" || normalized === "open api";
}

function stripGenericApiPlaceholderSeeds(input: Array<string | undefined | null>, limit = 6): string[] {
  return sanitizeSupportRetrievalSeeds(input, limit).filter((item) => !isGenericApiPlaceholderSeed(item));
}

function stripApiSpecificDocKinds(input: Array<string | undefined | null>, limit = 6): string[] {
  return uniqueStrings(input, limit).filter((item) => item !== "openapi/api" && item !== "permissions");
}

function shouldStripGenericApiRetrievalNoise(caseFrame: Pick<
  SupportCaseFrame,
  "product_area" | "deployment_model" | "specialist_agent" | "question_type" | "action_type"
>): boolean {
  return (
    caseFrame.product_area === "deployment" &&
    caseFrame.deployment_model === "private_deployment" &&
    (caseFrame.action_type === "how_to" ||
      caseFrame.action_type === "troubleshooting" ||
      caseFrame.question_type === "how_to_product" ||
      caseFrame.question_type === "config_setup")
  );
}

function sanitizeRetrievalSeedsForCaseFrame(
  input: Array<string | undefined | null>,
  caseFrame: Pick<SupportCaseFrame, "product_area" | "deployment_model" | "specialist_agent" | "question_type" | "action_type">,
  limit = 6
): string[] {
  return shouldStripGenericApiRetrievalNoise(caseFrame)
    ? stripGenericApiPlaceholderSeeds(input, limit)
    : sanitizeSupportRetrievalSeeds(input, limit);
}

function normalizeSupportLookup(value: string): string {
  return String(value ?? "").trim().toLowerCase();
}

function expandSupportAreaAliases(value: string): string[] {
  const normalized = normalizeSupportLookup(value);
  if (!normalized) return [];
  const aliases = new Set<string>([normalized]);
  if (normalized === "integration") aliases.add("integrations");
  if (normalized.startsWith("deployment")) aliases.add("deployment");
  if (normalized === "project_management" || normalized === "wiki" || normalized === "general") aliases.add("general");
  return [...aliases];
}

function preferredEvidenceKindsForQuestionType(questionType: SupportQuestionRoute["question_type"] | undefined): string[] {
  switch (questionType) {
    case "api_endpoint_lookup":
    case "api_field_lookup":
      return ["api_operation", "constraint", "capability"];
    case "api_scope_auth":
      return ["api_operation", "constraint", "capability", "procedure"];
    case "how_to_product":
    case "config_setup":
    case "data_export_reporting":
      return ["procedure", "troubleshooting", "constraint", "capability"];
    case "troubleshooting":
      return ["troubleshooting", "procedure", "constraint", "capability"];
    case "why_behavior":
    case "capability_confirmation":
      return ["constraint", "capability", "procedure", "troubleshooting"];
    default:
      return ["capability", "constraint", "procedure", "troubleshooting"];
  }
}

function evidenceKindPreferenceScore(kind: string, questionType: SupportQuestionRoute["question_type"] | undefined): number {
  const preferred = preferredEvidenceKindsForQuestionType(questionType);
  const index = preferred.indexOf(normalizeSupportLookup(kind));
  return index < 0 ? 0 : Math.max(0, preferred.length - index) * 8;
}

function collectStructuredSupportTerms(input: Array<string | undefined | null>, limit = 18): string[] {
  const source = input
    .map((item) => String(item ?? "").trim())
    .filter(Boolean)
    .join(" ");
  const urls = [...source.matchAll(/https?:\/\/[^\s`"')]+/gi)].map((match) => match[0]);
  const paths = [...source.matchAll(/\/[a-z0-9{}._/-]{3,}/gi)].map((match) => match[0]);
  const scopes = [...source.matchAll(/\b(?:read|write|manage|admin):[a-z0-9:_-]+\b/gi)].map((match) => match[0]);
  const configKeys = [...source.matchAll(/\b[a-z][a-z0-9]+(?:[._-][a-z0-9]+)+\b/g)].map((match) => match[0]);
  const camelTokens = [...source.matchAll(/\b[a-z]+(?:[A-Z][a-z0-9]+){1,}\b/g)].map((match) => match[0]);
  const upperCodes = [...source.matchAll(/\b[A-Z_]{3,}\b/g)].map((match) => match[0]);
  const cjkTerms = [...source.matchAll(/[\u4e00-\u9fff]{2,}/g)].map((match) => match[0]);
  return uniqueStrings([...urls, ...paths, ...scopes, ...configKeys, ...camelTokens, ...upperCodes, ...cjkTerms], limit);
}

function getSupportReferenceSourceFamilies(reference: SearchReference): string[] {
  const metadata = mergeSupportReferenceMetadata(reference) ?? {};
  return uniqueStrings(
    [
      String(metadata.source_family ?? ""),
      String(metadata.retrieval_unit_family ?? ""),
      String(metadata.artifact_family ?? ""),
      String(metadata.object_family ?? "")
    ],
    6
  ).map((item) => normalizeSupportLookup(item));
}

function scoreContractDrivenReference(input: {
  reference: SearchReference;
  query: string;
  caseFrame: SupportCaseFrame;
  primaryDomain: SupportDomain;
}): number {
  const domainEntry = resolveSupportDomainRegistryEntry(input.primaryDomain);
  const profile = getSupportEvidenceProfile(input.reference);
  const referenceProductAreas = new Set(expandSupportAreaAliases(profile.productArea));
  const domainProductAreas = new Set(domainEntry.owned_product_areas.flatMap((item) => expandSupportAreaAliases(item)));
  const sourceFamilies = getSupportReferenceSourceFamilies(input.reference);
  const caseProductAreas = new Set(expandSupportAreaAliases(String(input.caseFrame.product_area ?? "")));

  let score = Math.round(input.reference.score * 100);

  if (input.reference.authority === "canonical_visible") score += 14;
  if (input.reference.sourceType === "github_kb" || input.reference.sourceType === "local_docs") score += 8;
  if ([...referenceProductAreas].some((item) => domainProductAreas.has(item))) score += 26;
  if (domainEntry.preferred_doc_kinds.includes(profile.docKind)) score += 18;
  if ((input.caseFrame.required_doc_kinds ?? []).includes(profile.docKind)) score += 24;
  if (sourceFamilies.some((item) => domainEntry.owned_source_families.includes(item))) score += 18;
  score += evidenceKindPreferenceScore(profile.evidenceKind, input.caseFrame.question_type);
  if ([...referenceProductAreas].some((item) => caseProductAreas.has(item))) score += 14;
  if (
    normalizeSupportLookup(input.caseFrame.deployment_model) &&
    profile.deploymentModel &&
    normalizeSupportLookup(input.caseFrame.deployment_model) === normalizeSupportLookup(profile.deploymentModel)
  ) {
    score += 12;
  }
  if (input.caseFrame.question_type === "api_scope_auth" && profile.permissions.length > 0) score += 18;
  if (String(input.caseFrame.question_type ?? "").startsWith("api_")) {
    if (profile.productArea === "openapi") score += 12;
    else if (profile.productArea) score -= 8;
  }

  return score;
}

function localizedSectionTitle(language: "zh" | "en", zh: string, en: string): string {
  return language === "zh" ? zh : en;
}

function isLowSignalMissingInfo(item: string): boolean {
  const normalized = item.trim().toLowerCase();
  return (
    normalized === "the exact object or scenario you are working with" ||
    normalized === "the single most important missing detail" ||
    normalized === "more context" ||
    normalized === "more details"
  );
}

function sanitizeMissingCriticalInfo(input: Array<string | undefined | null>, limit = 3): string[] {
  return uniqueStrings(input, limit).filter((item) => !isLowSignalMissingInfo(item));
}

function elapsedMs(startedAt: number): number {
  return Math.max(0, Math.round(performance.now() - startedAt));
}

function supportStageErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error ?? "unknown error");
}

function stageTiming(
  status: SupportAgentStageTiming["status"],
  durationMs: number,
  extra: Partial<SupportAgentStageTiming> = {}
): SupportAgentStageTiming {
  return {
    duration_ms: durationMs,
    status,
    ...extra
  };
}

function skippedStageTiming(): SupportAgentStageTiming {
  return { duration_ms: 0, status: "skipped" };
}

function mergeStageTimings(timings: SupportAgentStageTiming[]): SupportAgentStageTiming {
  if (timings.length === 0) {
    return skippedStageTiming();
  }
  const duration_ms = timings.reduce((sum, item) => sum + item.duration_ms, 0);
  const status: SupportAgentStageTiming["status"] = timings.some((item) => item.status === "fallback")
    ? "fallback"
    : timings.every((item) => item.status === "skipped")
    ? "skipped"
    : "completed";
  const query_count = timings.reduce((sum, item) => sum + (item.query_count ?? 0), 0);
  const reference_count = timings.reduce((sum, item) => sum + (item.reference_count ?? 0), 0);
  return {
    duration_ms,
    status,
    ...(query_count > 0 ? { query_count } : {}),
    ...(reference_count > 0 ? { reference_count } : {})
  };
}

function stageTraceEntry(input: {
  stage: SupportAgentStageTraceEntry["stage"];
  timing: SupportAgentStageTiming;
  runtimeStage?: NonNullable<OpenClawRuntimeContext["stage"]>;
  idempotencyKey?: string;
}): SupportAgentStageTraceEntry {
  const resolved = input.runtimeStage ? resolveStageSpecificAgent(input.runtimeStage) : null;
  return {
    stage: input.stage,
    status: input.timing.status,
    duration_ms: input.timing.duration_ms,
    agent_id: resolved?.agentId,
    model: resolved?.model ?? null,
    idempotency_key: input.idempotencyKey,
    query_count: input.timing.query_count,
    reference_count: input.timing.reference_count
  };
}

function remainingBudgetMs(runtime?: OpenClawRuntimeContext): number | null {
  const startedAt = runtime?.requestStartedAtMs;
  const overallTimeoutMs = runtime?.overallTimeoutMs;
  if (!startedAt || !overallTimeoutMs) return null;
  return Math.max(0, overallTimeoutMs - (Date.now() - startedAt));
}

function hasEnoughBudget(runtime: OpenClawRuntimeContext | undefined, minimumMs: number): boolean {
  const remaining = remainingBudgetMs(runtime);
  return remaining === null || remaining >= minimumMs;
}

function buildStageRuntime(
  runtime: OpenClawRuntimeContext | undefined,
  reserveMs: number,
  minimumTimeoutMs = 3000,
  stageTimeoutMs = 12000
): OpenClawRuntimeContext | undefined {
  if (!runtime) {
    return {
      timeoutMs: stageTimeoutMs
    };
  }
  const remaining = remainingBudgetMs(runtime);
  if (remaining === null) {
    return {
      ...runtime,
      timeoutMs: stageTimeoutMs
    };
  }
  const timeoutMs = Math.max(minimumTimeoutMs, Math.min(stageTimeoutMs, remaining - reserveMs));
  return {
    ...runtime,
    timeoutMs
  };
}

type StageRuntimeBudget = {
  reserveMs: number;
  minimumTimeoutMs: number;
  stageTimeoutMs: number;
};

function buildDeliveryAwareStageRuntime(
  runtime: OpenClawRuntimeContext | undefined,
  interactive: StageRuntimeBudget,
  asyncJob: StageRuntimeBudget = interactive
): OpenClawRuntimeContext | undefined {
  const selected = runtime?.deliveryMode === "async_job" ? asyncJob : interactive;
  return buildStageRuntime(runtime, selected.reserveMs, selected.minimumTimeoutMs, selected.stageTimeoutMs);
}

function sanitizeSessionPart(input: string): string {
  return input.replace(/[^a-zA-Z0-9:_-]/g, "_").slice(0, 120);
}

function withStageRuntime(
  runtime: OpenClawRuntimeContext | undefined,
  stage: NonNullable<OpenClawRuntimeContext["stage"]>,
  sessionSeed: string
): OpenClawRuntimeContext | undefined {
  const prefix = env.OPENCLAW_AGENT_SESSION_PREFIX.trim() || "nf";
  const base = runtime ?? {};
  const { agentId, model } = resolveStageSpecificAgent(stage, base);
  return {
    ...base,
    stage,
    agentId,
    model,
    sessionKey: `agent:${agentId}:${sanitizeSessionPart(`${prefix}:${stage}:${sessionSeed}`)}`
  };
}

type SupportQuerySignals = {
  apiContext: boolean;
  integrationContext: boolean;
  privateDeploymentContext: boolean;
  infrastructureContext: boolean;
  deploymentArchitectureContext: boolean;
  isolationContext: boolean;
  accountRecoveryContext: boolean;
  mailDependencyContext: boolean;
  troubleshootingContext: boolean;
  wantsProcedure: boolean;
};

function resolveDispatchPrimaryDomain(
  value: unknown,
  caseFrame?: Pick<SupportCaseFrame, "primary_domain" | "product_area">
): SupportDomain {
  return (
    canonicalizeSupportDomain(value) ??
    canonicalizeSupportDomain(caseFrame?.primary_domain) ??
    canonicalizeSupportDomain(caseFrame?.product_area) ??
    "product"
  );
}


function hasCjkText(input: string): boolean {
  return /[\u3400-\u9FBF]/.test(input);
}

function analyzeSupportQuerySignals(query: string): SupportQuerySignals {
  void query;
  return {
    apiContext: false,
    integrationContext: false,
    privateDeploymentContext: false,
    infrastructureContext: false,
    deploymentArchitectureContext: false,
    isolationContext: false,
    accountRecoveryContext: false,
    mailDependencyContext: false,
    troubleshootingContext: false,
    wantsProcedure: false
  };
}

function localizedSupportLabel(query: string, zh: string, en: string): string {
  return hasCjkText(query) ? zh : en;
}

function isImplicitApiOperationQuery(query: string): boolean {
  const lowered = query.toLowerCase();
  const hasOperation =
    /(create|add|new|update|modify|change|set|delete|remove|get|fetch|read|list|query|search|execute|trigger)/i.test(query) ||
    /创建|新增|新建|更新|修改|变更|设置|删除|移除|获取|查询|列表|执行|触发/.test(query);
  const hasApiResource =
    /\b(issue|issues|comment|comments|project|projects|field|fields|status|statuses|workflow|wiki|space|page)\b/i.test(query) ||
    /工作项|评论|项目|字段|属性|状态|工作流|页面|知识库/.test(query);
  const hasApiSurfaceCue =
    /\b(assignee|owner|uuid|identifier|payload|request body|response field|response schema|field values?|issueid|teamid|issuetypeid|query param|path param|request param)\b/i.test(
      lowered
    ) ||
    /请求体|响应字段|响应结构|字段值|uuid|标识符|路径参数|查询参数|请求参数/.test(query);

  return hasOperation && hasApiResource && hasApiSurfaceCue;
}

function isApiShapedQuery(query: string): boolean {
  const explicitApiSurface =
    /\b(api|openapi|endpoint|path|method|scope)\b/i.test(query) || /接口|开放平台|接口路径|请求路径|方法|作用域/.test(query);
  const authSurfaceWithApiContext =
    (/\b(oauth|token)\b/i.test(query) || /鉴权|令牌|访问令牌/.test(query)) &&
    (/\b(api|openapi|endpoint|scope|permission|request|response)\b/i.test(query) ||
      /接口|开放平台|作用域|权限|请求|响应/.test(query) ||
      isImplicitApiOperationQuery(query));
  return (
    explicitApiSurface ||
    authSurfaceWithApiContext ||
    isImplicitApiOperationQuery(query)
  );
}

function normalizeRequiredDocKindsForCaseFrame(
  query: string,
  caseFrame: SupportCaseFrame,
  signals: SupportQuerySignals
): string[] {
  void query;
  void signals;
  return uniqueStrings(caseFrame.required_doc_kinds ?? [], 6);
}

function fallbackQuestionRoute(query: string): SupportQuestionRoute {
  const normalized = query.trim();
  return {
    question_type: "capability_confirmation",
    user_goal: normalized,
    answer_contract: "Give the best grounded answer first, then minimum missing info.",
    specialist_agent: "behavior-specialist",
    routing_confidence: 0.2,
    specialist_budget: 1,
    primary_domain: "product"
  };
}

async function resolveAiFallbackSupportDispatch(input: {
  query: string;
  language: "zh" | "en";
  contextType: "search" | "triage";
  conversationHistory: Array<{ role: "user" | "assistant"; content: string }>;
  adapter: OpenClawAdapter;
  runtime?: OpenClawRuntimeContext;
  idempotencyKey: string;
}): Promise<OpenClawSupportDispatchOutput> {
  let route: SupportQuestionRoute;
  try {
    const routerRuntime = withStageRuntime(
      buildDeliveryAwareStageRuntime(
        input.runtime,
        {
          reserveMs: 8_000,
          minimumTimeoutMs: 5_000,
          stageTimeoutMs: 10_000
        },
        {
          reserveMs: 16_000,
          minimumTimeoutMs: 8_000,
          stageTimeoutMs: 20_000
        }
      ),
      "router",
      `${input.idempotencyKey}:support-dispatch-router-fallback`
    );
    route = await input.adapter.routeSupportQuestion(
      {
        contextType: input.contextType,
        language: input.language,
        query: input.query,
        conversationHistory: input.conversationHistory
      },
      `${input.idempotencyKey}:support-dispatch-router-fallback`,
      routerRuntime
    );
  } catch (error) {
    console.warn("[support-runtime] supervisor dispatch router fallback", {
      query: input.query.slice(0, 160),
      error: supportStageErrorMessage(error)
    });
    throw new Error("support dispatch unavailable: router stage failed");
  }

  let evidencePlanResult: PlannerStageResult<SupportEvidencePlan> = { status: "fallback" };
  if (input.adapter.planSupportEvidence && hasEnoughBudget(input.runtime, 8_000)) {
    const evidencePlannerRuntime = withStageRuntime(
      buildDeliveryAwareStageRuntime(
        input.runtime,
        {
          reserveMs: 6_000,
          minimumTimeoutMs: 4_000,
          stageTimeoutMs: 8_000
        },
        {
          reserveMs: 12_000,
          minimumTimeoutMs: 8_000,
          stageTimeoutMs: 18_000
        }
      ),
      "evidence-planner",
      `${input.idempotencyKey}:support-dispatch-evidence-fallback`
    );
    evidencePlanResult = await input.adapter
      .planSupportEvidence(
        {
          contextType: input.contextType,
          language: input.language,
          query: input.query,
          route,
          conversationHistory: input.conversationHistory
        },
        `${input.idempotencyKey}:support-dispatch-evidence-fallback`,
        evidencePlannerRuntime
      )
      .then((value) => ({
        status: "completed" as const,
        value
      }))
      .catch((error) => {
        console.warn("[support-runtime] supervisor dispatch evidence fallback", {
          query: input.query.slice(0, 160),
          error: supportStageErrorMessage(error)
        });
        return { status: "fallback" as const };
      });
  }

  const executionPlan = resolveSupportExecutionPlan({
    query: input.query,
    routeResult: {
      status: "completed",
      value: route
    },
    evidencePlanResult,
    casePlanResult: {
      status: "fallback"
    }
  });
  const caseFrame = mergeRouteAndEvidencePlan(executionPlan.caseFrame, executionPlan.route, executionPlan.evidencePlan);
  const primaryDomain = resolveDispatchPrimaryDomain(executionPlan.route.primary_domain, caseFrame);
  const retrievalQueries = sanitizeSupportRetrievalSeeds(
    [
      ...executionPlan.retrievalPlan.baseQueries,
      ...(executionPlan.evidencePlan.query_plan?.concept_queries ?? []),
      ...(executionPlan.evidencePlan.query_plan?.object_queries ?? []),
      ...(executionPlan.evidencePlan.query_plan?.behavior_queries ?? [])
    ],
    8
  );

  return {
    primaryDomain,
    route: {
      ...executionPlan.route,
      primary_domain: primaryDomain
    },
    caseFrame: {
      ...caseFrame,
      primary_domain: primaryDomain
    },
    retrievalQueries
  };
}

function fallbackEvidencePlan(query: string): SupportEvidencePlan {
  return {
    query_plan: {
      concept_queries: [query],
      object_queries: [query],
      behavior_queries: [query]
    },
    evidence_priority: [],
    required_doc_kinds: [],
    retrieval_rounds: 1,
    allow_refinement: false,
    stop_after_grounded_evidence: false
  };
}

function mergeRouteAndEvidencePlan(caseFrame: SupportCaseFrame, route: SupportQuestionRoute, plan: SupportEvidencePlan): SupportCaseFrame {
  return {
    ...caseFrame,
    missing_critical_info: sanitizeMissingCriticalInfo(caseFrame.missing_critical_info, 3),
    question_type: route.question_type,
    specialist_agent: route.specialist_agent,
    answer_contract: route.answer_contract,
    routing_confidence: route.routing_confidence,
    query_plan: {
      concept_queries: uniqueStrings([...(plan.query_plan?.concept_queries ?? []), ...(caseFrame.query_plan?.concept_queries ?? []), ...caseFrame.retrieval_queries], 4),
      object_queries: uniqueStrings([...(plan.query_plan?.object_queries ?? []), ...(caseFrame.query_plan?.object_queries ?? []), caseFrame.object], 4),
      behavior_queries: uniqueStrings([...(plan.query_plan?.behavior_queries ?? []), ...(caseFrame.query_plan?.behavior_queries ?? []), caseFrame.action_type], 4)
    },
    evidence_priority: uniqueStrings([...(plan.evidence_priority ?? [])], 6),
    required_doc_kinds: uniqueStrings([...(plan.required_doc_kinds ?? [])], 6)
  };
}

function normalizeStageBudget(input: { route: SupportQuestionRoute; plan: SupportEvidencePlan }) {
  const apiRoute = String(input.route.question_type ?? "").startsWith("api_");
  const rawSpecialistBudget = input.route.specialist_budget ?? 1;
  const specialistBudget = Math.max(0, Math.min(1, Number.isFinite(rawSpecialistBudget) ? rawSpecialistBudget : 1));
  const retrievalFloor = apiRoute && !(input.plan.stop_after_grounded_evidence && specialistBudget === 0) ? 2 : 1;
  const retrievalRounds = Math.max(retrievalFloor, Math.min(2, Number(input.plan.retrieval_rounds ?? 2) || 2));
  return {
    retrieval_rounds: retrievalRounds,
    allow_refinement: input.plan.allow_refinement !== false,
    stop_after_grounded_evidence: Boolean(input.plan.stop_after_grounded_evidence),
    specialist_budget: specialistBudget
  };
}

function buildClaimGraph(verification: SupportVerificationResult) {
  return verification.claim_to_citation_map.map((claim) => ({
    text: claim.text,
    kind: claim.kind,
    verdict: claim.verdict,
    citation_ids: claim.citation_ids,
    has_citation: claim.citation_ids.length > 0
  }));
}

function buildOrchestrationTrace(input: {
  route: SupportQuestionRoute;
  specialistSkipped: boolean;
  usedUnifiedPlanner: boolean;
  verificationSkipped: boolean;
  answerComposerUsed: boolean;
}): Array<{ stage: string; agent_id: string; model?: string | null }> {
  const stages: Array<string> = input.usedUnifiedPlanner ? ["planner"] : ["router", "evidence-planner", "planner"];
  if (!input.specialistSkipped) stages.push(input.route.specialist_agent);
  if (!input.verificationSkipped) stages.push("evidence-judge");
  if (input.answerComposerUsed) stages.push("answer-composer");
  return stages.map((stage) => {
    const resolved = resolveStageSpecificAgent(stage as NonNullable<OpenClawRuntimeContext["stage"]>);
    return {
      stage,
      agent_id: resolved.agentId,
      model: resolved.model ?? null
    };
  });
}

function fallbackDraftSupportAnswer(input: {
  language: "zh" | "en";
  hasEvidence: boolean;
  missingInfo: string[];
}): DraftSupportAnswer {
  if (input.language === "zh") {
    return input.hasEvidence
      ? {
          direct_answer: "我已经找到相关文档证据，但当前回答生成链路暂时不可用，无法稳定产出可引用的最终结论。",
          claims: [],
          next_actions: ["请稍后重试，或直接创建工单并附上当前问题、预期结果、实际结果和报错原文。"],
          unknowns: input.missingInfo,
          escalation_needed: true
        }
      : {
          direct_answer: "抱歉，我暂时还不能给出可靠结论，因为当前缺少能支撑核心判断的文档证据。",
          claims: [],
          next_actions: input.missingInfo.length ? [`请先补充：${input.missingInfo[0]}`] : ["建议直接创建工单并附上完整上下文。"],
          unknowns: input.missingInfo,
          escalation_needed: !input.missingInfo.length
        };
  }

  return input.hasEvidence
    ? {
        direct_answer: "I found relevant documentation evidence, but the answer-generation chain is currently unavailable, so I cannot produce a stable cited final answer.",
        claims: [],
        next_actions: ["Please retry shortly, or create a ticket with the current context, expected result, actual result, and exact error text."],
        unknowns: input.missingInfo,
        escalation_needed: true
      }
    : {
        direct_answer: "I’m sorry, but I cannot give a reliable conclusion yet because the core answer is not supported by documentation evidence.",
        claims: [],
        next_actions: input.missingInfo.length ? [`Please share: ${input.missingInfo[0]}`] : ["Create a ticket with the current context."],
        unknowns: input.missingInfo,
        escalation_needed: !input.missingInfo.length
      };
}

function fallbackSpecialistDraftAnswer(input: {
  language: "zh" | "en";
  route: SupportQuestionRoute;
  query: string;
  evidenceBundle: SupportEvidenceBundle;
  missingInfo: string[];
}): SpecialistDraftAnswer {
  const base = fallbackDraftSupportAnswer({
    language: input.language,
    hasEvidence: input.evidenceBundle.primary.length > 0,
    missingInfo: input.missingInfo
  });
  return {
    question_type: input.route.question_type,
    render_variant: resolveRouteRenderVariant(input.route),
    ...base
  };
}

function resolveRouteRenderVariant(route: SupportQuestionRoute): SpecialistDraftAnswer["render_variant"] {
  return route.specialist_agent === "api-specialist"
    ? "api"
    : route.specialist_agent === "howto-specialist"
    ? "how_to"
    : route.specialist_agent === "behavior-specialist"
    ? "behavior"
    : "troubleshooting";
}

function convertGenericSupportDraftToSpecialistDraft(input: {
  route: SupportQuestionRoute;
  draft: DraftSupportAnswer;
}): SpecialistDraftAnswer {
  return {
    question_type: input.route.question_type,
    render_variant: resolveRouteRenderVariant(input.route),
    ...input.draft
  };
}

function fallbackSupportAnswer(input: {
  language: "zh" | "en";
  mode: SupportAnswer["mode"];
  route?: SupportQuestionRoute;
  missingInfo: string[];
}): SupportAnswer {
  const route = input.route ?? fallbackQuestionRoute("");
  const render_variant: SupportAnswer["render_variant"] =
    input.mode === "handoff"
      ? "handoff"
      : input.mode === "clarification"
      ? "clarification"
      : route.specialist_agent === "api-specialist"
      ? "api"
      : route.specialist_agent === "howto-specialist"
      ? "how_to"
      : route.specialist_agent === "behavior-specialist"
      ? "behavior"
      : "troubleshooting";
  const baseMeta = {
    question_type: route.question_type,
    render_variant,
    sections: [] as SupportAnswer["sections"]
  };
  if (input.language === "zh") {
    if (input.mode === "handoff") {
      return {
        ...baseMeta,
        mode: "handoff",
        direct_answer: "抱歉，当前还没有足够的已验证证据形成可靠结论。建议直接创建工单，我会自动预填当前上下文。",
        why: [],
        sections: [
          {
            kind: "bullet_list",
            title: "建议你现在做什么",
            items: ["点击“Create ticket now”生成工单草稿。", "补充报错原文、复现步骤和影响范围。"]
          }
        ],
        what_to_do_now: ["点击“Create ticket now”生成工单草稿。", "补充报错原文、复现步骤和影响范围。"],
        still_need_to_confirm: []
      };
    }
    if (input.mode === "clarification") {
      return {
        ...baseMeta,
        mode: "clarification",
        direct_answer: "为了给你更可靠的结论，我还缺少一个关键信息。",
        why: [],
        sections: input.missingInfo.length
          ? [
              {
                kind: "bullet_list",
                title: "还需要你补充",
                items: input.missingInfo.slice(0, 3)
              }
            ]
          : [],
        what_to_do_now: [input.missingInfo[0] ? `请先补充：${input.missingInfo[0]}` : "请先补充最关键的一条上下文。"],
        still_need_to_confirm: input.missingInfo.slice(0, 3)
      };
    }
    if (input.mode === "partial") {
      return {
        ...baseMeta,
        mode: "partial",
        direct_answer: "我可以先给出当前最可能的判断，但还有一部分结论尚未被文档直接确认。",
        why: [],
        sections: input.missingInfo.length
          ? [
              {
                kind: "bullet_list",
                title: "还需要确认",
                items: input.missingInfo.slice(0, 3)
              }
            ]
          : [],
        what_to_do_now: [],
        still_need_to_confirm: input.missingInfo.slice(0, 3)
      };
    }
    return {
      ...baseMeta,
      mode: "grounded",
      direct_answer: "现有文档已经足够支撑当前结论。",
      why: [],
      what_to_do_now: [],
      still_need_to_confirm: []
    };
  }

  if (input.mode === "handoff") {
    return {
      ...baseMeta,
      mode: "handoff",
      direct_answer: "I’m sorry, but there is still not enough verified evidence for a reliable final answer. Create a ticket now and I will prefill the current context.",
      why: [],
      sections: [
        {
          kind: "bullet_list",
          title: "What to do now",
          items: ["Create a ticket draft from this conversation.", "Add the exact error, repro steps, and impact scope."]
        }
      ],
      what_to_do_now: ["Create a ticket draft from this conversation.", "Add the exact error, repro steps, and impact scope."],
      still_need_to_confirm: []
    };
  }
  if (input.mode === "clarification") {
    return {
      ...baseMeta,
      mode: "clarification",
      direct_answer: "To give you a more reliable answer, I still need one critical detail.",
      why: [],
      sections: input.missingInfo.length
        ? [
            {
              kind: "bullet_list",
              title: "Need from you",
              items: input.missingInfo.slice(0, 3)
            }
          ]
        : [],
      what_to_do_now: [input.missingInfo[0] ? `Please share: ${input.missingInfo[0]}` : "Provide the single most important missing detail."],
      still_need_to_confirm: input.missingInfo.slice(0, 3)
    };
  }
  if (input.mode === "partial") {
    return {
      ...baseMeta,
      mode: "partial",
      direct_answer: "I can give the most likely answer now, but part of the conclusion is still not directly confirmed by documentation.",
      why: [],
      sections: input.missingInfo.length
        ? [
            {
              kind: "bullet_list",
              title: "Still need to confirm",
              items: input.missingInfo.slice(0, 3)
            }
          ]
        : [],
      what_to_do_now: [],
      still_need_to_confirm: input.missingInfo.slice(0, 3)
    };
  }
  return {
    ...baseMeta,
    mode: "grounded",
    direct_answer: "The current conclusion is fully supported by documentation evidence.",
    why: [],
    what_to_do_now: [],
    still_need_to_confirm: []
  };
}

function buildEvidenceBundle(input: {
  references: SearchReference[];
  confidence: number;
  fallbackUsed: boolean;
  resolvedQueries: string[];
  caseFrame: SupportCaseFrame;
  query: string;
  selection?: SupportEvidenceSelection | null;
  primaryDomain?: SupportDomain;
  strictSelection?: boolean;
}): SupportEvidenceBundle {
  const candidateReferences = filterReferencesByEvidencePolicy(input.references, input.caseFrame, input.query);
  const byId = new Map(candidateReferences.map((reference) => [resolveSearchReferenceEvidenceId(reference), reference] as const));
  const citationAliasIndex = buildCitationAliasIndex(candidateReferences);
  const selectedPrimary =
    input.selection?.primary_ids
      .map((id) => resolveCanonicalCitationId(id, citationAliasIndex))
      .filter((id): id is string => Boolean(id))
      .map((id) => byId.get(id))
      .filter((item): item is SearchReference => Boolean(item)) ?? [];
  const selectedSupplemental =
    input.selection?.supplemental_ids
      .map((id) => resolveCanonicalCitationId(id, citationAliasIndex))
      .filter((id): id is string => Boolean(id))
      .map((id) => byId.get(id))
      .filter(
        (item): item is SearchReference =>
          Boolean(item) &&
          !selectedPrimary.some(
            (primary) => resolveSearchReferenceEvidenceId(primary) === resolveSearchReferenceEvidenceId(item as SearchReference)
          )
      ) ?? [];
  const strictPrimaryIds = uniqueStrings(selectedPrimary.map((item) => resolveSearchReferenceEvidenceId(item)), 3);
  const primaryIds = input.strictSelection
    ? strictPrimaryIds
    : uniqueStrings(
        [
          ...strictPrimaryIds,
          ...collectProcedureCompanionChunkIds(candidateReferences, selectedPrimary, input.caseFrame),
          ...candidateReferences.slice(0, 3).map((item) => resolveSearchReferenceEvidenceId(item))
        ],
        3
      );
  const primary = primaryIds
    .map((id) => byId.get(id))
    .filter((item): item is SearchReference => Boolean(item))
    .map((item) => hydrateReferenceEvidence(item));
  const strictSupplementalIds = uniqueStrings(
    selectedSupplemental.map((item) => resolveSearchReferenceEvidenceId(item)),
    5
  );
  const supplementalIds = input.strictSelection
    ? strictSupplementalIds
    : uniqueStrings(
        [
          ...strictSupplementalIds,
          ...collectProcedureCompanionChunkIds(candidateReferences, primary, input.caseFrame),
          ...collectApiCompanionChunkIds(candidateReferences, primary, input.caseFrame),
          ...candidateReferences
            .filter(
              (item) =>
                !primary.some(
                  (primaryRef) => resolveSearchReferenceEvidenceId(primaryRef) === resolveSearchReferenceEvidenceId(item)
                )
            )
            .slice(0, 5)
            .map((item) => resolveSearchReferenceEvidenceId(item))
        ],
        5
      );
  const supplemental = supplementalIds
    .map((id) => byId.get(id))
    .filter((item): item is SearchReference => Boolean(item))
    .map((item) => hydrateReferenceEvidence(item));
  return {
    primary,
    supplemental,
    evidence_gaps: input.caseFrame.missing_critical_info.slice(0, 3),
    confidence: input.confidence,
    fallbackUsed: input.fallbackUsed,
    resolvedQueries: input.resolvedQueries
  };
}

function collectProcedureCompanionChunkIds(
  references: SearchReference[],
  primary: SearchReference[],
  caseFrame: SupportCaseFrame
): string[] {
  if (!["how_to_product", "config_setup", "data_export_reporting"].includes(String(caseFrame.question_type ?? ""))) {
    return [];
  }
  const ids: string[] = [];
  for (const item of primary) {
    const canonicalPath = canonicalDocsPath(item.path);
    if (!canonicalPath) continue;
    if (String(item.headingPath ?? "").toUpperCase() === "ROOT") continue;
    const companion = references.find(
      (candidate) =>
        resolveSearchReferenceEvidenceId(candidate) !== resolveSearchReferenceEvidenceId(item) &&
        canonicalDocsPath(candidate.path) === canonicalPath &&
        String(candidate.headingPath ?? "").toUpperCase() === "ROOT"
    );
    if (companion) ids.push(resolveSearchReferenceEvidenceId(companion));
  }
  return uniqueStrings(ids, 3);
}

function collectApiCompanionChunkIds(
  references: SearchReference[],
  primary: SearchReference[],
  caseFrame: SupportCaseFrame
): string[] {
  if (!String(caseFrame.question_type ?? "").startsWith("api_")) return [];
  const ids: string[] = [];
  for (const item of primary) {
    if (!isReferenceEligibleForCaseFrame(item, caseFrame)) continue;
    const canonicalPath = canonicalDocsPath(item.path);
    if (String(item.headingPath ?? "").toUpperCase() !== "ROOT") continue;
    const companion = references.find(
      (candidate) =>
        resolveSearchReferenceEvidenceId(candidate) !== resolveSearchReferenceEvidenceId(item) &&
        isReferenceEligibleForCaseFrame(candidate, caseFrame) &&
        canonicalDocsPath(candidate.path) === canonicalPath &&
        String(candidate.headingPath ?? "").toUpperCase() !== "ROOT"
    );
    if (companion) ids.push(resolveSearchReferenceEvidenceId(companion));
  }
  return uniqueStrings(ids, 3);
}

function fallbackEvidenceSelection(
  references: SearchReference[],
  query: string,
  caseFrame: SupportCaseFrame,
  primaryDomain?: SupportDomain
): SupportEvidenceSelection {
  const candidateReferences = filterReferencesByEvidencePolicy(references, caseFrame, query);
  const rejectedPool = references;
  return {
    primary_ids: candidateReferences.slice(0, 3).map((item) => resolveSearchReferenceEvidenceId(item)),
    supplemental_ids: candidateReferences.slice(3, 6).map((item) => resolveSearchReferenceEvidenceId(item)),
    rejected_ids: rejectedPool
      .filter(
        (item) =>
          !candidateReferences.some(
            (candidate) => resolveSearchReferenceEvidenceId(candidate) === resolveSearchReferenceEvidenceId(item)
          )
      )
      .map((item) => resolveSearchReferenceEvidenceId(item))
  };
}

function canonicalDocsPath(input?: string): string {
  return String(input ?? "")
    .trim()
    .replace(/^i18n\/[^/]+\/docusaurus-plugin-content-docs-open-docs\/current\//i, "open-docs/docs/")
    .replace(/^i18n\/[^/]+\/docusaurus-plugin-content-docs\/current\//i, "docs/");
}

function getReferenceMetadataList(reference: SearchReference, key: string): string[] {
  const metadata = (reference.supportMetadata ?? {}) as Record<string, unknown>;
  const raw = metadata[key];
  if (!Array.isArray(raw)) return [];
  return raw.map((item) => String(item ?? "").trim()).filter(Boolean);
}

function getReferenceSupportProfile(reference: SearchReference): {
  title: string;
  heading: string;
  snippet: string;
  docKind: string;
  objectType: string;
  evidenceKind: string;
  productArea: string;
  deploymentModel: string;
  permissions: string[];
  prerequisites: string[];
  actions: string[];
} {
  const profile = getSupportEvidenceProfile(reference);
  return {
    title: profile.title,
    heading: profile.heading,
    snippet: profile.snippet,
    docKind: profile.docKind,
    objectType: profile.objectType,
    evidenceKind: profile.evidenceKind,
    productArea: profile.productArea,
    deploymentModel: profile.deploymentModel,
    permissions: profile.permissions,
    prerequisites: profile.prerequisites,
    actions: profile.actions
  };
}

function getReferenceSemanticText(reference: SearchReference): string {
  const profile = getReferenceSupportProfile(reference);
  return [
    profile.title,
    profile.heading,
    profile.snippet,
    profile.docKind,
    profile.objectType,
    ...profile.permissions,
    ...profile.prerequisites,
    ...profile.actions
  ]
    .filter(Boolean)
    .join(" ");
}

function isConstraintFirstCapabilityCase(caseFrame: SupportCaseFrame): boolean {
  const questionType = String(caseFrame.question_type ?? "").toLowerCase();
  if (questionType.startsWith("api_")) return false;
  return questionType === "capability_confirmation";
}

function mergeSupportReferenceMetadata(reference: SearchReference): Record<string, unknown> | undefined {
  const merged = {
    ...(((reference.supportMetadata ?? {}) as Record<string, unknown>) ?? {}),
    ...(((reference.chunkMetadata ?? {}) as Record<string, unknown>) ?? {}),
    ...(((reference.docMetadata ?? {}) as Record<string, unknown>) ?? {})
  };
  return Object.keys(merged).length > 0 ? merged : undefined;
}

function getReferenceRetrievalUnitFamily(reference: SearchReference): string {
  const metadata = mergeSupportReferenceMetadata(reference) ?? {};
  return String(metadata.retrieval_unit_family ?? metadata.source_family ?? "")
    .trim()
    .toLowerCase();
}

function looksLikeOperationalPlanText(text: string): boolean {
  return /\b(migration|migrate|cutover|rollback|backup|rehearsal|preflight|dry run|rollout plan|runbook rehearsal)\b|迁移|切换|回滚|备份|实施预演|预演|演练|信息收集/.test(
    text
  );
}

function looksLikeStructuredConstraintText(text: string): boolean {
  return /\b(requirements?|required|supported|support matrix|compatibility|resource|resources|capacity|limits?|quota|cpu|memory|ram|disk|storage|operating system)\b|要求|支持矩阵|兼容性|资源|容量|限制|配额|cpu|内存|磁盘|存储|操作系统/.test(
    text
  );
}

function referenceHasStructuredConstraintEvidence(reference: SearchReference): boolean {
  const profile = getReferenceSupportProfile(reference);
  const retrievalUnitFamily = getReferenceRetrievalUnitFamily(reference);
  return (
    profile.evidenceKind === "constraint" ||
    profile.docKind === "rules" ||
    retrievalUnitFamily === "constraint_table_row_unit" ||
    retrievalUnitFamily === "schema_constraint_unit" ||
    profile.objectType === "deployment_node_sizing"
  );
}

function getReferenceHeadingDepth(headingPath?: string): number {
  return String(headingPath ?? "")
    .split(">")
    .map((item) => item.trim())
    .filter(Boolean).length;
}

function referenceLooksLikeLeafConstraintMatrix(reference: SearchReference): boolean {
  const retrievalUnitFamily = getReferenceRetrievalUnitFamily(reference);
  if (retrievalUnitFamily === "constraint_table_row_unit") return true;
  if (getReferenceHeadingDepth(reference.headingPath) < 4) return false;
  const snippet = String(reference.snippet ?? "");
  const semanticText = getReferenceSemanticText(reference);
  const hasResourceColumns =
    /\b(cpu|memory|ram|disk|storage|bandwidth|node|nodes|server|servers)\b|cpu|内存|磁盘|存储|带宽|节点|服务器|系统盘|数据盘|索引盘|网络带宽/.test(
      semanticText
    );
  const hasResourceValues = /(?:>=|<=|\d+\s*(?:c|g|gb|tb|mbps|台))|>=\d/i.test(snippet);
  return /\|/.test(snippet) && hasResourceColumns && hasResourceValues;
}

function referenceLooksLikeDeploymentApplicabilityOnly(reference: SearchReference): boolean {
  const canonicalPath = canonicalDocsPath(reference.path);
  if (/(^|\/)deploy-docs\//.test(canonicalPath)) return false;
  const semanticText = getReferenceSemanticText(reference);
  const applicabilityOnly =
    /\b(applicable environments?|supported environments?|environment availability|private deployment saas|saas)\b|适用环境|可用环境/.test(
      semanticText
    );
  const hasOperationalSignals =
    /\b(cpu|memory|ram|disk|storage|bandwidth|support matrix|compatibility|system requirements?|environment requirements?|operating system requirements?|topology|architecture|cluster|node|nodes|server|servers|install|configure|rollback|backup)\b|cpu|内存|磁盘|存储|带宽|支持矩阵|兼容性|系统要求|环境要求|操作系统要求|拓扑|架构|集群|节点|服务器|安装|配置|回滚|备份/.test(
      semanticText
    );
  return applicabilityOnly && !hasOperationalSignals;
}

function referenceLooksLikeDeploymentArchitectureEvidence(reference: SearchReference): boolean {
  const profile = getReferenceSupportProfile(reference);
  const titleHeading = `${profile.title} ${profile.heading}`;
  const semanticText = getReferenceSemanticText(reference);
  const noisyRequirementHeading =
    /\b(operating system requirements?|client requirements?|account preparation|risk warning|optional)\b|操作系统要求|客户端要求|两类账号准备|风险提示|信创环境要求/.test(
      titleHeading
    );
  if (noisyRequirementHeading) return false;
  return (
    /\b(topology|architecture|service boundaries|service topology|database topology|shared backend|backend services|query path|query paths|isolat(?:e|ed|ion)|separate|separable|colocated|unified(?: system| topology)?)\b|拓扑|架构|隔离|独立/.test(
      semanticText
    ) ||
    ((/\b(default|built-?in)\b|默认|内置/.test(semanticText) && /\b(database|middleware|storage|mysql|redis|kafka)\b|数据库|中间件|存储/.test(semanticText)) &&
      /\b(external|externalized|nfs|oss)\b|外置|NFS|OSS/.test(semanticText)) ||
    (/\b(deployment expansion)\b|部署扩展/.test(`${titleHeading} ${semanticText}`) &&
      /\b(database|middleware|storage|mysql|redis|kafka|external|nfs|oss)\b|数据库|中间件|存储|外置|NFS|OSS/.test(
        semanticText
      ))
  );
}

function referenceLooksLikeDeploymentArchitectureNoise(reference: SearchReference): boolean {
  if (referenceLooksLikeDeploymentArchitectureEvidence(reference)) return false;
  const profile = getReferenceSupportProfile(reference);
  const titleHeading = `${profile.title} ${profile.heading}`;
  return /\b(operating system requirements?|client requirements?|account preparation|risk warning|optional)\b|操作系统要求|客户端要求|两类账号准备|风险提示|信创环境要求/.test(
    titleHeading
  );
}

function referenceLooksLikeOperationalPlan(reference: SearchReference): boolean {
  return looksLikeOperationalPlanText(getReferenceSemanticText(reference));
}

function fragmentLooksLikeOperationalPlan(fragment: string): boolean {
  const normalized = normalizeBehaviorEvidenceFragment(fragment);
  if (!normalized) return false;
  return looksLikeOperationalPlanText(normalized);
}

function scoreObjectTypeFocusFit(objectType: string, focusTerms: string[]): number {
  const normalizedObjectType = String(objectType ?? "")
    .trim()
    .toLowerCase()
    .replace(/_/g, " ");
  if (!normalizedObjectType || normalizedObjectType === "unspecified") return 0;
  const focusText = focusTerms.join(" ").toLowerCase();
  let score = 0;
  for (const token of normalizedObjectType.split(/[^a-z0-9\u4e00-\u9fff]+/).filter(Boolean)) {
    score += tokenMatchesFocus(token, focusText) || focusText.includes(token) ? 8 : -2;
  }
  return score;
}

function referenceHasPermissionSignal(reference: SearchReference): boolean {
  const profile = getReferenceSupportProfile(reference);
  if (profile.permissions.length > 0) return true;
  const semanticText = getReferenceSemanticText(reference);
  return /\b(scope|scopes|permission|permissions|oauth|token|auth|authorization|authentication)\b/.test(semanticText);
}

function isReferenceEligibleForCaseFrame(reference: SearchReference, caseFrame: SupportCaseFrame): boolean {
  return matchesSupportEvidencePolicy(reference, caseFrame);
}

function filterReferencesByEvidencePolicy(
  references: SearchReference[],
  caseFrame: SupportCaseFrame,
  query?: string
): SearchReference[] {
  const policyFiltered = filterSupportEvidenceByPolicy(references, caseFrame, (reference) => reference);
  const normalizedQuery = String(query ?? "").trim();
  if (!normalizedQuery) return policyFiltered;
  return rerankReferencesForCaseFrame(policyFiltered, normalizedQuery, caseFrame);
}

function resolveLocalDocsMirrorPath(reference: SearchReference): string | null {
  const rawPath = String(reference.path ?? "").trim();
  if (!rawPath || !env.LOCAL_DOCS_COM_PATH.trim()) return null;
  const candidates = [rawPath, canonicalDocsPath(rawPath)]
    .filter(Boolean)
    .map((candidate) => path.resolve(env.LOCAL_DOCS_COM_PATH, candidate));
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function buildLocalDocsEvidenceSnippet(reference: SearchReference): string | null {
  const resolvedPath = resolveLocalDocsMirrorPath(reference);
  if (!resolvedPath) return null;

  const raw = fs.readFileSync(resolvedPath, "utf8");
  const normalizeEvidenceLine = (line: string): string => {
    const trimmed = line.trim();
    const methodMatch = trimmed.match(/<MethodEndpoint[\s\S]*method=\{"([^"]+)"\}[\s\S]*path=\{"([^"]+)"\}/);
    if (methodMatch) {
      return `MethodEndpoint method={"${methodMatch[1]}"} path={"${methodMatch[2]}"}`;
    }
    const paramsMatch = trimmed.match(/<ParamsItem[\s\S]*"name":"([^"]+)"[\s\S]*"description":"([^"]+)"/);
    if (paramsMatch) {
      return `ParamsItem name={"${paramsMatch[1]}"} description={"${paramsMatch[2]}"}`;
    }
    const schemaMatch = trimmed.match(/<SchemaItem[\s\S]*name=\{"([^"]+)"\}[\s\S]*description":"([^"]+)"/);
    if (schemaMatch) {
      return `SchemaField name={"${schemaMatch[1]}"} description={"${schemaMatch[2]}"}`;
    }
    return trimmed.length <= 220 ? trimmed : trimmed.slice(0, 220);
  };
  const cleanedLines = raw
    .replace(/^---[\s\S]*?---\s*/, "")
    .split("\n")
    .map((line) => normalizeEvidenceLine(line))
    .filter(Boolean)
    .filter((line) => !line.startsWith("import "))
    .filter((line) => !/^api:\s/.test(line))
    .filter((line) => !/^(sidebar_|hide_|custom_edit_url:|info_path:)/.test(line))
    .filter((line) => line.length <= 220);

  const heading = String(reference.headingPath ?? "").trim();
  const headingNeedle = heading && heading.toUpperCase() !== "ROOT" ? shortHeadingLabel(heading).toLowerCase() : "";
  const anchorIndex = headingNeedle ? cleanedLines.findIndex((line) => line.toLowerCase().includes(headingNeedle)) : -1;
  const scopedLines =
    anchorIndex >= 0 ? cleanedLines.slice(Math.max(0, anchorIndex - 18), anchorIndex + 90) : cleanedLines.slice(0, 140);
  const enriched = scopedLines.join(" ").replace(/\s+/g, " ").trim();
  return enriched ? enriched.slice(0, 3200) : null;
}

function hydrateReferenceEvidence(reference: SearchReference): SearchReference {
  if (reference.sourceType !== "local_docs") return reference;
  const enrichedSnippet = buildLocalDocsEvidenceSnippet(reference);
  if (!enrichedSnippet || enrichedSnippet.length <= reference.snippet.length) return reference;
  return {
    ...reference,
    snippet: enrichedSnippet
  };
}

function uniqueCitationIds(claims: SupportVerificationResult["claim_to_citation_map"]): string[] {
  return uniqueStrings(
    claims
      .filter((claim) => (claim.verdict === "verified" || claim.verdict === "supported_inference") && claim.citation_ids.length > 0)
      .flatMap((claim) => claim.citation_ids),
    12
  );
}

function normalizeCitationAliasKey(value: string): string {
  return String(value ?? "").trim().toLowerCase();
}

function resolveReferenceHeadingAlias(reference: SearchReference): string {
  const heading = String(reference.headingPath ?? "").trim();
  return heading || "ROOT";
}

function buildReferenceCitationAliases(reference: SearchReference, options?: { allowRootAlias?: boolean }): string[] {
  const aliases = new Set<string>();
  const canonicalEvidenceId = resolveSearchReferenceEvidenceId(reference);
  const documentId = String(reference.documentId ?? "").trim();
  const hasDistinctEvidenceId = Boolean(String(reference.evidenceId ?? "").trim()) && canonicalEvidenceId !== documentId;
  const sourceUrl = String(reference.sourceUrl ?? "").trim();
  const repoSourceUrl = String(reference.repoSourceUrl ?? "").trim();
  const canonicalPath = canonicalDocsPath(reference.path);
  const heading = resolveReferenceHeadingAlias(reference);
  const headingLower = heading.toLowerCase();

  for (const value of [canonicalEvidenceId, sourceUrl, repoSourceUrl]) {
    if (value) aliases.add(value);
  }
  if (documentId && !hasDistinctEvidenceId) {
    aliases.add(documentId);
  }

  if (canonicalPath) {
    aliases.add(`${canonicalPath}::${heading}`);
    aliases.add(`${canonicalPath}::${headingLower}`);
    aliases.add(`${canonicalPath}#${heading}`);
    aliases.add(`${canonicalPath}#${headingLower}`);
    aliases.add(`local:${canonicalPath}:${heading}`);
    aliases.add(`local:${canonicalPath}:${headingLower}`);
    if (options?.allowRootAlias) {
      aliases.add(`${canonicalPath}::ROOT`);
      aliases.add(`${canonicalPath}::root`);
      aliases.add(`${canonicalPath}#ROOT`);
      aliases.add(`${canonicalPath}#root`);
      aliases.add(`local:${canonicalPath}:ROOT`);
      aliases.add(`local:${canonicalPath}:root`);
    }
  }

  return [...aliases];
}

type CitationAliasIndex = {
  exact: Map<string, string>;
  normalized: Map<string, string>;
};

function buildCitationAliasIndex(references: SearchReference[]): CitationAliasIndex {
  const exact = new Map<string, string>();
  const normalized = new Map<string, string>();
  const referencesByCanonicalPath = new Map<string, SearchReference[]>();

  for (const reference of references) {
    const canonicalPath = canonicalDocsPath(reference.path);
    if (!canonicalPath) continue;
    const bucket = referencesByCanonicalPath.get(canonicalPath) ?? [];
    bucket.push(reference);
    referencesByCanonicalPath.set(canonicalPath, bucket);
  }

  for (const reference of references) {
    const canonicalEvidenceId = resolveSearchReferenceEvidenceId(reference);
    const canonicalPath = canonicalDocsPath(reference.path);
    const allowRootAlias = canonicalPath ? (referencesByCanonicalPath.get(canonicalPath)?.length ?? 0) === 1 : false;
    for (const alias of buildReferenceCitationAliases(reference, { allowRootAlias })) {
      const trimmed = alias.trim();
      if (!trimmed) continue;
      if (!exact.has(trimmed)) exact.set(trimmed, canonicalEvidenceId);
      const normalizedKey = normalizeCitationAliasKey(trimmed);
      if (normalizedKey && !normalized.has(normalizedKey)) normalized.set(normalizedKey, canonicalEvidenceId);
    }
  }

  return { exact, normalized };
}

function resolveCanonicalCitationId(citationId: string, aliasIndex: CitationAliasIndex): string | null {
  const trimmed = String(citationId ?? "").trim();
  if (!trimmed) return null;
  return aliasIndex.exact.get(trimmed) ?? aliasIndex.normalized.get(normalizeCitationAliasKey(trimmed)) ?? null;
}

function collectFocusTerms(query: string, caseFrame: SupportCaseFrame): string[] {
  const raw = [
    query,
    caseFrame.goal,
    caseFrame.object,
    caseFrame.symptom,
    caseFrame.product_area,
    caseFrame.action_type,
    ...caseFrame.retrieval_queries,
    ...(caseFrame.query_plan?.concept_queries ?? []),
    ...(caseFrame.query_plan?.object_queries ?? []),
    ...(caseFrame.query_plan?.behavior_queries ?? [])
  ]
    .map((item) => String(item ?? "").trim())
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  const ascii = [...raw.matchAll(/[a-z0-9:_./-]{3,}/g)].map((match) => match[0]);
  const cjk = [...raw.matchAll(/[\u4e00-\u9fff]{2,}/g)].map((match) => match[0]);
  return uniqueStrings([...ascii, ...cjk], 24);
}

function buildCompactFocusQuery(query: string, caseFrame: SupportCaseFrame): string | null {
  const stopwords = new Set([
    "does",
    "what",
    "when",
    "where",
    "which",
    "with",
    "that",
    "this",
    "have",
    "from",
    "into",
    "such",
    "used",
    "commonly",
    "noticed",
    "support",
    "supports",
    "query",
    "queries",
    "function",
    "seems",
    "translate",
    "changing",
    "exact",
    "object",
    "scenario",
    "working"
  ]);
  const focusTerms = collectFocusTerms(query, caseFrame).filter((term) => {
    const normalized = term.toLowerCase();
    return normalized.length > 2 && !stopwords.has(normalized);
  });
  const compact = uniqueStrings(focusTerms, 8).join(" ").trim();
  if (!compact) return null;
  return compact.toLowerCase() === query.trim().toLowerCase() ? null : compact;
}

function scoreRequiredDocKindForReference(reference: SearchReference, requiredDocKind: string): number {
  const profile = getReferenceSupportProfile(reference);
  const semanticText = getReferenceSemanticText(reference);
  switch (requiredDocKind.toLowerCase()) {
    case "openapi/api":
      return (profile.productArea === "openapi" ? 16 : 0) + (profile.evidenceKind === "api_operation" ? 18 : 0);
    case "schema":
    case "field":
      return ((profile.productArea === "openapi" || profile.evidenceKind === "api_operation") ? 8 : 0) +
        (/\b(schema|field|fields|property|properties|response|status object)\b|字段|属性|响应/.test(semanticText) ? 14 : 0);
    case "syntax_reference":
      return /\b(onesql|syntax|query language|expression|reference)\b|语法|查询语言|表达式/.test(semanticText) ? 18 : 0;
    case "permissions":
      return (referenceHasPermissionSignal(reference) ? 16 : 0) + (profile.productArea === "openapi" ? 4 : 0);
    case "rules":
      return (profile.evidenceKind === "constraint" ? 12 : 0) +
        (/\b(rule|rules|workflow|workflows|behavior|limitation|limitations)\b|规则|流程|行为|限制/.test(semanticText) ? 12 : 0);
    case "troubleshooting":
      return (profile.evidenceKind === "troubleshooting" ? 16 : 0) +
        (/\b(troubleshoot|troubleshooting|faq|why|failure|error)\b|排查|故障|报错|失败|为什么/.test(semanticText) ? 10 : 0);
    case "product_guide":
      return (profile.evidenceKind === "capability" || profile.evidenceKind === "procedure" ? 10 : 0) +
        (profile.productArea && profile.productArea !== "openapi" ? 6 : 0);
    case "deployment_runbook":
      return (profile.productArea === "deployment" ? 18 : 0) +
        (profile.deploymentModel === "private_deployment" ? 18 : 0) +
        (profile.evidenceKind === "procedure" || profile.evidenceKind === "constraint" || profile.evidenceKind === "troubleshooting" ? 8 : 0);
    default:
      return 0;
  }
}

function rerankReferencesForCaseFrame(references: SearchReference[], query: string, caseFrame: SupportCaseFrame): SearchReference[] {
  const requiredDocKinds = caseFrame.required_doc_kinds ?? [];
  const focusTerms = collectFocusTerms(query, caseFrame);
  const normalizedQuery = query.toLowerCase();
  const wantsListVariant =
    /列表|枚举|可选|全部|有哪些/.test(query) || /\b(list|enum|options|all statuses?)\b/.test(normalizedQuery);
  const constraintFirstCapabilityCase = isConstraintFirstCapabilityCase(caseFrame);
  const deploymentCapabilityQuestion =
    caseFrame.product_area === "deployment" && caseFrame.question_type === "capability_confirmation";
  const deploymentArchitectureQuestion = isDeploymentArchitectureQuestion(query, caseFrame);
  return [...references].sort((a, b) => {
    const scoreRef = (reference: SearchReference) => {
      const profile = getReferenceSupportProfile(reference);
      const title = profile.title;
      const heading = profile.heading;
      const snippet = profile.snippet;
      const semanticText = getReferenceSemanticText(reference);
      const retrievalUnitFamily = getReferenceRetrievalUnitFamily(reference);
      const structuredConstraintEvidence = referenceHasStructuredConstraintEvidence(reference);
      const leafConstraintMatrix = referenceLooksLikeLeafConstraintMatrix(reference);
      const deploymentApplicabilityOnly = referenceLooksLikeDeploymentApplicabilityOnly(reference);
      const deploymentArchitectureEvidence = referenceLooksLikeDeploymentArchitectureEvidence(reference);
      const deploymentArchitectureNoise = referenceLooksLikeDeploymentArchitectureNoise(reference);
      const operationalPlanReference = referenceLooksLikeOperationalPlan(reference);
      let topicScore = 0;
      for (const term of focusTerms) {
        if (title.includes(term)) topicScore += 8;
        else if (heading.includes(term)) topicScore += 5;
        else if (snippet.includes(term)) topicScore += 1;
      }
      topicScore += scoreObjectTypeFocusFit(profile.objectType, focusTerms);
      if (reference.sourceType === "local_docs" || reference.sourceType === "github_kb") {
        topicScore += 2;
      }
      for (const kind of requiredDocKinds.map((item) => item.toLowerCase())) {
        topicScore += scoreRequiredDocKindForReference(reference, kind);
      }
      if (caseFrame.deployment_model === "private_deployment") {
        if (profile.deploymentModel === "private_deployment") topicScore += 20;
        if (profile.productArea === "deployment") topicScore += 8;
      }
      if (caseFrame.product_area === "deployment") {
        if (profile.productArea === "deployment") topicScore += 18;
        if (profile.evidenceKind === "procedure") topicScore += 12;
        else if (profile.evidenceKind === "troubleshooting") topicScore += 6;
        else if (profile.evidenceKind === "constraint" || profile.evidenceKind === "capability") topicScore += 8;
        if (/\b(unified|shared|external|externalized|database|storage|topology|architecture|isolation|separate|separable)\b|统一|共享|外置|数据库|存储|拓扑|架构|隔离|独立/.test(semanticText)) {
          topicScore += 14;
        }
      }
      if (deploymentArchitectureQuestion) {
        if (deploymentArchitectureEvidence) topicScore += 38;
        if (deploymentArchitectureNoise) topicScore -= 28;
        if (profile.evidenceKind === "capability" || profile.evidenceKind === "constraint") topicScore += 18;
        if (profile.evidenceKind === "procedure") topicScore -= 16;
        if (operationalPlanReference) topicScore -= 22;
      }
      if (constraintFirstCapabilityCase) {
        if (structuredConstraintEvidence) topicScore += 26;
        else if (profile.evidenceKind === "capability") topicScore += 10;
        else if (profile.evidenceKind === "procedure") topicScore -= 8;
        if (retrievalUnitFamily === "constraint_table_row_unit") topicScore += 34;
        else if (retrievalUnitFamily === "schema_constraint_unit") topicScore += 16;
        if (leafConstraintMatrix) topicScore += 28;
        if (/\|/.test(String(reference.snippet ?? ""))) topicScore += 8;
        if (operationalPlanReference && !structuredConstraintEvidence) topicScore -= 20;
        if (deploymentApplicabilityOnly) topicScore -= 28;
        if (/\b(optional|risk|warning|warnings?)\b|可选|风险|提示/.test(`${title} ${heading}`)) topicScore -= 18;
      }
      if (deploymentCapabilityQuestion) {
        const rootHeading = String(reference.headingPath ?? "").trim().toUpperCase() === "ROOT";
        if (profile.evidenceKind === "constraint" || profile.evidenceKind === "capability") topicScore += 22;
        if (profile.evidenceKind === "procedure") topicScore -= 10;
        if (!rootHeading) topicScore += wantsListVariant ? 16 : 12;
        if (leafConstraintMatrix) topicScore += wantsListVariant ? 18 : 24;
        if (
          /\b(support matrix|compatibility|system requirements?|environment requirements?|operating system requirements?)\b|支持矩阵|兼容性|系统要求|环境要求|操作系统要求/.test(
            semanticText
          )
        ) {
          topicScore += 18;
        }
        if (
          /\b(linux|ubuntu|red hat|centos|debian|rocky|anolis|euler|uos)\b|linux|ubuntu|red hat|centos|debian|rocky|发行版|欧拉|麒麟|统信/.test(
            semanticText
          )
        ) {
          topicScore += 12;
        }
        if (
          rootHeading &&
          /\b(overview|introduction|before install|before you install|read together)\b|本文描述|可配合.*阅读|安装之前|正式安装.*之前/.test(
            semanticText
          )
        ) {
          topicScore -= 20;
        }
      }
      if (caseFrame.product_area === "integrations") {
        if (profile.productArea === "integrations") topicScore += 18;
        if (profile.evidenceKind === "troubleshooting") topicScore += 14;
        else if (profile.evidenceKind === "procedure") topicScore += 10;
        else if (profile.evidenceKind === "constraint" || profile.evidenceKind === "capability") topicScore += 8;
        if (/\b(github|gitlab|oauth|callback|redirect uri|redirect url|webhook|baseurl|page not found)\b|github|gitlab|回调|重定向|redirect uri|webhook|baseurl|page not found/.test(semanticText)) {
          topicScore += 16;
        }
      }
      if (
        caseFrame.question_type &&
        caseFrame.question_type.startsWith("api_") &&
        isReferenceEligibleForCaseFrame(reference, caseFrame)
      ) {
        topicScore += 8;
        topicScore += scoreApiIntentAlignment(
          collectApiOperationIntents(query, caseFrame),
          classifyApiOperationCandidate({
            method: extractApiOperationSignature(reference).method,
            path: extractApiOperationSignature(reference).path,
            title: reference.title,
            snippet
          })
        );
      }
      if (caseFrame.question_type === "api_scope_auth") {
        if (referenceHasPermissionSignal(reference)) {
          topicScore += 16;
        }
      }
      if (caseFrame.question_type === "how_to_product" || caseFrame.question_type === "config_setup") {
        if (profile.evidenceKind === "procedure") topicScore += 14;
        if (profile.deploymentModel === "private_deployment" && profile.productArea === "deployment") topicScore += 12;
      }
      if (caseFrame.question_type === "api_field_lookup") {
        const operationSignature = extractApiOperationSignature(reference);
        const isIssueDetailsOperation =
          /\/project\/issues\/\{issueid\}/.test(`${operationSignature.path} ${snippet}`.toLowerCase()) ||
          title.includes("issue details") ||
          title.includes("工作项详细信息");
        const isStatusListOperation =
          /\/project\/issuestatuses/.test(`${operationSignature.path} ${snippet}`.toLowerCase()) ||
          title.includes("issue status") ||
          title.includes("工作项状态列表");
        const hasFieldSignal =
          /status object|"status"|name=\{"status"\}|状态|字段|responseexample/.test(snippet) ||
          heading.includes("schema") ||
          heading.includes("responses");
        if (isIssueDetailsOperation) {
          topicScore += wantsListVariant ? 6 : 20;
          if (hasFieldSignal) topicScore += 14;
        }
        if (isStatusListOperation) {
          topicScore += wantsListVariant ? 18 : -8;
        }
      }
      if (
        /sidebar label|hide title|custom edit url|import apitabs|import methodendpoint|^---\s*id:/.test(snippet) ||
        (String(reference.headingPath ?? "").toUpperCase() === "ROOT" &&
          /sidebar label|hide title|custom edit url|import apitabs|import methodendpoint/.test(snippet))
      ) {
        topicScore -= 20;
      }
      if (String(caseFrame.question_type ?? "").startsWith("api_") && !isReferenceEligibleForCaseFrame(reference, caseFrame)) {
        topicScore -= 40;
      }
      if (caseFrame.deployment_model === "private_deployment" && profile.deploymentModel && profile.deploymentModel !== "private_deployment") {
        topicScore -= 8;
      }
      return topicScore;
    };
    const topicDiff = scoreRef(b) - scoreRef(a);
    if (topicDiff !== 0) return topicDiff;
    return b.score - a.score;
  });
}

function sanitizeVerification(input: {
  verification: SupportVerificationResult;
  evidenceBundle: SupportEvidenceBundle;
  query: string;
  caseFrame: SupportCaseFrame;
}): SupportVerificationResult {
  const candidateReferences = [...input.evidenceBundle.primary, ...input.evidenceBundle.supplemental].filter(
    (item) => item.authority === "canonical_visible"
  );
  const evidenceById = new Map(candidateReferences.map((item) => [resolveSearchReferenceEvidenceId(item), item] as const));
  const citationAliasIndex = buildCitationAliasIndex(candidateReferences);
  const sanitizedClaims = input.verification.claim_to_citation_map.map((claim) => {
    const validCitationIds = uniqueStrings(
      claim.citation_ids
        .map((citationId) => resolveCanonicalCitationId(citationId, citationAliasIndex))
        .filter((citationId): citationId is string => Boolean(citationId)),
      6
    );
    if ((claim.verdict === "verified" || claim.verdict === "supported_inference") && validCitationIds.length === 0) {
      return {
        ...claim,
        verdict: "unsupported" as const,
        citation_ids: []
      };
    }
    return {
      ...claim,
      citation_ids: validCitationIds
    };
  });
  const supportedClaims = sanitizedClaims.filter(
    (claim) => (claim.verdict === "verified" || claim.verdict === "supported_inference") && claim.citation_ids.length > 0
  );
  const claimLinkedCitationIds = uniqueCitationIds(sanitizedClaims);
  const claimLinkedCitationSet = new Set(claimLinkedCitationIds);
  const displayCitationIds = uniqueStrings(
    [
      ...claimLinkedCitationIds,
      ...input.verification.display_citation_ids
        .map((citationId) => resolveCanonicalCitationId(citationId, citationAliasIndex))
        .filter((citationId): citationId is string => Boolean(citationId))
    ],
    6
  ).filter((citationId) => evidenceById.has(citationId) && claimLinkedCitationSet.has(citationId));
  const unsupportedClaims = uniqueStrings(
    [
      ...input.verification.unsupported_claims,
      ...sanitizedClaims
        .filter((claim) => claim.verdict === "unsupported")
        .map((claim) => claim.text)
    ],
    12
  );
  const sanitized: SupportVerificationResult = {
    verdict:
      supportedClaims.length === 0
        ? "unsupported"
        : unsupportedClaims.length === 0 && input.verification.verdict === "verified"
        ? "verified"
        : "partial",
    summary: input.verification.summary,
    unsupported_claims: unsupportedClaims,
    missing_info: input.verification.missing_info,
    verified_citation_ids: claimLinkedCitationIds,
    display_citation_ids: displayCitationIds.slice(0, 3),
    verified_claims: supportedClaims.map((claim) => claim.text),
    claim_to_citation_map: sanitizedClaims
  };

  return refineVerificationForAnswer({
    verification: sanitized,
    evidenceBundle: input.evidenceBundle,
    query: input.query,
    caseFrame: input.caseFrame
  });
}

function buildCitations(input: {
  references: SearchReference[];
  verification: SupportVerificationResult;
}) {
  if (!input.verification.display_citation_ids.length) {
    return [];
  }
  const bestById = new Map<string, SearchReference>();
  for (const item of input.references) {
    if (!item.sourceUrl || item.authority !== "canonical_visible") continue;
    const evidenceId = resolveSearchReferenceEvidenceId(item);
    const previous = bestById.get(evidenceId);
    if (!previous || item.score > previous.score) bestById.set(evidenceId, item);
  }
  const selected: SearchReference[] = [];
  const seenCanonicalKeys = new Set<string>();
  for (const citationId of input.verification.display_citation_ids) {
    const item = bestById.get(citationId);
    if (!item) continue;
    const key = [canonicalDocsPath(item.path) || item.sourceUrl || item.documentId, item.headingPath || "ROOT"].join("::");
    if (seenCanonicalKeys.has(key)) continue;
    seenCanonicalKeys.add(key);
    selected.push(item);
    if (selected.length >= 3) break;
  }
  const normalizeCitationTitle = (reference: SearchReference): string => {
    const rawTitle = String(reference.title ?? "").trim();
    if (!/^(get|post|put|patch|delete)\s+\//i.test(rawTitle)) return rawTitle;
    const canonicalPath = canonicalDocsPath(reference.path) || String(reference.path ?? "").trim();
    const basename = canonicalPath.split("/").pop() ?? "";
    const derived = basename
      .replace(/\.(?:api\.)?mdx?$/i, "")
      .replace(/^\d+[-_]?/, "")
      .replace(/[_-]+/g, " ")
      .trim();
    return derived ? derived.replace(/\b[a-z]/g, (char) => char.toUpperCase()) : rawTitle;
  };
  return selected.map((item) => ({
    id: resolveSearchReferenceEvidenceId(item),
    title: normalizeCitationTitle(item),
    excerpt: item.snippet,
    score: item.score,
    source_url: item.sourceUrl,
    retrieved_at: item.retrievedAt,
    repo: item.repo,
    path: item.path,
    commit_sha: item.commitSha
  }));
}

function buildStructuredAnswer(
  supportAnswer: SupportAnswer,
  verification: SupportVerificationResult
): StructuredSearchAnswer {
  if (supportAnswer.mode === "clarification") {
    return {
      summary: supportAnswer.direct_answer,
      steps: supportAnswer.what_to_do_now,
      validation: [],
      required_inputs: supportAnswer.still_need_to_confirm.slice(0, 3),
      style: "clarification"
    };
  }

  if (supportAnswer.mode === "handoff") {
    return {
      summary: supportAnswer.direct_answer,
      assessment: supportAnswer.why.join(" ") || verification.summary,
      steps: supportAnswer.what_to_do_now,
      validation: supportAnswer.still_need_to_confirm,
      style: "diagnosis"
    };
  }

  return {
    summary: supportAnswer.direct_answer,
    assessment: supportAnswer.why.join(" ") || undefined,
    steps: supportAnswer.what_to_do_now,
    validation: supportAnswer.still_need_to_confirm,
    style: supportAnswer.mode === "partial" ? "diagnosis" : "kb_answer"
  };
}

function digestEvidenceBundle(bundle: SupportEvidenceBundle): string {
  return crypto.createHash("sha256").update(JSON.stringify(bundle)).digest("hex");
}

function normalizeComparableText(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

function overlapsUnsupportedClaim(text: string, unsupportedClaims: string[]): boolean {
  const normalizedText = normalizeComparableText(text);
  if (!normalizedText) return false;
  return unsupportedClaims.some((claim) => {
    const normalizedClaim = normalizeComparableText(claim);
    return normalizedClaim && (normalizedText.includes(normalizedClaim) || normalizedClaim.includes(normalizedText));
  });
}

function filterUnsupported(items: string[], unsupportedClaims: string[]): string[] {
  return items.filter((item) => !overlapsUnsupportedClaim(item, unsupportedClaims));
}

function resolveSupportMode(input: {
  verification: SupportVerificationResult;
  references: SearchReference[];
  currentRound: number;
  missingInfo: string[];
}): SupportAnswer["mode"] {
  const supportedCoreClaims = input.verification.claim_to_citation_map.filter(
    (claim) => (claim.verdict === "verified" || claim.verdict === "supported_inference") && claim.citation_ids.length > 0
  );
  if (supportedCoreClaims.length > 0 && input.verification.verdict === "verified" && input.missingInfo.length === 0) {
    return "grounded";
  }
  if (supportedCoreClaims.length > 0) {
    return "partial";
  }
  if (input.missingInfo.length > 0 && input.currentRound < env.AI_SEARCH_MAX_CLARIFICATION_ROUNDS) {
    return "clarification";
  }
  if (!input.references.length && input.missingInfo.length > 0 && input.currentRound < env.AI_SEARCH_MAX_CLARIFICATION_ROUNDS) {
    return "clarification";
  }
  return "handoff";
}

function supportedVerificationClaims(verification: SupportVerificationResult) {
  return verification.claim_to_citation_map.filter(
    (claim) => (claim.verdict === "verified" || claim.verdict === "supported_inference") && claim.citation_ids.length > 0
  );
}

function resolveSupportUnresolvedReasonCode(input: {
  retrievalStatus: "grounded" | "kb_unavailable" | "no_results";
  hasReferences: boolean;
  mode: SupportAnswer["mode"];
  verification: SupportVerificationResult;
}): "NO_MATCHING_KB" | "LOW_CONFIDENCE" | "KB_RETRIEVAL_UNAVAILABLE" | null {
  if (input.retrievalStatus === "kb_unavailable") {
    return "KB_RETRIEVAL_UNAVAILABLE";
  }
  if (!input.hasReferences) {
    return "NO_MATCHING_KB";
  }
  return input.mode === "grounded" ||
    input.mode === "partial" ||
    supportedVerificationClaims(input.verification).length > 0 ||
    input.verification.verified_citation_ids.length > 0
    ? null
    : "LOW_CONFIDENCE";
}

function scoreReferenceTopicMatch(reference: SearchReference, focusTerms: string[]): number {
  const title = String(reference.title ?? "").toLowerCase();
  const heading = String(reference.headingPath ?? "").toLowerCase();
  const snippet = String(reference.snippet ?? "").toLowerCase();
  let topicScore = 0;
  for (const term of focusTerms) {
    if (title.includes(term)) topicScore += 10;
    else if (heading.includes(term)) topicScore += 7;
    else if (snippet.includes(term)) topicScore += 2;
  }
  return topicScore;
}

const GENERIC_SUPPORT_SEARCH_TERMS = new Set([
  "the",
  "and",
  "for",
  "with",
  "that",
  "this",
  "from",
  "into",
  "ones",
  "onesql",
  "openapi",
  "scope",
  "scopes",
  "support",
  "supports",
  "supported",
  "documentation",
  "documented",
  "current",
  "query",
  "queries",
  "issue",
  "issues",
  "当前",
  "文档",
  "说明",
  "支持",
  "可以",
  "需要"
]);

function extractSupportSearchTerms(value: string): string[] {
  const normalized = String(value ?? "").toLowerCase();
  const exactAscii = [...normalized.matchAll(/[a-z0-9:_./-]{2,}/g)].map((match) => match[0]);
  const splitAscii = exactAscii.flatMap((token) => token.split(/[:/._-]+/).map((item) => item.trim()).filter((item) => item.length >= 3));
  const cjk = [...normalized.matchAll(/[\u4e00-\u9fff]{2,}/g)].map((match) => match[0]);
  return uniqueStrings([...exactAscii, ...splitAscii, ...cjk], 40);
}

function isGenericSupportSearchTerm(term: string): boolean {
  const normalized = term.trim().toLowerCase();
  return !normalized || normalized.length <= 2 || GENERIC_SUPPORT_SEARCH_TERMS.has(normalized);
}

function scoreSupportTextAgainstTerms(text: string, terms: string[]): number {
  const normalizedText = text.toLowerCase();
  let score = 0;
  for (const term of terms) {
    if (isGenericSupportSearchTerm(term)) continue;
    if (normalizedText.includes(term)) {
      score += /[:/._-]/.test(term) || term.length >= 6 ? 12 : 7;
    } else if (/^[a-z0-9:_./-]{4,}$/i.test(term)) {
      score -= 4;
    }
  }
  return score;
}

function extractDocumentedScopeValue(text: string): string | null {
  const match = String(text ?? "").match(/\b(?:read|write):[a-z0-9:_-]+\b/i);
  return match?.[0]?.trim() || null;
}

function scoreClaimFocusFit(claimText: string, query: string, caseFrame: SupportCaseFrame): number {
  const focusTerms = collectFocusTerms(query, caseFrame);
  const focusText = focusTerms.join(" ").toLowerCase();
  let score = 0;
  for (const term of extractSupportSearchTerms(claimText)) {
    if (isGenericSupportSearchTerm(term)) continue;
    if (tokenMatchesFocus(term, focusText) || focusText.includes(term)) {
      score += /^[a-z0-9:_./-]{4,}$/i.test(term) ? 8 : 4;
    } else if (/^[a-z0-9:_./-]{4,}$/i.test(term)) {
      score -= 4;
    }
  }
  const scopeValue = extractDocumentedScopeValue(claimText);
  if (scopeValue) {
    const targetIntents = collectApiOperationIntents(query, caseFrame);
    score += scorePermissionScopeFit(scopeValue, focusTerms);
    score += scoreApiScopeAccessFit(scopeValue, targetIntents);
  }
  return score;
}

function scoreReferenceForSupportedClaim(input: {
  reference: SearchReference;
  claimText: string;
  query: string;
  caseFrame: SupportCaseFrame;
}): number {
  const profile = getReferenceSupportProfile(input.reference);
  const semanticText = getReferenceSemanticText(input.reference).toLowerCase();
  const focusTerms = collectFocusTerms(input.query, input.caseFrame);
  const claimTerms = extractSupportSearchTerms(input.claimText);
  const normalizedClaimText = input.claimText.toLowerCase();
  const headingLabel = shortHeadingLabel(input.reference.headingPath).toLowerCase();
  let score = Math.round(input.reference.score * 10);
  score += scoreReferenceTopicMatch(input.reference, focusTerms);
  score += scoreSupportTextAgainstTerms(`${profile.title} ${profile.heading} ${semanticText}`, claimTerms);
  if (headingLabel && normalizedClaimText.includes(headingLabel)) score += 28;
  if (profile.title && normalizedClaimText.includes(profile.title)) score += 10;
  score += scoreObjectTypeFocusFit(profile.objectType, claimTerms);
  for (const requiredDocKind of input.caseFrame.required_doc_kinds ?? []) {
    score += scoreRequiredDocKindForReference(input.reference, requiredDocKind);
  }
  if (input.caseFrame.question_type === "api_scope_auth" && referenceHasPermissionSignal(input.reference)) {
    score += 12;
  }
  if (String(input.caseFrame.question_type ?? "").startsWith("api_")) {
    if (profile.productArea === "openapi") score += 12;
    if (/\bonesql\b|syntax|query language|expression|reference/.test(semanticText)) score += 10;
    if (profile.productArea && profile.productArea !== "openapi") score -= 10;
    const operationSignature = extractApiOperationSignature(input.reference);
    if (operationSignature.method || operationSignature.path) {
      const targetIntents = collectApiOperationIntents(input.query, input.caseFrame);
      score += scoreApiIntentAlignment(
        targetIntents,
        classifyApiOperationCandidate({
          method: operationSignature.method,
          path: operationSignature.path,
          title: input.reference.title,
          snippet: semanticText
        })
      );
      score += scoreApiOperationTitleIntentFit(profile.title, targetIntents);
    }
  }
  if (
    String(input.reference.headingPath ?? "").toUpperCase() === "ROOT" &&
    /overview|introduction|说明|介绍/.test(`${profile.title} ${profile.heading}`.toLowerCase())
  ) {
    score -= 8;
  }
  if (
    input.caseFrame.question_type === "capability_confirmation" &&
    /overview|introduction|部署说明|说明阅读/.test(semanticText) &&
    !/ubuntu|red hat|centos|linux|requirement|requirements|操作系统|环境要求|支持/.test(semanticText)
  ) {
    score -= 10;
  }
  return score;
}

function reanchorSupportedClaimCitationIds(input: {
  claimText: string;
  citationIds: string[];
  candidateReferences: SearchReference[];
  evidenceById: Map<string, SearchReference>;
  query: string;
  caseFrame: SupportCaseFrame;
}): string[] {
  const scoredCandidates = input.candidateReferences
    .map((reference) => ({
      evidenceId: resolveSearchReferenceEvidenceId(reference),
      score: scoreReferenceForSupportedClaim({
        reference,
        claimText: input.claimText,
        query: input.query,
        caseFrame: input.caseFrame
      })
    }))
    .sort((left, right) => right.score - left.score);
  if (!scoredCandidates.length) return uniqueStrings(input.citationIds, 2);

  const currentCandidates = uniqueStrings(input.citationIds, 4)
    .map((citationId) => {
      const reference = input.evidenceById.get(citationId);
      if (!reference) return null;
      return {
        evidenceId: citationId,
        score: scoreReferenceForSupportedClaim({
          reference,
          claimText: input.claimText,
          query: input.query,
          caseFrame: input.caseFrame
        })
      };
    })
    .filter((item): item is { evidenceId: string; score: number } => Boolean(item))
    .sort((left, right) => right.score - left.score);

  const anchoredCurrentCandidate = currentCandidates.find((candidate) => {
    const reference = input.evidenceById.get(candidate.evidenceId);
    if (!reference) return false;
    const headingLabel = shortHeadingLabel(reference.headingPath).toLowerCase();
    const title = String(reference.title ?? "").trim().toLowerCase();
    const normalizedClaimText = input.claimText.toLowerCase();
    return Boolean(
      (headingLabel && normalizedClaimText.includes(headingLabel)) || (title && normalizedClaimText.includes(title))
    );
  });
  if (anchoredCurrentCandidate) {
    return [anchoredCurrentCandidate.evidenceId];
  }

  const currentBestScore = currentCandidates[0]?.score ?? Number.NEGATIVE_INFINITY;
  const bestOverall = scoredCandidates[0];
  if (
    input.citationIds.length > 0 &&
    bestOverall.score >= 24 &&
    (currentBestScore === Number.NEGATIVE_INFINITY || bestOverall.score >= currentBestScore + 16)
  ) {
    return [bestOverall.evidenceId];
  }
  const preferred = currentCandidates.length ? currentCandidates : scoredCandidates.filter((item) => item.score > 0);
  return uniqueStrings(preferred.map((item) => item.evidenceId), 2);
}

function maxFocusedSupportedClaimCount(caseFrame: SupportCaseFrame): number {
  switch (caseFrame.question_type) {
    case "api_scope_auth":
    case "api_endpoint_lookup":
    case "api_field_lookup":
      return 1;
    case "capability_confirmation":
      return caseFrame.product_area === "deployment" ? 3 : 1;
    case "how_to_product":
    case "config_setup":
    case "troubleshooting":
      return 2;
    default:
      return String(caseFrame.question_type ?? "").startsWith("api_") ? 1 : 2;
  }
}

function refineVerificationForAnswer(input: {
  verification: SupportVerificationResult;
  evidenceBundle: SupportEvidenceBundle;
  query: string;
  caseFrame: SupportCaseFrame;
}): SupportVerificationResult {
  const candidateReferences = [...input.evidenceBundle.primary, ...input.evidenceBundle.supplemental].filter(
    (item) => item.authority === "canonical_visible"
  );
  const evidenceById = new Map(candidateReferences.map((item) => [resolveSearchReferenceEvidenceId(item), item] as const));
  const unsupportedClaims = input.verification.claim_to_citation_map.filter(
    (claim) => claim.verdict !== "verified" && claim.verdict !== "supported_inference"
  );
  const rankedSupportedClaims = input.verification.claim_to_citation_map
    .filter((claim) => (claim.verdict === "verified" || claim.verdict === "supported_inference") && claim.citation_ids.length > 0)
    .map((claim) => {
      const repairedCitationIds = reanchorSupportedClaimCitationIds({
        claimText: claim.text,
        citationIds: claim.citation_ids,
        candidateReferences,
        evidenceById,
        query: input.query,
        caseFrame: input.caseFrame
      });
      const bestCitationScore = repairedCitationIds.reduce((best, citationId) => {
        const reference = evidenceById.get(citationId);
        if (!reference) return best;
        return Math.max(
          best,
          scoreReferenceForSupportedClaim({
            reference,
            claimText: claim.text,
            query: input.query,
            caseFrame: input.caseFrame
          })
        );
      }, Number.NEGATIVE_INFINITY);
      return {
        claim: {
          ...claim,
          citation_ids: repairedCitationIds
        },
        score:
          scoreClaimFocusFit(claim.text, input.query, input.caseFrame) +
          (Number.isFinite(bestCitationScore) ? bestCitationScore : 0)
      };
    })
    .sort((left, right) => right.score - left.score);

  const maxClaims = maxFocusedSupportedClaimCount(input.caseFrame);
  const topScore = rankedSupportedClaims[0]?.score ?? 0;
  const focusedSupportedClaims = rankedSupportedClaims
    .filter(({ score }, index) => index === 0 || (index < maxClaims && score >= topScore - 18))
    .map((item) => item.claim);
  const supportedClaims = focusedSupportedClaims.length
    ? focusedSupportedClaims
    : rankedSupportedClaims[0]
    ? [rankedSupportedClaims[0].claim]
    : [];
  const supportedCitationIds = uniqueStrings(supportedClaims.flatMap((claim) => claim.citation_ids), 6);
  const unsupportedTexts = uniqueStrings(
    [
      ...input.verification.unsupported_claims,
      ...unsupportedClaims.map((claim) => claim.text)
    ],
    12
  );

  return {
    verdict:
      supportedClaims.length === 0
        ? "unsupported"
        : unsupportedTexts.length === 0 && input.verification.verdict === "verified"
        ? "verified"
        : "partial",
    summary: input.verification.summary,
    unsupported_claims: unsupportedTexts,
    missing_info: input.verification.missing_info,
    verified_citation_ids: supportedCitationIds,
    display_citation_ids: uniqueStrings(supportedClaims.flatMap((claim) => claim.citation_ids), 3),
    verified_claims: supportedClaims.map((claim) => claim.text),
    claim_to_citation_map: [...supportedClaims, ...unsupportedClaims]
  };
}

function scoreVerificationCandidate(
  verification: SupportVerificationResult,
  evidenceBundle: SupportEvidenceBundle,
  query: string,
  caseFrame: SupportCaseFrame
): number {
  const supportedClaims = supportedVerificationClaims(verification);
  const evidenceById = new Map(
    [...evidenceBundle.primary, ...evidenceBundle.supplemental]
      .filter((item) => item.authority === "canonical_visible")
      .map((item) => [resolveSearchReferenceEvidenceId(item), item] as const)
  );
  let score = 0;
  score += supportedClaims.length * 40;
  score += verification.display_citation_ids.length * 18;
  score -= verification.unsupported_claims.length * 8;
  for (const claim of supportedClaims) {
    score += scoreClaimFocusFit(claim.text, query, caseFrame);
    for (const citationId of claim.citation_ids) {
      const reference = evidenceById.get(citationId);
      if (!reference) continue;
      score += scoreReferenceForSupportedClaim({
        reference,
        claimText: claim.text,
        query,
        caseFrame
      });
    }
  }
  return score;
}

function pickBestVerificationCandidate(input: {
  query: string;
  caseFrame: SupportCaseFrame;
  evidenceBundle: SupportEvidenceBundle;
  primary: SupportVerificationResult;
  rebound: SupportVerificationResult | null;
  writerBound: SupportVerificationResult;
}): SupportVerificationResult {
  const candidates = [input.primary, input.rebound].filter(
    (candidate): candidate is SupportVerificationResult => Boolean(candidate)
  );
  const supportedCandidates = candidates.filter((candidate) => supportedVerificationClaims(candidate).length > 0);
  if (supportedCandidates.length > 0) {
    return [...supportedCandidates].sort(
      (a, b) =>
        scoreVerificationCandidate(b, input.evidenceBundle, input.query, input.caseFrame) -
        scoreVerificationCandidate(a, input.evidenceBundle, input.query, input.caseFrame)
    )[0];
  }
  const explicitlyReviewedCandidates = candidates.filter((candidate) => candidate.claim_to_citation_map.length > 0);
  if (explicitlyReviewedCandidates.length > 0) {
    return [...explicitlyReviewedCandidates].sort(
      (a, b) =>
        scoreVerificationCandidate(b, input.evidenceBundle, input.query, input.caseFrame) -
        scoreVerificationCandidate(a, input.evidenceBundle, input.query, input.caseFrame)
    )[0];
  }
  return supportedVerificationClaims(input.writerBound).length > 0 && input.primary.claim_to_citation_map.length === 0
    ? input.writerBound
    : input.primary;
}

function preferWriterBoundVerificationForDelivery(input: {
  selected: SupportVerificationResult;
  writerBound: SupportVerificationResult;
  evidenceBundle: SupportEvidenceBundle;
  query: string;
  caseFrame: SupportCaseFrame;
}): SupportVerificationResult {
  const selectedSupportedClaims = supportedVerificationClaims(input.selected);
  const writerBoundSupportedClaims = supportedVerificationClaims(input.writerBound);
  if (selectedSupportedClaims.length === 0) {
    if (writerBoundSupportedClaims.length > 0) {
      return input.writerBound;
    }
    return input.selected;
  }
  if (writerBoundSupportedClaims.length === 0) {
    return input.selected;
  }
  const selectedScore = scoreVerificationCandidate(input.selected, input.evidenceBundle, input.query, input.caseFrame);
  const writerBoundScore = scoreVerificationCandidate(input.writerBound, input.evidenceBundle, input.query, input.caseFrame);
  const shouldPreferWriterBound =
    writerBoundScore >= selectedScore + 20 ||
    (input.selected.display_citation_ids.length === 0 && writerBoundScore > selectedScore);
  if (!shouldPreferWriterBound) {
    return input.selected;
  }
  return {
    ...input.selected,
    verified_citation_ids: input.writerBound.verified_citation_ids,
    display_citation_ids: input.writerBound.display_citation_ids,
    verified_claims: input.writerBound.verified_claims,
    claim_to_citation_map: [
      ...supportedVerificationClaims(input.writerBound),
      ...input.selected.claim_to_citation_map.filter((claim) => claim.verdict === "unsupported")
    ]
  };
}

function buildFallbackDirectAnswerFromSupportedClaims(input: {
  language: "zh" | "en";
  mode: SupportAnswer["mode"];
  supportedClaims: SupportVerificationResult["claim_to_citation_map"];
  fallback: SupportAnswer;
}): string {
  const maxLeadingClaims = input.supportedClaims.some((claim) => isStructuredBehaviorEvidenceFragment(claim.text)) ? 3 : 2;
  const leadingClaims = uniqueStrings(
    input.supportedClaims
      .filter((claim) => claim.kind === "verified_fact" || claim.kind === "grounded_inference")
      .map((claim) => claim.text),
    maxLeadingClaims
  );
  const explicitVerdict = leadingClaims.find((claim) => /could not confirm|does not explicitly|not explicitly|未明确|无法确认|没有明确/i.test(claim));
  if (!leadingClaims.length || (input.mode !== "grounded" && input.mode !== "partial")) {
    return input.fallback.direct_answer;
  }
  if (input.language === "zh") {
    return input.mode === "partial"
      ? explicitVerdict
        ? `${explicitVerdict}${leadingClaims.length > 1 ? ` 另外，${leadingClaims.filter((item) => item !== explicitVerdict).join("；")}` : ""}`
        : `基于当前文档，我可以先确认：${leadingClaims.join("；")}。其余部分还需要进一步确认。`
      : leadingClaims.join("；");
  }
  return input.mode === "partial"
    ? explicitVerdict
      ? `${explicitVerdict}${leadingClaims.length > 1 ? ` ${leadingClaims.filter((item) => item !== explicitVerdict).join(" ")}` : ""}`
      : `Based on the current documentation, I can confirm this much: ${leadingClaims.join("; ")}. The remaining part is still not fully confirmed.`
    : leadingClaims.join("; ");
}

function isGenericUncertaintyDirectAnswer(value: string): boolean {
  const normalized = normalizeComparableText(value);
  if (!normalized) return false;
  return /i still need|need one critical detail|missing detail|cannot confirm|could not confirm|unable to confirm|need further confirmation|not enough (verified )?evidence|还缺少|还需要|无法确认|不能确认|需要进一步确认|没有足够(的)?已验证证据|还不能给出可靠结论/.test(
    normalized
  );
}

function buildSupportedClaimsSections(input: {
  language: "zh" | "en";
  supportedClaims: SupportVerificationResult["claim_to_citation_map"];
  stillNeedToConfirm: string[];
  mode: SupportAnswer["mode"];
}): SupportAnswer["sections"] {
  const confirmedItems = uniqueStrings(
    input.supportedClaims
      .filter((claim) => claim.kind === "verified_fact" || claim.kind === "grounded_inference")
      .map((claim) => claim.text),
    4
  );
  if (!confirmedItems.length) return [];

  return [
    {
      kind: "bullet_list",
      title: localizedSectionTitle(input.language, "已确认事实", "Confirmed facts"),
      items: confirmedItems
    },
    ...(input.mode === "partial" && input.stillNeedToConfirm.length
      ? [
          {
            kind: "bullet_list" as const,
            title: localizedSectionTitle(input.language, "还需要确认", "Still need to confirm"),
            items: input.stillNeedToConfirm
          }
        ]
      : [])
  ];
}

function buildFallbackSectionsFromDraft(draft: SpecialistDraftAnswer, language: "zh" | "en"): SupportAnswer["sections"] {
  const title = (zh: string, en: string) => localizedSectionTitle(language, zh, en);
  switch (draft.render_variant) {
    case "api": {
      const keyNotes = uniqueStrings(
        [
          draft.response_field_hint
            ? language === "zh"
              ? `返回字段：${draft.response_field_hint}`
              : `Response field: ${draft.response_field_hint}`
            : undefined,
          draft.important_note,
          draft.related_variant
            ? language === "zh"
              ? `相关变体：${draft.related_variant}`
              : `Related variant: ${draft.related_variant}`
            : undefined
        ],
        4
      );
      return [
        ...(draft.api_method || draft.api_path
          ? [
              {
                kind: "api_card" as const,
                title: title("接口信息", "API information"),
                method: draft.api_method ?? "",
                path: draft.api_path ?? "",
                required_params: draft.required_params ?? [],
                auth_scope: draft.auth_scope ?? [],
                response_field_hint: draft.response_field_hint,
                important_note: draft.important_note,
                related_variant: draft.related_variant
              }
            ]
          : []),
        ...(draft.required_params?.length
          ? [{ kind: "bullet_list" as const, title: title("必填参数及获取方式", "Required parameters and how to get them"), items: draft.required_params }]
          : []),
        ...(keyNotes.length ? [{ kind: "bullet_list" as const, title: title("关键说明", "Key notes"), items: keyNotes }] : [])
      ];
    }
    case "how_to":
      return [
        ...(draft.steps?.length ? [{ kind: "bullet_list" as const, title: title("操作步骤", "Steps"), items: draft.steps }] : []),
        ...(draft.prerequisites?.length
          ? [{ kind: "bullet_list" as const, title: title("前提条件", "Prerequisites"), items: draft.prerequisites }]
          : []),
        ...(draft.limits_or_notes?.length
          ? [{ kind: "bullet_list" as const, title: title("关键说明", "Notes"), items: draft.limits_or_notes }]
          : [])
      ];
    case "behavior":
      return [
        ...(draft.most_likely_explanation
          ? [{ kind: "paragraph" as const, title: title("结论说明", "Conclusion"), body: draft.most_likely_explanation }]
          : []),
        ...(draft.confirmed_facts?.length
          ? [{ kind: "bullet_list" as const, title: title("已确认事实", "Confirmed facts"), items: draft.confirmed_facts }]
          : []),
        ...(draft.what_to_check_next?.length
          ? [{ kind: "bullet_list" as const, title: title("需要注意", "What to watch"), items: draft.what_to_check_next }]
          : [])
      ];
    case "troubleshooting":
      return [
        ...(draft.most_likely_causes?.length
          ? [{ kind: "bullet_list" as const, title: title("高概率原因", "Most likely causes"), items: draft.most_likely_causes }]
          : []),
        ...(draft.recommended_checks?.length
          ? [{ kind: "bullet_list" as const, title: title("直接排查动作", "Checks to run now"), items: draft.recommended_checks }]
          : []),
        ...(draft.required_followup_info?.length
          ? [{ kind: "bullet_list" as const, title: title("还需要补充", "Still needed"), items: draft.required_followup_info }]
          : [])
      ];
    default:
      return [];
  }
}

function mergePreferredSupportSections(
  preferredSections: SupportAnswer["sections"],
  specialistSections: SupportAnswer["sections"]
): SupportAnswer["sections"] {
  if (!specialistSections.length) return preferredSections;
  const mergedSections = [...specialistSections];
  for (const preferredSection of preferredSections) {
    const existingIndex = mergedSections.findIndex(
      (section) => section.kind === preferredSection.kind && section.title === preferredSection.title
    );
    if (existingIndex >= 0) {
      mergedSections[existingIndex] = preferredSection;
      continue;
    }
    mergedSections.push(preferredSection);
  }
  return mergedSections;
}

function buildSupportAnswerFromDraft(input: {
  language: "zh" | "en";
  mode: SupportAnswer["mode"];
  route: SupportQuestionRoute;
  draft: SpecialistDraftAnswer;
  verification: SupportVerificationResult;
  missingInfo: string[];
  composed?: Omit<SupportAnswer, "mode"> | null;
}): SupportAnswer {
  const supportedClaims = supportedVerificationClaims(input.verification);
  const preferComposedOnly = input.mode === "clarification" || input.mode === "handoff";
  const why = uniqueStrings(
    preferComposedOnly
      ? [...(input.composed?.why ?? [])]
      : [
          ...(input.composed?.why ?? []),
          ...supportedClaims.filter((claim) => claim.kind === "verified_fact" || claim.kind === "grounded_inference").map((claim) => claim.text)
        ],
    4
  );
  const whatToDoNow = uniqueStrings(
    preferComposedOnly
      ? [...(input.composed?.what_to_do_now ?? [])]
      : [
          ...(input.composed?.what_to_do_now ?? []),
          ...filterUnsupported(input.draft.next_actions, input.verification.unsupported_claims)
        ],
    4
  );
  const stillNeedToConfirm = uniqueStrings(
    preferComposedOnly
      ? [...(input.composed?.still_need_to_confirm ?? []), ...input.verification.missing_info, ...input.missingInfo]
      : [...(input.composed?.still_need_to_confirm ?? []), ...input.draft.unknowns, ...input.verification.missing_info, ...input.missingInfo],
    4
  );
  const fallback = fallbackSupportAnswer({
    language: input.language,
    mode: input.mode,
    route: input.route,
    missingInfo: stillNeedToConfirm
  });
  const safeDraftDirectAnswer =
    input.draft.direct_answer?.trim() && !overlapsUnsupportedClaim(input.draft.direct_answer, input.verification.unsupported_claims)
      ? input.draft.direct_answer.trim()
      : "";
  const safeComposedDirectAnswer =
    input.composed?.direct_answer?.trim() && !overlapsUnsupportedClaim(input.composed.direct_answer, input.verification.unsupported_claims)
      ? input.composed.direct_answer.trim()
      : "";
  const supportedClaimDirectAnswer = buildFallbackDirectAnswerFromSupportedClaims({
    language: input.language,
    mode: input.mode,
    supportedClaims,
    fallback
  });
  const preferredDirectAnswerCandidate =
    safeComposedDirectAnswer ||
    safeDraftDirectAnswer ||
    (input.mode === "grounded" || input.mode === "partial" ? supportedClaimDirectAnswer : "");
  const directAnswer =
    preferredDirectAnswerCandidate || supportedClaimDirectAnswer || fallback.direct_answer;
  const fallbackSections = buildFallbackSectionsFromDraft(input.draft, input.language);
  const supportedClaimSections = buildSupportedClaimsSections({
    language: input.language,
    supportedClaims,
    stillNeedToConfirm,
    mode: input.mode
  });
  const minimalStructuredSections =
    input.mode === "clarification" && stillNeedToConfirm.length
      ? [
          {
            kind: "bullet_list" as const,
            title: localizedSectionTitle(input.language, "还需要你补充", "Need from you"),
            items: stillNeedToConfirm
          }
        ]
      : input.mode === "handoff" && whatToDoNow.length
      ? [
          {
            kind: "bullet_list" as const,
            title: localizedSectionTitle(input.language, "建议你现在做什么", "What to do now"),
            items: whatToDoNow
          }
        ]
      : input.mode === "partial" && stillNeedToConfirm.length && !fallbackSections.length
      ? [
          {
            kind: "bullet_list" as const,
            title: localizedSectionTitle(input.language, "还需要确认", "Still need to confirm"),
            items: stillNeedToConfirm
          }
        ]
      : [];
  const sections =
    input.composed?.sections?.length
      ? input.composed.sections
      : fallbackSections.length
      ? fallbackSections
      : supportedClaimSections.length
      ? supportedClaimSections
      : minimalStructuredSections.length
      ? minimalStructuredSections
      : fallback.sections;
  return {
    question_type: input.composed?.question_type ?? input.draft.question_type ?? input.route.question_type,
    render_variant: input.composed?.render_variant ?? input.draft.render_variant ?? fallback.render_variant,
    mode: input.mode,
    direct_answer: directAnswer,
    sections,
    why: why.length ? why : fallback.why,
    what_to_do_now: whatToDoNow.length ? whatToDoNow : fallback.what_to_do_now,
    still_need_to_confirm:
      input.mode === "grounded" && input.verification.verdict === "verified"
        ? []
        : stillNeedToConfirm.length
        ? stillNeedToConfirm
        : fallback.still_need_to_confirm
  };
}

function hasGroundedDraftClaims(draft: SpecialistDraftAnswer): boolean {
  return draft.claims.some(
    (claim) =>
      claim.evidence_ids.length > 0 && (claim.kind === "verified_fact" || claim.kind === "grounded_inference")
  );
}

function hasGroundedDraftClaimsInEvidence(draft: SpecialistDraftAnswer, evidenceBundle: SupportEvidenceBundle): boolean {
  const evidenceIds = new Set(
    [...evidenceBundle.primary, ...evidenceBundle.supplemental].map((reference) => resolveSearchReferenceEvidenceId(reference))
  );
  return draft.claims.some(
    (claim) =>
      (claim.kind === "verified_fact" || claim.kind === "grounded_inference") &&
      claim.evidence_ids.some((evidenceId) => evidenceIds.has(evidenceId))
  );
}

function shortHeadingLabel(headingPath?: string): string {
  const heading = String(headingPath ?? "").trim();
  if (!heading) return "";
  const parts = heading.split(">").map((item) => item.trim()).filter(Boolean);
  return (parts[parts.length - 1] ?? heading).replace(/^[0-9.\-\s\\]+/, "").trim();
}

function normalizeProcedureText(input: string): string {
  return input.replace(/\s+/g, " ").trim();
}

function stripProcedureMarkup(line: string): string {
  return normalizeProcedureText(
    line
      .replace(/<RegionBlock[^>]*>/gi, " ")
      .replace(/<\/RegionBlock>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/\[(.*?)\]\((.*?)\)/g, "$1")
      .replace(/`([^`]*)`/g, "$1")
      .replace(/\*\*(.*?)\*\*/g, "$1")
      .replace(/\*(.*?)\*/g, "$1")
      .replace(/_{1,2}([^_]+)_{1,2}/g, "$1")
      .replace(/^>\s+/, "")
      .replace(/^#{1,6}\s+/, "")
      .replace(/&nbsp;|&#x20;/gi, " ")
  );
}

function sanitizeProcedureItem(input: string): string {
  let value = stripProcedureMarkup(input)
    .replace(/^\s*(?:[-*+]\s+|\d+[.)]\s+|[（(]?\d+[）)]\s*)/, "")
    .replace(/^[：:;,，；、.\-\s]+/, "")
    .replace(/[：:;,，；、\s]+$/, "")
    .trim();
  if (value.length > 220) value = `${value.slice(0, 217).trimEnd()}...`;
  return value;
}

function pushProcedureItem(target: string[], input: string, limit: number): void {
  const value = sanitizeProcedureItem(input);
  if (!value) return;
  if (target.includes(value)) return;
  target.push(value);
  if (target.length > limit) target.length = limit;
}

function isProcedureHeading(text: string): boolean {
  return /(操作步骤|操作方式|步骤|流程|procedure|procedures|steps?|how to|guide|guidance|执行方式|处理方式|处理步骤|使用步骤|配置步骤|安装步骤)/i.test(
    text
  );
}

function isProcedureNoteHeading(text: string): boolean {
  return /(注意事项|注意|说明|提示|前提|要求|限制|风险|备注|校验|验证|prerequisite|note|notes|warning|important|requirement|requirements|validation|risk)/i.test(
    text
  );
}

function looksLikeProcedureAction(text: string): boolean {
  if (!text || text.length < 4) return false;
  if (
    /^(先|首先|然后|再|接着|最后|执行|配置|确认|准备|提供|申请|登录|创建|设置|使用|输入|保存|安装|升级|重启|检查|联系|导出|导入|运行|开放|打通|关闭|开启|重建|重置|恢复|进入|增加|添加|点击|切换|选择|下载|上传|复现|抓取|查看|打开|共享)/.test(
      text
    )
  ) {
    return true;
  }
  if (
    /^(follow|run|open|configure|confirm|prepare|provide|apply|log in|create|set|use|enter|save|install|upgrade|restart|check|contact|export|import|rebuild|reset|restore|click|switch|select|download|upload|reproduce|capture|review|share|choose|navigate)\b/i.test(
      text
    )
  ) {
    return true;
  }
  return /(?:必须|需|需要|建议|推荐|确保|提前|用于|可按需|should|must|need to|required to|recommended to)/i.test(text);
}

function looksLikeProcedureNote(text: string): boolean {
  if (/^(注意|说明|提示|前提|要求|限制|风险|备注|建议|必须|需|需要|推荐|校验|验证)/.test(text)) return true;
  return /^(note|warning|important|prerequisite|requirement|risk|validate|validation)\b/i.test(text);
}

function shouldPromoteProcedureHeadingAsStep(text: string): boolean {
  const normalized = sanitizeProcedureItem(text);
  if (!normalized || normalized.length > 80) return false;
  if (/^(info|notice|tip|faq|overview)$/i.test(normalized)) return false;
  if (/^[A-Z][A-Z\s/_-]{3,}$/.test(normalized)) return false;
  return looksLikeProcedureAction(normalized) || /^\d+[.)]\s+/.test(text);
}

function isProcedureShellNoise(reference: SearchReference, text: string): boolean {
  const normalized = sanitizeProcedureItem(text);
  if (!normalized) return true;
  if (/^(info|notice|tip|faq|overview)$/i.test(normalized)) return true;
  if (/^[A-Z][A-Z\s/_-]{3,}$/.test(normalized)) return true;

  const normalizedTitle = sanitizeProcedureItem(reference.title);
  return normalized === normalizedTitle;
}

function appendProcedureDetailToLastStep(target: string[], detail: string): void {
  const normalizedDetail = sanitizeProcedureItem(detail);
  const last = target[target.length - 1];
  if (!last || !normalizedDetail) return;
  if (last.toLowerCase().includes(normalizedDetail.toLowerCase())) return;
  target[target.length - 1] = normalizeProcedureText(`${last} (${normalizedDetail})`);
}

function procedureSupplementOverlap(
  primary: SearchReference,
  candidate: SearchReference,
  query: string,
  caseFrame: SupportCaseFrame
): number {
  const primaryTerms = new Set(
    collectProcedureSemanticTerms(
      [primary.title, primary.headingPath ?? "", getReferenceSemanticText(primary)].filter(Boolean).join(" ")
    )
  );
  const candidateTerms = new Set(
    collectProcedureSemanticTerms(
      [candidate.title, candidate.headingPath ?? "", getReferenceSemanticText(candidate)].filter(Boolean).join(" ")
    )
  );
  const focusTerms = collectProcedureSemanticTerms(
    [query, caseFrame.object, ...(caseFrame.retrieval_queries ?? [])].filter(Boolean).join(" ")
  );
  let overlap = 0;
  for (const term of focusTerms) {
    if (!primaryTerms.has(term) || !candidateTerms.has(term)) continue;
    overlap += 1;
    if (overlap >= 2) return overlap;
  }
  return overlap;
}

function isProcedureSupplementReferenceRelevant(
  primary: SearchReference,
  candidate: SearchReference,
  query: string,
  caseFrame: SupportCaseFrame
): boolean {
  const primarySourceUrl = String(primary.sourceUrl ?? "").trim();
  const candidateSourceUrl = String(candidate.sourceUrl ?? "").trim();
  if (primarySourceUrl && candidateSourceUrl && primarySourceUrl === candidateSourceUrl) return true;

  const primaryPath = canonicalDocsPath(primary.path);
  const candidatePath = canonicalDocsPath(candidate.path);
  if (primaryPath && candidatePath && primaryPath === candidatePath) return true;

  return procedureSupplementOverlap(primary, candidate, query, caseFrame) >= 2;
}

const PUBLISHED_DOCS_EXPANSION_CACHE_TTL_MS = 10 * 60 * 1000;
const publishedDocsExpansionCache = new Map<string, { expiresAt: number; source: string }>();
const publishedDocsExpansionInFlight = new Map<string, Promise<string | null>>();

function trimPublishedDocsExpansionCache(now = Date.now()): void {
  for (const [key, value] of publishedDocsExpansionCache.entries()) {
    if (value.expiresAt <= now) {
      publishedDocsExpansionCache.delete(key);
    }
  }
  while (publishedDocsExpansionCache.size > 32) {
    const oldestKey = publishedDocsExpansionCache.keys().next().value;
    if (!oldestKey) break;
    publishedDocsExpansionCache.delete(oldestKey);
  }
}

function decodeHtmlEntities(source: string): string {
  return source
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#([0-9]+);/g, (_, value: string) => String.fromCodePoint(parseInt(value, 10)));
}

function renderHtmlTableRows(source: string): string {
  return source.replace(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi, (_, rowSource: string) => {
    const cells = [...rowSource.matchAll(/<(?:td|th)\b[^>]*>([\s\S]*?)<\/(?:td|th)>/gi)]
      .map((match) =>
        decodeHtmlEntities(
          String(match[1] ?? "")
            .replace(/<br\s*\/?>/gi, " ")
            .replace(/<[^>]+>/g, " ")
            .replace(/\s+/g, " ")
            .trim()
        )
      )
      .filter(Boolean);
    return cells.length ? `\n${cells.join(" | ")}\n` : "\n";
  });
}

function extractPublishedDocsArticleText(source: string): string {
  const scoped =
    source.match(/<article\b[^>]*>([\s\S]*?)<\/article>/i)?.[1] ??
    source.match(/<main\b[^>]*>([\s\S]*?)<\/main>/i)?.[1] ??
    source;
  const normalized = renderHtmlTableRows(scoped)
    .replace(/<script[\s\S]*?<\/script>/gi, "\n")
    .replace(/<style[\s\S]*?<\/style>/gi, "\n")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, "\n")
    .replace(/<svg[\s\S]*?<\/svg>/gi, "\n")
    .replace(/<h([1-6])\b[^>]*>/gi, (_, level: string) => `\n${"#".repeat(Number(level))} `)
    .replace(/<\/h[1-6]>/gi, "\n")
    .replace(/<li\b[^>]*>/gi, "\n- ")
    .replace(/<\/li>/gi, "\n")
    .replace(/<blockquote\b[^>]*>/gi, "\n> ")
    .replace(/<\/blockquote>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<(?:p|div|section|article|main|ol|ul|table|thead|tbody|tr|td|th|pre|code)\b[^>]*>/gi, "\n")
    .replace(/<\/(?:p|div|section|article|main|ol|ul|table|thead|tbody|tr|td|th|pre|code)>/gi, "\n")
    .replace(/<[^>]+>/g, " ");
  return decodeHtmlEntities(normalized)
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .filter((line) => !/^(skip to main content|on this page)$/i.test(line))
    .join("\n");
}

async function loadPublishedDocsExpansionSource(reference: SearchReference): Promise<string | null> {
  const sourceUrl = String(reference.sourceUrl ?? "").trim();
  if (!sourceUrl.startsWith("https://docs.ones.com/")) return null;
  if (reference.authority !== "canonical_visible") return null;
  if (resolveLocalDocsMirrorPath(reference)) return null;

  const now = Date.now();
  trimPublishedDocsExpansionCache(now);
  const cached = publishedDocsExpansionCache.get(sourceUrl);
  if (cached && cached.expiresAt > now) {
    return cached.source;
  }
  const inFlight = publishedDocsExpansionInFlight.get(sourceUrl);
  if (inFlight) {
    return inFlight;
  }

  const loadingPromise = (async () => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2500);
    if (typeof (timeout as { unref?: () => void }).unref === "function") {
      (timeout as { unref: () => void }).unref();
    }

    try {
      const response = await fetchWithNodeCompat(sourceUrl, {
        headers: {
          accept: "text/html,application/xhtml+xml"
        },
        signal: controller.signal
      });
      if (!response.ok) return null;

      const raw = await response.text();
      const extracted = /<[^>]+>/.test(raw) ? extractPublishedDocsArticleText(raw) : raw.trim();
      const normalized = extracted.trim();
      if (!normalized) return null;

      publishedDocsExpansionCache.set(sourceUrl, {
        expiresAt: now + PUBLISHED_DOCS_EXPANSION_CACHE_TTL_MS,
        source: normalized.slice(0, 40_000)
      });
      trimPublishedDocsExpansionCache(now);
      return normalized.slice(0, 40_000);
    } catch {
      return null;
    } finally {
      clearTimeout(timeout);
      publishedDocsExpansionInFlight.delete(sourceUrl);
    }
  })();

  publishedDocsExpansionInFlight.set(sourceUrl, loadingPromise);
  return loadingPromise;
}

function scopeProcedureSourceLines(
  reference: SearchReference,
  source: string,
  allowHeadingScoping: boolean,
  fallbackToSnippetOnMissingHeading = false
): string[] {
  const lines = source.replace(/^---\s*\n[\s\S]*?\n---\s*(?:\n|$)/, "").split(/\r?\n/);
  const headingLabel = shortHeadingLabel(reference.headingPath);
  if (!allowHeadingScoping || !headingLabel || headingLabel.toUpperCase() === "ROOT") return lines.slice(0, 260);

  const normalizedHeading = stripProcedureMarkup(headingLabel).toLowerCase();
  let anchorIndex = -1;
  let anchorLevel = 0;
  for (let index = 0; index < lines.length; index += 1) {
    const matched = lines[index]?.match(/^\s*(#{1,6})\s+(.+)$/);
    if (!matched) continue;
    const candidate = stripProcedureMarkup(matched[2] ?? "").toLowerCase();
    if (!candidate) continue;
    if (candidate === normalizedHeading || candidate.includes(normalizedHeading) || normalizedHeading.includes(candidate)) {
      anchorIndex = index;
      anchorLevel = matched[1]?.length ?? 0;
      break;
    }
  }

  if (anchorIndex < 0) {
    if (fallbackToSnippetOnMissingHeading) {
      return String(reference.snippet ?? "")
        .split(/\r?\n/)
        .filter((line) => line.trim().length > 0)
        .slice(0, 40);
    }
    const firstHeadingIndex = lines.findIndex((line) => /^\s*#{1,6}\s+/.test(line));
    return (firstHeadingIndex >= 0 ? lines.slice(firstHeadingIndex) : lines).slice(0, 260);
  }

  const scoped = [lines[anchorIndex] ?? ""];
  for (let index = anchorIndex + 1; index < lines.length && scoped.length < 260; index += 1) {
    const matched = lines[index]?.match(/^\s*(#{1,6})\s+(.+)$/);
    if (matched && (matched[1]?.length ?? 0) <= anchorLevel) break;
    scoped.push(lines[index] ?? "");
  }
  return scoped;
}

function loadProcedureSourceLines(reference: SearchReference): string[] {
  const resolvedPath = resolveLocalDocsMirrorPath(reference);
  const source = (() => {
    if (!resolvedPath) return String(reference.snippet ?? "");
    try {
      return fs.readFileSync(resolvedPath, "utf8");
    } catch {
      return String(reference.snippet ?? "");
    }
  })();
  return scopeProcedureSourceLines(reference, source, Boolean(resolvedPath));
}

async function loadProcedureSourceLinesAsync(reference: SearchReference): Promise<string[]> {
  const resolvedPath = resolveLocalDocsMirrorPath(reference);
  if (resolvedPath) {
    try {
      return scopeProcedureSourceLines(reference, fs.readFileSync(resolvedPath, "utf8"), true);
    } catch {
      return scopeProcedureSourceLines(reference, String(reference.snippet ?? ""), false);
    }
  }

  const expandedSource = await loadPublishedDocsExpansionSource(reference);
  return scopeProcedureSourceLines(reference, expandedSource ?? String(reference.snippet ?? ""), Boolean(expandedSource));
}

function extractProcedureBlocksFromLines(reference: SearchReference, scopedLines: string[]): { steps: string[]; notes: string[] } {
  const steps: string[] = [];
  const notes: string[] = [];
  let sectionContext: "steps" | "notes" | null = null;
  let inCodeBlock = false;
  let codeLines: string[] = [];

  const flushCodeBlock = () => {
    if (!codeLines.length) return;
    const command = normalizeProcedureText(codeLines.join(" "));
    if (command && command.length <= 120 && codeLines.length <= 3 && steps.length > 0) {
      const last = steps[steps.length - 1] ?? "";
      if (last && !last.includes(command)) {
        steps[steps.length - 1] = `${last} (${command})`;
      }
    }
    codeLines = [];
  };

  for (const rawLine of scopedLines) {
    const line = String(rawLine ?? "");
    if (/^\s*```/.test(line)) {
      if (inCodeBlock) flushCodeBlock();
      inCodeBlock = !inCodeBlock;
      continue;
    }
    if (inCodeBlock) {
      const cleanedCode = sanitizeProcedureItem(line);
      if (cleanedCode) codeLines.push(cleanedCode);
      continue;
    }

    const headingMatch = line.match(/^\s*(#{1,6})\s+(.+)$/);
    if (headingMatch) {
      const headingText = sanitizeProcedureItem(headingMatch[2] ?? "");
      if (!headingText) continue;
      if (isProcedureNoteHeading(headingText)) {
        sectionContext = "notes";
        continue;
      }
      if (isProcedureHeading(headingText)) {
        sectionContext = "steps";
        continue;
      }
      if (
        (headingMatch[1]?.length ?? 0) >= 3 &&
        shouldPromoteProcedureHeadingAsStep(headingText) &&
        !isProcedureShellNoise(reference, headingText)
      ) {
        sectionContext = "steps";
        pushProcedureItem(steps, headingText, 6);
        continue;
      }
      sectionContext = null;
      continue;
    }

    if (!line.trim() || /^\s*import\s+/.test(line) || /^\s*api:\s*/.test(line) || /^\s*\|/.test(line)) continue;

    const cleaned = sanitizeProcedureItem(line);
    if (!cleaned) continue;
    if (isProcedureShellNoise(reference, cleaned)) continue;

    const bulletLike = /^\s*(?:[-*+]\s+|\d+[.)]\s+|[（(]?\d+[）)]\s*)/.test(line);
    if (sectionContext === "notes" || looksLikeProcedureNote(cleaned)) {
      pushProcedureItem(notes, cleaned, 5);
      continue;
    }
    if (sectionContext === "steps" && !bulletLike && !looksLikeProcedureAction(cleaned)) {
      if (steps.length > 0) {
        appendProcedureDetailToLastStep(steps, cleaned);
      } else {
        pushProcedureItem(notes, cleaned, 5);
      }
      continue;
    }
    if (sectionContext === "steps" || bulletLike || looksLikeProcedureAction(cleaned)) {
      pushProcedureItem(steps, cleaned, 6);
    }
  }

  if (inCodeBlock) flushCodeBlock();

  if (!steps.length || !notes.length) {
    const fallbackFragments = String(reference.snippet ?? "")
      .replace(/<[^>]+>/g, " ")
      .split(/。|；|\. |\n/)
      .map((item) => sanitizeProcedureItem(item))
      .filter(Boolean);
    for (const fragment of fallbackFragments) {
      if (!steps.length && looksLikeProcedureAction(fragment)) pushProcedureItem(steps, fragment, 6);
      else if (!notes.length && looksLikeProcedureNote(fragment)) pushProcedureItem(notes, fragment, 5);
      if (steps.length >= 4 && notes.length >= 2) break;
    }
  }

  return { steps, notes };
}

function extractProcedureBlocks(reference: SearchReference): { steps: string[]; notes: string[] } {
  return extractProcedureBlocksFromLines(reference, loadProcedureSourceLines(reference));
}

async function extractProcedureBlocksAsync(reference: SearchReference): Promise<{ steps: string[]; notes: string[] }> {
  return extractProcedureBlocksFromLines(reference, await loadProcedureSourceLinesAsync(reference));
}

function scoreProcedureReference(input: {
  reference: SearchReference;
  blocks: { steps: string[]; notes: string[] };
  query: string;
  caseFrame: SupportCaseFrame;
}): number {
  const { reference, blocks } = input;
  const profile = getReferenceSupportProfile(reference);
  const focusTerms = collectFocusTerms(input.query, input.caseFrame);
  const haystack = [
    getReferenceSemanticText(reference),
    reference.sourceUrl,
    reference.path
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  let score = Math.round(reference.score * 10);
  score += blocks.steps.length * 8;
  score += blocks.notes.length * 3;
  if (shortHeadingLabel(reference.headingPath)) score += 2;
  if (reference.sourceType === "local_docs") score += 2;
  if (profile.evidenceKind === "procedure") score += 6;
  else if (profile.evidenceKind === "troubleshooting") score += 4;
  if (!isApiShapedQuery(input.query) && profile.productArea === "openapi") score -= 18;
  for (const term of focusTerms) {
    const normalized = term.toLowerCase();
    if (!normalized) continue;
    if (haystack.includes(normalized)) score += normalized.length >= 4 ? 6 : 3;
  }
  return score;
}

function collectProcedureSemanticTerms(input: string): string[] {
  const normalized = String(input ?? "").toLowerCase();
  const ascii = [...normalized.matchAll(/[a-z0-9]{3,}/g)].map((match) => match[0]);
  const cjk = [...normalized.matchAll(/[\u4e00-\u9fff]{2,}/g)].map((match) => match[0]);
  return uniqueStrings([...ascii, ...cjk], 32);
}

function shouldPreserveRecoveredProcedureDraft(value: string, actionItems: string[]): boolean {
  const normalizedValue = String(value ?? "").trim();
  if (!normalizedValue) return false;
  if (!actionItems.length) return true;

  const actionTerms = new Set(actionItems.flatMap((item) => collectProcedureSemanticTerms(item)));
  if (!actionTerms.size) return true;

  let overlapCount = 0;
  for (const term of collectProcedureSemanticTerms(normalizedValue)) {
    if (!actionTerms.has(term)) continue;
    overlapCount += 1;
    if (overlapCount >= 2) return true;
  }
  return false;
}

type BehaviorEvidenceCandidate = {
  fragment: string;
  evidenceId: string;
  score: number;
  note: boolean;
  reference: SearchReference;
};

function normalizeBehaviorEvidenceFragment(fragment: string): string {
  return String(fragment ?? "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .replace(/^[-*•]\s*/, "")
    .trim();
}

function isStructuredBehaviorEvidenceFragment(fragment: string): boolean {
  const normalized = normalizeBehaviorEvidenceFragment(fragment);
  if (!normalized) return false;
  const labelValuePairs = normalized.match(/(?:^|[;；])\s*[^;:：|]{1,32}\s*[:：]\s*[^;；]+/g) ?? [];
  return labelValuePairs.length >= 2;
}

function looksLikeBehaviorEvidenceFragment(fragment: string): boolean {
  const normalized = normalizeBehaviorEvidenceFragment(fragment);
  if (!normalized || normalized.length < 12 || normalized.length > 320) return false;
  if (/^(title:|description:|slug:|sidebar_|hide_|custom_edit_url:|import )/i.test(normalized)) return false;
  if (isStructuredBehaviorEvidenceFragment(normalized)) return true;
  return /(supports?|supported|available|only|requires?|required|recommended|must|cannot|not support|unsupported|compatible|compatibility|支持|可用|仅|只在|要求|推荐|必须|不能|不支持|兼容|环境要求|系统要求|适用)/i.test(
    normalized
  );
}

function isRecommendationLikeFragment(fragment: string): boolean {
  return /(recommended|recommendation|建议|推荐)/i.test(fragment);
}

function sanitizeBehaviorSourceLine(line: string): string {
  return normalizeBehaviorEvidenceFragment(
    String(line ?? "")
      .replace(/^\s*(?:[-*+]\s+|\d+[.)]\s+|[（(]?\d+[）)]\s*)/, "")
      .replace(/^\s*#+\s*/, "")
  );
}

function appendBehaviorHeadingContext(heading: string, fragment: string): string {
  const normalizedHeading = sanitizeBehaviorSourceLine(heading);
  const normalizedFragment = normalizeBehaviorEvidenceFragment(fragment);
  if (!normalizedHeading || !normalizedFragment) return normalizedFragment;
  if (normalizedFragment.toLowerCase().includes(normalizedHeading.toLowerCase())) return normalizedFragment;
  return normalizeBehaviorEvidenceFragment(`${normalizedHeading}: ${normalizedFragment}`);
}

function parseBehaviorTableCells(line: string): string[] | null {
  if (!line.includes("|")) return null;
  const cells = line
    .split("|")
    .map((cell) => sanitizeBehaviorSourceLine(cell))
    .filter(Boolean);
  return cells.length >= 2 ? cells : null;
}

function isBehaviorTableSeparatorRow(cells: string[]): boolean {
  return cells.every((cell) => /^:?-{3,}:?$/.test(cell.replace(/\s+/g, "")));
}

function looksLikeBehaviorTableHeaderRow(cells: string[]): boolean {
  return cells.length >= 2 && cells.every((cell) => cell.length <= 32) && cells.every((cell) => !/\d/.test(cell));
}

function formatBehaviorTableRowFragment(heading: string, headerCells: string[] | null, rowCells: string[]): string {
  const pairs =
    headerCells && headerCells.length === rowCells.length
      ? rowCells.map((value, index) => `${headerCells[index]}: ${value}`)
      : rowCells;
  return appendBehaviorHeadingContext(heading, pairs.join("; "));
}

function inferBehaviorInlineTableHeaderLength(cells: string[]): number {
  const maxHeaderLength = Math.min(12, Math.floor(cells.length / 2));
  const firstValueLikeIndex = cells.findIndex(
    (cell, index) => index > 0 && /(?:\d|>=|<=|mbps|gb|g\b|c\b|台|人|users?|seats?)/i.test(cell)
  );
  if (
    firstValueLikeIndex >= 2 &&
    firstValueLikeIndex <= maxHeaderLength &&
    looksLikeBehaviorTableHeaderRow(cells.slice(0, firstValueLikeIndex))
  ) {
    return firstValueLikeIndex;
  }

  for (let size = maxHeaderLength; size >= 2; size -= 1) {
    const headerCells = cells.slice(0, size);
    const firstRow = cells.slice(size, size * 2);
    if (firstRow.length < size || !looksLikeBehaviorTableHeaderRow(headerCells) || looksLikeBehaviorTableHeaderRow(firstRow)) {
      continue;
    }
    const rowFragment = formatBehaviorTableRowFragment("", headerCells, firstRow);
    if (looksLikeBehaviorEvidenceFragment(rowFragment) || looksLikeStructuredConstraintText(rowFragment)) {
      return size;
    }
  }

  return 0;
}

function extractBehaviorEvidenceFragmentsFromInlineTable(reference: SearchReference, snippet: string): string[] {
  const cells = parseBehaviorTableCells(snippet);
  if (!cells || cells.length < 4) return [];

  const headerLength = inferBehaviorInlineTableHeaderLength(cells);
  if (headerLength < 2) return [];

  const headerCells = cells.slice(0, headerLength);
  const rowCells = cells.slice(headerLength);
  const heading = shortHeadingLabel(reference.headingPath) || reference.title;
  const fragments: string[] = [];

  for (let index = 0; index + headerLength <= rowCells.length; index += headerLength) {
    const row = rowCells.slice(index, index + headerLength);
    const rowFragment = formatBehaviorTableRowFragment(heading, headerCells, row);
    if (looksLikeBehaviorEvidenceFragment(rowFragment) || looksLikeStructuredConstraintText(rowFragment)) {
      fragments.push(rowFragment);
    }
    if (fragments.length >= 4) break;
  }

  return uniqueStrings(fragments, 4);
}

function extractBehaviorEvidenceFragmentsFromLines(reference: SearchReference, scopedLines: string[]): string[] {
  const fragments: string[] = [];
  let currentHeading = shortHeadingLabel(reference.headingPath) || reference.title;
  let tableHeader: string[] | null = null;

  for (const rawLine of scopedLines) {
    const line = String(rawLine ?? "");
    if (!line.trim() || /^\s*import\s+/.test(line) || /^\s*api:\s*/.test(line)) continue;

    const headingMatch = line.match(/^\s*(#{1,6})\s+(.+)$/);
    if (headingMatch) {
      currentHeading = sanitizeBehaviorSourceLine(headingMatch[2] ?? "") || currentHeading;
      tableHeader = null;
      continue;
    }

    const tableCells = parseBehaviorTableCells(line);
    if (tableCells) {
      if (isBehaviorTableSeparatorRow(tableCells)) continue;
      if (looksLikeBehaviorTableHeaderRow(tableCells)) {
        tableHeader = tableCells;
        continue;
      }
      const rowFragment = formatBehaviorTableRowFragment(currentHeading, tableHeader, tableCells);
      if (looksLikeBehaviorEvidenceFragment(rowFragment)) {
        fragments.push(rowFragment);
      }
      continue;
    }

    tableHeader = null;
    const cleaned = sanitizeBehaviorSourceLine(line);
    if (!cleaned) continue;
    const fragment = appendBehaviorHeadingContext(currentHeading, cleaned);
    if (looksLikeBehaviorEvidenceFragment(fragment)) {
      fragments.push(fragment);
    }
  }

  return uniqueStrings(fragments, 10);
}

async function loadBehaviorSourceLinesAsync(reference: SearchReference): Promise<string[] | null> {
  const resolvedPath = resolveLocalDocsMirrorPath(reference);
  if (resolvedPath) {
    try {
      return scopeProcedureSourceLines(reference, fs.readFileSync(resolvedPath, "utf8"), true);
    } catch {
      return null;
    }
  }

  const expandedSource = await loadPublishedDocsExpansionSource(reference);
  if (!expandedSource) return null;
  return scopeProcedureSourceLines(reference, expandedSource, true, true);
}

async function collectBehaviorEvidenceFragmentsAsync(reference: SearchReference): Promise<string[]> {
  const snippetFragments = collectBehaviorEvidenceFragments(reference);
  const canExpandFromSource =
    reference.authority === "canonical_visible" &&
    (Boolean(resolveLocalDocsMirrorPath(reference)) || String(reference.sourceUrl ?? "").startsWith("https://docs.ones.com/"));
  if (!canExpandFromSource) return snippetFragments;

  const scopedLines = await loadBehaviorSourceLinesAsync(reference);
  if (!scopedLines?.length) return snippetFragments;

  return uniqueStrings([...extractBehaviorEvidenceFragmentsFromLines(reference, scopedLines), ...snippetFragments], 12);
}

function collectBehaviorEvidenceFragments(reference: SearchReference): string[] {
  const normalizedSnippet = normalizeBehaviorEvidenceFragment(reference.snippet);
  const inlineTableFragments = extractBehaviorEvidenceFragmentsFromInlineTable(reference, normalizedSnippet);
  const sentenceFragments = uniqueStrings(
    normalizedSnippet
      .split(/。|；|(?:\.\s+)|\n/)
      .map((item) => normalizeBehaviorEvidenceFragment(item))
      .filter(looksLikeBehaviorEvidenceFragment),
    8
  );
  const fragments = uniqueStrings([...inlineTableFragments, ...sentenceFragments], 8);
  if (fragments.length > 0) return fragments;
  return looksLikeBehaviorEvidenceFragment(normalizedSnippet) ? [normalizedSnippet] : [];
}

function scoreBehaviorEvidenceFragment(input: {
  fragment: string;
  reference: SearchReference;
  query: string;
  caseFrame: SupportCaseFrame;
  primaryBoost: number;
}): number {
  const focusTerms = collectFocusTerms(input.query, input.caseFrame);
  const haystack = `${input.reference.title} ${input.reference.headingPath ?? ""} ${input.fragment}`.toLowerCase();
  const profile = getReferenceSupportProfile(input.reference);
  const constraintFirstCapabilityCase = isConstraintFirstCapabilityCase(input.caseFrame);
  const structuredConstraintReference = referenceHasStructuredConstraintEvidence(input.reference);
  const leafConstraintMatrix = referenceLooksLikeLeafConstraintMatrix(input.reference);
  const deploymentApplicabilityOnly = referenceLooksLikeDeploymentApplicabilityOnly(input.reference);
  const operationalPlanFragment = fragmentLooksLikeOperationalPlan(input.fragment);
  const retrievalUnitFamily = getReferenceRetrievalUnitFamily(input.reference);
  let score = input.primaryBoost + Math.round(input.reference.score * 10);
  if (profile.evidenceKind === "capability" || profile.evidenceKind === "constraint") score += 14;
  else if (profile.evidenceKind === "procedure" || profile.evidenceKind === "troubleshooting") score += 6;
  if (profile.productArea && profile.productArea === String(input.caseFrame.product_area ?? "").toLowerCase()) score += 10;
  if (profile.deploymentModel && profile.deploymentModel === String(input.caseFrame.deployment_model ?? "").toLowerCase()) score += 8;
  if (isStructuredBehaviorEvidenceFragment(input.fragment)) score += 12;
  if (/(supports?|supported|available|only|requires?|required|recommended|must|cannot|not support|unsupported)/i.test(input.fragment)) score += 10;
  if (/(支持|可用|仅|只在|要求|推荐|必须|不能|不支持|兼容|环境要求|系统要求)/.test(input.fragment)) score += 10;
  if (isRecommendationLikeFragment(input.fragment)) score += 4;
  if (constraintFirstCapabilityCase) {
    if (structuredConstraintReference) score += 20;
    if (retrievalUnitFamily === "constraint_table_row_unit") score += 24;
    if (leafConstraintMatrix) score += 28;
    if (isStructuredBehaviorEvidenceFragment(input.fragment)) score += 10;
    if (referenceLooksLikeOperationalPlan(input.reference) && !structuredConstraintReference) score -= 18;
    if (operationalPlanFragment && !isStructuredBehaviorEvidenceFragment(input.fragment)) score -= 18;
    if (deploymentApplicabilityOnly) score -= 28;
  }
  for (const term of focusTerms) {
    const normalized = term.toLowerCase();
    if (!normalized) continue;
    if (haystack.includes(normalized)) score += normalized.length >= 4 ? 6 : 3;
  }
  return score;
}

function formatBehaviorEvidenceSentence(language: "zh" | "en", fragment: string): string {
  const normalized = normalizeBehaviorEvidenceFragment(fragment);
  if (!normalized) return "";
  const terminal = /[。.!?]$/.test(normalized) ? normalized : `${normalized}${hasCjkText(normalized) ? "。" : "."}`;
  return language === "zh" ? `当前文档明确写到：${terminal}` : `The current documentation explicitly states: ${terminal}`;
}

function buildBehaviorRecommendation(language: "zh" | "en", fragment: string): string {
  const normalized = normalizeBehaviorEvidenceFragment(fragment);
  if (!normalized) return "";
  const terminal = /[。.!?]$/.test(normalized) ? normalized : `${normalized}${hasCjkText(normalized) ? "。" : "."}`;
  return language === "zh" ? `规划时优先参考：${terminal}` : `Use this documented recommendation as the planning baseline: ${terminal}`;
}

function isDeploymentArchitectureQuestion(query: string, caseFrame: SupportCaseFrame): boolean {
  void query;
  if (caseFrame.product_area !== "deployment") return false;
  return Boolean(
    (caseFrame.required_doc_kinds ?? []).includes("deployment_runbook") ||
      String(caseFrame.deployment_model ?? "").toLowerCase() === "private_deployment"
  );
}

function shouldExpandBehaviorEvidenceAsync(
  reference: SearchReference,
  index: number,
  query: string,
  caseFrame: SupportCaseFrame
): boolean {
  const constraintFirstCapabilityCase = isConstraintFirstCapabilityCase(caseFrame);
  if (index < 2) {
    if (constraintFirstCapabilityCase && referenceLooksLikeOperationalPlan(reference)) {
      return referenceHasStructuredConstraintEvidence(reference);
    }
    return true;
  }
  if (!constraintFirstCapabilityCase) return false;
  if (referenceHasStructuredConstraintEvidence(reference)) return true;
  return index < 4 && !referenceLooksLikeOperationalPlan(reference);
}

type ApiOperationIntent = "create" | "read" | "list" | "update" | "delete" | "execute";

type ApiEvidenceCandidate = {
  text: string;
  evidenceId: string;
  kind: "verified_fact" | "grounded_inference" | "operational_advice" | "unknown";
  authority: "canonical" | "assistive";
  score: number;
  method?: string;
  path?: string;
  fieldName?: string;
  requiredParams?: string[];
  scopeValue?: string;
  candidateCategory?: "operation" | "field" | "permission" | "narrative";
};

function extractApiOperationSignature(reference: SearchReference): { method?: string; path?: string } {
  const source = `${reference.title ?? ""}\n${reference.headingPath ?? ""}\n${reference.path ?? ""}\n${reference.snippet ?? ""}`;
  const methodPathInline = source.match(/\b(GET|POST|PUT|PATCH|DELETE)\s+([/][^\s"'`<>{}]+(?:\{[^}]+\}[^\s"'`<>{}]*)*)/i);
  if (methodPathInline) {
    return {
      method: String(methodPathInline[1] ?? "").toUpperCase(),
      path: String(methodPathInline[2] ?? "").trim()
    };
  }

  const methodEndpoint = source.match(/method=\{"(GET|POST|PUT|PATCH|DELETE)"\}[\s\S]{0,240}?path=\{"([^"]+)"\}/i);
  if (methodEndpoint) {
    return {
      method: String(methodEndpoint[1] ?? "").toUpperCase(),
      path: String(methodEndpoint[2] ?? "").trim()
    };
  }

  const pathOnly = source.match(/(\/open-api\/[a-z0-9_./{}-]+)/i);
  return {
    method: undefined,
    path: pathOnly ? String(pathOnly[1] ?? "").trim() : undefined
  };
}

function collectApiOperationIntents(query: string, caseFrame: SupportCaseFrame): Set<ApiOperationIntent> {
  void query;
  const intents = new Set<ApiOperationIntent>();
  const normalizedAction = String(caseFrame.action_type ?? "").trim().toLowerCase();
  switch (normalizedAction) {
    case "create":
      intents.add("create");
      break;
    case "update":
      intents.add("update");
      break;
    case "delete":
      intents.add("delete");
      break;
    case "execute":
      intents.add("execute");
      break;
    case "list":
      intents.add("list");
      break;
    case "read":
    case "api_lookup":
      intents.add("read");
      break;
    default:
      break;
  }

  if (String(caseFrame.question_type ?? "") === "api_scope_auth") {
    intents.add("read");
  }
  if (String(caseFrame.question_type ?? "") === "api_endpoint_lookup") {
    intents.add("read");
  }
  if (String(caseFrame.question_type ?? "") === "api_field_lookup" && !intents.size) {
    intents.add("read");
  }

  if (!intents.size) {
    intents.add("read");
  }
  return intents;
}

function buildApiExtractionSource(reference: SearchReference): string {
  const snippet = String(reference.snippet ?? "");
  const resolvedPath = resolveLocalDocsMirrorPath(reference);
  if (!resolvedPath) return snippet;
  try {
    const raw = fs.readFileSync(resolvedPath, "utf8");
    return `${snippet}\n${raw}`;
  } catch {
    return snippet;
  }
}

function extractApiFieldCandidates(reference: SearchReference, language: "zh" | "en"): ApiEvidenceCandidate[] {
  const candidates: ApiEvidenceCandidate[] = [];
  const source = buildApiExtractionSource(reference);
  for (const match of source.matchAll(/name=\{"([^"]+)"\}[\s\S]{0,1200}?(?:"description":"|description=\{")([^"}]+)/g)) {
    const fieldName = String(match[1] ?? "").trim();
    const description = String(match[2] ?? "").trim();
    if (!fieldName || !description) continue;
    candidates.push({
      text:
        language === "zh"
          ? `该接口的字段 ${fieldName} 在文档中说明为“${description}”。`
          : `The documentation describes field ${fieldName} as "${description}".`,
      evidenceId: resolveSearchReferenceEvidenceId(reference),
      kind: "verified_fact",
      authority: "canonical",
      score: 0,
      fieldName,
      candidateCategory: "field"
    });
  }
  return candidates;
}

function extractApiNarrativeCandidates(reference: SearchReference, language: "zh" | "en"): ApiEvidenceCandidate[] {
  const candidates: ApiEvidenceCandidate[] = [];
  const rawSnippet = String(reference.snippet ?? "").replace(/\s+/g, " ").trim();
  const fragments = rawSnippet
    .split(/\s+-\s+|。|\.\s+/)
    .map((item) => item.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .filter((item) => item.length >= 8 && item.length <= 180);

  for (const fragment of fragments) {
    if (!/(返回包含|支持|获取.+列表|returns?|includes?|supports?)/i.test(fragment)) continue;
    candidates.push({
      text:
        language === "zh"
          ? `《${reference.title}》说明：${fragment.replace(/^[-•]\s*/, "")}。`
          : `"${reference.title}" states: ${fragment.replace(/^[-•]\s*/, "")}.`,
      evidenceId: resolveSearchReferenceEvidenceId(reference),
      kind: "verified_fact",
      authority: "canonical",
      score: 0,
      candidateCategory: "narrative"
    });
  }
  return candidates;
}

function extractApiPermissionCandidates(reference: SearchReference, language: "zh" | "en"): ApiEvidenceCandidate[] {
  const source = buildApiExtractionSource(reference);
  const profile = getReferenceSupportProfile(reference);
  const operation = extractApiOperationSignature(reference);
  const permissionEntries = new Map<string, { scope: string; description?: string }>();
  const normalizeScopeValue = (value: string): string | null => {
    const normalized = String(value ?? "")
      .trim()
      .replace(/^[`'"]+/, "")
      .replace(/[`'",.;]+$/, "");
    return /^[A-Za-z]+:[A-Za-z0-9_-]+(?::[A-Za-z0-9_-]+)*$/.test(normalized) ? normalized : null;
  };
  const addPermission = (scope: string, description?: string) => {
    const normalizedScope = normalizeScopeValue(scope);
    if (!normalizedScope) return;
    const existing = permissionEntries.get(normalizedScope);
    const normalizedDescription = String(description ?? "").trim();
    permissionEntries.set(normalizedScope, {
      scope: normalizedScope,
      description: existing?.description || normalizedDescription || undefined
    });
  };

  for (const scope of profile.permissions) {
    addPermission(scope);
  }
  for (const prerequisite of profile.prerequisites) {
    const match = prerequisite.match(/^scope:(.+)$/i);
    if (match) addPermission(match[1] ?? "");
  }
  for (const match of source.matchAll(/^\s*[-*+]\s*((?:read|write):[A-Za-z0-9:_-]+)\s*:\s*([^\n]+)/gim)) {
    addPermission(String(match[1] ?? ""), String(match[2] ?? ""));
  }
  for (const match of source.matchAll(/\b(?:scope|scopes|权限|鉴权)\b[：:\s`]+([A-Za-z]+:[A-Za-z0-9:_-]+)/gim)) {
    addPermission(String(match[1] ?? ""));
  }

  return [...permissionEntries.values()].map(({ scope, description }) => ({
    text:
      language === "zh"
        ? description
          ? `文档写明 \`${scope}\` 用于 ${description.replace(/[。.]$/, "")}。`
          : `当前文档写明所需 OAuth scope 是 \`${scope}\`。`
        : description
        ? `The documentation states that \`${scope}\` is used for ${description.replace(/[.。]$/, "")}.`
        : `The documentation states that the required OAuth scope is \`${scope}\`.`,
    evidenceId: resolveSearchReferenceEvidenceId(reference),
    kind: "verified_fact",
    authority: "canonical",
    score: 0,
    method: operation.method,
    path: operation.path,
    scopeValue: scope,
    candidateCategory: "permission"
  }));
}

function extractApiRequestParamNames(reference: SearchReference): string[] {
  const source = buildApiExtractionSource(reference);
  return uniqueStrings(
    [
      ...[...source.matchAll(/param=\{\{"name":"([^"]+)"/g)].map((match) => String(match[1] ?? "").trim()),
      ...[...source.matchAll(/name=\{"([^"]+)"\}[\s\S]{0,400}?required=\{true\}/g)].map((match) => String(match[1] ?? "").trim())
    ],
    6
  );
}

function classifyApiOperationCandidate(input: { method?: string; path?: string; title?: string; snippet?: string }): Set<ApiOperationIntent> {
  const intents = new Set<ApiOperationIntent>();
  const method = String(input.method ?? "").toUpperCase();
  const path = String(input.path ?? "").toLowerCase();
  const title = String(input.title ?? "").toLowerCase();
  const snippet = String(input.snippet ?? "").toLowerCase();
  const haystack = `${path} ${title} ${snippet}`;

  if (method === "PUT" || method === "PATCH" || /update|更新|修改|变更|edit|patch/.test(haystack)) intents.add("update");
  if (method === "DELETE" || /delete|remove|删除|移除/.test(haystack)) intents.add("delete");
  if (method === "POST" && /create|创建|新增|新建|add /.test(haystack)) intents.add("create");
  if ((method === "POST" && /execute|执行|触发|trigger|run /.test(haystack)) || /action=executeworkflow/.test(haystack)) intents.add("execute");
  if (method === "GET") {
    if (/list|列表|issuestatuses|\/workflows\b|\/fields\b/.test(haystack) && !/\{[^}]+\}/.test(path)) intents.add("list");
    if (!intents.has("list")) intents.add("read");
  }
  if ((/\{[^}]+\}/.test(path) || /detail|details|详情|详细信息/.test(haystack)) && method === "GET") intents.add("read");

  return intents;
}

function scoreApiIntentAlignment(targetIntents: Set<ApiOperationIntent>, candidateIntents: Set<ApiOperationIntent>): number {
  if (!targetIntents.size || !candidateIntents.size) return 0;

  let score = 0;
  if (targetIntents.has("update")) {
    if (candidateIntents.has("update")) score += 52;
    if (candidateIntents.has("read")) score -= 12;
    if (candidateIntents.has("list")) score -= 30;
  }
  if (targetIntents.has("create")) {
    if (candidateIntents.has("create")) score += 30;
    if (candidateIntents.has("read") || candidateIntents.has("list")) score -= 10;
  }
  if (targetIntents.has("delete")) {
    if (candidateIntents.has("delete")) score += 30;
    if (candidateIntents.has("read") || candidateIntents.has("list")) score -= 10;
  }
  if (targetIntents.has("execute")) {
    if (candidateIntents.has("execute")) score += 28;
    if (candidateIntents.has("read") || candidateIntents.has("list")) score -= 8;
  }
  if (targetIntents.has("list")) {
    if (candidateIntents.has("list")) score += 24;
    if (candidateIntents.has("update") || candidateIntents.has("delete")) score -= 8;
  }
  if (targetIntents.has("read") && !targetIntents.has("update") && !targetIntents.has("create") && !targetIntents.has("delete")) {
    if (candidateIntents.has("read")) score += 16;
    if (candidateIntents.has("list")) score += 8;
  }

  return score;
}

function scorePermissionScopeFit(scopeValue: string, focusTerms: string[]): number {
  const focusText = focusTerms.join(" ").toLowerCase();
  const genericTokens = new Set(["read", "write", "project", "projects", "oauth", "scope", "scopes", "api", "openapi"]);
  const scopeTokens = uniqueStrings(
    scopeValue
      .toLowerCase()
      .split(/[:/._-]+/)
      .map((item) => item.trim())
      .filter(Boolean),
    8
  );
  let score = 0;
  for (const token of scopeTokens) {
    if (genericTokens.has(token)) continue;
    score += focusText.includes(token) ? 14 : -8;
  }
  return score;
}

function scoreApiScopeAccessFit(scopeValue: string, targetIntents: Set<ApiOperationIntent>): number {
  const normalizedScope = scopeValue.toLowerCase();
  const writeScope = normalizedScope.startsWith("write:");
  const readScope = normalizedScope.startsWith("read:");
  if (targetIntents.has("create") || targetIntents.has("update") || targetIntents.has("delete") || targetIntents.has("execute")) {
    if (writeScope) return 20;
    if (readScope) return -18;
  }
  if (targetIntents.has("read") || targetIntents.has("list")) {
    if (readScope) return 10;
    if (writeScope) return -4;
  }
  return 0;
}

function tokenMatchesFocus(token: string, focusText: string): boolean {
  if (!token) return false;
  if (focusText.includes(token)) return true;
  if (token.endsWith("s") && token.length > 3 && focusText.includes(token.slice(0, -1))) return true;
  if (!token.endsWith("s") && token.length > 3 && focusText.includes(`${token}s`)) return true;
  return false;
}

function scoreApiOperationFocusFit(candidate: ApiEvidenceCandidate, reference: SearchReference, focusTerms: string[]): number {
  if (!candidate.path) return 0;
  const focusText = focusTerms.join(" ").toLowerCase();
  const genericTokens = new Set([
    "api",
    "openapi",
    "project",
    "projects",
    "teamid",
    "issueid",
    "get",
    "post",
    "put",
    "patch",
    "delete"
  ]);
  const tokenize = (value: string): string[] =>
    uniqueStrings(
      value
        .replace(/([a-z])([A-Z])/g, "$1 $2")
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((token) => token.length >= 3),
      20
    );
  const candidateTokens = uniqueStrings(
    [...tokenize(candidate.path), ...tokenize(reference.title), ...tokenize(candidate.text)],
    20
  );
  let score = 0;
  for (const token of candidateTokens) {
    if (genericTokens.has(token)) continue;
    score += tokenMatchesFocus(token, focusText) ? 10 : -6;
  }
  return score;
}

function scoreApiOperationTitleIntentFit(title: string, targetIntents: Set<ApiOperationIntent>): number {
  const normalizedTitle = String(title ?? "").toLowerCase();
  let score = 0;
  if (targetIntents.has("create") && /(create|新增|新建|添加)/.test(normalizedTitle)) score += 18;
  if (targetIntents.has("update") && /(update|更新|修改|变更|edit|patch)/.test(normalizedTitle)) score += 18;
  if (targetIntents.has("delete") && /(delete|删除|移除|remove)/.test(normalizedTitle)) score += 18;
  if (targetIntents.has("list") && /(list|列表|status list|枚举)/.test(normalizedTitle)) score += 16;
  if (targetIntents.has("read") && /(get|detail|详情|获取)/.test(normalizedTitle)) score += 12;
  return score;
}

function scoreApiEvidenceCandidate(
  candidate: ApiEvidenceCandidate,
  focusTerms: string[],
  reference: SearchReference,
  primaryBoost: number,
  targetIntents: Set<ApiOperationIntent>,
  caseFrame: SupportCaseFrame
): number {
  const haystack = `${candidate.text} ${candidate.fieldName ?? ""} ${candidate.method ?? ""} ${candidate.path ?? ""} ${reference.title} ${reference.headingPath ?? ""} ${reference.path ?? ""}`.toLowerCase();
  let score = primaryBoost + Math.round(reference.score * 10);
  const wantsIdentifier = focusTerms.some((term) => /标识|id|uuid|identifier/i.test(term));
  const wantsProject = focusTerms.some((term) => /项目|project/i.test(term));
  const wantsMember = focusTerms.some((term) => /负责人|成员|member|user|owner|assignee/i.test(term));
  for (const term of focusTerms) {
    if (!term) continue;
    const normalized = term.toLowerCase();
    if (haystack.includes(normalized)) score += normalized.length >= 4 ? 7 : 4;
  }
  if (candidate.fieldName && /^(id|uuid)$/i.test(candidate.fieldName) && wantsIdentifier) {
    score += 18;
  }
  if (wantsProject && /项目|project/i.test(candidate.text)) score += 12;
  if (wantsMember && /负责人|成员|member|user|owner|assignee/i.test(candidate.text)) score += 12;
  if (wantsProject && /成员|member|user|owner|assignee/i.test(candidate.text)) score -= 8;
  if (wantsMember && /项目|project/i.test(candidate.text) && !/成员|member|user|owner|assignee/i.test(candidate.text)) score -= 6;
  if (/(返回包含|returns?)/i.test(candidate.text)) score += 4;
  if (candidate.method && candidate.path) score += 6;
  if (candidate.scopeValue) {
    score += caseFrame.question_type === "api_scope_auth" ? 54 : 18;
    score += scorePermissionScopeFit(candidate.scopeValue, focusTerms);
    score += scoreApiScopeAccessFit(candidate.scopeValue, targetIntents);
    score += scoreApiOperationFocusFit(candidate, reference, focusTerms);
  }
  if (candidate.candidateCategory === "operation") {
    score += scoreApiOperationFocusFit(candidate, reference, focusTerms);
    score += scoreApiOperationTitleIntentFit(reference.title, targetIntents);
    if (/^(get|post|put|patch|delete)\s+\//i.test(String(reference.title ?? "").trim())) {
      score -= 8;
    }
  }
  score += scoreApiIntentAlignment(
    targetIntents,
    classifyApiOperationCandidate({
      method: candidate.method,
      path: candidate.path,
      title: reference.title,
      snippet: candidate.text
    })
  );
  if (
    caseFrame.question_type === "api_scope_auth" &&
    candidate.scopeValue == null &&
    /oauth2\/token|access[_ -]?token|authorization|authorize\b/.test(haystack)
  ) {
    score -= 28;
  }
  return score;
}

function extractEvidenceSnippetSentences(text: string, limit = 3): string[] {
  return uniqueStrings(
    String(text ?? "")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .split(/(?<=[。.!?])\s+|[；;\n]+/)
      .map((item) => item.trim())
      .filter((item) => item.length >= 12),
    limit
  );
}

function buildApiRetrievalBridgeQuery(query: string, caseFrame: SupportCaseFrame): string | null {
  if (!String(caseFrame.question_type ?? "").startsWith("api_")) return null;
  const intents = collectApiOperationIntents(query, caseFrame);
  const intentLexicon: Record<ApiOperationIntent, string[]> = {
    create: ["create", "add", "new"],
    read: ["get", "read", "detail"],
    list: ["list", "enum", "statuses"],
    update: ["update", "modify", "edit", "patch", "put"],
    delete: ["delete", "remove"],
    execute: ["execute", "trigger", "run"]
  };
  const intentTokens = uniqueStrings(
    [...intents].flatMap((intent) => intentLexicon[intent] ?? []),
    6
  );
  const focusTerms = collectFocusTerms(query, caseFrame).filter(
    (term) =>
      !/^(api|openapi|endpoint|接口|开放平台|如何|怎么|what|how|through|via|please|question|query)$/i.test(term) &&
      term.length >= 2
  );
  const focusTokens = uniqueStrings(focusTerms, 7);
  const bridgeTokens = uniqueStrings(["openapi", "api", "endpoint", ...intentTokens, ...focusTokens], 14);
  return bridgeTokens.length > 0 ? bridgeTokens.join(" ") : null;
}

function buildStructuredCaseFrameQuery(caseFrame: SupportCaseFrame): string | null {
  const segments = uniqueStrings(
    [
      caseFrame.goal,
      caseFrame.object,
      caseFrame.symptom,
      caseFrame.action_type,
      caseFrame.product_area,
      caseFrame.deployment_model,
      ...(caseFrame.required_doc_kinds ?? []),
      ...(caseFrame.constraints ?? []).slice(0, 2)
    ].map((item) => String(item ?? "").replace(/[_/]+/g, " ")),
    10
  );
  return segments.length ? segments.join(" ") : null;
}

function buildInitialRetrievalQueries(query: string, caseFrame: SupportCaseFrame, seedQueries: string[] = []): string[] {
  return uniqueStrings(
    [
      ...caseFrame.retrieval_queries,
      query
    ],
    6
  ).filter(Boolean);
}

function combineRetrievalQueries(
  query: string,
  caseFrame: SupportCaseFrame,
  orchestrator: Pick<SearchOrchestrator, "normalizeQuery">,
  baseQueries: string[] = []
): string[] {
  return [];
}

type SupportSearchOrchestrator = Pick<
  SearchOrchestrator,
  "collectEvidence" | "combineEvidenceCollections" | "refineEvidence" | "normalizeQuery"
>;

type SupportAgentStageProgress = {
  currentStage: string;
  lastCompletedStage?: string;
};

function buildEvidenceBoundDraftVerification(input: {
  language: "zh" | "en";
  draftAnswer: SpecialistDraftAnswer;
  missingInfo: string[];
  summary?: {
    zh: string;
    en: string;
  };
}): SupportVerificationResult {
  const supportedClaims = input.draftAnswer.claims
    .filter(
      (claim) =>
        claim.evidence_ids.length > 0 &&
        (claim.kind === "verified_fact" || claim.kind === "grounded_inference")
    )
    .map((claim) => ({
      text: claim.text,
      kind: claim.kind,
      verdict: claim.kind === "grounded_inference" ? ("supported_inference" as const) : ("verified" as const),
      citation_ids: claim.evidence_ids
    }));
  const unsupportedClaims = uniqueStrings(
    input.draftAnswer.claims
      .filter(
        (claim) =>
          claim.evidence_ids.length === 0 &&
          (claim.kind === "verified_fact" || claim.kind === "grounded_inference")
      )
      .map((claim) => claim.text),
    12
  );
  const verifiedCitationIds = uniqueStrings(supportedClaims.flatMap((claim) => claim.citation_ids), 6);
  return {
    verdict:
      supportedClaims.length === 0
        ? "unsupported"
        : unsupportedClaims.length === 0 && input.missingInfo.length === 0
        ? "verified"
        : "partial",
    summary:
      input.language === "zh"
        ? input.summary?.zh ?? "回答草稿已按已发布知识证据完成绑定。"
        : input.summary?.en ?? "The draft answer was reconciled against published knowledge evidence.",
    unsupported_claims: unsupportedClaims,
    missing_info: input.missingInfo,
    verified_citation_ids: verifiedCitationIds,
    display_citation_ids: verifiedCitationIds.slice(0, 3),
    verified_claims: supportedClaims.map((claim) => claim.text),
    claim_to_citation_map: supportedClaims
  };
}

async function runSupervisorDomainSupportSearch(input: {
  query: string;
  language: "zh" | "en";
  currentRound: number;
  conversationHistory: Array<{ role: "user" | "assistant"; content: string }>;
  adapter: OpenClawAdapter;
  runtime?: OpenClawRuntimeContext;
  attachments?: string[];
  repoId?: string;
  branch?: string;
  idempotencyKey: string;
  contextType: "search" | "triage";
  orchestrator: SupportSearchOrchestrator;
  runtimePolicy: ReturnType<typeof resolveSupportRuntimePolicy>;
  onStageProgress?: (progress: SupportAgentStageProgress) => Promise<void> | void;
  ticketContext?: {
    priority: string;
    customerMeta: Record<string, unknown>;
    history: Array<{ author: string; body: string; at: string }>;
  };
}): Promise<{
  result: SearchModeResult;
  caseFrame: SupportCaseFrame;
  evidenceBundle: SupportEvidenceBundle;
  verification: SupportVerificationResult;
  stageTimings: SupportAgentStageTimings;
}> {
  const runStartedAt = performance.now();
  let lastCompletedStage: string | undefined;
  const reportStageProgress = async (currentStage: string): Promise<void> => {
    if (!input.onStageProgress) return;
    await input.onStageProgress({ currentStage, lastCompletedStage });
  };
  const markStageCompleted = (stage: string): void => {
    lastCompletedStage = stage;
  };

  const dispatchRuntime = withStageRuntime(
    buildDeliveryAwareStageRuntime(
      input.runtime,
      {
        reserveMs: 8_000,
        minimumTimeoutMs: 8_000,
        stageTimeoutMs: 18_000
      },
      {
        reserveMs: 20_000,
        minimumTimeoutMs: 12_000,
        stageTimeoutMs: 28_000
      }
    ),
    "planner",
    `${input.idempotencyKey}:support-dispatch`
  );

  await reportStageProgress("planner");
  const dispatchStartedAt = performance.now();
  const dispatchResult = await input.adapter.planSupportDispatch!(
    {
      contextType: input.contextType,
      language: input.language,
      query: input.query,
      conversationHistory: input.conversationHistory,
      ticketContext: input.ticketContext
    },
    `${input.idempotencyKey}:support-dispatch`,
    dispatchRuntime
  )
    .then((value) => ({ value, timing: stageTiming("completed", elapsedMs(dispatchStartedAt)) }))
    .catch(async (error) => {
      console.warn("[support-runtime] supervisor dispatch fallback", {
        query: input.query.slice(0, 160),
        error: supportStageErrorMessage(error),
        runtime: {
          deliveryMode: dispatchRuntime?.deliveryMode ?? null,
          timeoutMs: dispatchRuntime?.timeoutMs ?? null,
          overallTimeoutMs: dispatchRuntime?.overallTimeoutMs ?? null
        }
      });
      throw new Error("support dispatch unavailable: supervisor contract invalid");
    });
  markStageCompleted("planner");

  const dispatch = dispatchResult.value;
  const normalizedRoute = dispatch.route;
  const initialCaseFrame: SupportCaseFrame = {
    ...dispatch.caseFrame,
    question_type: dispatch.caseFrame.question_type ?? normalizedRoute.question_type,
    specialist_agent: dispatch.caseFrame.specialist_agent ?? normalizedRoute.specialist_agent,
    answer_contract: dispatch.caseFrame.answer_contract ?? normalizedRoute.answer_contract,
    routing_confidence: dispatch.caseFrame.routing_confidence ?? normalizedRoute.routing_confidence,
    retrieval_queries: sanitizeSupportRetrievalSeeds(
      [...dispatch.retrievalQueries, ...dispatch.caseFrame.retrieval_queries, input.query],
      8
    )
  };
  const initialRoute: SupportQuestionRoute = {
    ...normalizedRoute,
    primary_domain: resolveDispatchPrimaryDomain(dispatch.primaryDomain ?? normalizedRoute.primary_domain, initialCaseFrame)
  };
  const stageBudget = {
    retrieval_rounds: 1,
    allow_refinement: false,
    stop_after_grounded_evidence: false,
    specialist_budget: 1
  };
  const initialEvidencePlan: SupportEvidencePlan = {
    query_plan: initialCaseFrame.query_plan ?? {
      concept_queries: initialCaseFrame.retrieval_queries.slice(0, 3),
      object_queries: [initialCaseFrame.object].filter(Boolean),
      behavior_queries: [initialCaseFrame.action_type].filter(Boolean)
    },
    evidence_priority: initialCaseFrame.required_doc_kinds ?? [],
    required_doc_kinds: initialCaseFrame.required_doc_kinds ?? [],
    retrieval_rounds: 1,
    allow_refinement: false,
    stop_after_grounded_evidence: false
  };
  let primaryDomain = resolveDispatchPrimaryDomain(initialRoute.primary_domain, initialCaseFrame);
  let route: SupportQuestionRoute = {
    ...initialRoute,
    primary_domain: primaryDomain
  };
  let caseFrame: SupportCaseFrame = {
    ...initialCaseFrame,
    primary_domain: primaryDomain,
    retrieval_queries: sanitizeSupportRetrievalSeeds(
      [
        ...dispatch.retrievalQueries,
        ...initialCaseFrame.retrieval_queries,
        ...(initialCaseFrame.query_plan?.concept_queries ?? []),
        ...(initialCaseFrame.query_plan?.object_queries ?? []),
        ...(initialCaseFrame.query_plan?.behavior_queries ?? []),
        input.query
      ],
      8
    )
  };
  const evidencePlan: SupportEvidencePlan = {
    ...initialEvidencePlan,
    evidence_priority: initialEvidencePlan.required_doc_kinds ?? [],
    required_doc_kinds: initialEvidencePlan.required_doc_kinds ?? []
  };

  await reportStageProgress("retrieval_base");
  const retrievalStartedAt = performance.now();
  const retrievalQueries = sanitizeSupportRetrievalSeeds(
    [
      ...dispatch.retrievalQueries,
      ...caseFrame.retrieval_queries,
      ...(evidencePlan.query_plan?.concept_queries ?? []),
      ...(evidencePlan.query_plan?.object_queries ?? []),
      ...(evidencePlan.query_plan?.behavior_queries ?? []),
      input.query
    ],
    8
  );
  const evidenceResult = await input.orchestrator
    .collectEvidence({
      queries: retrievalQueries,
      idempotencyKey: `${input.idempotencyKey}:support-domain:evidence`,
      runtime: input.runtime,
      answerLanguage: input.language,
      attachments: input.attachments,
      caseFrame,
      repoId: input.repoId,
      branch: input.branch
    })
    .then((value) => ({
      value,
      timing: stageTiming("completed", elapsedMs(retrievalStartedAt), {
        query_count: retrievalQueries.length,
        reference_count: value.references.length
      })
    }))
    .catch(() => ({
      value: {
        query: input.query,
        answer: "",
        confidence: 0,
        references: [],
        retrievalStatus: "kb_unavailable" as const,
        unresolvedReasonCode: "KB_RETRIEVAL_UNAVAILABLE" as const,
        resolvedQueries: retrievalQueries,
        fallbackUsed: true
      },
      timing: stageTiming("fallback", elapsedMs(retrievalStartedAt), {
        query_count: retrievalQueries.length,
        reference_count: 0
      })
    }));
  markStageCompleted("retrieval_base");

  await reportStageProgress("evidence_selection");
  const evidenceSelectionStartedAt = performance.now();
  const rankedEvidenceReferences = evidenceResult.value.references;
  const deterministicEvidenceSelection = fallbackEvidenceSelection(
    rankedEvidenceReferences,
    input.query,
    caseFrame,
    primaryDomain
  );
  const evidenceSelectorRuntime = withStageRuntime(
    buildDeliveryAwareStageRuntime(
      input.runtime,
      {
        reserveMs: 9_000,
        minimumTimeoutMs: 4_000,
        stageTimeoutMs: 24_000
      },
      {
        reserveMs: 12_000,
        minimumTimeoutMs: 8_000,
        stageTimeoutMs: 36_000
      }
    ),
    "support-evidence-selector",
    `${input.idempotencyKey}:support-domain:evidence-selection`
  );
  const evidenceSelection =
    rankedEvidenceReferences.length > 0
      ? await input.adapter
          .selectSupportEvidence(
            {
              contextType: input.contextType,
              language: input.language,
              query: input.query,
              caseFrame,
              references: rankedEvidenceReferences
            },
            `${input.idempotencyKey}:support-domain:evidence-selection`,
            evidenceSelectorRuntime
          )
          .then((value) => ({
            value,
            timing: stageTiming("completed", elapsedMs(evidenceSelectionStartedAt), {
              reference_count: rankedEvidenceReferences.length
            })
          }))
          .catch((error) => {
            console.warn("[support-runtime] evidence selector fallback", {
              query: input.query.slice(0, 160),
              primaryDomain,
              error: supportStageErrorMessage(error)
            });
            return {
              value: deterministicEvidenceSelection,
              timing: stageTiming("fallback", elapsedMs(evidenceSelectionStartedAt), {
                reference_count: rankedEvidenceReferences.length
              })
            };
          })
      : {
          value: deterministicEvidenceSelection,
          timing:
            rankedEvidenceReferences.length > 0
              ? stageTiming("skipped", elapsedMs(evidenceSelectionStartedAt), {
                  reference_count: rankedEvidenceReferences.length
                })
              : stageTiming("completed", elapsedMs(evidenceSelectionStartedAt), {
                  reference_count: 0
                })
        };
  markStageCompleted("evidence_selection");

  const evidenceBundle = buildEvidenceBundle({
    references: evidenceResult.value.references,
    confidence: evidenceResult.value.confidence,
    fallbackUsed: evidenceResult.value.fallbackUsed,
    resolvedQueries: evidenceResult.value.resolvedQueries,
    caseFrame,
    query: input.query,
    selection: evidenceSelection.value,
    primaryDomain,
    strictSelection: false
  });

  const specialistRuntime = withStageRuntime(
    buildDeliveryAwareStageRuntime(
      input.runtime,
      {
        reserveMs: 6_000,
        minimumTimeoutMs: 8_000,
        stageTimeoutMs: 55_000
      },
      {
        reserveMs: 14_000,
        minimumTimeoutMs: 10_000,
        stageTimeoutMs: 70_000
      }
    ),
    route.specialist_agent,
    `${input.idempotencyKey}:domain-specialist`
  );
  const supportWriterRuntime = withStageRuntime(
    buildDeliveryAwareStageRuntime(
      input.runtime,
      {
        reserveMs: 4_000,
        minimumTimeoutMs: 6_000,
        stageTimeoutMs: 40_000
      },
      {
        reserveMs: 8_000,
        minimumTimeoutMs: 8_000,
        stageTimeoutMs: 55_000
      }
    ),
    "support-writer",
    `${input.idempotencyKey}:support-writer`
  );

  await reportStageProgress("writer");
  const writerStartedAt = performance.now();
  const specialistResult = await writeDomainSpecialistDraft({
    adapter: input.adapter,
    primaryDomain,
    contextType: input.contextType,
    route,
    language: input.language,
    query: input.query,
    caseFrame,
    evidenceBundle,
    conversationHistory: input.conversationHistory,
    runtime: specialistRuntime,
    idempotencyKey: `${input.idempotencyKey}:domain-specialist`
  })
    .then((value) => ({ value, timing: stageTiming("completed", elapsedMs(writerStartedAt)) }))
    .catch((error) => {
      console.warn("[support-runtime] domain specialist fallback", {
        query: input.query.slice(0, 160),
        primaryDomain,
        specialist: route.specialist_agent,
        error: supportStageErrorMessage(error),
        runtime: {
          deliveryMode: specialistRuntime?.deliveryMode ?? null,
          timeoutMs: specialistRuntime?.timeoutMs ?? null,
          overallTimeoutMs: specialistRuntime?.overallTimeoutMs ?? null
        }
      });
      return { value: null, timing: stageTiming("fallback", elapsedMs(writerStartedAt)) };
    });
  const specialistHasGroundedClaims = specialistResult.value ? hasGroundedDraftClaims(specialistResult.value) : false;
  const specialistHasEvidenceAlignedClaims =
    specialistResult.value ? hasGroundedDraftClaimsInEvidence(specialistResult.value, evidenceBundle) : false;
  const shouldUseSupportWriter =
    !specialistResult.value ||
    !specialistResult.value.direct_answer.trim() ||
    (!specialistHasEvidenceAlignedClaims && !specialistHasGroundedClaims);
  const supportWriterResult = shouldUseSupportWriter
    ? await input.adapter
        .writeSupportAnswer(
          {
            contextType: input.contextType,
            language: input.language,
            query: input.query,
            caseFrame,
            evidenceBundle,
            conversationHistory: input.conversationHistory,
            ticketContext: input.ticketContext
          },
          `${input.idempotencyKey}:support-writer`,
          supportWriterRuntime
        )
        .then((value) => ({ value, timing: stageTiming("completed", elapsedMs(writerStartedAt)) }))
        .catch((error) => {
          console.warn("[support-runtime] support writer fallback", {
            query: input.query.slice(0, 160),
            primaryDomain,
            error: supportStageErrorMessage(error)
          });
          return { value: null, timing: stageTiming("fallback", elapsedMs(writerStartedAt)) };
        })
    : { value: null, timing: stageTiming("skipped", elapsedMs(writerStartedAt)) };
  markStageCompleted("writer");

  const supportWriterDraft = supportWriterResult.value
    ? convertGenericSupportDraftToSpecialistDraft({
        route,
        draft: supportWriterResult.value
      })
    : null;
  const shouldPreferSupportWriterDraft =
    Boolean(supportWriterDraft) &&
    (!specialistResult.value ||
      !specialistResult.value.direct_answer.trim() ||
      (!specialistHasEvidenceAlignedClaims && !specialistHasGroundedClaims));
  const draftSupportAnswer =
    (shouldPreferSupportWriterDraft ? supportWriterDraft : specialistResult.value) ??
    supportWriterDraft ??
    specialistResult.value ??
    fallbackSpecialistDraftAnswer({
      language: input.language,
      route,
      query: input.query,
      evidenceBundle,
      missingInfo: caseFrame.missing_critical_info
    });
  const finalDraftSupportAnswer = draftSupportAnswer;
  const writerTiming = stageTiming(
    specialistResult.value || supportWriterDraft ? "completed" : "fallback",
    elapsedMs(writerStartedAt)
  );

  const localVerificationStartedAt = performance.now();
  const writerBoundVerification = sanitizeVerification({
    verification: buildEvidenceBoundDraftVerification({
      language: input.language,
      draftAnswer: finalDraftSupportAnswer,
      missingInfo: sanitizeMissingCriticalInfo([...caseFrame.missing_critical_info, ...finalDraftSupportAnswer.unknowns], 3),
      summary: {
        zh: "support-agent 回答草稿已按已发布知识证据完成绑定。",
        en: "The support-agent draft answer was reconciled against published knowledge evidence."
      }
    }),
    evidenceBundle,
    query: input.query,
    caseFrame
  });
  const writerBoundVerificationTiming = stageTiming("completed", elapsedMs(localVerificationStartedAt));

  await reportStageProgress("verification");
  const verifierStartedAt = performance.now();
  const judgeRuntime = withStageRuntime(
    buildDeliveryAwareStageRuntime(
      input.runtime,
      {
        reserveMs: 3_000,
        minimumTimeoutMs: 8_000,
        stageTimeoutMs: 45_000
      },
      {
        reserveMs: 5_000,
        minimumTimeoutMs: 10_000,
        stageTimeoutMs: 60_000
      }
    ),
    "evidence-judge",
    `${input.idempotencyKey}:support-domain:evidence-judge`
  );
  const verificationResult = await input.adapter
    .judgeSupportAnswer(
      {
        contextType: input.contextType,
        language: input.language,
        query: input.query,
        caseFrame,
        evidenceBundle,
        draftSupportAnswer: finalDraftSupportAnswer
      },
      `${input.idempotencyKey}:support-domain:evidence-judge`,
      judgeRuntime
    )
    .then((value) => ({ value, timing: stageTiming("completed", elapsedMs(verifierStartedAt)) }))
    .catch(async (error) => {
      console.warn("[support-runtime] evidence judge fallback", {
        query: input.query.slice(0, 160),
        primaryDomain,
        attempt: 1,
        error: supportStageErrorMessage(error)
      });
      try {
        const retryValue = await input.adapter.judgeSupportAnswer(
          {
            contextType: input.contextType,
            language: input.language,
            query: input.query,
            caseFrame,
            evidenceBundle,
            draftSupportAnswer: finalDraftSupportAnswer
          },
          `${input.idempotencyKey}:support-domain:evidence-judge:retry-2`,
          judgeRuntime
        );
        return { value: retryValue, timing: stageTiming("completed", elapsedMs(verifierStartedAt)) };
      } catch (retryError) {
        console.warn("[support-runtime] evidence judge fallback", {
          query: input.query.slice(0, 160),
          primaryDomain,
          attempt: 2,
          error: supportStageErrorMessage(retryError)
        });
        return { value: null, timing: stageTiming("fallback", elapsedMs(verifierStartedAt)) };
      }
    });
  markStageCompleted("verification");
  const sanitizedJudgeVerification = verificationResult.value
    ? sanitizeVerification({
        verification: verificationResult.value,
        evidenceBundle,
        query: input.query,
        caseFrame
      })
    : null;
  const supportedCoreClaims = sanitizedJudgeVerification ? supportedVerificationClaims(sanitizedJudgeVerification) : [];
  const unsupportedCore =
    sanitizedJudgeVerification?.unsupported_claims.some(
      (claim) =>
        overlapsUnsupportedClaim(finalDraftSupportAnswer.direct_answer, [claim]) ||
        finalDraftSupportAnswer.claims.some(
          (draftClaim: SpecialistDraftAnswer["claims"][number]) =>
            draftClaim.kind !== "operational_advice" && overlapsUnsupportedClaim(draftClaim.text, [claim])
        )
    ) ?? false;
  const effectiveJudgeVerification =
    sanitizedJudgeVerification &&
    sanitizedJudgeVerification.verdict === "partial" &&
    supportedCoreClaims.length > 0 &&
    sanitizedJudgeVerification.unsupported_claims.length > 0 &&
    !unsupportedCore
      ? {
          ...sanitizedJudgeVerification,
          verdict: "verified" as const,
          unsupported_claims: [],
          missing_info: []
        }
      : sanitizedJudgeVerification;
  const finalVerification =
    effectiveJudgeVerification
      ? preferWriterBoundVerificationForDelivery({
          selected: sanitizeVerification({
            verification: pickBestVerificationCandidate({
              query: input.query,
              caseFrame,
              evidenceBundle,
              primary: effectiveJudgeVerification,
              rebound: null,
              writerBound: writerBoundVerification
            }),
            evidenceBundle,
            query: input.query,
            caseFrame
          }),
          writerBound: writerBoundVerification,
          evidenceBundle,
          query: input.query,
          caseFrame
        })
      : writerBoundVerification;
  const supportedFinalClaims = supportedVerificationClaims(finalVerification);
  const effectiveFinalVerification =
    supportedFinalClaims.length > 0
      ? finalVerification
      : {
          ...finalVerification,
          verified_citation_ids: [],
          display_citation_ids: []
        };
  const deliveryUnknowns =
    supportedFinalClaims.length > 0 || evidenceBundle.primary.length > 0 || evidenceBundle.supplemental.length > 0
      ? finalDraftSupportAnswer.unknowns
      : [];
  const normalizedMissingInfo = sanitizeMissingCriticalInfo(
    [...effectiveFinalVerification.missing_info, ...caseFrame.missing_critical_info, ...deliveryUnknowns],
    3
  );
  const mode = resolveSupportMode({
    verification: effectiveFinalVerification,
    references: [...evidenceBundle.primary, ...evidenceBundle.supplemental],
    currentRound: input.currentRound + 1,
    missingInfo: normalizedMissingInfo
  });
  const supportedClaims = supportedVerificationClaims(effectiveFinalVerification);
  const answerComposerRuntime = withStageRuntime(
    buildDeliveryAwareStageRuntime(
      input.runtime,
      {
        reserveMs: 1_500,
        minimumTimeoutMs: 4_000,
        stageTimeoutMs: 30_000
      },
      {
        reserveMs: 2_000,
        minimumTimeoutMs: 10_000,
        stageTimeoutMs: 70_000
      }
    ),
    "answer-composer",
    `${input.idempotencyKey}:answer-composer`
  );
  const answerComposerStartedAt = performance.now();
  await reportStageProgress("answer_composition");
  const shouldComposeCustomerAnswer = true;
  const composedSupportAnswer =
    shouldComposeCustomerAnswer
      ? await input.adapter
          .composeCustomerAnswer(
            {
              contextType: input.contextType,
              language: input.language,
              query: input.query,
              mode,
              route,
              caseFrame,
              draftSupportAnswer: finalDraftSupportAnswer,
              supportedClaims,
              nextActions: filterUnsupported(finalDraftSupportAnswer.next_actions, effectiveFinalVerification.unsupported_claims),
              unknowns: uniqueStrings([...deliveryUnknowns, ...normalizedMissingInfo], 4)
            },
            `${input.idempotencyKey}:answer-composer`,
            answerComposerRuntime
          )
          .then((value) => ({ value, timing: stageTiming("completed", elapsedMs(answerComposerStartedAt)) }))
          .catch(async (error) => {
            console.warn("[support-runtime] answer composer fallback", {
              query: input.query.slice(0, 160),
              primaryDomain,
              attempt: 1,
              error: supportStageErrorMessage(error),
              runtime: {
                deliveryMode: answerComposerRuntime?.deliveryMode ?? null,
                timeoutMs: answerComposerRuntime?.timeoutMs ?? null,
                overallTimeoutMs: answerComposerRuntime?.overallTimeoutMs ?? null
              }
            });
            try {
              const retryValue = await input.adapter.composeCustomerAnswer(
                {
                  contextType: input.contextType,
                  language: input.language,
                  query: input.query,
                  mode,
                  route,
                  caseFrame,
                  draftSupportAnswer: finalDraftSupportAnswer,
                  supportedClaims,
                  nextActions: filterUnsupported(finalDraftSupportAnswer.next_actions, effectiveFinalVerification.unsupported_claims),
                  unknowns: uniqueStrings([...deliveryUnknowns, ...normalizedMissingInfo], 4)
                },
                `${input.idempotencyKey}:answer-composer:retry-2`,
                answerComposerRuntime
              );
              return { value: retryValue, timing: stageTiming("completed", elapsedMs(answerComposerStartedAt)) };
            } catch (retryError) {
              console.warn("[support-runtime] answer composer fallback", {
                query: input.query.slice(0, 160),
                primaryDomain,
                attempt: 2,
                error: supportStageErrorMessage(retryError),
                runtime: {
                  deliveryMode: answerComposerRuntime?.deliveryMode ?? null,
                  timeoutMs: answerComposerRuntime?.timeoutMs ?? null,
                  overallTimeoutMs: answerComposerRuntime?.overallTimeoutMs ?? null
                }
              });
              return { value: null, timing: stageTiming("fallback", elapsedMs(answerComposerStartedAt)) };
            }
          })
      : { value: null, timing: skippedStageTiming() };
  markStageCompleted("answer_composition");
  const supportAnswer = buildSupportAnswerFromDraft({
    language: input.language,
    mode,
    route,
    draft: finalDraftSupportAnswer,
    verification: effectiveFinalVerification,
    missingInfo: normalizedMissingInfo,
    composed: composedSupportAnswer.value
  });
  const structuredAnswer = buildStructuredAnswer(supportAnswer, effectiveFinalVerification);
  const citations = buildCitations({
    references: [...evidenceBundle.primary, ...evidenceBundle.supplemental],
    verification: effectiveFinalVerification
  });
  const unresolvedReasonCode = resolveSupportUnresolvedReasonCode({
    retrievalStatus:
      evidenceResult.value.retrievalStatus === "kb_unavailable"
        ? "kb_unavailable"
        : evidenceBundle.primary.length > 0 || evidenceBundle.supplemental.length > 0
        ? "grounded"
        : "no_results",
    hasReferences: evidenceBundle.primary.length > 0 || evidenceBundle.supplemental.length > 0,
    mode,
    verification: effectiveFinalVerification
  });
  const clarificationRound = mode === "clarification" ? input.currentRound + 1 : 0;
  const state: SearchDialogState =
    mode === "clarification"
      ? input.currentRound > 0
        ? "CLARIFICATION_IN_PROGRESS"
        : "CLARIFICATION_REQUIRED"
      : mode === "handoff"
      ? "TICKET_HANDOFF_RECOMMENDED"
      : "GROUNDABLE_ANSWER_READY";
  const stageTimings: SupportAgentStageTimings = {
    total_ms: elapsedMs(runStartedAt),
    planner: dispatchResult.timing,
    retrieval_base: evidenceResult.timing,
    retrieval_extra: skippedStageTiming(),
    writer: writerTiming,
    verifier: verificationResult.value ? verificationResult.timing : writerBoundVerificationTiming
  };
  const stageTrace: SupportAgentStageTraceEntry[] = [
    stageTraceEntry({
      stage: "domain_dispatch",
      timing: dispatchResult.timing,
      runtimeStage: "planner",
      idempotencyKey: `${input.idempotencyKey}:support-dispatch`
    }),
    stageTraceEntry({
      stage: "retrieval",
      timing: evidenceResult.timing,
      idempotencyKey: `${input.idempotencyKey}:support-domain:evidence`
    }),
    stageTraceEntry({
      stage: "evidence_selection",
      timing: evidenceSelection.timing,
      runtimeStage: evidenceSelection.timing.status === "completed" ? "support-evidence-selector" : undefined,
      idempotencyKey: `${input.idempotencyKey}:support-domain:evidence-selection`
    }),
    stageTraceEntry({
      stage: "domain_specialist",
      timing: specialistResult.timing,
      runtimeStage: route.specialist_agent,
      idempotencyKey: `${input.idempotencyKey}:domain-specialist`
    }),
    ...(supportWriterResult.timing.status === "completed" || supportWriterResult.timing.status === "fallback"
      ? [
          stageTraceEntry({
            stage: "generic_writer",
            timing: supportWriterResult.timing,
            runtimeStage: "support-writer",
            idempotencyKey: `${input.idempotencyKey}:support-writer`
          })
        ]
      : []),
    stageTraceEntry({
      stage: "verification",
      timing: verificationResult.value ? verificationResult.timing : writerBoundVerificationTiming,
      runtimeStage: "evidence-judge",
      idempotencyKey: `${input.idempotencyKey}:support-domain:evidence-judge`
    }),
    stageTraceEntry({
      stage: "answer_composition",
      timing: composedSupportAnswer.timing,
      runtimeStage: shouldComposeCustomerAnswer ? "answer-composer" : undefined,
      idempotencyKey: `${input.idempotencyKey}:answer-composer`
    })
  ];

  return {
    caseFrame,
    evidenceBundle,
    verification: effectiveFinalVerification,
    stageTimings,
    result: {
      session_id: "",
      answer: supportAnswer.direct_answer,
      answer_language: input.language,
      case_frame: caseFrame,
      support_answer: supportAnswer,
      verification: effectiveFinalVerification,
      structured_answer: structuredAnswer,
      confidence: evidenceResult.value.confidence,
      suggested_next_step: mode === "grounded" ? "self_serve" : "submit_ticket",
      retrieval_status:
        evidenceResult.value.retrievalStatus === "kb_unavailable"
          ? "kb_unavailable"
          : evidenceResult.value.references.length
          ? "grounded"
          : "no_results",
      unresolved_reason_code: unresolvedReasonCode,
      references: [...evidenceBundle.primary, ...evidenceBundle.supplemental],
      citations,
      state,
      clarification_round: clarificationRound,
      show_create_ticket_now: mode === "handoff",
      follow_up_question: mode === "clarification" ? normalizedMissingInfo[0] ?? null : null,
      internal_diagnostics: {
        route,
        evidence_plan: evidencePlan,
        stage_budget: stageBudget,
        retrieval_queries_used: retrievalQueries,
        retrieval_queries_refined: [],
        claim_graph: buildClaimGraph(effectiveFinalVerification),
        specialist_skipped: !specialistResult.value,
        specialists_used: uniqueStrings(
          [specialistResult.value ? route.specialist_agent : null, supportWriterDraft ? "support-writer" : null],
          3
        ),
        domains_used: [primaryDomain],
        evidence_sources: uniqueStrings(
          evidenceBundle.primary.concat(evidenceBundle.supplemental).map((item) => item.sourceType ?? "unknown"),
          6
        ),
        runtime_policy: input.runtimePolicy,
        runtime_mode: "supervisor_domain",
        fast_path_used: false,
        confirmed_facts: uniqueStrings(finalDraftSupportAnswer.confirmed_facts ?? [], 4),
        stage_trace: stageTrace,
        orchestration_trace: buildOrchestrationTrace({
          route,
          specialistSkipped: !specialistResult.value,
          usedUnifiedPlanner: true,
          verificationSkipped: false,
          answerComposerUsed: shouldComposeCustomerAnswer && Boolean(composedSupportAnswer.value)
        })
      }
    }
  };
}

async function writeSpecialistDraft(input: {
  adapter: OpenClawAdapter;
  contextType: "search" | "triage";
  route: SupportQuestionRoute;
  language: "zh" | "en";
  query: string;
  caseFrame: SupportCaseFrame;
  evidenceBundle: SupportEvidenceBundle;
  conversationHistory: Array<{ role: "user" | "assistant"; content: string }>;
  runtime?: OpenClawRuntimeContext;
  idempotencyKey: string;
}): Promise<SpecialistDraftAnswer> {
  const specialistInput = {
    contextType: input.contextType,
    language: input.language,
    query: input.query,
    route: input.route,
    caseFrame: input.caseFrame,
    evidenceBundle: input.evidenceBundle,
    conversationHistory: input.conversationHistory
  };
  switch (input.route.specialist_agent) {
    case "api-specialist":
      return input.adapter.writeApiSpecialistAnswer(specialistInput, input.idempotencyKey, input.runtime);
    case "howto-specialist":
      return input.adapter.writeHowToSpecialistAnswer(specialistInput, input.idempotencyKey, input.runtime);
    case "behavior-specialist":
      return input.adapter.writeBehaviorSpecialistAnswer(specialistInput, input.idempotencyKey, input.runtime);
    default:
      return input.adapter.writeTroubleshootingSpecialistAnswer(specialistInput, input.idempotencyKey, input.runtime);
  }
}

async function writeDomainSpecialistDraft(input: {
  adapter: OpenClawAdapter;
  primaryDomain: SupportDomain;
  contextType: "search" | "triage";
  route: SupportQuestionRoute;
  language: "zh" | "en";
  query: string;
  caseFrame: SupportCaseFrame;
  evidenceBundle: SupportEvidenceBundle;
  conversationHistory: Array<{ role: "user" | "assistant"; content: string }>;
  runtime?: OpenClawRuntimeContext;
  idempotencyKey: string;
}): Promise<SpecialistDraftAnswer | null> {
  const specialistInput = {
    contextType: input.contextType,
    language: input.language,
    query: input.query,
    route: input.route,
    caseFrame: input.caseFrame,
    evidenceBundle: input.evidenceBundle,
    conversationHistory: input.conversationHistory
  };

  switch (input.primaryDomain) {
    case "openapi":
      if (input.adapter.writeOpenApiDomainAnswer) {
        return input.adapter.writeOpenApiDomainAnswer(specialistInput, input.idempotencyKey, input.runtime);
      }
      return writeSpecialistDraft({
        adapter: input.adapter,
        contextType: input.contextType,
        route: input.route,
        language: input.language,
        query: input.query,
        caseFrame: input.caseFrame,
        evidenceBundle: input.evidenceBundle,
        conversationHistory: input.conversationHistory,
        runtime: input.runtime,
        idempotencyKey: input.idempotencyKey
      });
    case "deployment":
      if (input.adapter.writeDeploymentDomainAnswer) {
        return input.adapter.writeDeploymentDomainAnswer(specialistInput, input.idempotencyKey, input.runtime);
      }
      return writeSpecialistDraft({
        adapter: input.adapter,
        contextType: input.contextType,
        route: input.route,
        language: input.language,
        query: input.query,
        caseFrame: input.caseFrame,
        evidenceBundle: input.evidenceBundle,
        conversationHistory: input.conversationHistory,
        runtime: input.runtime,
        idempotencyKey: input.idempotencyKey
      });
    default:
      if (input.adapter.writeDocsDomainAnswer) {
        return input.adapter.writeDocsDomainAnswer(specialistInput, input.idempotencyKey, input.runtime);
      }
      return writeSpecialistDraft({
        adapter: input.adapter,
        contextType: input.contextType,
        route: input.route,
        language: input.language,
        query: input.query,
        caseFrame: input.caseFrame,
        evidenceBundle: input.evidenceBundle,
        conversationHistory: input.conversationHistory,
        runtime: input.runtime,
        idempotencyKey: input.idempotencyKey
      });
  }
}

function fallbackTriageInsight(language: "zh" | "en", caseFrame: SupportCaseFrame, mode: "ask_user" | "escalate"): TriageSupportInsight {
  if (language === "zh") {
    return {
      direct_answer: mode === "escalate" ? "现有证据更适合升级给研发处理。" : "当前还缺少一个关键信息，建议先向客户追问。",
      recommended_action: mode,
      customer_reply:
        mode === "escalate"
          ? "感谢反馈。该问题需要更深入的技术分析，我已升级给研发团队继续处理。"
          : `为继续处理，请先补充：${caseFrame.missing_critical_info[0] ?? "最关键的一条上下文"}`,
      customer_reply_policy: mode === "escalate" ? "no_send" : "send_now",
      support_summary: mode === "escalate" ? "Escalate to R&D with current evidence." : "Ask one targeted follow-up question.",
      verified_evidence: [],
      risk_flags: mode === "escalate" ? ["needs_rnd"] : [],
      missing_info: caseFrame.missing_critical_info.slice(0, 3),
      verifier_verdict: mode === "escalate" ? "partial" : "unsupported"
    };
  }

  return {
    direct_answer:
      mode === "escalate"
        ? "The current evidence points to an engineering-level issue that should be escalated."
        : "One critical detail is still missing, so ask the customer a single targeted follow-up question.",
    recommended_action: mode,
    customer_reply:
      mode === "escalate"
        ? "Thanks for the report. This issue needs deeper technical investigation, so I have escalated it to our engineering team."
        : `To continue, please share: ${caseFrame.missing_critical_info[0] ?? "the single most important missing detail"}.`,
    customer_reply_policy: mode === "escalate" ? "no_send" : "send_now",
    support_summary: mode === "escalate" ? "Escalate to R&D with current evidence." : "Ask one targeted follow-up question.",
    verified_evidence: [],
    risk_flags: mode === "escalate" ? ["needs_rnd"] : [],
    missing_info: caseFrame.missing_critical_info.slice(0, 3),
    verifier_verdict: mode === "escalate" ? "partial" : "unsupported"
  };
}

export async function runSupportSearchAgent(input: {
  query: string;
  language: "zh" | "en";
  currentRound: number;
  conversationHistory: Array<{ role: "user" | "assistant"; content: string }>;
  adapter: OpenClawAdapter;
  runtime?: OpenClawRuntimeContext;
  attachments?: string[];
  repoId?: string;
  branch?: string;
  idempotencyKey: string;
  contextType?: "search" | "triage";
  orchestrator?: SupportSearchOrchestrator;
  onStageProgress?: (progress: SupportAgentStageProgress) => Promise<void> | void;
  ticketContext?: {
    priority: string;
    customerMeta: Record<string, unknown>;
    history: Array<{ author: string; body: string; at: string }>;
  };
}): Promise<{
  result: SearchModeResult;
  caseFrame: SupportCaseFrame;
  evidenceBundle: SupportEvidenceBundle;
  verification: SupportVerificationResult;
  stageTimings: SupportAgentStageTimings;
}> {
  const orchestrator = input.orchestrator ?? new SearchOrchestrator(input.adapter);
  const contextType = input.contextType ?? "search";
  const runtimePolicy = resolveSupportRuntimePolicy(input.runtime);
  if (!input.adapter.planSupportDispatch) {
    throw new Error("support dispatch contract unavailable: adapter.planSupportDispatch is required");
  }

  return runSupervisorDomainSupportSearch({
    ...input,
    adapter: input.adapter,
    contextType,
    orchestrator,
    runtimePolicy
  });

}

function buildTriageCustomerReply(input: {
  language: "zh" | "en";
  action: TriageSupportInsight["recommended_action"];
  supportAnswer: SupportAnswer;
  missingInfo: string[];
}): string {
  if (input.action === "escalate") {
    return input.language === "zh"
      ? "感谢反馈。当前证据不足以给出可靠自助结论，建议升级给研发继续排查。"
      : "Thanks for the report. The current evidence is not strong enough for a reliable self-serve conclusion, so this should be escalated to engineering.";
  }

  if (input.action === "ask_user") {
    const missing = input.missingInfo[0] ?? input.supportAnswer.still_need_to_confirm[0];
    if (missing) {
      return input.language === "zh" ? `为继续处理，请先补充：${missing}` : `To continue, please share: ${missing}.`;
    }
    return input.language === "zh"
      ? "为继续处理，请补充当前失败步骤、预期结果、实际结果和报错原文。"
      : "To continue, please share the failing step, expected result, actual result, and the exact error message.";
  }

  return uniqueStrings([input.supportAnswer.direct_answer, ...input.supportAnswer.what_to_do_now], 3).join("\n");
}

function buildTriageInsightFromSupportRuntime(input: {
  language: "zh" | "en";
  supportAnswer: SupportAnswer;
  verification: SupportVerificationResult;
  evidenceBundle: SupportEvidenceBundle;
  citations: SearchModeResult["citations"];
}): TriageSupportInsight {
  const missingInfo = uniqueStrings(
    [...input.supportAnswer.still_need_to_confirm, ...input.verification.missing_info],
    3
  );
  const recommended_action: TriageSupportInsight["recommended_action"] =
    input.supportAnswer.mode === "handoff"
      ? "escalate"
      : input.supportAnswer.mode === "clarification"
      ? "ask_user"
      : input.verification.verdict === "verified" && input.evidenceBundle.primary.length > 0
      ? "resolve"
      : "ask_user";

  return {
    direct_answer: input.supportAnswer.direct_answer,
    recommended_action,
    customer_reply: buildTriageCustomerReply({
      language: input.language,
      action: recommended_action,
      supportAnswer: input.supportAnswer,
      missingInfo
    }),
    customer_reply_policy: recommended_action === "escalate" ? "no_send" : "send_now",
    support_summary: input.supportAnswer.direct_answer,
    verified_evidence:
      input.citations.length > 0
        ? input.citations.map((item) => item.title).slice(0, 3)
        : uniqueStrings(input.evidenceBundle.primary.map((item) => item.title), 3),
    risk_flags: recommended_action === "escalate" ? ["needs_rnd"] : [],
    missing_info: missingInfo,
    verifier_verdict: input.verification.verdict
  };
}

export async function runSupportTriageAgent(input: {
  query: string;
  language: "zh" | "en";
  adapter: OpenClawAdapter;
  runtime?: OpenClawRuntimeContext;
  idempotencyKey: string;
  priority: string;
  customerMeta: Record<string, unknown>;
  history: Array<{ author: string; body: string; at: string }>;
  attachments?: string[];
  repoId?: string;
  branch?: string;
  orchestrator?: SupportSearchOrchestrator;
}): Promise<{
  analyzeOutput: OpenClawAnalyzeOutput & Record<string, unknown>;
  caseFrame: SupportCaseFrame;
  evidenceBundle: SupportEvidenceBundle;
  verification: SupportVerificationResult;
  stageTimings: SupportAgentStageTimings;
}> {
  const conversationHistory = input.history
    .slice(-6)
    .map((item) => ({ role: "user" as const, content: `${item.author}: ${item.body}` }));
  const supportExecution = await runSupportSearchAgent({
    query: input.query,
    language: input.language,
    currentRound: 0,
    conversationHistory,
    adapter: input.adapter,
    runtime: input.runtime,
    attachments: input.attachments,
    repoId: input.repoId,
    branch: input.branch,
    orchestrator: input.orchestrator,
    idempotencyKey: input.idempotencyKey,
    contextType: "triage",
    ticketContext: {
      priority: input.priority,
      customerMeta: input.customerMeta,
      history: input.history
    }
  });
  const supportAnswer =
    supportExecution.result.support_answer ??
    fallbackSupportAnswer({
      language: input.language,
      mode: "handoff",
      missingInfo: supportExecution.caseFrame.missing_critical_info
    });
  const insight = buildTriageInsightFromSupportRuntime({
    language: input.language,
    supportAnswer,
    verification: supportExecution.verification,
    evidenceBundle: supportExecution.evidenceBundle,
    citations: supportExecution.result.citations
  });
  const action = insight.recommended_action;

  return {
    caseFrame: supportExecution.caseFrame,
    evidenceBundle: supportExecution.evidenceBundle,
    verification: supportExecution.verification,
    stageTimings: supportExecution.stageTimings,
    analyzeOutput: {
      action,
      confidence: supportExecution.result.confidence,
      reply: insight.customer_reply_policy === "send_now" ? insight.customer_reply : "",
      reasoning_summary: insight.support_summary,
      evidence: insight.verified_evidence.length
        ? insight.verified_evidence
        : uniqueStrings(supportExecution.evidenceBundle.primary.map((item) => item.title), 4),
      risk_flags: insight.risk_flags,
      support_insight: insight,
      verification_summary: supportExecution.verification,
      case_frame: supportExecution.caseFrame,
      evidence_bundle_digest: digestEvidenceBundle(supportExecution.evidenceBundle),
      stage_timings: supportExecution.stageTimings,
      stage_trace: supportExecution.result.internal_diagnostics?.stage_trace ?? []
    }
  };
}
