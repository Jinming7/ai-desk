import type { SupportCaseFrame, SupportEvidencePlan, SupportQuestionRoute } from "./types.js";

export type PlannerStageStatus =
  | "completed"
  | "timeout"
  | "parse_failure"
  | "transport_failure"
  | "fallback";

export type PlannerStageResult<T> =
  | {
      status: "completed";
      value: T;
    }
  | {
      status: Exclude<PlannerStageStatus, "completed">;
      value?: null | undefined;
    };

export interface SupportExecutionPlan {
  route: SupportQuestionRoute;
  caseFrame: SupportCaseFrame;
  evidencePlan: SupportEvidencePlan;
  retrievalPlan: {
    baseQueries: string[];
  };
  degradedPolicy: {
    plannerSynthesized: boolean;
  };
  budgetHints: {
    preferAsyncExecution: boolean;
  };
  plannerDiagnostics: {
    route: { status: PlannerStageStatus };
    evidencePlan: { status: PlannerStageStatus };
    casePlan: { status: PlannerStageStatus };
    synthesized: boolean;
  };
}

function uniqueStrings(values: Array<string | null | undefined>, limit = 8): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of values) {
    const value = String(item ?? "").trim();
    if (!value || seen.has(value)) continue;
    seen.add(value);
    result.push(value);
    if (result.length >= limit) break;
  }
  return result;
}

function normalizeLookup(value: unknown): string {
  return String(value ?? "").trim().toLowerCase();
}

function collectPlannerSemanticText(input: {
  query: string;
  route: SupportQuestionRoute;
  caseFrame: SupportCaseFrame;
  evidencePlan: SupportEvidencePlan;
}): string {
  return uniqueStrings(
    [
      input.query,
      input.route.user_goal,
      input.caseFrame.goal,
      input.caseFrame.symptom,
      input.caseFrame.object,
      input.caseFrame.action_type,
      input.caseFrame.product_area,
      input.caseFrame.deployment_model,
      ...(input.caseFrame.constraints ?? []),
      ...(input.caseFrame.retrieval_queries ?? []),
      ...(input.caseFrame.required_doc_kinds ?? []),
      ...(input.caseFrame.query_plan?.concept_queries ?? []),
      ...(input.caseFrame.query_plan?.object_queries ?? []),
      ...(input.caseFrame.query_plan?.behavior_queries ?? []),
      ...(input.evidencePlan.evidence_priority ?? []),
      ...(input.evidencePlan.required_doc_kinds ?? []),
      ...(input.evidencePlan.query_plan?.concept_queries ?? []),
      ...(input.evidencePlan.query_plan?.object_queries ?? []),
      ...(input.evidencePlan.query_plan?.behavior_queries ?? [])
    ],
    64
  )
    .join(" ")
    .toLowerCase();
}

function normalizeStageStatus<T>(result: PlannerStageResult<T>): PlannerStageStatus {
  return result.status;
}

function analyzePlanSignals(query: string) {
  const lowered = query.toLowerCase();
  const linuxDistributionContext =
    /linux|发行版|操作系统/.test(lowered) &&
    (/\bdistribution\b/.test(lowered) ||
      /\bdistributions\b/.test(lowered) ||
      /\boperating system\b/.test(lowered) ||
      /\bos\b/.test(lowered) ||
      /发行版|操作系统/.test(lowered));
  const environmentRequirementsContext =
    linuxDistributionContext ||
    /\bsystem requirements?\b/.test(lowered) ||
    /\bdeployment requirements?\b/.test(lowered) ||
    /\bsupported operating systems?\b/.test(lowered) ||
    /\bserver os\b/.test(lowered) ||
    /系统要求|环境要求|兼容性|支持矩阵|操作系统要求/.test(lowered);

  return {
    linuxDistributionContext,
    environmentRequirementsContext
  };
}

