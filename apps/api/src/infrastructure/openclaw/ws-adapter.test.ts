import assert from "node:assert/strict";
import { test } from "node:test";
import type { OpenClawRuntimeContext } from "./types.js";
import { WsOpenClawAdapter } from "./ws-adapter.js";

function createRuntimeAt(nowMs: number, input: {
  timeoutMs?: number;
  overallTimeoutMs: number;
  elapsedMs: number;
}): OpenClawRuntimeContext {
  return {
    timeoutMs: input.timeoutMs,
    overallTimeoutMs: input.overallTimeoutMs,
    requestStartedAtMs: nowMs - input.elapsedMs
  };
}

test("startChatRun caps chat.send transport timeout to the remaining overall runtime budget", async () => {
  const adapter = new WsOpenClawAdapter() as never as {
    startChatRun: (
      message: string,
      idempotencyKey: string,
      runtime?: OpenClawRuntimeContext,
      attachmentUrls?: string[],
      sessionKey?: string
    ) => Promise<string>;
    resolveAgentRuntime: (runtime?: OpenClawRuntimeContext) => { agentId: string; sessionKey: string; model?: string };
    buildChatAttachments: (attachmentUrls?: string[]) => Promise<unknown[]>;
    callMethod: (method: string, params: Record<string, unknown>, timeoutMs?: number) => Promise<unknown>;
  };
  const originalNow = Date.now;
  const fixedNow = 100_000;
  let observedTimeoutMs = -1;
  let observedMethod = "";

  Date.now = () => fixedNow;
  adapter.resolveAgentRuntime = () => ({
    agentId: "support-planner",
    sessionKey: "agent:support-planner:test"
  });
  adapter.buildChatAttachments = async () => [];
  adapter.callMethod = async (method, _params, timeoutMs) => {
    observedMethod = method;
    observedTimeoutMs = timeoutMs ?? -1;
    return { runId: "run-chat-1", status: "ok" };
  };

  try {
    const runId = await adapter.startChatRun(
      "{}",
      "timeout-cap:chat-send",
      createRuntimeAt(fixedNow, {
        timeoutMs: 12_000,
        overallTimeoutMs: 6_000,
        elapsedMs: 5_000
      }),
      [],
      "agent:support-planner:test"
    );
    assert.equal(runId, "run-chat-1");
  } finally {
    Date.now = originalNow;
  }

  assert.equal(observedMethod, "chat.send");
  assert.equal(observedTimeoutMs, 1_000);
});

test("startChatRun preserves explicit stage runtime timeout above default env caps", async () => {
  const adapter = new WsOpenClawAdapter() as never as {
    startChatRun: (
      message: string,
      idempotencyKey: string,
      runtime?: OpenClawRuntimeContext,
      attachmentUrls?: string[],
      sessionKey?: string
    ) => Promise<string>;
    resolveAgentRuntime: (runtime?: OpenClawRuntimeContext) => { agentId: string; sessionKey: string; model?: string };
    buildChatAttachments: (attachmentUrls?: string[]) => Promise<unknown[]>;
    callMethod: (method: string, params: Record<string, unknown>, timeoutMs?: number) => Promise<unknown>;
  };
  const originalNow = Date.now;
  const fixedNow = 300_000;
  let observedTimeoutMs = -1;

  Date.now = () => fixedNow;
  adapter.resolveAgentRuntime = () => ({
    agentId: "support-behavior-specialist",
    sessionKey: "agent:support-behavior-specialist:test"
  });
  adapter.buildChatAttachments = async () => [];
  adapter.callMethod = async (_method, _params, timeoutMs) => {
    observedTimeoutMs = timeoutMs ?? -1;
    return { runId: "run-chat-2", status: "ok" };
  };

  try {
    const runId = await adapter.startChatRun(
      "{}",
      "timeout-preserve:chat-send",
      createRuntimeAt(fixedNow, {
        timeoutMs: 45_000,
        overallTimeoutMs: 240_000,
        elapsedMs: 0
      }),
      [],
      "agent:support-behavior-specialist:test"
    );
    assert.equal(runId, "run-chat-2");
  } finally {
    Date.now = originalNow;
  }

  assert.equal(observedTimeoutMs, 45_000);
});

test("waitAgentRun caps both agent.wait timeout fields to the remaining overall runtime budget", async () => {
  const adapter = new WsOpenClawAdapter() as never as {
    waitAgentRun: (runId: string, sessionKey?: string, runtime?: OpenClawRuntimeContext) => Promise<void>;
    callMethod: (method: string, params: Record<string, unknown>, timeoutMs?: number) => Promise<unknown>;
    touchManagedSession: (sessionKey: string) => void;
  };
  const originalNow = Date.now;
  const fixedNow = 200_000;
  let observedMethod = "";
  let observedParams: Record<string, unknown> | null = null;
  let observedTimeoutMs = -1;
  let touchedSession = "";

  Date.now = () => fixedNow;
  adapter.callMethod = async (method, params, timeoutMs) => {
    observedMethod = method;
    observedParams = params;
    observedTimeoutMs = timeoutMs ?? -1;
    return { status: "ok" };
  };
  adapter.touchManagedSession = (sessionKey) => {
    touchedSession = sessionKey;
  };

  try {
    await adapter.waitAgentRun(
      "run-wait-1",
      "agent:support-planner:test",
      createRuntimeAt(fixedNow, {
        timeoutMs: 12_000,
        overallTimeoutMs: 6_000,
        elapsedMs: 5_000
      })
    );
  } finally {
    Date.now = originalNow;
  }

  assert.equal(observedMethod, "agent.wait");
  assert.deepEqual(observedParams, {
    runId: "run-wait-1",
    timeoutMs: 1_000
  });
  assert.equal(observedTimeoutMs, 1_000);
  assert.equal(touchedSession, "agent:support-planner:test");
});

test("waitAgentRun preserves explicit stage runtime timeout above default env caps", async () => {
  const adapter = new WsOpenClawAdapter() as never as {
    waitAgentRun: (runId: string, sessionKey?: string, runtime?: OpenClawRuntimeContext) => Promise<void>;
    callMethod: (method: string, params: Record<string, unknown>, timeoutMs?: number) => Promise<unknown>;
    touchManagedSession: (sessionKey: string) => void;
  };
  const originalNow = Date.now;
  const fixedNow = 400_000;
  let observedParams: Record<string, unknown> | null = null;
  let observedTimeoutMs = -1;

  Date.now = () => fixedNow;
  adapter.callMethod = async (_method, params, timeoutMs) => {
    observedParams = params;
    observedTimeoutMs = timeoutMs ?? -1;
    return { status: "ok" };
  };
  adapter.touchManagedSession = () => {};

  try {
    await adapter.waitAgentRun(
      "run-wait-2",
      "agent:support-behavior-specialist:test",
      createRuntimeAt(fixedNow, {
        timeoutMs: 45_000,
        overallTimeoutMs: 240_000,
        elapsedMs: 0
      })
    );
  } finally {
    Date.now = originalNow;
  }

  assert.deepEqual(observedParams, {
    runId: "run-wait-2",
    timeoutMs: 45_000
  });
  assert.equal(observedTimeoutMs, 45_000);
});
