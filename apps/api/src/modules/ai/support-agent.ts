import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { env } from "../../config/env.js";
import type {
  OpenClawAdapter,
  OpenClawAnalyzeOutput,
  OpenClawRuntimeContext
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
  SupportEvidenceBundle,
  SupportEvidencePlan,
  SupportEvidenceSelection,
  SupportQuestionRoute,
  SupportVerificationResult,
  TriageSupportInsight
} from "./types.js";
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

function withExplicitStageRuntime(input: {
  runtime?: OpenClawRuntimeContext;
  stage: NonNullable<OpenClawRuntimeContext["stage"]>;
  sessionSeed: string;
  agentId: string;
  model?: string;
}): OpenClawRuntimeContext {
  const prefix = env.OPENCLAW_AGENT_SESSION_PREFIX.trim() || "nf";
  const base = input.runtime ?? {};
  return {
    ...base,
    stage: input.stage,
    agentId: input.agentId,
    model: input.model,
    sessionKey: `agent:${input.agentId}:${sanitizeSessionPart(`${prefix}:${input.stage}:${input.sessionSeed}`)}`
  };
}

function fallbackCaseFrame(query: string): SupportCaseFrame {
  const normalized = query.trim();
  return {
    goal: normalized,
    symptom: normalized,
    object: "unspecified",
    action_type: /how|如何|怎么|步骤|api|接口/i.test(query) ? "how_to" : "troubleshooting",
    deployment_model: /公有云|public cloud/i.test(query)
      ? "public_cloud"
      : /私有部署|private deployment|on[- ]?prem/i.test(query)
      ? "private_deployment"
      : "shared",
    product_area: /api|openapi|接口/i.test(query) ? "openapi" : "general",
    constraints: [],
    missing_critical_info: [],
    retrieval_queries: [normalized],
    query_plan: {
      concept_queries: [normalized],
      object_queries: [normalized],
      behavior_queries: [normalized]
    }
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
  capabilityQuestionContext: boolean;
};

function hasCjkText(input: string): boolean {
  return /[\u3400-\u9FBF]/.test(input);
}

function analyzeSupportQuerySignals(query: string): SupportQuerySignals {
  const normalized = query.trim();
  const lowered = normalized.toLowerCase();
  return {
    apiContext: isApiShapedQuery(normalized),
    integrationContext:
      /集成|回调|重定向|redirect uri|redirect url|callback|webhook|github|gitlab|slack|teams/.test(normalized) ||
      /\b(integration|callback|redirect(?:\s+uri|\s+url)?|webhook|oauth app|github|gitlab|slack|teams)\b/i.test(lowered),
    privateDeploymentContext:
      /私有部署|本地部署|闭网|闭域网|内网|离线|受限环境/.test(normalized) ||
      /\b(private deployment|self[- ]?hosted|selfhosted|on[- ]?prem|onprem|air[- ]?gapped|closed network|offline|restricted environment)\b/i.test(lowered),
    infrastructureContext:
      /服务器|os层|操作系统|pod|集群|k8s|k3s|容器|运维/.test(normalized) ||
      /\b(server|backend service|backend services|database|databases|service topology|query path|query paths|architecture|topology|os[- ]?level|operating system|pod|cluster|k8s|k3s|container|ops|operation toolkit)\b/i.test(lowered),
    deploymentArchitectureContext:
      /部署架构|架构拓扑|服务拓扑|数据库拓扑|查询路径|隔离部署|模块隔离/.test(normalized) ||
      /\b(architecture|topology|service boundaries|service topology|database topology|shared backend|backend services|query path|query paths|monolith|unified system)\b/i.test(lowered),
    isolationContext:
      /隔离|拆分|独立部署|独立数据库|独立服务/.test(normalized) ||
      /\b(isolate|isolated|isolation|separate|separable|split|dedicated service|dedicated database)\b/i.test(lowered),
    accountRecoveryContext:
      /管理员密码|重置密码|恢复管理员|登录访问权限|邮件重置/.test(normalized) ||
      /\b(admin(?:istrator)? password|password reset|reset password|restore admin(?:istrator)? access|mail reset|email reset)\b/i.test(lowered),
    mailDependencyContext:
      /邮件服务|邮箱|邮件重置|外部无法直接连接|无法远程/.test(normalized) ||
      /\b(email|mail|smtp|remote access|remote operation|external connection)\b/i.test(lowered),
    troubleshootingContext:
      /排查|报错|错误|异常|失败|无法|不能|404|401|500|page not found/.test(normalized) ||
      /\b(troubleshoot|troubleshooting|error|errors|failed|failure|cannot|unable|not work|not working|stopped working|page not found|404|401|403|500)\b/i.test(lowered),
    wantsProcedure:
      /如何|怎么|步骤|方式|能否|是否存在|可以通过/.test(normalized) ||
      /\b(how|how to|steps?|procedure|workflow|can we|is there|via server|via os)\b/i.test(lowered),
    capabilityQuestionContext:
      /是否支持|支不支持|是否可以|能否|有没有|可不可以/.test(normalized) ||
      /\b(does|can|is)\b[\s\S]{0,80}\b(support|supported|possible|available|allow|allows)\b/i.test(normalized)
  };
}

function hasExplicitSupportAnchor(signals: SupportQuerySignals): boolean {
  return (
    signals.apiContext ||
    signals.integrationContext ||
    signals.privateDeploymentContext ||
    signals.infrastructureContext ||
    signals.deploymentArchitectureContext ||
    signals.isolationContext ||
    signals.accountRecoveryContext ||
    signals.mailDependencyContext
  );
}

function buildMinimumTroubleshootingClarification(query: string, caseFrame: SupportCaseFrame, signals: SupportQuerySignals): string | null {
  if (sanitizeMissingCriticalInfo(caseFrame.missing_critical_info, 1).length > 0) return null;
  if (String(caseFrame.question_type ?? "") !== "troubleshooting") return null;
  if (String(caseFrame.object ?? "").trim() && String(caseFrame.object ?? "").trim() !== "unspecified") return null;
  if (!signals.troubleshootingContext) return null;
  if (hasExplicitSupportAnchor(signals)) return null;
  return localizedSupportLabel(
    query,
    "变更后具体是哪个页面、接口或操作不能工作，以及你刚改了什么",
    "which exact page, API, or action stopped working, and what changed right before it"
  );
}

function localizedSupportLabel(query: string, zh: string, en: string): string {
  return hasCjkText(query) ? zh : en;
}

function isApiShapedQuery(query: string): boolean {
  return /\b(api|openapi|endpoint|path|method|scope|oauth|token)\b/i.test(query) || /接口|开放平台|鉴权|授权/.test(query);
}

function inferApiQuestionType(query: string): SupportQuestionRoute["question_type"] {
  if (/\b(scope|oauth|token)\b/i.test(query) || /权限|鉴权|授权/.test(query)) {
    return "api_scope_auth";
  }
  if ((/\b(status|field|id|uuid|identifier)\b/i.test(query) || /状态|字段|属性|标识|标识符/.test(query)) && isApiShapedQuery(query)) {
    return "api_field_lookup";
  }
  return "api_endpoint_lookup";
}

function stabilizeSupportRouteAndCaseFrame(input: {
  query: string;
  route: SupportQuestionRoute;
  caseFrame: SupportCaseFrame;
}): { route: SupportQuestionRoute; caseFrame: SupportCaseFrame } {
  const signals = analyzeSupportQuerySignals(input.query);
  const architectureQuestion =
    (signals.privateDeploymentContext || /deployment documentation|部署文档/i.test(input.query)) &&
    (signals.deploymentArchitectureContext || signals.isolationContext || signals.infrastructureContext);
  const deploymentModel =
    input.caseFrame.deployment_model === "unknown" || input.caseFrame.deployment_model === "shared"
      ? signals.privateDeploymentContext || architectureQuestion || (signals.infrastructureContext && signals.mailDependencyContext)
        ? "private_deployment"
        : input.caseFrame.deployment_model
      : input.caseFrame.deployment_model;
  const productArea =
    (input.caseFrame.product_area === "general" ||
      (input.caseFrame.product_area === "openapi" &&
        !isApiShapedQuery(input.query) &&
        (signals.accountRecoveryContext || signals.infrastructureContext || architectureQuestion))) &&
    (deploymentModel === "private_deployment" || signals.infrastructureContext || architectureQuestion)
      ? "deployment"
      : (input.caseFrame.product_area === "general" || input.caseFrame.product_area === "openapi") &&
        signals.integrationContext &&
        (input.caseFrame.action_type === "troubleshooting" || signals.troubleshootingContext)
      ? "integrations"
      : input.caseFrame.product_area;
  const shouldTreatAsHowTo =
    (signals.accountRecoveryContext && (signals.privateDeploymentContext || signals.infrastructureContext)) ||
    (signals.wantsProcedure && deploymentModel === "private_deployment");
  const shouldPreserveIntegrationTroubleshooting =
    (productArea === "integrations" || input.caseFrame.product_area === "integrations" || signals.integrationContext) &&
    (input.caseFrame.action_type === "troubleshooting" || signals.troubleshootingContext);
  const shouldForceBehaviorRoute =
    signals.capabilityQuestionContext &&
    !signals.apiContext &&
    !signals.troubleshootingContext &&
    !shouldPreserveIntegrationTroubleshooting &&
    !shouldTreatAsHowTo &&
    !architectureQuestion;
  const shouldForceApiRoute =
    signals.apiContext &&
    !shouldPreserveIntegrationTroubleshooting &&
    (input.caseFrame.product_area === "openapi" ||
      input.route.specialist_agent !== "api-specialist" ||
      !String(input.route.question_type ?? "").startsWith("api_"));
  const object =
    input.caseFrame.object === "unspecified" && signals.accountRecoveryContext
      ? localizedSupportLabel(input.query, "管理员密码重置", "administrator password reset")
      : input.caseFrame.object === "unspecified" && architectureQuestion
      ? localizedSupportLabel(input.query, "私有部署架构与隔离能力", "self-hosted deployment architecture and isolation")
      : input.caseFrame.object === "unspecified" && signals.integrationContext
      ? localizedSupportLabel(input.query, "集成授权回调", "integration authorization callback")
      : input.caseFrame.object;
  const actionType = shouldTreatAsHowTo ? "how_to" : input.caseFrame.action_type;

  let caseFrame: SupportCaseFrame = {
    ...input.caseFrame,
    deployment_model: deploymentModel,
    product_area: productArea,
    object,
    action_type: actionType,
    retrieval_queries: uniqueStrings(
      [...input.caseFrame.retrieval_queries, object, deploymentModel, productArea].map((item) =>
        String(item ?? "").replace(/[_/]+/g, " ")
      ),
      6
    ),
    query_plan: {
      concept_queries: uniqueStrings(
        [
          ...(input.caseFrame.query_plan?.concept_queries ?? []),
          productArea.replace(/[_/]+/g, " "),
          deploymentModel.replace(/[_/]+/g, " ")
        ],
        4
      ),
      object_queries: uniqueStrings([...(input.caseFrame.query_plan?.object_queries ?? []), object], 4),
      behavior_queries: uniqueStrings([...(input.caseFrame.query_plan?.behavior_queries ?? []), actionType], 4)
    },
    required_doc_kinds: shouldForceApiRoute
      ? uniqueStrings(
          [
            ...(input.caseFrame.required_doc_kinds ?? []),
            "openapi/api",
            /\b(scope|oauth|token)\b/i.test(input.query) || /权限|鉴权|授权/.test(input.query) ? "permissions" : undefined
          ],
          6
        )
      : shouldForceBehaviorRoute
      ? uniqueStrings([...(input.caseFrame.required_doc_kinds ?? []), "rules", "product_guide"], 6)
      : shouldPreserveIntegrationTroubleshooting
      ? uniqueStrings([...(input.caseFrame.required_doc_kinds ?? []), "troubleshooting", "product_guide", "rules"], 6)
      : architectureQuestion
      ? ["deployment_runbook", "product_guide", "rules", "troubleshooting"]
      : shouldTreatAsHowTo
      ? uniqueStrings([...(input.caseFrame.required_doc_kinds ?? []), "deployment_runbook", "troubleshooting"], 6)
      : input.caseFrame.required_doc_kinds
  };

  const route: SupportQuestionRoute =
    shouldForceApiRoute
      ? {
          ...input.route,
          question_type: inferApiQuestionType(input.query),
          specialist_agent: "api-specialist",
          answer_contract: "Give the exact API answer first.",
          routing_confidence: Math.max(input.route.routing_confidence, 0.84)
        }
      : shouldForceBehaviorRoute
      ? {
          ...input.route,
          question_type: "capability_confirmation",
          specialist_agent: "behavior-specialist",
          answer_contract: "State the documented capability or limitation first, then cite the closest behavior-defining evidence.",
          routing_confidence: Math.max(input.route.routing_confidence, 0.84)
        }
      : shouldPreserveIntegrationTroubleshooting
      ? {
          ...input.route,
          question_type: "troubleshooting",
          specialist_agent: "troubleshooting-specialist",
          answer_contract: "Give the most likely integration configuration cause first, then the direct checks to run now.",
          routing_confidence: Math.max(input.route.routing_confidence, 0.84)
        }
      : shouldTreatAsHowTo && (input.route.question_type === "capability_confirmation" || input.route.specialist_agent === "behavior-specialist")
      ? {
          ...input.route,
          question_type: "how_to_product",
          specialist_agent: "howto-specialist",
          answer_contract: "Provide the direct recovery steps and prerequisites first.",
          routing_confidence: Math.max(input.route.routing_confidence, 0.82)
        }
      : architectureQuestion && input.route.specialist_agent !== "api-specialist"
      ? {
          ...input.route,
          question_type: "capability_confirmation",
          specialist_agent: "behavior-specialist",
          answer_contract:
            "State the documented deployment architecture first, then clarify which components can be isolated or externalized and where documentation remains silent.",
          routing_confidence: Math.max(input.route.routing_confidence, 0.86)
        }
      : input.route;

  const minimumClarification = buildMinimumTroubleshootingClarification(input.query, { ...caseFrame, question_type: route.question_type }, signals);
  caseFrame = {
    ...caseFrame,
    missing_critical_info: uniqueStrings([minimumClarification, ...caseFrame.missing_critical_info], 3),
    question_type: route.question_type,
    specialist_agent: route.specialist_agent,
    answer_contract: route.answer_contract,
    routing_confidence: route.routing_confidence
  };

  return { route, caseFrame };
}

function fallbackQuestionRoute(query: string): SupportQuestionRoute {
  const lowered = query.toLowerCase();
  const question_type: SupportQuestionRoute["question_type"] =
    /\b(scope|oauth|token)\b/i.test(query)
      ? "api_scope_auth"
      : /\b(api|endpoint|method|path|openapi|接口)\b/i.test(query)
      ? "api_endpoint_lookup"
      : /\b(status|field|字段)\b/i.test(query) && /\b(api|接口|openapi)\b/i.test(query)
      ? "api_field_lookup"
      : /为什么|why|预期|行为/.test(query)
      ? "why_behavior"
      : /如何|怎么|步骤|setup|configure|config|导出|export/.test(query)
      ? "how_to_product"
      : /\b(not work|failed|failure|error|报错|异常|失败)\b/i.test(query)
      ? "troubleshooting"
      : "capability_confirmation";
  const specialist_agent: SupportQuestionRoute["specialist_agent"] =
    question_type === "api_endpoint_lookup" || question_type === "api_field_lookup" || question_type === "api_scope_auth"
      ? "api-specialist"
      : question_type === "how_to_product"
      ? "howto-specialist"
      : question_type === "why_behavior" || question_type === "capability_confirmation"
      ? "behavior-specialist"
      : "troubleshooting-specialist";
  return {
    question_type,
    user_goal: query.trim(),
    answer_contract:
      specialist_agent === "api-specialist"
        ? "Give the exact API answer first."
        : specialist_agent === "howto-specialist"
        ? "Give direct steps first."
        : specialist_agent === "behavior-specialist"
        ? "Give the most likely explanation first."
        : "Give the most likely cause and checks first.",
    specialist_agent,
    routing_confidence: 0.7,
    specialist_budget: 1
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
    retrieval_rounds: 2,
    allow_refinement: true,
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
}): Array<{ stage: string; agent_id: string; model?: string | null }> {
  const stages: Array<string> = [
    "router",
    "evidence-planner",
    "planner",
    "support-evidence-selector",
    "evidence-judge",
    "citation-curator",
    "answer-composer"
  ];
  if (!input.specialistSkipped) {
    stages.splice(3, 0, input.route.specialist_agent);
  }
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
          direct_answer: "我已经找到可以支撑当前问题的文档证据，先给你最稳妥的判断。",
          claims: [],
          next_actions: ["先按当前回答执行最直接的一步。", "如果结果仍不符合预期，再补充报错原文和复现步骤。"],
          unknowns: input.missingInfo,
          escalation_needed: false
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
        direct_answer: "I found documentation evidence that supports a useful first answer.",
        claims: [],
        next_actions: [
          "Start with the most direct next step from the current answer.",
          "If the issue persists, add the exact error and repro steps."
        ],
        unknowns: input.missingInfo,
        escalation_needed: false
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
  const render_variant: SpecialistDraftAnswer["render_variant"] =
    input.route.specialist_agent === "api-specialist"
      ? "api"
      : input.route.specialist_agent === "howto-specialist"
      ? "how_to"
      : input.route.specialist_agent === "behavior-specialist"
      ? "behavior"
      : "troubleshooting";
  return {
    question_type: input.route.question_type,
    render_variant,
    ...base
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

function fallbackVerification(language: "zh" | "en", verdict: SupportVerificationResult["verdict"], missingInfo: string[]): SupportVerificationResult {
  return {
    verdict,
    summary:
      language === "zh"
        ? verdict === "verified"
          ? "当前回答已被现有证据支撑。"
          : verdict === "partial"
          ? "当前回答仅有部分证据支撑。"
          : "当前回答缺少足够证据支撑。"
        : verdict === "verified"
        ? "The current answer is supported by the available evidence."
        : verdict === "partial"
        ? "The current answer is only partially supported by the available evidence."
        : "The current answer lacks enough supporting evidence.",
    unsupported_claims: [],
    missing_info: missingInfo,
    verified_citation_ids: [],
    display_citation_ids: [],
    verified_claims: [],
    claim_to_citation_map: []
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
}): SupportEvidenceBundle {
  const reranked = rerankReferencesForCaseFrame(input.references, input.query, input.caseFrame);
  const candidateReferences = filterReferencesByEvidencePolicy(reranked, input.caseFrame);
  const byId = new Map(candidateReferences.map((reference) => [resolveSearchReferenceEvidenceId(reference), reference] as const));
  const selectedPrimary =
    input.selection?.primary_ids
      .map((id) => byId.get(id))
      .filter((item): item is SearchReference => Boolean(item)) ?? [];
  const selectedSupplemental =
    input.selection?.supplemental_ids
      .map((id) => byId.get(id))
      .filter(
        (item): item is SearchReference =>
          Boolean(item) &&
          !selectedPrimary.some(
            (primary) => resolveSearchReferenceEvidenceId(primary) === resolveSearchReferenceEvidenceId(item as SearchReference)
          )
      ) ?? [];
  const primary = uniqueStrings(
    [
      ...selectedPrimary.map((item) => resolveSearchReferenceEvidenceId(item)),
      ...collectProcedureCompanionChunkIds(candidateReferences, selectedPrimary, input.caseFrame),
      ...candidateReferences.slice(0, 3).map((item) => resolveSearchReferenceEvidenceId(item))
    ],
    3
  )
    .map((id) => byId.get(id))
    .filter((item): item is SearchReference => Boolean(item))
    .map((item) => hydrateReferenceEvidence(item));
  const supplemental = uniqueStrings(
    [
      ...selectedSupplemental.map((item) => resolveSearchReferenceEvidenceId(item)),
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
  )
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

function fallbackEvidenceSelection(references: SearchReference[], query: string, caseFrame: SupportCaseFrame): SupportEvidenceSelection {
  const reranked = rerankReferencesForCaseFrame(references, query, caseFrame);
  const candidateReferences = filterReferencesByEvidencePolicy(reranked, caseFrame);
  return {
    primary_ids: candidateReferences.slice(0, 3).map((item) => resolveSearchReferenceEvidenceId(item)),
    supplemental_ids: candidateReferences.slice(3, 6).map((item) => resolveSearchReferenceEvidenceId(item)),
    rejected_ids: reranked
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

type EvidencePolicy = {
  strict: boolean;
  allowedProductAreas: string[];
  allowedEvidenceKinds: string[];
  allowedDeploymentModels?: string[];
  requiresPermissionSignal?: boolean;
};

function buildEvidencePolicy(caseFrame: SupportCaseFrame): EvidencePolicy | null {
  if (String(caseFrame.question_type ?? "").startsWith("api_")) {
    if (caseFrame.question_type === "api_scope_auth") {
      return {
        strict: true,
        allowedProductAreas: ["openapi"],
        allowedEvidenceKinds: ["api_operation", "capability", "constraint"],
        requiresPermissionSignal: true
      };
    }
    return {
      strict: true,
      allowedProductAreas: ["openapi"],
      allowedEvidenceKinds: ["api_operation"]
    };
  }

  const questionType = String(caseFrame.question_type ?? "");
  const productArea = String(caseFrame.product_area ?? "").toLowerCase();
  const deploymentModel = String(caseFrame.deployment_model ?? "").toLowerCase();
  const deploymentScoped = productArea === "deployment" || deploymentModel === "private_deployment";

  if (deploymentScoped) {
    return {
      strict: true,
      allowedProductAreas: ["deployment"],
      allowedEvidenceKinds:
        questionType === "how_to_product" || questionType === "config_setup"
          ? ["procedure", "troubleshooting", "constraint", "capability"]
          : ["capability", "constraint", "procedure", "troubleshooting"],
      allowedDeploymentModels: ["private_deployment"]
    };
  }

  if (productArea === "integrations") {
    return {
      strict: true,
      allowedProductAreas: ["integrations"],
      allowedEvidenceKinds:
        questionType === "troubleshooting"
          ? ["troubleshooting", "procedure", "constraint", "capability"]
          : ["procedure", "capability", "constraint", "troubleshooting"]
    };
  }

  if (questionType === "how_to_product" || questionType === "config_setup" || questionType === "data_export_reporting") {
    return {
      strict: productArea !== "" && productArea !== "general" && productArea !== "unknown",
      allowedProductAreas: productArea && productArea !== "general" && productArea !== "unknown" ? [productArea] : [],
      allowedEvidenceKinds: ["procedure", "capability", "constraint", "troubleshooting"]
    };
  }

  if (questionType === "why_behavior" || questionType === "capability_confirmation" || questionType === "troubleshooting") {
    return {
      strict: productArea !== "" && productArea !== "general" && productArea !== "unknown",
      allowedProductAreas: productArea && productArea !== "general" && productArea !== "unknown" ? [productArea] : [],
      allowedEvidenceKinds: ["capability", "constraint", "procedure", "troubleshooting"]
    };
  }

  return null;
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
  evidenceKind: string;
  productArea: string;
  deploymentModel: string;
  permissions: string[];
  prerequisites: string[];
  actions: string[];
} {
  const metadata = (reference.supportMetadata ?? {}) as Record<string, unknown>;
  return {
    title: String(reference.title ?? "").toLowerCase(),
    heading: String(reference.headingPath ?? "").toLowerCase(),
    snippet: String(reference.snippet ?? "").toLowerCase(),
    evidenceKind: String(metadata.evidence_kind ?? "").toLowerCase(),
    productArea: String(metadata.product_area ?? "").toLowerCase(),
    deploymentModel: String(metadata.deployment_model ?? "").toLowerCase(),
    permissions: getReferenceMetadataList(reference, "permissions").map((item) => item.toLowerCase()),
    prerequisites: getReferenceMetadataList(reference, "prerequisites").map((item) => item.toLowerCase()),
    actions: getReferenceMetadataList(reference, "actions").map((item) => item.toLowerCase())
  };
}

function getReferenceSemanticText(reference: SearchReference): string {
  const profile = getReferenceSupportProfile(reference);
  return [
    profile.title,
    profile.heading,
    profile.snippet,
    ...profile.permissions,
    ...profile.prerequisites,
    ...profile.actions
  ]
    .filter(Boolean)
    .join(" ");
}

function referenceHasPermissionSignal(reference: SearchReference): boolean {
  const profile = getReferenceSupportProfile(reference);
  if (profile.permissions.length > 0) return true;
  const semanticText = getReferenceSemanticText(reference);
  return /\b(scope|scopes|permission|permissions|oauth|token|auth|authorization|authentication)\b/.test(semanticText);
}

function isReferenceEligibleForCaseFrame(reference: SearchReference, caseFrame: SupportCaseFrame): boolean {
  const policy = buildEvidencePolicy(caseFrame);
  if (!policy) return true;
  const profile = getReferenceSupportProfile(reference);
  const appliesTo = getReferenceMetadataList(reference, "applies_to").map((item) => item.toLowerCase());
  const productMatched = policy.allowedProductAreas.includes(profile.productArea);
  const kindMatched = policy.allowedEvidenceKinds.includes(profile.evidenceKind);
  const deploymentMatched =
    !policy.allowedDeploymentModels?.length ||
    policy.allowedDeploymentModels.includes(profile.deploymentModel) ||
    appliesTo.some((item) => policy.allowedDeploymentModels?.includes(item));
  const permissionMatched = policy.requiresPermissionSignal ? referenceHasPermissionSignal(reference) : true;
  const topicalMatched =
    (!policy.allowedProductAreas.length || productMatched) &&
    (!policy.allowedEvidenceKinds.length || kindMatched);
  return topicalMatched && deploymentMatched && permissionMatched ? true : !policy.strict;
}

function filterReferencesByEvidencePolicy(references: SearchReference[], caseFrame: SupportCaseFrame): SearchReference[] {
  const policy = buildEvidencePolicy(caseFrame);
  if (!policy?.strict) return references;
  const eligible = references.filter((reference) => isReferenceEligibleForCaseFrame(reference, caseFrame));
  return eligible.length > 0 ? eligible : references;
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
  return [...references].sort((a, b) => {
    const scoreRef = (reference: SearchReference) => {
      const profile = getReferenceSupportProfile(reference);
      const title = profile.title;
      const heading = profile.heading;
      const snippet = profile.snippet;
      const semanticText = getReferenceSemanticText(reference);
      let topicScore = 0;
      for (const term of focusTerms) {
        if (title.includes(term)) topicScore += 8;
        else if (heading.includes(term)) topicScore += 5;
        else if (snippet.includes(term)) topicScore += 1;
      }
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
}): SupportVerificationResult {
  const evidenceById = new Map(
    [...input.evidenceBundle.primary, ...input.evidenceBundle.supplemental]
      .filter((item) => item.authority === "canonical_visible")
      .map((item) => [resolveSearchReferenceEvidenceId(item), item] as const)
  );
  const sanitizedClaims = input.verification.claim_to_citation_map.map((claim) => {
    const validCitationIds = uniqueStrings(
      claim.citation_ids.filter((citationId) => evidenceById.has(citationId)),
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
  return {
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
  return selected.map((item) => ({
    id: resolveSearchReferenceEvidenceId(item),
    title: item.title,
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
  preferClarificationWhenBlocking?: boolean;
}): SupportAnswer["mode"] {
  const supportedCoreClaims = input.verification.claim_to_citation_map.filter(
    (claim) => (claim.verdict === "verified" || claim.verdict === "supported_inference") && claim.citation_ids.length > 0
  );
  const clarificationAvailable = input.missingInfo.length > 0 && input.currentRound < env.AI_SEARCH_MAX_CLARIFICATION_ROUNDS;
  if (input.preferClarificationWhenBlocking && clarificationAvailable) {
    return "clarification";
  }
  if (supportedCoreClaims.length > 0 && input.verification.verdict === "verified" && input.missingInfo.length === 0) {
    return "grounded";
  }
  if (supportedCoreClaims.length > 0) {
    return "partial";
  }
  if (clarificationAvailable) {
    return "clarification";
  }
  if (!input.references.length && clarificationAvailable) {
    return "clarification";
  }
  return "handoff";
}

function supportedVerificationClaims(verification: SupportVerificationResult) {
  return verification.claim_to_citation_map.filter(
    (claim) => (claim.verdict === "verified" || claim.verdict === "supported_inference") && claim.citation_ids.length > 0
  );
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
  const focusTerms = collectFocusTerms(query, caseFrame);
  let score = 0;
  score += supportedClaims.length * 40;
  score += verification.display_citation_ids.length * 18;
  score -= verification.unsupported_claims.length * 8;
  for (const citationId of verification.display_citation_ids) {
    const reference = evidenceById.get(citationId);
    if (!reference) continue;
    score += scoreReferenceTopicMatch(reference, focusTerms);
    score += Math.round(reference.score * 10);
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
  return supportedVerificationClaims(input.writerBound).length > 0 ? input.writerBound : input.primary;
}

function buildFallbackDirectAnswerFromSupportedClaims(input: {
  language: "zh" | "en";
  mode: SupportAnswer["mode"];
  supportedClaims: SupportVerificationResult["claim_to_citation_map"];
  fallback: SupportAnswer;
}): string {
  const leadingClaims = uniqueStrings(
    input.supportedClaims
      .filter((claim) => claim.kind === "verified_fact" || claim.kind === "grounded_inference")
      .map((claim) => claim.text),
    2
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
  const directAnswer =
    input.mode === "grounded" || input.mode === "partial"
      ? safeComposedDirectAnswer ||
        safeDraftDirectAnswer ||
        buildFallbackDirectAnswerFromSupportedClaims({
          language: input.language,
          mode: input.mode,
          supportedClaims,
          fallback
        })
      : safeComposedDirectAnswer || fallback.direct_answer;
  const fallbackSections = buildFallbackSectionsFromDraft(input.draft, input.language);
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

function shouldUseFastAgentPath(input: {
  route: SupportQuestionRoute;
  caseFrame: SupportCaseFrame;
  evidenceBundle: SupportEvidenceBundle;
  draft: SpecialistDraftAnswer;
  currentRound: number;
}): boolean {
  if (!input.evidenceBundle.primary.length) return false;
  if (!input.draft.direct_answer.trim()) return false;
  if (!hasGroundedDraftClaims(input.draft)) return false;
  if (input.draft.escalation_needed) return false;
  if (input.caseFrame.missing_critical_info.length > 1) return false;
  if (input.currentRound > 0 && input.caseFrame.missing_critical_info.length > 0) return false;

  const fastQuestionTypes = new Set<SupportQuestionRoute["question_type"]>([
    "api_endpoint_lookup",
    "api_field_lookup",
    "api_scope_auth",
    "how_to_product",
    "config_setup",
    "data_export_reporting"
  ]);
  if (!fastQuestionTypes.has(input.route.question_type)) return false;

  const groundedHowTo =
    ["how_to_product", "config_setup", "data_export_reporting"].includes(input.route.question_type) &&
    input.evidenceBundle.primary.length >= 1;

  return (
    groundedHowTo ||
    input.evidenceBundle.primary.length >= 2 ||
    input.evidenceBundle.confidence >= env.AI_SEARCH_ANSWER_CONFIDENCE_THRESHOLD ||
    input.route.question_type.startsWith("api_")
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
    /^(先|首先|然后|再|接着|最后|执行|配置|确认|准备|提供|申请|登录|创建|设置|使用|输入|保存|安装|升级|重启|检查|联系|导出|导入|运行|开放|打通|关闭|开启|重建|重置|恢复)/.test(
      text
    )
  ) {
    return true;
  }
  if (
    /^(follow|run|open|configure|confirm|prepare|provide|apply|log in|create|set|use|enter|save|install|upgrade|restart|check|contact|export|import|rebuild|reset|restore)\b/i.test(
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
  const lines = source.replace(/^---\s*\n[\s\S]*?\n---\s*(?:\n|$)/, "").split(/\r?\n/);
  const headingLabel = shortHeadingLabel(reference.headingPath);
  if (!resolvedPath || !headingLabel || headingLabel.toUpperCase() === "ROOT") return lines.slice(0, 260);

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

  if (anchorIndex < 0) return lines.slice(0, 260);

  const scoped = [lines[anchorIndex] ?? ""];
  for (let index = anchorIndex + 1; index < lines.length && scoped.length < 260; index += 1) {
    const matched = lines[index]?.match(/^\s*(#{1,6})\s+(.+)$/);
    if (matched && (matched[1]?.length ?? 0) <= anchorLevel) break;
    scoped.push(lines[index] ?? "");
  }
  return scoped;
}

function extractProcedureBlocks(reference: SearchReference): { steps: string[]; notes: string[] } {
  const scopedLines = loadProcedureSourceLines(reference);
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
      if ((headingMatch[1]?.length ?? 0) >= 3 && headingText.length <= 80) {
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

    const bulletLike = /^\s*(?:[-*+]\s+|\d+[.)]\s+|[（(]?\d+[）)]\s*)/.test(line);
    if (sectionContext === "notes" || looksLikeProcedureNote(cleaned)) {
      pushProcedureItem(notes, cleaned, 5);
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

function scoreProcedureReference(reference: SearchReference, blocks: { steps: string[]; notes: string[] }): number {
  let score = Math.round(reference.score * 10);
  score += blocks.steps.length * 8;
  score += blocks.notes.length * 3;
  if (shortHeadingLabel(reference.headingPath)) score += 2;
  if (reference.sourceType === "local_docs") score += 2;
  return score;
}

function recoverEvidenceAnchoredHowToDraft(input: {
  language: "zh" | "en";
  query: string;
  draft: SpecialistDraftAnswer;
  evidenceBundle: SupportEvidenceBundle;
  route: SupportQuestionRoute;
}): SpecialistDraftAnswer | null {
  if (input.route.specialist_agent !== "howto-specialist") return null;
  if (hasGroundedDraftClaimsInEvidence(input.draft, input.evidenceBundle)) return null;

  const ranked = [...input.evidenceBundle.primary, ...input.evidenceBundle.supplemental].filter(
    (reference) => reference.authority === "canonical_visible"
  );
  const analyzed = ranked
    .map((reference) => {
      const blocks = extractProcedureBlocks(reference);
      return {
        reference,
        blocks,
        score: scoreProcedureReference(reference, blocks)
      };
    })
    .sort((left, right) => right.score - left.score);
  const actionCandidate = analyzed.find((item) => item.blocks.steps.length > 0) ?? analyzed[0];
  if (!actionCandidate) return null;
  const noteCandidate =
    analyzed.find(
      (item) =>
        resolveSearchReferenceEvidenceId(item.reference) !== resolveSearchReferenceEvidenceId(actionCandidate.reference) &&
        item.blocks.notes.length > 0
    ) ??
    analyzed.find(
      (item) =>
        resolveSearchReferenceEvidenceId(item.reference) !== resolveSearchReferenceEvidenceId(actionCandidate.reference) &&
        item.blocks.steps.length > 0
    ) ??
    null;
  const actionReference = actionCandidate.reference;
  const noteReference = noteCandidate?.reference;
  const actionBlocks = actionCandidate.blocks;
  const noteBlocks = noteCandidate?.blocks ?? { steps: [], notes: [] };
  const howToSteps = uniqueStrings([...actionBlocks.steps, ...noteBlocks.steps], 4);
  const supportNotes = uniqueStrings([...actionBlocks.notes, ...noteBlocks.notes], 3);
  const actionHeading = shortHeadingLabel(actionReference.headingPath) || actionReference.title;
  const noteHeading = noteReference ? shortHeadingLabel(noteReference.headingPath) || noteReference.title : "";
  const zhDirectAnswer = [
    howToSteps.length ? `可以直接这样处理：${howToSteps.join("；")}。` : `当前命中的文档已经给出了可执行处理方式，可以直接按下面步骤操作。`,
    supportNotes.length ? `另外需要注意：${supportNotes.join("；")}。` : ""
  ]
    .filter(Boolean)
    .join("");
  const enDirectAnswer = [
    howToSteps.length ? `You can handle it like this: ${howToSteps.join("; ")}.` : "The retrieved documentation already contains an actionable procedure you can follow directly.",
    supportNotes.length ? `Also note: ${supportNotes.join("; ")}.` : ""
  ]
    .filter(Boolean)
    .join(" ");
  const preferredDraftDirectAnswer = (() => {
    const value = String(input.draft.direct_answer ?? "").trim();
    if (!value) return "";
    if (/documented api details first|exact api answer first|critical detail before/i.test(value.toLowerCase())) {
      return "";
    }
    return value;
  })();

  if (input.language === "zh") {
    return {
      ...input.draft,
      render_variant: "how_to",
      direct_answer: preferredDraftDirectAnswer || zhDirectAnswer,
      claims: [
        {
          text: `《${actionReference.title}》中的“${actionHeading}”提供了与当前问题直接相关的操作步骤或处理要求。`,
          kind: "verified_fact",
          evidence_ids: [resolveSearchReferenceEvidenceId(actionReference)],
          authority: "canonical"
        },
        ...(noteReference
          ? [
              {
                text: `《${noteReference.title}》补充说明了“${noteHeading}”相关的限制、前提或验证信息。`,
                kind: "verified_fact" as const,
                evidence_ids: [resolveSearchReferenceEvidenceId(noteReference)],
                authority: "canonical" as const
              }
            ]
          : [])
      ],
      next_actions: uniqueStrings(
        [
          ...howToSteps,
          ...supportNotes
        ],
        4
      ),
      steps: uniqueStrings(
        [
          ...howToSteps,
          ...(supportNotes.length ? supportNotes : ["执行完成后检查结果是否符合预期。"])
        ],
        4
      ),
      limits_or_notes: supportNotes.length ? supportNotes : input.draft.limits_or_notes,
      unknowns: []
    };
  }

  return {
    ...input.draft,
    render_variant: "how_to",
    direct_answer: preferredDraftDirectAnswer || enDirectAnswer,
    claims: [
      {
        text: `"${actionReference.title}" contains "${actionHeading}", which provides directly relevant procedure steps or requirements.`,
        kind: "verified_fact",
        evidence_ids: [resolveSearchReferenceEvidenceId(actionReference)],
        authority: "canonical"
      },
      ...(noteReference
        ? [
            {
              text: `"${noteReference.title}" adds "${noteHeading}" details that are relevant for prerequisites, limits, or validation.`,
              kind: "verified_fact" as const,
              evidence_ids: [resolveSearchReferenceEvidenceId(noteReference)],
              authority: "canonical" as const
            }
          ]
        : [])
    ],
    next_actions: uniqueStrings(
      [
        ...howToSteps,
        ...supportNotes
      ],
      4
    ),
    steps: uniqueStrings(
      [
        ...howToSteps,
        ...(supportNotes.length ? supportNotes : ["Check the final result after the procedure completes."])
      ],
      4
    ),
    limits_or_notes: supportNotes.length ? supportNotes : input.draft.limits_or_notes,
    unknowns: []
  };
}

function recoverEvidenceAnchoredDeploymentBehaviorDraft(input: {
  language: "zh" | "en";
  draft: SpecialistDraftAnswer;
  evidenceBundle: SupportEvidenceBundle;
  route: SupportQuestionRoute;
  caseFrame: SupportCaseFrame;
}): SpecialistDraftAnswer | null {
  if (input.route.specialist_agent !== "behavior-specialist") return null;
  if (input.caseFrame.product_area !== "deployment") return null;
  if (hasGroundedDraftClaimsInEvidence(input.draft, input.evidenceBundle)) return null;

  const ranked = [...input.evidenceBundle.primary, ...input.evidenceBundle.supplemental]
    .filter((reference) => reference.authority === "canonical_visible")
    .sort((a, b) => b.score - a.score);
  if (!ranked.length) return null;

  const deploymentRefs = ranked.filter((reference) => {
    const profile = getReferenceSupportProfile(reference);
    return profile.productArea === "deployment" || profile.deploymentModel === "private_deployment";
  });
  const primary = deploymentRefs[0] ?? ranked[0];
  const externalizationRef =
    deploymentRefs.find((reference) => /外置|external|nfs|oss|database/i.test(`${reference.title} ${reference.snippet}`)) ?? null;

  const primaryText = `${primary.title} ${primary.snippet}`.toLowerCase();
  const confirmsUnifiedDefault =
    /统一系统|unified system|合设|app\+storage|应用\+存储|single node|单机版/.test(primaryText);
  const confirmsExternalization = externalizationRef
    ? /外置|external|nfs|oss|oceanbase|数据库/i.test(`${externalizationRef.title} ${externalizationRef.snippet}`.toLowerCase())
    : false;

  const directAnswerZh = uniqueStrings(
    [
      confirmsUnifiedDefault
        ? "当前文档更支持这样的结论：ONES 私有部署默认是统一部署拓扑，而不是按需求与工作项拆成两套独立后端链路。"
        : "当前命中的部署文档没有证明需求与工作项可以拆成两套独立后端服务链路。",
      confirmsExternalization
        ? "文档同时显示，部分基础设施能力可以外置或分离，例如存储或数据库组件。"
        : undefined,
      "但就当前证据看，我还没有找到明确写明“需求与工作项可分别独立部署服务、数据库和查询路径”的文档。"
    ],
    3
  ).join("");

  const directAnswerEn = uniqueStrings(
    [
      confirmsUnifiedDefault
        ? "The current deployment docs support this conclusion first: ONES self-hosted deployment is documented as a unified topology by default, not as two separately deployable backend chains for requirements and issues."
        : "The retrieved deployment docs do not prove that requirements and issues can be split into two separately deployable backend service chains.",
      confirmsExternalization
        ? "The docs also show that some infrastructure components can be externalized or separated, such as storage or database components."
        : undefined,
      "However, with the current evidence I still do not see explicit documentation that requirements and issues can each use independent services, databases, and query paths."
    ],
    3
  ).join(" ");

  const claims: SpecialistDraftAnswer["claims"] = [
    {
      text:
        input.language === "zh"
          ? `《${primary.title}》显示当前私有部署文档描述的是统一部署或合设架构。`
          : `"${primary.title}" describes the current self-hosted deployment as a unified or colocated architecture.`,
      kind: "verified_fact",
      evidence_ids: [resolveSearchReferenceEvidenceId(primary)],
      authority: "canonical"
    }
  ];

  if (externalizationRef) {
    claims.push({
      text:
        input.language === "zh"
          ? `《${externalizationRef.title}》说明部分基础设施组件可以外置或单独调整，例如数据库或存储。`
          : `"${externalizationRef.title}" shows that some infrastructure components can be externalized or adjusted separately, such as database or storage components.`,
      kind: "verified_fact",
      evidence_ids: [resolveSearchReferenceEvidenceId(externalizationRef)],
      authority: "canonical"
    });
  }

  claims.push({
    text:
      input.language === "zh"
        ? "基于当前命中的部署文档，我无法确认需求与工作项存在分别独立的服务、数据库和查询路径部署方式。"
        : "Based on the currently retrieved deployment docs, I cannot confirm a separately deployable service/database/query-path topology for requirements versus issues.",
    kind: "grounded_inference",
    evidence_ids: uniqueStrings(
      [resolveSearchReferenceEvidenceId(primary), externalizationRef ? resolveSearchReferenceEvidenceId(externalizationRef) : undefined],
      2
    ),
    authority: "canonical"
  });

  return {
    ...input.draft,
    render_variant: "behavior",
    direct_answer: input.language === "zh" ? directAnswerZh : directAnswerEn,
    claims,
    next_actions:
      input.language === "zh"
        ? [
            "先按当前文档把系统理解为统一部署拓扑来做容量与性能规划。",
            "如果你要做更强隔离，优先核对数据库/存储是否支持外置，以及是否有官方架构说明支持模块级拆分。"
          ]
        : [
            "Plan capacity and performance assuming a unified deployment topology first.",
            "If stronger isolation is required, verify whether database/storage externalization is supported and whether official architecture docs mention module-level split deployment."
          ],
    unknowns: []
  };
}

type ApiEvidenceCandidate = {
  text: string;
  evidenceId: string;
  kind: SpecialistDraftAnswer["claims"][number]["kind"];
  authority: SpecialistDraftAnswer["claims"][number]["authority"];
  score: number;
  fieldName?: string;
  method?: string;
  path?: string;
};

type ApiOperationIntent = "create" | "read" | "list" | "update" | "delete" | "execute";

function expandApiSemanticFocusTerms(query: string, caseFrame: SupportCaseFrame): string[] {
  const raw = `${query} ${caseFrame.goal} ${caseFrame.object} ${caseFrame.symptom}`.toLowerCase();
  const expanded = new Set<string>(collectFocusTerms(query, caseFrame));
  const add = (values: string[]) => values.forEach((value) => expanded.add(value));

  if (/(标识|id|uuid|identifier|唯一)/i.test(raw)) add(["标识", "id", "uuid", "identifier", "项目id", "属性uuid"]);
  if (/(负责人|成员|owner|assignee|user|用户)/i.test(raw)) add(["负责人", "成员", "member", "user", "owner", "assignee", "uuid", "name", "avatar"]);
  if (/(选项|option|options)/i.test(raw)) add(["选项", "option", "options", "field/options", "属性选项"]);
  if (/(项目|project)/i.test(raw)) add(["项目", "project", "projects", "项目id", "项目列表"]);
  if (/(状态|status)/i.test(raw)) add(["状态", "status"]);
  if (/(评论|comment)/i.test(raw)) add(["评论", "comment"]);
  if (/(scope|权限|授权|oauth|token)/i.test(raw)) add(["scope", "权限", "授权", "oauth", "token"]);

  return uniqueStrings([...expanded], 32);
}

function collectApiOperationIntents(query: string, caseFrame: SupportCaseFrame): Set<ApiOperationIntent> {
  const raw = `${query} ${caseFrame.goal} ${caseFrame.object} ${caseFrame.symptom} ${caseFrame.action_type}`.toLowerCase();
  const intents = new Set<ApiOperationIntent>();

  if (/(创建|新增|新建|添加|create|add|new )/i.test(raw)) intents.add("create");
  if (/(更新|修改|变更|设置|edit|update|modify|change|set )/i.test(raw)) intents.add("update");
  if (/(删除|移除|remove|delete)/i.test(raw)) intents.add("delete");
  if (/(执行|触发|run |execute|trigger)/i.test(raw)) intents.add("execute");
  if (/(列表|列出|枚举|清单|list |all statuses)/i.test(raw)) intents.add("list");
  if (/(获取|查询|查看|详情|get |fetch|read|detail)/i.test(raw)) intents.add("read");

  if (!intents.size) {
    if (caseFrame.action_type === "update") intents.add("update");
    else if (caseFrame.question_type === "api_field_lookup" || caseFrame.question_type === "api_scope_auth") intents.add("read");
  }

  return intents;
}

function extractApiOperationSignature(reference: SearchReference): { method?: string; path?: string } {
  const source = (() => {
    const snippet = String(reference.snippet ?? "");
    const resolvedPath = resolveLocalDocsMirrorPath(reference);
    if (!resolvedPath) return snippet;
    try {
      const raw = fs.readFileSync(resolvedPath, "utf8");
      return `${snippet}\n${raw}`;
    } catch {
      return snippet;
    }
  })();
  const jsxMatch = source.match(/method=\{"([a-z]+)"\}\s+path=\{"([^"]+)"\}/i);
  if (jsxMatch) {
    return {
      method: jsxMatch[1].toUpperCase(),
      path: jsxMatch[2]
    };
  }
  const plainMatch = source.match(/\b(GET|POST|PUT|PATCH|DELETE)\s+([/A-Za-z0-9._:{}?=&-]+)/);
  if (plainMatch) {
    return {
      method: plainMatch[1].toUpperCase(),
      path: plainMatch[2]
    };
  }
  const titleMatch = String(reference.title ?? "").match(/\b(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+([/A-Za-z0-9._:{}?=&-]+)/i);
  if (titleMatch) {
    return {
      method: titleMatch[1].toUpperCase(),
      path: titleMatch[2]
    };
  }
  return {};
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
      fieldName
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
      score: 0
    });
  }
  return candidates;
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

function scoreApiEvidenceCandidate(
  candidate: ApiEvidenceCandidate,
  focusTerms: string[],
  reference: SearchReference,
  primaryBoost: number,
  targetIntents: Set<ApiOperationIntent>
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
  score += scoreApiIntentAlignment(
    targetIntents,
    classifyApiOperationCandidate({
      method: candidate.method,
      path: candidate.path,
      title: reference.title,
      snippet: candidate.text
    })
  );
  return score;
}

function recoverEvidenceAnchoredApiDraft(input: {
  language: "zh" | "en";
  query: string;
  draft: SpecialistDraftAnswer;
  evidenceBundle: SupportEvidenceBundle;
  route: SupportQuestionRoute;
  caseFrame: SupportCaseFrame;
}): SpecialistDraftAnswer | null {
  if (input.route.specialist_agent !== "api-specialist") return null;
  if (hasGroundedDraftClaimsInEvidence(input.draft, input.evidenceBundle)) return null;

  const ranked = [...input.evidenceBundle.primary, ...input.evidenceBundle.supplemental].filter(
    (reference) => reference.authority === "canonical_visible" && isReferenceEligibleForCaseFrame(reference, input.caseFrame)
  );
  if (!ranked.length) return null;

  const focusTerms = expandApiSemanticFocusTerms(input.query, input.caseFrame);
  const targetIntents = collectApiOperationIntents(input.query, input.caseFrame);
  const wantsIdentifier = focusTerms.some((term) => /标识|id|uuid|identifier/i.test(term));
  const scoredClaims: ApiEvidenceCandidate[] = [];
  let topOperationMethod = "";
  let topOperationPath = "";
  let topOperationScore = -1;
  let requiredParams: string[] = [];

  ranked.forEach((reference, index) => {
    const primaryBoost = index < input.evidenceBundle.primary.length ? 24 : 10;
    const operation = extractApiOperationSignature(reference);
    if (operation.method && operation.path) {
      const operationCandidate: ApiEvidenceCandidate = {
        text:
          input.language === "zh"
            ? `当前应优先调用 ${operation.method} ${operation.path}。`
            : `The primary operation to use here is ${operation.method} ${operation.path}.`,
        evidenceId: resolveSearchReferenceEvidenceId(reference),
        kind: "verified_fact",
        authority: "canonical",
        score: 0,
        method: operation.method,
        path: operation.path
      };
      operationCandidate.score = scoreApiEvidenceCandidate(operationCandidate, focusTerms, reference, primaryBoost, targetIntents);
      scoredClaims.push(operationCandidate);
      if (operationCandidate.score > topOperationScore) {
        topOperationMethod = operation.method;
        topOperationPath = operation.path;
        topOperationScore = operationCandidate.score;
        requiredParams = extractApiRequestParamNames(reference);
      }
    }

    extractApiFieldCandidates(reference, input.language).forEach((candidate) => {
      candidate.score = scoreApiEvidenceCandidate(candidate, focusTerms, reference, primaryBoost, targetIntents);
      scoredClaims.push(candidate);
    });
    extractApiNarrativeCandidates(reference, input.language).forEach((candidate) => {
      candidate.score = scoreApiEvidenceCandidate(candidate, focusTerms, reference, primaryBoost, targetIntents);
      scoredClaims.push(candidate);
    });
  });

  const selectedClaims = scoredClaims
    .sort((a, b) => {
      const aIdentifierBoost =
        wantsIdentifier && /字段 (?:id|uuid)|field (?:id|uuid)|项目id|属性uuid/i.test(a.text) ? 50 : 0;
      const bIdentifierBoost =
        wantsIdentifier && /字段 (?:id|uuid)|field (?:id|uuid)|项目id|属性uuid/i.test(b.text) ? 50 : 0;
      return b.score + bIdentifierBoost - (a.score + aIdentifierBoost);
    })
    .filter((candidate, index, all) => all.findIndex((item) => item.text === candidate.text) === index)
    .slice(0, 3)
    .map((candidate) => ({
      text: candidate.text,
      kind: candidate.kind,
      evidence_ids: [candidate.evidenceId],
      authority: candidate.authority
    }));

  if (!selectedClaims.length) return null;
  const anchorEvidenceId = selectedClaims[0]?.evidence_ids[0];
  const identifierClaim = wantsIdentifier
    ? selectedClaims.find((claim) => /字段 (?:id|uuid)|field (?:id|uuid)|项目id|属性uuid/i.test(claim.text))
    : undefined;
  const coherentClaims = selectedClaims
    .sort((a, b) => {
      const aAnchor = Number(a.evidence_ids[0] === anchorEvidenceId);
      const bAnchor = Number(b.evidence_ids[0] === anchorEvidenceId);
      const aIdentifier = Number(identifierClaim?.text === a.text);
      const bIdentifier = Number(identifierClaim?.text === b.text);
      return bIdentifier - aIdentifier || bAnchor - aAnchor;
    })
    .slice(0, 3);

  const directAnswerLead = coherentClaims[0]?.text ?? "";
  const draftOperationPath = (() => {
    const raw = String(input.draft.api_path ?? "").trim();
    if (!raw) return undefined;
    try {
      const parsed = new URL(raw);
      return parsed.pathname;
    } catch {
      return raw;
    }
  })();
  const operationMethod = topOperationMethod || input.draft.api_method || undefined;
  const operationPath = topOperationPath || draftOperationPath || undefined;
  const operationLabel = operationMethod && operationPath ? `${operationMethod} ${operationPath}` : "";
  const resolvedRequiredParams = requiredParams.length > 0 ? requiredParams : (input.draft.required_params ?? []);
  const directAnswer =
    input.language === "zh"
      ? operationLabel
        ? `${directAnswerLead}${directAnswerLead.includes(operationLabel) ? "" : ` 对应接口是 ${operationLabel}。`}`.trim()
        : directAnswerLead
      : operationLabel
      ? `${directAnswerLead}${directAnswerLead.includes(operationLabel) ? "" : ` The endpoint is ${operationLabel}.`}`.trim()
      : directAnswerLead;

  const nextActions =
    input.language === "zh"
      ? uniqueStrings(
          [
            operationLabel ? `优先按 ${operationLabel} 这个接口核对调用。` : "",
            resolvedRequiredParams.length ? `调用前确认必填参数是否已补齐，例如 ${resolvedRequiredParams.join("、")}。` : ""
          ],
          3
        )
      : uniqueStrings(
          [
            operationLabel ? `Start by checking ${operationLabel}.` : "",
            resolvedRequiredParams.length ? `Confirm the required inputs are present, for example ${resolvedRequiredParams.join(", ")}.` : ""
          ],
          3
        );

  const responseFieldClaim = coherentClaims.find((claim) => /字段|field/i.test(claim.text));
  const responseFieldHint = responseFieldClaim?.text.replace(/^.*?(?:字段|field)\s+/i, "").slice(0, 80) || input.draft.response_field_hint;

  return {
    ...input.draft,
    render_variant: "api",
    direct_answer: directAnswer,
    claims: coherentClaims,
    next_actions: nextActions,
    unknowns: [],
    api_method: operationMethod,
    api_path: operationPath,
    required_params: resolvedRequiredParams,
    response_field_hint: responseFieldHint
  };
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

function buildInitialRetrievalQueries(query: string, caseFrame: SupportCaseFrame, orchestrator: SearchOrchestrator): string[] {
  const structuredCaseFrameQuery = buildStructuredCaseFrameQuery(caseFrame);
  const compactFocus = buildCompactFocusQuery(query, caseFrame);
  return uniqueStrings(
    [
      structuredCaseFrameQuery,
      query,
      compactFocus,
      caseFrame.query_plan?.object_queries?.[0],
      caseFrame.query_plan?.concept_queries?.[0]
    ],
    3
  ).filter(Boolean);
}

function combineRetrievalQueries(
  query: string,
  caseFrame: SupportCaseFrame,
  orchestrator: SearchOrchestrator,
  baseQueries: string[] = []
): string[] {
  const apiBridge = buildApiRetrievalBridgeQuery(query, caseFrame);
  const compactFocus = buildCompactFocusQuery(query, caseFrame);
  const groupedQueries = [
    apiBridge,
    compactFocus,
    ...caseFrame.retrieval_queries,
    ...(caseFrame.query_plan?.object_queries ?? []),
    ...(caseFrame.query_plan?.concept_queries ?? []),
    ...(caseFrame.query_plan?.behavior_queries ?? [])
  ];
  const excludedQueries = new Set(baseQueries.map((item) => orchestrator.normalizeQuery(item)));
  return uniqueStrings(groupedQueries, 8).filter((item) => {
    const normalized = orchestrator.normalizeQuery(item);
    return normalized !== orchestrator.normalizeQuery(query) && !excludedQueries.has(normalized);
  });
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
  const orchestrator = new SearchOrchestrator(input.adapter);
  const allowMultiPassRetrieval = input.runtime?.allowMultiPassRetrieval !== false;
  const allowRefinement = input.runtime?.allowRefinement !== false;
  const contextType = input.contextType ?? "search";

  const routeStartedAt = performance.now();
  const routerRuntime = withStageRuntime(buildStageRuntime(input.runtime, 32000, 5000, 12000), "router", `${input.idempotencyKey}:router`);
  const routeResult = await input.adapter
    .routeSupportQuestion(
      {
        contextType,
        language: input.language,
        query: input.query,
        conversationHistory: input.conversationHistory
      },
      `${input.idempotencyKey}:route`,
      routerRuntime
    )
    .then((value) => ({ route: value, timing: stageTiming("completed", elapsedMs(routeStartedAt)) }))
    .catch(() => ({ route: fallbackQuestionRoute(input.query), timing: stageTiming("fallback", elapsedMs(routeStartedAt)) }));
  const evidencePlanStartedAt = performance.now();
  const evidencePlannerRuntime = withStageRuntime(
    buildStageRuntime(input.runtime, 26000, 4000, 10000),
    "evidence-planner",
    `${input.idempotencyKey}:evidence-planner`
  );
  const evidencePlanResult = await input.adapter
    .planSupportEvidence(
      {
        contextType,
        language: input.language,
        query: input.query,
        route: routeResult.route,
        conversationHistory: input.conversationHistory
      },
      `${input.idempotencyKey}:evidence-plan`,
      evidencePlannerRuntime
    )
    .then((value) => ({ plan: value, timing: stageTiming("completed", elapsedMs(evidencePlanStartedAt)) }))
    .catch(() => ({ plan: fallbackEvidencePlan(input.query), timing: stageTiming("fallback", elapsedMs(evidencePlanStartedAt)) }));
  const casePlanStartedAt = performance.now();
  const plannerRuntime = withStageRuntime(buildStageRuntime(input.runtime, 22000, 5000, 14000), "planner", `${input.idempotencyKey}:planner`);
  const plannerPromise = input.adapter
    .planSupportCase(
      {
        contextType,
        language: input.language,
        query: input.query,
        conversationHistory: input.conversationHistory,
        ticketContext: input.ticketContext
      },
      `${input.idempotencyKey}:plan`,
      plannerRuntime
    )
    .then((value) => ({ value, timing: stageTiming("completed", elapsedMs(casePlanStartedAt)) }))
    .catch(() => ({ value: null, timing: stageTiming("fallback", elapsedMs(casePlanStartedAt)) }));
  const plannerResult = await plannerPromise;
  const mergedCaseFrame = mergeRouteAndEvidencePlan(plannerResult.value ?? fallbackCaseFrame(input.query), routeResult.route, evidencePlanResult.plan);
  const stabilized = stabilizeSupportRouteAndCaseFrame({
    query: input.query,
    route: routeResult.route,
    caseFrame: mergedCaseFrame
  });
  const route = stabilized.route;
  const caseFrame = stabilized.caseFrame;
  const stageBudget = normalizeStageBudget({
    route,
    plan: evidencePlanResult.plan
  });
  const baseQueries = buildInitialRetrievalQueries(input.query, caseFrame, orchestrator);
  const baseEvidenceStartedAt = performance.now();
  const baseEvidenceResult = await orchestrator
    .collectEvidence({
      queries: baseQueries,
      idempotencyKey: `${input.idempotencyKey}:evidence`,
      runtime: input.runtime,
      answerLanguage: input.language,
      attachments: input.attachments,
      caseFrame,
      repoId: input.repoId,
      branch: input.branch
    })
    .then((value) => ({
      value,
      timing: stageTiming("completed", elapsedMs(baseEvidenceStartedAt), {
        query_count: baseQueries.length,
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
        resolvedQueries: baseQueries,
        fallbackUsed: true
      },
      timing: stageTiming("fallback", elapsedMs(baseEvidenceStartedAt), {
        query_count: baseQueries.length,
        reference_count: 0
      })
    }));
  const baseEvidence = baseEvidenceResult.value;
  const additionalQueries = combineRetrievalQueries(input.query, caseFrame, orchestrator, baseQueries);
  const additionalStartedAt = performance.now();
  const additionalEvidence =
    allowMultiPassRetrieval &&
    stageBudget.retrieval_rounds > 1 &&
    additionalQueries.length > 0 &&
    hasEnoughBudget(input.runtime, 9000)
      ? await orchestrator
          .collectEvidence({
            queries: additionalQueries,
            idempotencyKey: `${input.idempotencyKey}:evidence:extra`,
            runtime: input.runtime,
            answerLanguage: input.language,
            attachments: input.attachments,
            caseFrame,
            repoId: input.repoId,
            branch: input.branch
          })
          .catch(() => null)
      : null;
  const preRefinedEvidence = additionalEvidence
    ? orchestrator.combineEvidenceCollections([baseEvidence, additionalEvidence])
    : baseEvidence;
  const refinementEvidence =
    allowRefinement &&
    stageBudget.retrieval_rounds > 1 &&
    stageBudget.allow_refinement &&
    preRefinedEvidence.references.length > 0 &&
    hasEnoughBudget(input.runtime, 7000)
      ? await orchestrator
          .refineEvidence({
            baseQuery: input.query,
            references: preRefinedEvidence.references,
            idempotencyKey: `${input.idempotencyKey}:evidence`,
            runtime: input.runtime,
            answerLanguage: input.language,
            attachments: input.attachments,
            caseFrame
          })
          .catch(() => null)
      : null;
  const evidenceCollection =
    refinementEvidence && refinementEvidence.references.length > 0
      ? orchestrator.combineEvidenceCollections([preRefinedEvidence, refinementEvidence])
      : preRefinedEvidence;
  const secondRoundQueryCount = (additionalEvidence ? additionalQueries.length : 0) + (refinementEvidence?.resolvedQueries.length ?? 0);
  const additionalTiming =
    secondRoundQueryCount > 0
      ? stageTiming("completed", elapsedMs(additionalStartedAt), {
          query_count: secondRoundQueryCount,
          reference_count: evidenceCollection.references.length
        })
      : skippedStageTiming();

  const selectionRuntime = withStageRuntime(
    buildStageRuntime(input.runtime, 22000, 4000, 12000),
    "support-evidence-selector",
    `${input.idempotencyKey}:evidence-selector`
  );
  const evidenceSelectionStartedAt = performance.now();
  const evidenceSelection =
    evidenceCollection.references.length > 0 && hasEnoughBudget(input.runtime, 5000)
      ? await input.adapter
          .selectSupportEvidence(
            {
              contextType,
              language: input.language,
              query: input.query,
              caseFrame,
              references: evidenceCollection.references
            },
            `${input.idempotencyKey}:evidence-selector`,
            selectionRuntime
          )
          .then((value) => ({ value, timing: stageTiming("completed", elapsedMs(evidenceSelectionStartedAt), { reference_count: value.primary_ids.length + value.supplemental_ids.length }) }))
          .catch(() => ({
            value: fallbackEvidenceSelection(evidenceCollection.references, input.query, caseFrame),
            timing: stageTiming("fallback", elapsedMs(evidenceSelectionStartedAt), { reference_count: 0 })
          }))
      : {
          value: fallbackEvidenceSelection(evidenceCollection.references, input.query, caseFrame),
          timing: stageTiming("skipped", elapsedMs(evidenceSelectionStartedAt), { reference_count: 0 })
        };

  const evidenceBundle = buildEvidenceBundle({
    references: evidenceCollection.references,
    confidence: evidenceCollection.confidence,
    fallbackUsed: evidenceCollection.fallbackUsed,
    resolvedQueries: evidenceCollection.resolvedQueries,
    caseFrame,
    query: input.query,
    selection: evidenceSelection
      .value
  });
  const shouldSkipWriterFamily = stageBudget.specialist_budget === 0;
  const shouldSkipSpecialist =
    shouldSkipWriterFamily ||
    (stageBudget.stop_after_grounded_evidence &&
      evidenceBundle.primary.length > 0 &&
      evidenceBundle.confidence >= env.AI_SEARCH_ANSWER_CONFIDENCE_THRESHOLD);

  const writerStartedAt = performance.now();
  const specialistRuntime = withStageRuntime(
    buildStageRuntime(input.runtime, 12000, 5000, 18000),
    route.specialist_agent,
    `${input.idempotencyKey}:${route.specialist_agent}`
  );
  const specialistResult = !shouldSkipSpecialist && hasEnoughBudget(input.runtime, 6000)
    ? await writeSpecialistDraft({
        adapter: input.adapter,
        contextType,
        route,
        language: input.language,
        query: input.query,
        caseFrame,
        evidenceBundle,
        conversationHistory: input.conversationHistory,
        runtime: specialistRuntime,
        idempotencyKey: `${input.idempotencyKey}:specialist`
      })
        .then((value) => ({ value, timing: stageTiming("completed", elapsedMs(writerStartedAt)) }))
        .catch(() => ({ value: null, timing: stageTiming("fallback", elapsedMs(writerStartedAt)) }))
    : { value: null, timing: stageTiming("skipped", elapsedMs(writerStartedAt)) };
  const genericWriterStartedAt = performance.now();
  const genericWriterRuntime = withExplicitStageRuntime({
    runtime: buildStageRuntime(input.runtime, 9000, 4000, 12000),
    stage: "support-writer",
    sessionSeed: `${input.idempotencyKey}:support-writer`,
    agentId: resolveStageSpecificAgent(route.specialist_agent).agentId,
    model: resolveStageSpecificAgent(route.specialist_agent).model
  });
  const genericWriterResult =
    !shouldSkipWriterFamily &&
    evidenceBundle.primary.length > 0 &&
    hasEnoughBudget(input.runtime, 5000) &&
    (!specialistResult.value || !hasGroundedDraftClaims(specialistResult.value))
      ? await input.adapter
          .writeSupportAnswer(
            {
              contextType,
              language: input.language,
              query: input.query,
              caseFrame,
              evidenceBundle,
              conversationHistory: input.conversationHistory,
              ticketContext: input.ticketContext
            },
            `${input.idempotencyKey}:support-writer`,
            genericWriterRuntime
          )
          .then((value) => {
            const routedDraft: SpecialistDraftAnswer = {
              question_type: route.question_type,
              render_variant:
                route.specialist_agent === "api-specialist"
                  ? ("api" as const)
                  : route.specialist_agent === "howto-specialist"
                  ? ("how_to" as const)
                  : route.specialist_agent === "behavior-specialist"
                  ? ("behavior" as const)
                  : ("troubleshooting" as const),
              ...value
            };
            return {
              value: routedDraft,
              timing: stageTiming("completed", elapsedMs(genericWriterStartedAt))
            };
          })
          .catch(() => ({ value: null, timing: stageTiming("fallback", elapsedMs(genericWriterStartedAt)) }))
      : { value: null, timing: stageTiming("skipped", elapsedMs(genericWriterStartedAt)) };
  const rawDraftSupportAnswer =
    specialistResult.value ??
    genericWriterResult.value ??
    fallbackSpecialistDraftAnswer({
      language: input.language,
      route,
      query: input.query,
      evidenceBundle,
      missingInfo: caseFrame.missing_critical_info
    });
  const draftSupportAnswer =
    recoverEvidenceAnchoredApiDraft({
      language: input.language,
      query: input.query,
      draft: rawDraftSupportAnswer,
      evidenceBundle,
      route,
      caseFrame
    }) ??
    recoverEvidenceAnchoredHowToDraft({
      language: input.language,
      query: input.query,
      draft: rawDraftSupportAnswer,
      evidenceBundle,
      route
    }) ??
    recoverEvidenceAnchoredDeploymentBehaviorDraft({
      language: input.language,
      draft: rawDraftSupportAnswer,
      evidenceBundle,
      route,
      caseFrame
    }) ??
    rawDraftSupportAnswer;
  const draftClaimsWithEvidence = draftSupportAnswer.claims.filter(
    (claim: SpecialistDraftAnswer["claims"][number]) =>
      claim.evidence_ids.length > 0 && (claim.kind === "verified_fact" || claim.kind === "grounded_inference")
  );
  const draftClaimsWithoutEvidence = draftSupportAnswer.claims.filter(
    (claim: SpecialistDraftAnswer["claims"][number]) =>
      claim.evidence_ids.length === 0 && (claim.kind === "verified_fact" || claim.kind === "grounded_inference")
  );
  const writerBoundVerification = sanitizeVerification({
    verification: {
      verdict:
        draftClaimsWithEvidence.length === 0
          ? "unsupported"
          : draftClaimsWithoutEvidence.length === 0 && draftSupportAnswer.unknowns.length === 0
          ? "verified"
          : "partial",
      summary:
        input.language === "zh"
          ? "已根据回答草稿中的证据引用补充文档绑定。"
          : "Documentation bindings were recovered from the draft answer evidence ids.",
      unsupported_claims: draftClaimsWithoutEvidence.map((claim: SpecialistDraftAnswer["claims"][number]) => claim.text),
      missing_info: [],
      verified_citation_ids: uniqueStrings(
        draftSupportAnswer.claims.flatMap((claim: SpecialistDraftAnswer["claims"][number]) => claim.evidence_ids),
        6
      ),
      display_citation_ids: uniqueStrings(
        draftSupportAnswer.claims.flatMap((claim: SpecialistDraftAnswer["claims"][number]) => claim.evidence_ids),
        3
      ),
      verified_claims: draftSupportAnswer.claims
        .filter((claim: SpecialistDraftAnswer["claims"][number]) => claim.evidence_ids.length > 0)
        .map((claim: SpecialistDraftAnswer["claims"][number]) => claim.text),
      claim_to_citation_map: draftSupportAnswer.claims.map((claim: SpecialistDraftAnswer["claims"][number]) => ({
        text: claim.text,
        kind: claim.kind,
        verdict:
          claim.evidence_ids.length === 0
            ? ("unsupported" as const)
            : claim.kind === "grounded_inference"
            ? ("supported_inference" as const)
            : ("verified" as const),
        citation_ids: claim.evidence_ids
      }))
    },
    evidenceBundle
  });
  const useFastAgentPath =
    shouldUseFastAgentPath({
      route,
      caseFrame,
      evidenceBundle,
      draft: draftSupportAnswer,
      currentRound: input.currentRound
    }) && hasEnoughBudget(input.runtime, 2500);

  const verifierStartedAt = performance.now();
  const verificationResult = useFastAgentPath
    ? { value: writerBoundVerification, timing: stageTiming("skipped", elapsedMs(verifierStartedAt)) }
    : await (async () => {
        const judgeRuntime = withStageRuntime(
          buildStageRuntime(input.runtime, 5000, 6000, 25000),
          "evidence-judge",
          `${input.idempotencyKey}:evidence-judge`
        );
        return hasEnoughBudget(input.runtime, 7000)
          ? input.adapter
              .judgeSupportAnswer(
                {
                  contextType,
                  language: input.language,
                  query: input.query,
                  caseFrame,
                  evidenceBundle,
                  draftSupportAnswer
                },
                `${input.idempotencyKey}:judge`,
                judgeRuntime
              )
              .then((value) => ({ value, timing: stageTiming("completed", elapsedMs(verifierStartedAt)) }))
              .catch(() => ({ value: null, timing: stageTiming("fallback", elapsedMs(verifierStartedAt)) }))
          : { value: null, timing: stageTiming("skipped", elapsedMs(verifierStartedAt)) };
      })();
  const verification =
    verificationResult.value ??
    fallbackVerification(
      input.language,
      evidenceCollection.references.length ? "partial" : "unsupported",
      caseFrame.missing_critical_info
    );
  const sanitizedVerification = sanitizeVerification({
    verification,
    evidenceBundle
  });
  const supportedCoreClaims = supportedVerificationClaims(sanitizedVerification);
  const unsupportedCore = sanitizedVerification.unsupported_claims.some(
    (claim: string) =>
      overlapsUnsupportedClaim(draftSupportAnswer.direct_answer, [claim]) ||
      draftSupportAnswer.claims.some(
        (draftClaim: SpecialistDraftAnswer["claims"][number]) =>
          draftClaim.kind !== "operational_advice" && overlapsUnsupportedClaim(draftClaim.text, [claim])
      )
  );
  const shouldUpgradeVerifiedVerdict =
    sanitizedVerification.verdict === "partial" &&
    supportedCoreClaims.length > 0 &&
    !unsupportedCore &&
    sanitizedVerification.missing_info.length === 0;
  const effectiveVerification =
    shouldUpgradeVerifiedVerdict
      ? {
          ...sanitizedVerification,
          verdict: "verified" as const,
          unsupported_claims: [],
          missing_info: []
        }
      : sanitizedVerification;

  const citationBinderRuntime = withStageRuntime(
    buildStageRuntime(input.runtime, 3000, 5000, 16000),
    "support-citation-binder",
    `${input.idempotencyKey}:support-citation-binder`
  );
  const citationBinderStartedAt = performance.now();
  const reboundVerification =
    useFastAgentPath || !draftSupportAnswer.claims.length || !evidenceBundle.primary.length || !hasEnoughBudget(input.runtime, 5000)
      ? null
      : await input.adapter
          .bindSupportCitations(
            {
              contextType,
              language: input.language,
              query: input.query,
              caseFrame,
              evidenceBundle,
              draftSupportAnswer
            },
            `${input.idempotencyKey}:support-citation-binder`,
            citationBinderRuntime
          )
          .catch(() => null);
  const citationBinderTiming =
    useFastAgentPath || !draftSupportAnswer.claims.length || !evidenceBundle.primary.length || !hasEnoughBudget(input.runtime, 5000)
      ? skippedStageTiming()
      : stageTiming(reboundVerification ? "completed" : "fallback", elapsedMs(citationBinderStartedAt), {
          reference_count: reboundVerification?.verified_citation_ids.length ?? 0
        });
  const reboundSanitized = reboundVerification
    ? sanitizeVerification({
        verification: reboundVerification,
        evidenceBundle
      })
    : null;
  const preselectedVerification = pickBestVerificationCandidate({
    query: input.query,
    caseFrame,
    evidenceBundle,
    primary: effectiveVerification,
    rebound: reboundSanitized,
    writerBound: writerBoundVerification
  });

  const displayCitationSelectorRuntime = withStageRuntime(
    buildStageRuntime(input.runtime, 2500, 4000, 14000),
    useFastAgentPath ? "support-citation-selector" : "citation-curator",
    `${input.idempotencyKey}:${useFastAgentPath ? "support-citation-selector" : "citation-curator"}`
  );
  const citationSelectionStartedAt = performance.now();
  const selectedDisplayCitations =
    supportedVerificationClaims(preselectedVerification).length > 0 && hasEnoughBudget(input.runtime, 4500)
      ? await (useFastAgentPath
          ? input.adapter.selectDisplayCitations(
                {
                contextType,
                language: input.language,
                query: input.query,
                caseFrame,
                evidenceBundle,
                supportedClaims: supportedVerificationClaims(preselectedVerification)
              },
              `${input.idempotencyKey}:support-citation-selector`,
              displayCitationSelectorRuntime
            )
          : input.adapter.curateSupportCitations(
                {
                contextType,
                language: input.language,
                query: input.query,
                caseFrame,
                evidenceBundle,
                supportedClaims: supportedVerificationClaims(preselectedVerification)
              },
              `${input.idempotencyKey}:citation-curator`,
              displayCitationSelectorRuntime
            ))
          .catch(() => null)
      : null;
  const citationSelectionTiming =
    supportedVerificationClaims(preselectedVerification).length > 0 && hasEnoughBudget(input.runtime, 4500)
      ? stageTiming(selectedDisplayCitations ? "completed" : "fallback", elapsedMs(citationSelectionStartedAt), {
          reference_count: selectedDisplayCitations?.display_citation_ids.length ?? 0
        })
      : skippedStageTiming();

  const finalVerification = sanitizeVerification({
    verification: selectedDisplayCitations
      ? {
          ...preselectedVerification,
          display_citation_ids: selectedDisplayCitations.display_citation_ids
        }
      : preselectedVerification,
    evidenceBundle
  });

  const missingInfo = uniqueStrings([...finalVerification.missing_info, ...caseFrame.missing_critical_info], 3);
  const mode = resolveSupportMode({
    verification: finalVerification,
    references: evidenceCollection.references,
    currentRound: input.currentRound + 1,
    missingInfo,
    preferClarificationWhenBlocking: caseFrame.object === "unspecified" && caseFrame.missing_critical_info.length > 0
  });
  const answerComposerRuntime = withStageRuntime(
    buildStageRuntime(input.runtime, 1500, 4000, 14000),
    "answer-composer",
    `${input.idempotencyKey}:answer-composer`
  );
  const answerComposerStartedAt = performance.now();
  const shouldComposeCustomerAnswer =
    !useFastAgentPath &&
    hasEnoughBudget(input.runtime, 4500) &&
    (mode === "clarification" ||
      mode === "handoff" ||
      (supportedVerificationClaims(finalVerification).length > 0 && (mode === "grounded" || mode === "partial")));
  const composedSupportAnswer =
    shouldComposeCustomerAnswer
      ? await input.adapter
          .composeCustomerAnswer(
            {
              contextType,
              language: input.language,
              query: input.query,
              mode,
              route,
              caseFrame,
              draftSupportAnswer,
              supportedClaims: supportedVerificationClaims(finalVerification),
              nextActions: filterUnsupported(draftSupportAnswer.next_actions, finalVerification.unsupported_claims),
              unknowns: uniqueStrings([...draftSupportAnswer.unknowns, ...missingInfo], 4)
            },
            `${input.idempotencyKey}:answer-composer`,
            answerComposerRuntime
          )
          .catch(() => null)
      : null;
  const answerComposerTiming =
    shouldComposeCustomerAnswer
      ? stageTiming(composedSupportAnswer ? "completed" : "fallback", elapsedMs(answerComposerStartedAt))
      : skippedStageTiming();
  const supportAnswer = buildSupportAnswerFromDraft({
    language: input.language,
    mode,
    route,
    draft: draftSupportAnswer,
    verification: {
      ...finalVerification,
      unsupported_claims: finalVerification.unsupported_claims
    },
    missingInfo,
    composed: composedSupportAnswer
  });
  const structuredAnswer = buildStructuredAnswer(supportAnswer, finalVerification);
  const citations = buildCitations({
    references: [...evidenceBundle.primary, ...evidenceBundle.supplemental],
    verification: finalVerification
  });

  const handoffAfterClarificationExhausted =
    mode === "handoff" && missingInfo.length > 0 && input.currentRound + 1 >= env.AI_SEARCH_MAX_CLARIFICATION_ROUNDS;
  const clarificationRound =
    mode === "clarification"
      ? input.currentRound + 1
      : handoffAfterClarificationExhausted
      ? env.AI_SEARCH_MAX_CLARIFICATION_ROUNDS
      : 0;
  const state: SearchDialogState =
    mode === "clarification"
      ? input.currentRound > 0
        ? "CLARIFICATION_IN_PROGRESS"
        : "CLARIFICATION_REQUIRED"
      : mode === "handoff"
      ? "TICKET_HANDOFF_RECOMMENDED"
      : "GROUNDABLE_ANSWER_READY";
  const unresolvedReasonCode =
    evidenceCollection.retrievalStatus === "kb_unavailable"
      ? "KB_RETRIEVAL_UNAVAILABLE"
      : !evidenceCollection.references.length
      ? "NO_MATCHING_KB"
      : finalVerification.verdict === "verified"
      ? null
      : "LOW_CONFIDENCE";
  const stageTimings: SupportAgentStageTimings = {
    total_ms: elapsedMs(runStartedAt),
    planner: mergeStageTimings([routeResult.timing, evidencePlanResult.timing, plannerResult.timing]),
    retrieval_base: baseEvidenceResult.timing,
    retrieval_extra: additionalTiming,
    writer: mergeStageTimings([specialistResult.timing, genericWriterResult.timing]),
    verifier: mergeStageTimings([verificationResult.timing, citationBinderTiming, citationSelectionTiming])
  };
  const stageTrace: SupportAgentStageTraceEntry[] = [
    stageTraceEntry({
      stage: "route",
      timing: routeResult.timing,
      runtimeStage: "router",
      idempotencyKey: `${input.idempotencyKey}:route`
    }),
    stageTraceEntry({
      stage: "evidence_plan",
      timing: evidencePlanResult.timing,
      runtimeStage: "evidence-planner",
      idempotencyKey: `${input.idempotencyKey}:evidence-plan`
    }),
    stageTraceEntry({
      stage: "case_plan",
      timing: plannerResult.timing,
      runtimeStage: "planner",
      idempotencyKey: `${input.idempotencyKey}:plan`
    }),
    stageTraceEntry({
      stage: "retrieval",
      timing: baseEvidenceResult.timing,
      idempotencyKey: `${input.idempotencyKey}:evidence`
    }),
    stageTraceEntry({
      stage: "retrieval_refine",
      timing: additionalTiming,
      idempotencyKey: `${input.idempotencyKey}:evidence:extra`
    }),
    stageTraceEntry({
      stage: "evidence_selection",
      timing: evidenceSelection.timing,
      runtimeStage: "support-evidence-selector",
      idempotencyKey: `${input.idempotencyKey}:evidence-selector`
    }),
    stageTraceEntry({
      stage: "specialist",
      timing: specialistResult.timing,
      runtimeStage: route.specialist_agent,
      idempotencyKey: `${input.idempotencyKey}:specialist`
    }),
    stageTraceEntry({
      stage: "generic_writer",
      timing: genericWriterResult.timing,
      runtimeStage: "support-writer",
      idempotencyKey: `${input.idempotencyKey}:support-writer`
    }),
    stageTraceEntry({
      stage: "verification",
      timing: verificationResult.timing,
      runtimeStage: "evidence-judge",
      idempotencyKey: `${input.idempotencyKey}:judge`
    }),
    stageTraceEntry({
      stage: "citation_binding",
      timing: citationBinderTiming,
      runtimeStage: "support-citation-binder",
      idempotencyKey: `${input.idempotencyKey}:support-citation-binder`
    }),
    stageTraceEntry({
      stage: "citation_selection",
      timing: citationSelectionTiming,
      runtimeStage: useFastAgentPath ? "support-citation-selector" : "citation-curator",
      idempotencyKey: `${input.idempotencyKey}:${useFastAgentPath ? "support-citation-selector" : "citation-curator"}`
    }),
    stageTraceEntry({
      stage: "answer_composition",
      timing: answerComposerTiming,
      runtimeStage: "answer-composer",
      idempotencyKey: `${input.idempotencyKey}:answer-composer`
    })
  ];

  return {
    caseFrame,
    evidenceBundle,
    verification: finalVerification,
    stageTimings,
    result: {
      session_id: "",
      answer: supportAnswer.direct_answer,
      answer_language: input.language,
      case_frame: caseFrame,
      support_answer: supportAnswer,
      verification: finalVerification,
      structured_answer: structuredAnswer,
      confidence: evidenceCollection.confidence,
      suggested_next_step: mode === "grounded" ? "self_serve" : "submit_ticket",
      retrieval_status:
        evidenceCollection.retrievalStatus === "kb_unavailable"
          ? "kb_unavailable"
          : evidenceCollection.references.length
          ? "grounded"
          : "no_results",
      unresolved_reason_code: unresolvedReasonCode,
      references: [...evidenceBundle.primary, ...evidenceBundle.supplemental],
      citations,
      state,
      clarification_round: clarificationRound,
      show_create_ticket_now: mode === "handoff",
      follow_up_question: mode === "clarification" ? missingInfo[0] ?? supportAnswer.still_need_to_confirm[0] ?? null : null,
      internal_diagnostics: {
        route,
        evidence_plan: evidencePlanResult.plan,
        stage_budget: stageBudget,
        retrieval_queries_used: uniqueStrings(
          [
            ...baseQueries,
            ...additionalQueries,
            ...(caseFrame.query_plan?.concept_queries ?? []),
            ...(caseFrame.query_plan?.object_queries ?? []),
            ...(caseFrame.query_plan?.behavior_queries ?? [])
          ],
          12
        ),
        retrieval_queries_refined: refinementEvidence?.resolvedQueries ?? [],
        claim_graph: buildClaimGraph(finalVerification),
        specialist_skipped: shouldSkipSpecialist,
        specialists_used: shouldSkipSpecialist ? [] : [route.specialist_agent],
        evidence_sources: uniqueStrings(
          evidenceCollection.references.map((item) => item.sourceType ?? "unknown"),
          6
        ),
        fast_path_used: useFastAgentPath,
        confirmed_facts: uniqueStrings(draftSupportAnswer.confirmed_facts ?? [], 4),
        stage_trace: stageTrace,
        orchestration_trace: buildOrchestrationTrace({
          route,
          specialistSkipped: shouldSkipSpecialist
        })
      }
    }
  };
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