function inferActionType(route: SupportQuestionRoute): string {
  switch (route.question_type) {
    case "how_to_product":
    case "config_setup":
      return "how_to";
    case "troubleshooting":
      return "troubleshooting";
    case "api_endpoint_lookup":
    case "api_field_lookup":
    case "api_scope_auth":
      return "api_lookup";
    default:
      return "capability_confirmation";
  }
}

function synthesizeCaseFrame(query: string, route: SupportQuestionRoute): SupportCaseFrame {
  const signals = analyzePlanSignals(query);
  const deploymentScoped = signals.environmentRequirementsContext;
  const object = signals.linuxDistributionContext ? "linux distributions" : route.user_goal || query;
  const conceptQueries = deploymentScoped
    ? ["supported operating systems", "deployment environment requirements", "system requirements"]
    : [route.user_goal || query];
  const objectQueries = signals.linuxDistributionContext
    ? ["linux distributions", "linux operating systems", "server os"]
    : [object];
  const behaviorQueries =
    route.question_type === "capability_confirmation"
      ? ["officially supported", "support matrix", "compatibility policy"]
      : [route.question_type.replace(/_/g, " ")];

  return {
    goal: route.user_goal || query,
    symptom: route.user_goal || query,
    object,
    action_type: inferActionType(route),
    deployment_model: deploymentScoped ? "private_deployment" : "unknown",
    product_area: deploymentScoped ? "deployment" : "general",
    constraints: [],
    missing_critical_info: [],
    retrieval_queries: uniqueStrings(
      deploymentScoped
        ? [
            `${query} deployment`,
            "supported operating systems",
            "deployment environment requirements",
            "system requirements linux distributions"
          ]
        : [query, route.user_goal],
      6
    ),
    query_plan: {
      concept_queries: uniqueStrings(conceptQueries, 4),
      object_queries: uniqueStrings(objectQueries, 4),
      behavior_queries: uniqueStrings(behaviorQueries, 4)
    },
    question_type: route.question_type,
    specialist_agent: route.specialist_agent,
    answer_contract: route.answer_contract,
    routing_confidence: route.routing_confidence,
    required_doc_kinds: deploymentScoped ? ["product_guide", "rules", "troubleshooting"] : []
  };
}

function synthesizeEvidencePlan(query: string, route: SupportQuestionRoute, caseFrame: SupportCaseFrame): SupportEvidencePlan {
  const signals = analyzePlanSignals(query);
  const conceptQueries = caseFrame.query_plan?.concept_queries ?? [query];
  const objectQueries = caseFrame.query_plan?.object_queries ?? [caseFrame.object];
  const behaviorQueries = caseFrame.query_plan?.behavior_queries ?? [caseFrame.action_type];
  return {
    query_plan: {
      concept_queries: uniqueStrings(conceptQueries, 4),
      object_queries: uniqueStrings(objectQueries, 4),
      behavior_queries: uniqueStrings(behaviorQueries, 4)
    },
    evidence_priority: signals.environmentRequirementsContext
      ? ["platform/system requirements", "support matrix", "deployment guide"]
      : [route.question_type.replace(/_/g, " ")],
    required_doc_kinds:
      caseFrame.required_doc_kinds && caseFrame.required_doc_kinds.length > 0
        ? caseFrame.required_doc_kinds
        : signals.environmentRequirementsContext
        ? ["product_guide", "rules", "troubleshooting"]
        : [],
    retrieval_rounds: 2,
    allow_refinement: true,
    stop_after_grounded_evidence: false
  };
}

