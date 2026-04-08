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

test("runSupportMainAgent parses structured references and claim reference ids", async () => {
  const adapter = new WsOpenClawAdapter() as never as {
    runSupportMainAgent: (
      input: {
        contextType: "search" | "triage";
        language: "zh" | "en";
        query: string;
        conversationHistory?: Array<{ role: "user" | "assistant"; content: string }>;
        knowledgeScope?: {
          knowledgeSpace?: string;
          repoId?: string;
          branch?: string;
        };
      },
      idempotencyKey: string,
      runtime?: OpenClawRuntimeContext
    ) => Promise<{
      route: {
        question_type: string;
        specialist_agent: string;
      };
      caseFrame: {
        object: string;
      };
      draftAnswer: {
        claims: Array<{ text: string; reference_ids: string[] }>;
      };
      references: Array<{ reference_id: string; sourceUrl: string }>;
      retrievalQueries: string[];
    }>;
    runJsonPrompt: (prompt: string) => Promise<unknown>;
  };
  let capturedPrompt = "";

  adapter.runJsonPrompt = async (prompt) => {
    capturedPrompt = prompt;
    return {
      route: {
        question_type: "api_scope_auth",
        user_goal: "Find the required scope for the issue comment API.",
        answer_contract: "Return the exact scope first.",
        specialist_agent: "api-specialist",
        routing_confidence: 0.94
      },
      case_frame: {
        goal: "Find the required scope for the issue comment API.",
        symptom: "Scope lookup",
        object: "issue comment API",
        action_type: "lookup",
        deployment_model: "shared",
        product_area: "openapi",
        constraints: [],
        missing_critical_info: [],
        retrieval_queries: ["issue comment api scope"]
      },
      draft_answer: {
        question_type: "api_scope_auth",
        render_variant: "api",
        direct_answer: "Use the scope documented for the issue comment API.",
        claims: [
          {
            text: "The issue comment API requires the documented comment scope.",
            kind: "verified_fact",
            reference_ids: ["ref-issue-comment-scope"],
            authority: "canonical"
          }
        ],
        next_actions: ["Use the documented scope value in the access token."],
        unknowns: [],
        escalation_needed: false,
        auth_scope: ["write:project"]
      },
      references: [
        {
          reference_id: "ref-issue-comment-scope",
          title: "Add issue comment",
          snippet: "Scope: write:project",
          sourceUrl: "https://docs.ones.com/openapi/add-issue-comment",
          path: "open-docs/docs/openapi/api/add-issue-comment.api.mdx",
          headingPath: "Permissions"
        }
      ],
      retrieval_queries: ["issue comment api scope"]
    };
  };

  const result = await adapter.runSupportMainAgent(
    {
      contextType: "search",
      language: "en",
      query: "What scope is required for the issue comment API?",
      knowledgeScope: {
        knowledgeSpace: "support-preview"
      }
    },
    "ws-adapter:support-main"
  );

  assert.match(capturedPrompt, /reference_id/);
  assert.match(capturedPrompt, /reference_ids/);
  assert.match(capturedPrompt, /knowledge_scope/);
  assert.equal(result.route.question_type, "api_scope_auth");
  assert.equal(result.caseFrame.object, "issue comment API");
  assert.deepEqual(result.draftAnswer.claims[0]?.reference_ids, ["ref-issue-comment-scope"]);
  assert.equal(result.references[0]?.reference_id, "ref-issue-comment-scope");
  assert.deepEqual(result.retrievalQueries, ["issue comment api scope"]);
});
