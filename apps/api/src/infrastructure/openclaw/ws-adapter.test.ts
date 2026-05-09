import assert from "node:assert/strict";
import { test } from "node:test";
import type { OpenClawRuntimeContext } from "./types.js";
import { summarizeOpenClawWsRuntimeConfigForLog, WsOpenClawAdapter } from "./ws-adapter.js";

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

test("summarizeOpenClawWsRuntimeConfigForLog compacts multiline runtime env into a single-line preview", () => {
  const originalWsUrl = process.env.OPENCLAW_WS_URL;
  const originalVercelEnv = process.env.VERCEL_ENV;
  const originalGitRef = process.env.VERCEL_GIT_COMMIT_REF;

  process.env.OPENCLAW_WS_URL =
    'vercel env add OPENCLAW_AGENT_ID_PLANNER preview "$branch" --value support-planner --yes --force >/dev/null\necho synced:OPENCLAW_AGENT_ID_PLANNER';
  process.env.VERCEL_ENV = "preview";
  process.env.VERCEL_GIT_COMMIT_REF = "feature/support-runtime-clean-topology-20260424";

  try {
    const summary = summarizeOpenClawWsRuntimeConfigForLog();
    assert.equal(summary.processEnvPresent, true);
    assert.equal(summary.processEnvPreview.includes("\n"), false);
    assert.match(summary.processEnvPreview, /vercel env add OPENCLAW_AGENT_ID_PLANNER preview/);
    assert.match(summary.processEnvPreview, /echo synced:OPENCLAW_AGENT_ID_PLANNER/);
    assert.equal(summary.vercelEnv, "preview");
    assert.equal(summary.gitRef, "feature/support-runtime-clean-topology-20260424");
  } finally {
    if (originalWsUrl === undefined) delete process.env.OPENCLAW_WS_URL;
    else process.env.OPENCLAW_WS_URL = originalWsUrl;
    if (originalVercelEnv === undefined) delete process.env.VERCEL_ENV;
    else process.env.VERCEL_ENV = originalVercelEnv;
    if (originalGitRef === undefined) delete process.env.VERCEL_GIT_COMMIT_REF;
    else process.env.VERCEL_GIT_COMMIT_REF = originalGitRef;
  }
});

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
  let observedParams: Record<string, unknown> | null = null;

  Date.now = () => fixedNow;
  adapter.resolveAgentRuntime = () => ({
    agentId: "support-behavior-specialist",
    sessionKey: "agent:support-behavior-specialist:test"
  });
  adapter.buildChatAttachments = async () => [];
  adapter.callMethod = async (_method, params, timeoutMs) => {
    observedParams = params;
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
  assert.equal((observedParams as Record<string, unknown> | null)?.deliver, true);
});

