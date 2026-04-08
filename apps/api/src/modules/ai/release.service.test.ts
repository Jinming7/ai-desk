import assert from "node:assert/strict";
import { test } from "node:test";
import { env } from "../../config/env.js";
import { getSupportReleaseFlagSnapshot } from "./release/service.js";

test("support release snapshot defaults hybrid retrieval on for preview when the raw env flag is unset", () => {
  const originalVercelEnv = process.env.VERCEL_ENV;
  const originalRawFlag = process.env.FEATURE_SUPPORT_AGENT_HYBRID_RETRIEVAL;
  const originalEnvFlag = env.FEATURE_SUPPORT_AGENT_HYBRID_RETRIEVAL;

  try {
    process.env.VERCEL_ENV = "preview";
    delete process.env.FEATURE_SUPPORT_AGENT_HYBRID_RETRIEVAL;
    env.FEATURE_SUPPORT_AGENT_HYBRID_RETRIEVAL = false;

    const snapshot = getSupportReleaseFlagSnapshot();

    assert.equal(snapshot.FEATURE_SUPPORT_AGENT_HYBRID_RETRIEVAL, true);
  } finally {
    if (originalVercelEnv === undefined) delete process.env.VERCEL_ENV;
    else process.env.VERCEL_ENV = originalVercelEnv;
    if (originalRawFlag === undefined) delete process.env.FEATURE_SUPPORT_AGENT_HYBRID_RETRIEVAL;
    else process.env.FEATURE_SUPPORT_AGENT_HYBRID_RETRIEVAL = originalRawFlag;
    env.FEATURE_SUPPORT_AGENT_HYBRID_RETRIEVAL = originalEnvFlag;
  }
});

test("support release snapshot keeps hybrid retrieval on even when legacy false flags are present", () => {
  const originalVercelEnv = process.env.VERCEL_ENV;
  const originalRawFlag = process.env.FEATURE_SUPPORT_AGENT_HYBRID_RETRIEVAL;
  const originalEnvFlag = env.FEATURE_SUPPORT_AGENT_HYBRID_RETRIEVAL;

  try {
    process.env.VERCEL_ENV = "production";
    process.env.FEATURE_SUPPORT_AGENT_HYBRID_RETRIEVAL = "false";
    env.FEATURE_SUPPORT_AGENT_HYBRID_RETRIEVAL = false;

    const snapshot = getSupportReleaseFlagSnapshot();

    assert.equal(snapshot.FEATURE_SUPPORT_AGENT_HYBRID_RETRIEVAL, true);
  } finally {
    if (originalVercelEnv === undefined) delete process.env.VERCEL_ENV;
    else process.env.VERCEL_ENV = originalVercelEnv;
    if (originalRawFlag === undefined) delete process.env.FEATURE_SUPPORT_AGENT_HYBRID_RETRIEVAL;
    else process.env.FEATURE_SUPPORT_AGENT_HYBRID_RETRIEVAL = originalRawFlag;
    env.FEATURE_SUPPORT_AGENT_HYBRID_RETRIEVAL = originalEnvFlag;
  }
});