function canonicalizeProductArea(input: {
  query: string;
  route: SupportQuestionRoute;
  caseFrame: SupportCaseFrame;
  evidencePlan: SupportEvidencePlan;
}): string {
  const explicit = normalizeLookup(input.caseFrame.product_area);
  if (explicit === "deployment" || explicit === "deployment_environment" || explicit.startsWith("deployment_")) {
    return "deployment";
  }
  if (explicit === "openapi") return "openapi";
  if (explicit === "integrations" || explicit === "integration") return "integrations";

  const semanticText = collectPlannerSemanticText(input);
  if (String(input.route.question_type ?? "").startsWith("api_")) {
    return "openapi";
  }
  if (/(部署|安装|环境要求|系统要求|支持矩阵|兼容性|private deployment|self-hosted|self hosted|on-prem|on prem|operating system|supported operating systems|deployment requirements|system requirements)/.test(semanticText)) {
    return "deployment";
  }
  if (/(集成|回调|重定向|integration|callback|redirect|webhook|oauth app)/.test(semanticText)) {
    return "integrations";
  }
  if (/(openapi|api|接口|scope|oauth|token)/.test(semanticText)) {
    return "openapi";
  }
  return input.caseFrame.product_area;
}

function canonicalizeRequiredDocKinds(values: string[], canonicalProductArea: string): string[] {
  const canonical = uniqueStrings(
    values.flatMap((value) => {
      const normalized = normalizeLookup(value);
      if (!normalized) return [];
      const result: string[] = [];
      if (normalized === "deployment_runbook" || /部署|安装|runbook/.test(normalized)) {
        result.push("deployment_runbook");
      }
      if (
        normalized === "product_guide" ||
        /product.?guide|系统要求|环境要求|安装指南|部署文档|官方部署安装文档|guide/.test(normalized)
      ) {
        result.push("product_guide");
      }
      if (
        normalized === "rules" ||
        /rules?|constraint|compatibility|support matrix|版本(?:发布)?说明|限制|规则|支持矩阵|兼容性/.test(normalized)
      ) {
        result.push("rules");
      }
      if (normalized === "troubleshooting" || /故障|排查|troubleshooting/.test(normalized)) {
        result.push("troubleshooting");
      }
      if (normalized === "openapi/api" || /openapi|api|接口/.test(normalized)) {
        result.push("openapi/api");
      }
      if (normalized === "permissions" || /permission|scope|oauth|token|鉴权|授权|权限/.test(normalized)) {
        result.push("permissions");
      }
      return result;
    }),
    6
  );

  if (canonical.length > 0) return canonical;
  if (canonicalProductArea === "deployment") return ["deployment_runbook", "product_guide", "rules"];
  if (canonicalProductArea === "openapi") return ["openapi/api"];
  return [];
}

function canonicalizeObject(input: {
  query: string;
  caseFrame: SupportCaseFrame;
  evidencePlan: SupportEvidencePlan;
}): string {
  const semanticText = uniqueStrings(
    [
      input.query,
      input.caseFrame.object,
      ...(input.caseFrame.retrieval_queries ?? []),
      ...(input.caseFrame.query_plan?.object_queries ?? []),
      ...(input.evidencePlan.query_plan?.object_queries ?? [])
    ],
    24
  )
    .join(" ")
    .toLowerCase();

  if (/linux/.test(semanticText) && (/distribution/.test(semanticText) || /发行版|操作系统/.test(semanticText))) {
    return "linux distributions";
  }

  return input.caseFrame.object;
}

function canonicalizeActionType(actionType: string, route: SupportQuestionRoute): string {
  const normalized = normalizeLookup(actionType);
  if (normalized === "how_to" || normalized === "troubleshooting" || normalized === "api_lookup" || normalized === "capability_confirmation") {
    return normalized;
  }
  if (/support[_ ]?matrix|compatibility|发行版|操作系统|system requirements?|environment requirements?/.test(normalized)) {
    return "capability_confirmation";
  }
  if (/how|步骤|安装|配置|setup|configure/.test(normalized)) {
    return "how_to";
  }
  if (/故障|排查|error|failed|troubleshoot/.test(normalized)) {
    return "troubleshooting";
  }
  return inferActionType(route);
}

