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
