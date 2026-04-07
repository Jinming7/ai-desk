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

function normalizeStageStatus<T>(result: PlannerStageResult<T>): PlannerStageStatus {
  return result.status;
}

function analyzePlanSignals(query: string) {
  const lowered = query.toLowerCase();
  const linuxDistributionContext =
    /\blinux\b/.test(lowered) &&
    (/\bdistribution\b/.test(lowered) ||
      /\bdistributions\b/.test(lowered) ||
      /\boperating system\b/.test(lowered) ||
      /\bos\b/.test(lowered));
  const environmentRequirementsContext =
    linuxDistributionContext ||
    /\bsystem requirements?\b/.test(lowered) ||
    /\bdeployment requirements?\b/.test(lowered) ||
    /\bsupported operating systems?\b/.test(lowered) ||
    /\bserver os\b/.test(lowered);

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

  return {
    route,
    caseFrame: synthesizedCaseFrame,
    evidencePlan,
    retrievalPlan: buildRetrievalPlan(input.query, synthesizedCaseFrame, evidencePlan),
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
