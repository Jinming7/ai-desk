import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveRollbackFlagState, resolveSafeRollbackFlagState } from "./release/service.js";

test("resolveSafeRollbackFlagState keeps hybrid retrieval enabled", () => {
  assert.deepEqual(resolveSafeRollbackFlagState(), {
    FEATURE_SUPPORT_AGENT_HYBRID_RETRIEVAL: true,
    FEATURE_SUPPORT_AGENT_RUNTIME_TIGHTENING: false
  });
});

test("resolveRollbackFlagState normalizes legacy hybrid false while preserving runtime tightening intent", () => {
  assert.deepEqual(
    resolveRollbackFlagState({
      FEATURE_SUPPORT_AGENT_HYBRID_RETRIEVAL: false,
      FEATURE_SUPPORT_AGENT_RUNTIME_TIGHTENING: true
    }),
    {
      FEATURE_SUPPORT_AGENT_HYBRID_RETRIEVAL: true,
      FEATURE_SUPPORT_AGENT_RUNTIME_TIGHTENING: true
    }
  );
});
