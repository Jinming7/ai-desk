import type { SupportCaseFrame, SupportDomain, SupportEvidencePlan, SupportQuestionRoute } from "./types.js";

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

function synthesizeCaseFrame(query: string, route: SupportQuestionRoute): SupportCaseFrame {
  const goal = route.user_goal || query;
  const actionType = String(route.question_type ?? "").trim() || "unknown";

  return {
    goal,
    symptom: goal,
    object: goal,
    action_type: actionType,
    deployment_model: "unknown",
    product_area: "general",
    constraints: [],
    missing_critical_info: [],
    retrieval_queries: uniqueStrings([query, route.user_goal], 4),
    query_plan: {
      concept_queries: uniqueStrings([query], 4),
      object_queries: uniqueStrings([goal], 4),
      behavior_queries: uniqueStrings([actionType], 4)
    },
    question_type: route.question_type,
    specialist_agent: route.specialist_agent,
    answer_contract: route.answer_contract,
    routing_confidence: route.routing_confidence,
    required_doc_kinds: []
  };
}

function synthesizeEvidencePlan(query: string, route: SupportQuestionRoute, caseFrame: SupportCaseFrame): SupportEvidencePlan {
  void route;
  const conceptQueries = caseFrame.query_plan?.concept_queries ?? [query];
  const objectQueries = caseFrame.query_plan?.object_queries ?? [caseFrame.object];
  const behaviorQueries = caseFrame.query_plan?.behavior_queries ?? [caseFrame.action_type];
  return {
    query_plan: {
      concept_queries: uniqueStrings(conceptQueries, 4),
      object_queries: uniqueStrings(objectQueries, 4),
      behavior_queries: uniqueStrings(behaviorQueries, 4)
    },
    evidence_priority: uniqueStrings(caseFrame.required_doc_kinds ?? [], 6),
    required_doc_kinds: uniqueStrings(caseFrame.required_doc_kinds ?? [], 6),
    retrieval_rounds: 1,
    allow_refinement: false,
    stop_after_grounded_evidence: false
  };
}

function normalizePlannerOutput(input: {
  query: string;
  route: SupportQuestionRoute;
  caseFrame: SupportCaseFrame;
  evidencePlan: SupportEvidencePlan;
}): { caseFrame: SupportCaseFrame; evidencePlan: SupportEvidencePlan } {
  const requiredDocKinds = uniqueStrings(
    [...(input.caseFrame.required_doc_kinds ?? []), ...(input.evidencePlan.required_doc_kinds ?? [])],
    6
  );
  const caseFrame: SupportCaseFrame = {
    ...input.caseFrame,
    product_area: String(input.caseFrame.product_area ?? "").trim() || "general",
    object: String(input.caseFrame.object ?? "").trim() || input.query,
    action_type: String(input.caseFrame.action_type ?? "").trim() || "unknown",
    retrieval_queries: uniqueStrings(
      [...(input.caseFrame.retrieval_queries ?? []), input.query],
      8
    ),
    query_plan: {
      concept_queries: uniqueStrings(input.caseFrame.query_plan?.concept_queries?.length ? input.caseFrame.query_plan.concept_queries : [input.query], 4),
      object_queries: uniqueStrings(
        input.caseFrame.query_plan?.object_queries?.length
          ? input.caseFrame.query_plan.object_queries
          : [String(input.caseFrame.object ?? "").trim() || input.query],
        4
      ),
      behavior_queries: uniqueStrings(
        input.caseFrame.query_plan?.behavior_queries?.length
          ? input.caseFrame.query_plan.behavior_queries
          : [String(input.caseFrame.action_type ?? "").trim() || "unknown"],
        4
      )
    },
    required_doc_kinds: requiredDocKinds.length > 0 ? requiredDocKinds : input.caseFrame.required_doc_kinds
  };
  const evidencePlan: SupportEvidencePlan = {
    ...input.evidencePlan,
    query_plan: {
      concept_queries: uniqueStrings(
        input.evidencePlan.query_plan?.concept_queries?.length ? input.evidencePlan.query_plan.concept_queries : caseFrame.query_plan?.concept_queries ?? [input.query],
        4
      ),
      object_queries: uniqueStrings(
        input.evidencePlan.query_plan?.object_queries?.length
          ? input.evidencePlan.query_plan.object_queries
          : caseFrame.query_plan?.object_queries ?? [String(caseFrame.object ?? "").trim() || input.query],
        4
      ),
      behavior_queries: uniqueStrings(
        input.evidencePlan.query_plan?.behavior_queries?.length
          ? input.evidencePlan.query_plan.behavior_queries
          : caseFrame.query_plan?.behavior_queries ?? [String(caseFrame.action_type ?? "").trim() || "unknown"],
        4
      )
    },
    evidence_priority: uniqueStrings(input.evidencePlan.evidence_priority ?? [], 6),
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
  void evidencePlan;
  const baseQueries = uniqueStrings(
    [
      ...caseFrame.retrieval_queries,
      query
    ],
    8
  );

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