function normalizePlannerOutput(input: {
  query: string;
  route: SupportQuestionRoute;
  caseFrame: SupportCaseFrame;
  evidencePlan: SupportEvidencePlan;
}): { caseFrame: SupportCaseFrame; evidencePlan: SupportEvidencePlan } {
  const productArea = canonicalizeProductArea(input);
  const requiredDocKinds = canonicalizeRequiredDocKinds(
    [...(input.caseFrame.required_doc_kinds ?? []), ...(input.evidencePlan.required_doc_kinds ?? [])],
    productArea
  );
  const caseFrame: SupportCaseFrame = {
    ...input.caseFrame,
    product_area: productArea,
    object: canonicalizeObject(input),
    action_type: canonicalizeActionType(input.caseFrame.action_type, input.route),
    required_doc_kinds: requiredDocKinds.length > 0 ? requiredDocKinds : input.caseFrame.required_doc_kinds
  };
  const evidencePlan: SupportEvidencePlan = {
    ...input.evidencePlan,
    required_doc_kinds: requiredDocKinds.length > 0 ? requiredDocKinds : input.evidencePlan.required_doc_kinds
  };
  return {
    caseFrame,
    evidencePlan
  };
}

export function canonicalizeSupportPlannerArtifacts(input: {
  query: string;
  route: SupportQuestionRoute;
  caseFrame: SupportCaseFrame;
  evidencePlan: SupportEvidencePlan;
}): { caseFrame: SupportCaseFrame; evidencePlan: SupportEvidencePlan } {
  return normalizePlannerOutput(input);
}

function buildRetrievalPlan(query: string, caseFrame: SupportCaseFrame, evidencePlan: SupportEvidencePlan) {
  const baseQueries = uniqueStrings(
    [
      ...caseFrame.retrieval_queries,
      ...(evidencePlan.query_plan?.concept_queries ?? []),
      ...(evidencePlan.query_plan?.object_queries ?? []),
      ...(evidencePlan.query_plan?.behavior_queries ?? []),
      query
    ],
    8
  ).filter((item) => !/unspecified|general|shared|troubleshooting/i.test(item));

  return { baseQueries };
}

export function resolveSupportExecutionPlan(input: {
  query: string;
  routeResult: PlannerStageResult<SupportQuestionRoute>;
  evidencePlanResult: PlannerStageResult<SupportEvidencePlan>;
  casePlanResult: PlannerStageResult<SupportCaseFrame>;
}): SupportExecutionPlan {
  if (input.routeResult.status !== "completed") {
    throw new Error("resolveSupportExecutionPlan requires a successful route result");
  }

  const route = input.routeResult.value;
  const synthesizedCaseFrame =
    input.casePlanResult.status === "completed"
      ? {
          ...input.casePlanResult.value,
          question_type: route.question_type,
          specialist_agent: route.specialist_agent,
          answer_contract: route.answer_contract,
          routing_confidence: route.routing_confidence
        }
      : synthesizeCaseFrame(input.query, route);

  const evidencePlan =
    input.evidencePlanResult.status === "completed"
      ? input.evidencePlanResult.value
      : synthesizeEvidencePlan(input.query, route, synthesizedCaseFrame);
  const normalizedPlannerOutput = normalizePlannerOutput({
    query: input.query,
    route,
    caseFrame: synthesizedCaseFrame,
    evidencePlan
  });

  return {
    route,
    caseFrame: normalizedPlannerOutput.caseFrame,
    evidencePlan: normalizedPlannerOutput.evidencePlan,
    retrievalPlan: buildRetrievalPlan(input.query, normalizedPlannerOutput.caseFrame, normalizedPlannerOutput.evidencePlan),
    degradedPolicy: {
      plannerSynthesized:
        input.casePlanResult.status !== "completed" || input.evidencePlanResult.status !== "completed"
    },
    budgetHints: {
      preferAsyncExecution: true
    },
    plannerDiagnostics: {
      route: { status: normalizeStageStatus(input.routeResult) },
      evidencePlan: { status: normalizeStageStatus(input.evidencePlanResult) },
      casePlan: { status: normalizeStageStatus(input.casePlanResult) },
      synthesized: input.casePlanResult.status !== "completed" || input.evidencePlanResult.status !== "completed"
    }
  };
}