test("runJsonPrompt still reads assistant JSON when agent.wait times out", async () => {
  const adapter = new WsOpenClawAdapter() as never as {
    runJsonPrompt: (
      message: string,
      idempotencyKey: string,
      runtime?: OpenClawRuntimeContext,
      attachmentUrls?: string[],
      stage?: string
    ) => Promise<unknown>;
    createRunScopedSessionKey: (
      runtime: OpenClawRuntimeContext | undefined,
      idempotencyKey: string,
      stage: string
    ) => string;
    startChatRun: (
      message: string,
      idempotencyKey: string,
      runtime?: OpenClawRuntimeContext,
      attachmentUrls?: string[],
      sessionKey?: string
    ) => Promise<string>;
    waitAgentRun: (runId: string, sessionKey?: string, runtime?: OpenClawRuntimeContext) => Promise<void>;
    fetchLatestAssistantText: (sessionKey: string) => Promise<string>;
  };
  let fetchedSessionKey = "";

  adapter.createRunScopedSessionKey = () => "agent:support-planner:test";
  adapter.startChatRun = async () => "run-chat-timeout";
  adapter.waitAgentRun = async () => {
    throw new Error("OpenClaw agent.wait timeout");
  };
  adapter.fetchLatestAssistantText = async (sessionKey) => {
    fetchedSessionKey = sessionKey;
    return '{"ok":true}';
  };

  const parsed = await adapter.runJsonPrompt("{}", "json-timeout-fallback", undefined, undefined, "planner");

  assert.deepEqual(parsed, { ok: true });
  assert.equal(fetchedSessionKey, "agent:support-planner:test");
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

test("selectSupportEvidence exposes exact evidence ids to the selector prompt", async () => {
  const adapter = new WsOpenClawAdapter() as never as {
    selectSupportEvidence: (
      input: {
        contextType: "search" | "triage";
        language: "zh" | "en";
        query: string;
        caseFrame: Record<string, unknown>;
        references: Array<Record<string, unknown>>;
      },
      idempotencyKey: string,
      runtime?: OpenClawRuntimeContext
    ) => Promise<{ primary_ids: string[]; supplemental_ids: string[]; rejected_ids: string[] }>;
    runJsonPrompt: (prompt: string) => Promise<unknown>;
  };
  let capturedPrompt = "";

  adapter.runJsonPrompt = async (prompt) => {
    capturedPrompt = prompt;
    return {
      primary_ids: ["chunk:capacity"],
      supplemental_ids: [],
      rejected_ids: []
    };
  };

  const selection = await adapter.selectSupportEvidence(
    {
      contextType: "search",
      language: "en",
      query: "Does private deployment support capacity scaling?",
      caseFrame: {
        goal: "capacity scaling",
        symptom: "capacity question",
        object: "private deployment",
        action_type: "why",
        deployment_model: "private_deployment",
        product_area: "deploy",
        constraints: [],
        missing_critical_info: [],
        retrieval_queries: ["capacity scaling"]
      },
      references: [
        {
          documentId: "doc:deploy-capacity",
          evidenceId: "chunk:capacity",
          title: "Deployment capacity",
          snippet: "Capacity scaling is supported for private deployment clusters.",
          sourceUrl: "https://docs.ones.com/deploy/capacity",
          path: "deploy-docs/docs/capacity.mdx",
          headingPath: "Capacity",
          score: 0.93,
          retrievedAt: "2026-04-08T08:00:00.000Z",
          supportMetadata: {
            authority: "canonical_visible",
            source_type: "github_kb"
          }
        }
      ]
    },
    "ws-adapter:evidence-selector-prompt"
  );

  assert.match(capturedPrompt, /"evidenceId":"chunk:capacity"/);
  assert.equal(capturedPrompt.includes('"documentId":"doc:deploy-capacity"'), true);
  assert.deepEqual(selection.primary_ids, ["chunk:capacity"]);
});

test("selectSupportEvidence falls back rejected ids to evidence ids instead of document ids", async () => {
  const adapter = new WsOpenClawAdapter() as never as {
    selectSupportEvidence: (
      input: {
        contextType: "search" | "triage";
        language: "zh" | "en";
        query: string;
        caseFrame: Record<string, unknown>;
        references: Array<Record<string, unknown>>;
      },
      idempotencyKey: string,
      runtime?: OpenClawRuntimeContext
    ) => Promise<{ primary_ids: string[]; supplemental_ids: string[]; rejected_ids: string[] }>;
    runJsonPrompt: (prompt: string) => Promise<unknown>;
  };

  adapter.runJsonPrompt = async () => ({
    primary_ids: [],
    supplemental_ids: []
  });

  const selection = await adapter.selectSupportEvidence(
    {
      contextType: "search",
      language: "en",
      query: "Why does this behavior happen?",
      caseFrame: {
        goal: "behavior explanation",
        symptom: "unexpected behavior",
        object: "query execution",
        action_type: "why",
        deployment_model: "shared",
        product_area: "onesql",
        constraints: [],
        missing_critical_info: [],
        retrieval_queries: ["behavior explanation"]
      },
      references: [
        {
          documentId: "doc:onesql",
          evidenceId: "chunk:onesql-root",
          title: "Execute ONESQL query",
          snippet: "General overview.",
          sourceUrl: "https://docs.ones.com/openapi/onesql",
          path: "open-docs/docs/openapi/api/execute-onesql.api.mdx",
          headingPath: "ROOT",
          score: 0.8,
          retrievedAt: "2026-04-08T08:00:00.000Z"
        },
        {
          documentId: "doc:onesql",
          evidenceId: "chunk:onesql-order-by",
          title: "Execute ONESQL query",
          snippet: "ORDER BY and GROUP BY are supported.",
          sourceUrl: "https://docs.ones.com/openapi/onesql#query-syntax",
          path: "open-docs/docs/openapi/api/execute-onesql.api.mdx",
          headingPath: "Query syntax",
          score: 0.79,
          retrievedAt: "2026-04-08T08:00:00.000Z"
        }
      ]
    },
    "ws-adapter:evidence-selector-rejected-fallback"
  );

  assert.deepEqual(selection.rejected_ids, ["chunk:onesql-root", "chunk:onesql-order-by"]);
});

test("judgeSupportAnswer loads the external evidence judge contract", async () => {
  const adapter = new WsOpenClawAdapter() as never as {
    judgeSupportAnswer: (
      input: {
        contextType: "search" | "triage";
        language: "zh" | "en";
        query: string;
        caseFrame: Record<string, unknown>;
        evidenceBundle: Record<string, unknown>;
        draftSupportAnswer?: Record<string, unknown>;
      },
      idempotencyKey: string,
      runtime?: OpenClawRuntimeContext
    ) => Promise<{
      verdict: string;
    }>;
    runJsonPrompt: (prompt: string) => Promise<unknown>;
    parseVerificationResult: (input: unknown) => { verdict: string };
  };
  let capturedPrompt = "";

  adapter.runJsonPrompt = async (prompt) => {
    capturedPrompt = prompt;
    return {
      verdict: "verified",
      summary: "verified",
      unsupported_claims: [],
      missing_info: [],
      verified_citation_ids: ["chunk:callback-mismatch"],
      display_citation_ids: ["chunk:callback-mismatch"],
      verified_claims: ["Callback URL mismatch causes the integration to fail."],
      claim_to_citation_map: []
    };
  };
  adapter.parseVerificationResult = (input) => input as { verdict: string };

  const result = await adapter.judgeSupportAnswer(
    {
      contextType: "search",
      language: "en",
      query: "GitHub callback keeps failing after OAuth setup",
      caseFrame: {
        goal: "Diagnose the failing callback flow.",
        symptom: "GitHub callback returns an error after setup.",
        object: "GitHub callback",
        action_type: "troubleshooting",
        deployment_model: "shared",
        product_area: "integrations",
        constraints: [],
        missing_critical_info: [],
        retrieval_queries: ["github callback troubleshooting"],
        question_type: "troubleshooting",
        specialist_agent: "troubleshooting-specialist",
        primary_domain: "integrations"
      },
      evidenceBundle: {
        primary: [],
        supplemental: [],
        confidence: 0.98,
        fallbackUsed: false,
        resolvedQueries: ["github callback troubleshooting"],
        evidence_gaps: []
      },
      draftSupportAnswer: {
        direct_answer: "The most likely documented cause is a callback URL mismatch.",
        claims: [],
        next_actions: [],
        unknowns: [],
        escalation_needed: false
      }
    },
    "ws-adapter:evidence-judge-contract"
  );

  assert.match(capturedPrompt, /Support Evidence Judge Contract/);
  assert.equal(result.verdict, "verified");
});

test("composeCustomerAnswer loads the external answer composer contract", async () => {
  const adapter = new WsOpenClawAdapter() as never as {
    composeCustomerAnswer: (
      input: {
        language: "zh" | "en";
        mode: "grounded" | "partial" | "clarification" | "handoff";
        query: string;
        route: Record<string, unknown>;
        caseFrame: Record<string, unknown>;
        draftSupportAnswer: Record<string, unknown>;
        supportedClaims: Array<{ text: string; kind: string }>;
        nextActions: string[];
        unknowns: string[];
      },
      idempotencyKey: string,
      runtime?: OpenClawRuntimeContext
    ) => Promise<{
      direct_answer: string;
      sections: unknown[];
      why: string[];
      what_to_do_now: string[];
      still_need_to_confirm: string[];
      suppress_still_need_to_confirm: boolean;
    }>;
    runJsonPrompt: (prompt: string) => Promise<unknown>;
  };
  let capturedPrompt = "";

  adapter.runJsonPrompt = async (prompt) => {
    capturedPrompt = prompt;
    return {
      question_type: "troubleshooting",
      render_variant: "troubleshooting",
      direct_answer: "The most likely documented cause is a callback URL mismatch.",
      sections: [],
      why: ["The troubleshooting guide explicitly points to callback URL mismatch."],
      what_to_do_now: ["Compare the redirect URI in ONES with the provider callback URL."],
      still_need_to_confirm: [],
      suppress_still_need_to_confirm: true
    };
  };

  const result = await adapter.composeCustomerAnswer(
    {
      language: "en",
      mode: "grounded",
      query: "GitHub callback keeps failing after OAuth setup",
      route: {
        question_type: "troubleshooting",
        specialist_agent: "troubleshooting-specialist",
        primary_domain: "integrations"
      },
      caseFrame: {
        product_area: "integrations",
        primary_domain: "integrations"
      },
      draftSupportAnswer: {
        question_type: "troubleshooting",
        render_variant: "troubleshooting",
        direct_answer: "The most likely documented cause is a callback URL mismatch.",
        claims: [],
        next_actions: ["Compare the redirect URI in ONES with the provider callback URL."],
        unknowns: [],
        escalation_needed: false
      },
      supportedClaims: [
        {
          text: "The troubleshooting guide explicitly points to callback URL mismatch.",
          kind: "verified_fact"
        }
      ],
      nextActions: ["Compare the redirect URI in ONES with the provider callback URL."],
      unknowns: []
    },
    "ws-adapter:answer-composer-contract"
  );

  assert.match(capturedPrompt, /Support Answer Composer/);
  assert.equal(result.direct_answer, "The most likely documented cause is a callback URL mismatch.");
});

test("buildConnectParams includes a nonce-signed device payload for the live gateway", () => {
  const adapter = new WsOpenClawAdapter() as never as {
    buildConnectParams: (input: {
      connectNonce: string;
      instanceSuffix?: string;
      userAgent: string;
    }) => {
      client: { id: string; mode: string; instanceId: string };
      role: string;
      scopes: string[];
      auth?: Record<string, unknown>;
      device: {
        id: string;
        publicKey: string;
        signature: string;
        signedAt: number;
        nonce: string;
      };
    };
  };

  const params = adapter.buildConnectParams({
    connectNonce: "nonce-live-1",
    instanceSuffix: "health",
    userAgent: "ticket-core-health"
  });

  assert.equal(params.client.id, "gateway-client");
  assert.equal(params.client.mode, "backend");
  assert.equal(params.client.instanceId.endsWith("-health"), true);
  assert.equal(params.role, "operator");
  assert.equal(params.scopes.includes("operator.admin"), true);
  assert.equal(typeof params.auth, "object");
  assert.equal(typeof params.device.id, "string");
  assert.equal(typeof params.device.publicKey, "string");
  assert.equal(typeof params.device.signature, "string");
  assert.equal(params.device.nonce, "nonce-live-1");
  assert.equal(typeof params.device.signedAt, "number");
});

test("buildConnectParams prefers device-token auth when OPENCLAW_DEVICE_TOKEN is present", () => {
  const original = process.env.OPENCLAW_DEVICE_TOKEN;
  process.env.OPENCLAW_DEVICE_TOKEN = "device-token-123";

  try {
    const adapter = new WsOpenClawAdapter() as never as {
      buildConnectParams: (input: {
        connectNonce: string;
        userAgent: string;
      }) => {
        auth?: Record<string, unknown>;
      };
    };

    const params = adapter.buildConnectParams({
      connectNonce: "nonce-live-2",
      userAgent: "ticket-core"
    });

    assert.deepEqual(params.auth, {
      deviceToken: "device-token-123"
    });
  } finally {
    if (original === undefined) delete process.env.OPENCLAW_DEVICE_TOKEN;
    else process.env.OPENCLAW_DEVICE_TOKEN = original;
  }
});

test("callMethod retries once without device-token auth after a stale device token mismatch", async () => {
  const adapter = new WsOpenClawAdapter() as never as {
    callMethod: (method: string, params: Record<string, unknown>, timeoutMs?: number) => Promise<unknown>;
    callMethodOnce: (
      method: string,
      params: Record<string, unknown>,
      timeoutMs: number,
      options: { preferDeviceToken: boolean }
    ) => Promise<unknown>;
    clearStoredDeviceToken: () => void;
  };
  const attempts: boolean[] = [];
  let cleared = 0;

  adapter.callMethodOnce = async (_method, _params, _timeoutMs, options) => {
    attempts.push(options.preferDeviceToken);
    if (options.preferDeviceToken) {
      throw new Error("OpenClaw connect failed: unauthorized: device token mismatch (rotate/reissue device token)");
    }
    return { ok: true };
  };
  adapter.clearStoredDeviceToken = () => {
    cleared += 1;
  };

  const result = await adapter.callMethod("agents.list", {}, 2_000);

  assert.deepEqual(attempts, [true, false]);
  assert.equal(cleared, 1);
  assert.deepEqual(result, { ok: true });
});

test("connectOnly retries once without device-token auth after a stale device token mismatch", async () => {
  const adapter = new WsOpenClawAdapter() as never as {
    connectOnly: () => Promise<void>;
    connectOnlyOnce: (options: { preferDeviceToken: boolean }) => Promise<void>;
    clearStoredDeviceToken: () => void;
  };
  const attempts: boolean[] = [];
  let cleared = 0;

  adapter.connectOnlyOnce = async (options) => {
    attempts.push(options.preferDeviceToken);
    if (options.preferDeviceToken) {
      throw new Error("OpenClaw health connect failed: unauthorized: device token mismatch (rotate/reissue device token)");
    }
  };
  adapter.clearStoredDeviceToken = () => {
    cleared += 1;
  };

  await adapter.connectOnly();

  assert.deepEqual(attempts, [true, false]);
  assert.equal(cleared, 1);
});

test("callMethod retries once without device-token auth when gateway returns 403", async () => {
  const adapter = new WsOpenClawAdapter() as never as {
    callMethod: (method: string, params: Record<string, unknown>, timeoutMs?: number) => Promise<unknown>;
    callMethodOnce: (
      method: string,
      params: Record<string, unknown>,
      timeoutMs: number,
      options: { preferDeviceToken: boolean }
    ) => Promise<unknown>;
    clearStoredDeviceToken: () => void;
  };
  const attempts: boolean[] = [];
  let cleared = 0;

  adapter.callMethodOnce = async (_method, _params, _timeoutMs, options) => {
    attempts.push(options.preferDeviceToken);
    if (options.preferDeviceToken) {
      throw new Error("OpenClaw agent.run failed: 403 status code (no body)");
    }
    return { ok: true };
  };
  adapter.clearStoredDeviceToken = () => {
    cleared += 1;
  };

  const result = await adapter.callMethod("agent.run", {}, 2_000);

  assert.deepEqual(attempts, [true, false]);
  assert.equal(cleared, 1);
  assert.deepEqual(result, { ok: true });
});

test("connectOnly retries once without device-token auth when gateway returns forbidden", async () => {
  const adapter = new WsOpenClawAdapter() as never as {
    connectOnly: () => Promise<void>;
    connectOnlyOnce: (options: { preferDeviceToken: boolean }) => Promise<void>;
    clearStoredDeviceToken: () => void;
  };
  const attempts: boolean[] = [];
  let cleared = 0;

  adapter.connectOnlyOnce = async (options) => {
    attempts.push(options.preferDeviceToken);
    if (options.preferDeviceToken) {
      throw new Error("OpenClaw health connect failed: forbidden");
    }
  };
  adapter.clearStoredDeviceToken = () => {
    cleared += 1;
  };

  await adapter.connectOnly();

  assert.deepEqual(attempts, [true, false]);
  assert.equal(cleared, 1);
});
