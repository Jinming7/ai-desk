import assert from "node:assert/strict";
import { test } from "node:test";
import type { SupportCaseFrame, SupportEvidencePlan, SupportQuestionRoute } from "./types.js";
import {
  resolveSupportExecutionPlan,
  type PlannerStageResult
} from "./support-execution-plan.js";

function completed<T>(value: T): PlannerStageResult<T> {
  return { status: "completed", value };
}

function timedOut<T>(): PlannerStageResult<T> {
  return { status: "timeout" };
}

test("preserves successful route semantics when evidence and case planning time out", () => {
  const route: SupportQuestionRoute = {
    question_type: "capability_confirmation",
    user_goal: "Confirm which Linux distributions are officially supported.",
    answer_contract:
      "State the officially supported Linux distributions clearly, note any version constraints if documented, and distinguish official support from unsupported distributions.",
    specialist_agent: "behavior-specialist",
    routing_confidence: 0.93,
    specialist_budget: 1
  };

  const plan = resolveSupportExecutionPlan({
    query: "Which Linux distributions are officially supported?",
    routeResult: completed(route),
    evidencePlanResult: timedOut<SupportEvidencePlan>(),
    casePlanResult: timedOut<SupportCaseFrame>()
  });

  assert.equal(plan.route.question_type, "capability_confirmation");
  assert.equal(plan.route.specialist_agent, "behavior-specialist");
  assert.equal(plan.caseFrame.question_type, "capability_confirmation");
  assert.equal(plan.caseFrame.specialist_agent, "behavior-specialist");
  assert.equal(plan.plannerDiagnostics.route.status, "completed");
  assert.equal(plan.plannerDiagnostics.evidencePlan.status, "timeout");
  assert.equal(plan.plannerDiagnostics.casePlan.status, "timeout");
  assert.equal(plan.plannerDiagnostics.synthesized, true);
});

test("synthesizes a deployment-scoped case frame instead of collapsing to generic fallback markers", () => {
  const route: SupportQuestionRoute = {
    question_type: "capability_confirmation",
    user_goal: "Confirm which Linux distributions are officially supported.",
    answer_contract:
      "State the officially supported Linux distributions clearly, note any version constraints if documented, and distinguish official support from unsupported distributions.",
    specialist_agent: "behavior-specialist",
    routing_confidence: 0.93,
    specialist_budget: 1
  };

  const plan = resolveSupportExecutionPlan({
    query: "Which Linux distributions are officially supported?",
    routeResult: completed(route),
    evidencePlanResult: timedOut<SupportEvidencePlan>(),
    casePlanResult: timedOut<SupportCaseFrame>()
  });

  assert.equal(plan.caseFrame.product_area, "deployment");
  assert.equal(plan.caseFrame.deployment_model, "private_deployment");
  assert.equal(plan.caseFrame.object, "linux distributions");
  assert.notEqual(plan.caseFrame.product_area, "general");
  assert.notEqual(plan.caseFrame.deployment_model, "shared");
  assert.notEqual(plan.caseFrame.object, "unspecified");
});

test("builds retrieval queries from the unified plan without generic fallback terms", () => {
  const route: SupportQuestionRoute = {
    question_type: "capability_confirmation",
    user_goal: "Confirm which Linux distributions are officially supported.",
    answer_contract:
      "State the officially supported Linux distributions clearly, note any version constraints if documented, and distinguish official support from unsupported distributions.",
    specialist_agent: "behavior-specialist",
    routing_confidence: 0.93,
    specialist_budget: 1
  };

  const plan = resolveSupportExecutionPlan({
    query: "Which Linux distributions are officially supported?",
    routeResult: completed(route),
    evidencePlanResult: timedOut<SupportEvidencePlan>(),
    casePlanResult: timedOut<SupportCaseFrame>()
  });

  assert.equal(plan.retrievalPlan.baseQueries.length > 0, true);
  assert.equal(
    plan.retrievalPlan.baseQueries.some((query) =>
      /unspecified|general|shared|troubleshooting/i.test(query)
    ),
    false
  );
  assert.equal(
    plan.retrievalPlan.baseQueries.some((query) =>
      /linux distributions|supported operating systems|deployment environment requirements/i.test(query)
    ),
    true
  );
});

test("canonicalizes free-form planner taxonomy onto the retrieval schema before strict evidence policy runs", () => {
  const route: SupportQuestionRoute = {
    question_type: "capability_confirmation",
    user_goal: "确认 ONES 支持的 Linux 发行版范围",
    answer_contract: "基于官方文档给出受支持的 Linux 发行版清单，并注明版本范围、安装/部署前提及是否区分服务端与客户端支持。",
    specialist_agent: "behavior-specialist",
    routing_confidence: 0.95,
    specialist_budget: 1
  };

  const plan = resolveSupportExecutionPlan({
    query: "ONES 支持哪些 Linux 发行版？",
    routeResult: completed(route),
    evidencePlanResult: completed<SupportEvidencePlan>({
      query_plan: {
        concept_queries: ["兼容性要求 操作系统 支持矩阵", "部署环境 前置条件 系统要求"],
        object_queries: ["Linux 发行版", "私有部署 服务端 操作系统"],
        behavior_queries: ["支持哪些发行版", "最低版本/推荐版本"]
      },
      evidence_priority: ["官方部署安装文档中的系统要求章节", "官方兼容性/支持矩阵文档"],
      required_doc_kinds: ["产品部署文档", "安装指南", "系统要求/环境要求", "兼容性或支持矩阵"],
      retrieval_rounds: 2,
      allow_refinement: true,
      stop_after_grounded_evidence: true
    }),
    casePlanResult: completed<SupportCaseFrame>({
      goal: "确认 ONES 支持哪些 Linux 发行版",
      symptom: "用户需要了解 ONES 的 Linux 兼容性/支持范围",
      object: "Linux 发行版支持列表",
      action_type: "support_matrix_lookup",
      deployment_model: "private_deployment",
      product_area: "部署安装与系统兼容性",
      constraints: [
        "需要以官方文档中的兼容性/环境要求为准",
        "优先查找安装部署、系统要求、支持矩阵类文档"
      ],
      missing_critical_info: [],
      retrieval_queries: ["ONES Linux 发行版 支持", "ONES 部署环境 Linux 要求", "兼容性要求 操作系统 支持矩阵"],
      query_plan: {
        concept_queries: ["兼容性要求 操作系统 支持矩阵", "部署环境 前置条件 系统要求"],
        object_queries: ["Linux 发行版", "私有部署 服务端 操作系统"],
        behavior_queries: ["支持哪些发行版", "support_matrix_lookup"]
      }
    })
  });

  assert.equal(plan.caseFrame.product_area, "deployment");
  assert.equal(plan.caseFrame.object, "linux distributions");
  assert.equal(plan.caseFrame.action_type, "capability_confirmation");
  assert.deepEqual(plan.evidencePlan.required_doc_kinds, ["deployment_runbook", "product_guide", "rules"]);
});
