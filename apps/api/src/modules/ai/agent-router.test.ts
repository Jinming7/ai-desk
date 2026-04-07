import assert from "node:assert/strict";
import { test } from "node:test";
import { buildSearchRuntime } from "./agent-router.js";

test("buildSearchRuntime keeps serverless retrieval on github kb path but allows limited multi-pass retrieval", () => {
  const originalVercel = process.env.VERCEL;
  try {
    process.env.VERCEL = "1";
    const runtime = buildSearchRuntime({
      intent: "retrieval",
      sessionId: "serverless-runtime-budget"
    });

    assert.equal(runtime.disableLocalDocs, true);
    assert.equal(runtime.allowMultiPassRetrieval, true);
    assert.equal(runtime.allowRefinement, true);
    assert.equal(runtime.kbTopK, 8);
    assert.equal(runtime.queryLimit, 2);
  } finally {
    if (originalVercel === undefined) delete process.env.VERCEL;
    else process.env.VERCEL = originalVercel;
  }
});

test("buildSearchRuntime keeps local runtime on broader retrieval budget", () => {
  const originalVercel = process.env.VERCEL;
  try {
    delete process.env.VERCEL;
    const runtime = buildSearchRuntime({
      intent: "retrieval",
      sessionId: "local-runtime-budget"
    });

    assert.equal(runtime.disableLocalDocs, true);
    assert.equal(runtime.allowMultiPassRetrieval, true);
    assert.equal(runtime.allowRefinement, true);
    assert.equal(runtime.kbTopK, 8);
    assert.equal(runtime.queryLimit, 4);
  } finally {
    if (originalVercel === undefined) delete process.env.VERCEL;
    else process.env.VERCEL = originalVercel;
  }
});

test("buildSearchRuntime gives async job delivery a larger serverless budget than interactive delivery", () => {
  const originalVercel = process.env.VERCEL;
  try {
    process.env.VERCEL = "1";
    const interactive = buildSearchRuntime({
      intent: "retrieval",
      sessionId: "interactive-runtime-budget"
    });
    const asyncJob = buildSearchRuntime({
      intent: "retrieval",
      sessionId: "job-runtime-budget",
      delivery: "async_job"
    });

    assert.equal(interactive.overallTimeoutMs! < asyncJob.overallTimeoutMs!, true);
    assert.equal(interactive.queryLimit! < asyncJob.queryLimit!, true);
    assert.equal(asyncJob.allowRefinement, true);
  } finally {
    if (originalVercel === undefined) delete process.env.VERCEL;
    else process.env.VERCEL = originalVercel;
  }
});
