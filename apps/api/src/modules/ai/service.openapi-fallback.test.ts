import assert from "node:assert/strict";
import { test } from "node:test";
import { buildDeterministicOpenApiAnswer } from "./service.js";

test("buildDeterministicOpenApiAnswer returns update-issue guidance for work-item update questions", () => {
  const result = buildDeterministicOpenApiAnswer("怎么通过接口更新工作项", "zh");

  assert.ok(result);
  assert.equal(result?.style, "kb_answer");
  assert.match(result?.summary ?? "", /PUT `?\/project\/issues\/\{issueID\}`?/);
  assert.match(result?.assessment ?? "", /write:project:issue/);
  assert.equal(result?.steps.some((item) => item.includes("teamID")), true);
  assert.equal(result?.steps.some((item) => item.includes("executeWorkflow")), true);
});
