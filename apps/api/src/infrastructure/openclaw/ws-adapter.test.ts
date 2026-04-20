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
    'vercel env add OPENCLAW_AGENT_ID_SUPPORT_MAIN preview "$branch" --value support-main --yes --force >/dev/null\necho synced:OPENCLAW_AGENT_ID_SUPPORT_MAIN';
  process.env.VERCEL_ENV = "preview";
  process.env.VERCEL_GIT_COMMIT_REF = "feature/support-single-agent-runtime-20260408";

  try {
    const summary = summarizeOpenClawWsRuntimeConfigForLog();
    assert.equal(summary.processEnvPresent, true);
    assert.equal(summary.processEnvPreview.includes("\n"), false);
    assert.match(summary.processEnvPreview, /vercel env add OPENCLAW_AGENT_ID_SUPPORT_MAIN preview/);
    assert.match(summary.processEnvPreview, /echo synced:OPENCLAW_AGENT_ID_SUPPORT_MAIN/);
    assert.equal(summary.vercelEnv, "preview");
    assert.equal(summary.gitRef, "feature/support-single-agent-runtime-20260408");
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

test("planSupportMainAgent parses route, case frame, and retrieval queries without requiring draft output", async () => {
  const adapter = new WsOpenClawAdapter() as never as {
    planSupportMainAgent: (
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
        routing_confidence: 0.94,
        primary_domain: "openapi"
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
      retrieval_queries: ["issue comment api scope"]
    };
  };

  const result = await adapter.planSupportMainAgent(
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

  assert.match(capturedPrompt, /retrieval_queries/);
  assert.match(capturedPrompt, /knowledge_scope/);
  assert.doesNotMatch(capturedPrompt, /draft_answer/);
  assert.equal(result.route.question_type, "api_scope_auth");
  assert.equal(result.caseFrame.object, "issue comment API");
  assert.deepEqual(result.retrievalQueries, ["issue comment api scope"]);
});

test("planSupportDispatch parses primary domain, route, case frame, and retrieval queries for the supervisor runtime", async () => {
  const adapter = new WsOpenClawAdapter() as never as {
    planSupportDispatch: (
      input: {
        contextType: "search" | "triage";
        language: "zh" | "en";
        query: string;
      },
      idempotencyKey: string,
      runtime?: OpenClawRuntimeContext
    ) => Promise<{
      primaryDomain: string;
      route: {
        question_type: string;
      };
      caseFrame: {
        product_area: string;
      };
      retrievalQueries: string[];
    }>;
    runJsonPrompt: (prompt: string) => Promise<unknown>;
  };
  let capturedPrompt = "";

  adapter.runJsonPrompt = async (prompt) => {
    capturedPrompt = prompt;
    return {
      primary_domain: "deployment",
      route: {
        question_type: "config_setup",
        user_goal: "Reset the administrator password in a private deployment.",
        answer_contract: "Give the direct recovery steps first.",
        specialist_agent: "howto-specialist",
        routing_confidence: 0.93,
        primary_domain: "deployment"
      },
      case_frame: {
        goal: "Reset the administrator password in a private deployment.",
        symptom: "Administrator password reset is blocked.",
        object: "administrator password reset",
        action_type: "recovery",
        deployment_model: "private_deployment",
        product_area: "deployment",
        constraints: [],
        missing_critical_info: [],
        retrieval_queries: ["private deployment administrator password reset"],
        required_doc_kinds: ["deployment_runbook", "product_guide"]
      },
      retrieval_queries: ["private deployment administrator password reset"]
    };
  };

  const result = await adapter.planSupportDispatch(
    {
      contextType: "search",
      language: "en",
      query: "How do I reset the administrator password in a private deployment?"
    },
    "ws-adapter:domain-dispatch"
  );

  assert.match(capturedPrompt, /primary_domain/);
  assert.match(capturedPrompt, /retrieval_queries/);
  assert.match(capturedPrompt, /do not:\s*[\s\S]*draft the answer/i);
  assert.equal(result.primaryDomain, "deployment");
  assert.equal(result.route.question_type, "config_setup");
  assert.equal(result.caseFrame.product_area, "deployment");
  assert.deepEqual(result.retrievalQueries, ["private deployment administrator password reset"]);
});

test("planSupportExecution loads the external supervisor contract and preserves integrations domain framing", async () => {
  const adapter = new WsOpenClawAdapter() as never as {
    planSupportExecution: (
      input: {
        contextType: "search" | "triage";
        language: "zh" | "en";
        query: string;
      },
      idempotencyKey: string,
      runtime?: OpenClawRuntimeContext
    ) => Promise<{
      route: {
        question_type: string;
        primary_domain?: string;
      };
      caseFrame: {
        product_area: string;
        primary_domain?: string;
      };
      evidencePlan: {
        required_doc_kinds: string[];
      };
    }>;
    runJsonPrompt: (prompt: string) => Promise<unknown>;
  };
  let capturedPrompt = "";

  adapter.runJsonPrompt = async (prompt) => {
    capturedPrompt = prompt;
    return {
      primary_domain: "integrations",
      route: {
        question_type: "troubleshooting",
        user_goal: "Diagnose the failing GitHub callback flow.",
        answer_contract: "Start with the likely cause and the checks to run now.",
        specialist_agent: "troubleshooting-specialist",
        routing_confidence: 0.92,
        primary_domain: "integrations"
      },
      case_frame: {
        goal: "Diagnose the failing GitHub callback flow.",
        symptom: "GitHub callback returns page not found after setup.",
        object: "GitHub callback",
        action_type: "troubleshooting",
        deployment_model: "shared",
        product_area: "integrations",
        constraints: [],
        missing_critical_info: [],
        retrieval_queries: ["github callback page not found"],
        required_doc_kinds: ["troubleshooting", "product_guide"]
      },
      evidence_plan: {
        query_plan: {
          concept_queries: ["github callback"],
          object_queries: ["redirect uri"],
          behavior_queries: ["page not found"]
        },
        evidence_priority: ["integration_troubleshooting", "callback_config"],
        required_doc_kinds: ["troubleshooting", "product_guide"],
        retrieval_rounds: 1,
        allow_refinement: false,
        stop_after_grounded_evidence: true
      }
    };
  };

  const result = await adapter.planSupportExecution(
    {
      contextType: "search",
      language: "en",
      query: "GitHub OAuth callback returns page not found after setup"
    },
    "ws-adapter:support-execution-contracts"
  );

  assert.match(capturedPrompt, /Support Supervisor Contract/);
  assert.match(capturedPrompt, /primary_domain/);
  assert.equal(result.route.primary_domain, "integrations");
  assert.equal(result.caseFrame.primary_domain, "integrations");
  assert.deepEqual(result.evidencePlan.required_doc_kinds, ["troubleshooting", "product_guide"]);
});

test("draftSupportMainAgent parses claim reference ids from provided evidence without triggering retrieval", async () => {
  const adapter = new WsOpenClawAdapter() as never as {
    draftSupportMainAgent: (
      input: {
        contextType: "search" | "triage";
        language: "zh" | "en";
        query: string;
        route: Record<string, unknown>;
        caseFrame: Record<string, unknown>;
        providedEvidence: Array<{
          reference_id: string;
          evidence_id: string;
          title: string;
          snippet: string;
          sourceUrl: string;
        }>;
      },
      idempotencyKey: string,
      runtime?: OpenClawRuntimeContext
    ) => Promise<{
      draftAnswer: {
        claims: Array<{ text: string; reference_ids: string[] }>;
      };
    }>;
    runJsonPrompt: (prompt: string) => Promise<unknown>;
  };
  let capturedPrompt = "";

  adapter.runJsonPrompt = async (prompt) => {
    capturedPrompt = prompt;
    return {
      draft_answer: {
        question_type: "api_scope_auth",
        render_variant: "api",
        direct_answer: "Use write:project for the issue comment API.",
        claims: [
          {
            text: "The issue comment API requires write:project.",
            kind: "verified_fact",
            reference_ids: ["ref-issue-comment-scope"],
            authority: "canonical"
          }
        ],
        next_actions: ["Use write:project in the access token."],
        unknowns: [],
        escalation_needed: false,
        auth_scope: ["write:project"]
      }
    };
  };

  const result = await adapter.draftSupportMainAgent(
    {
      contextType: "search",
      language: "en",
      query: "What scope is required for the issue comment API?",
      route: {
        question_type: "api_scope_auth",
        user_goal: "Find the required scope for the issue comment API.",
        answer_contract: "Return the exact scope first.",
        specialist_agent: "api-specialist",
        routing_confidence: 0.94
      },
      caseFrame: {
        goal: "Find the required scope for the issue comment API.",
        symptom: "Scope lookup",
        object: "issue comment API",
        action_type: "lookup",
        deployment_model: "shared",
        product_area: "openapi",
        constraints: [],
        missing_critical_info: [],
        retrieval_queries: ["issue comment api scope"],
        question_type: "api_scope_auth",
        specialist_agent: "api-specialist",
        answer_contract: "Return the exact scope first.",
        routing_confidence: 0.94
      },
      providedEvidence: [
        {
          reference_id: "ref-issue-comment-scope",
          evidence_id: "chunk:comment-scope",
          title: "Add issue comment",
          snippet: "Scope: write:project",
          sourceUrl: "https://docs.ones.com/openapi/add-issue-comment"
        }
      ]
    },
    "ws-adapter:support-main:draft"
  );

  assert.match(capturedPrompt, /provided_evidence/);
  assert.match(capturedPrompt, /reference_id/);
  assert.match(capturedPrompt, /evidence_id/);
  assert.match(capturedPrompt, /Do not retrieve/i);
  assert.deepEqual(result.draftAnswer.claims[0]?.reference_ids, ["ref-issue-comment-scope"]);
});

test("writeDeploymentDomainAnswer parses evidence ids from provided evidence without triggering retrieval", async () => {
  const adapter = new WsOpenClawAdapter() as never as {
    writeDeploymentDomainAnswer: (
      input: {
        contextType: "search" | "triage";
        language: "zh" | "en";
        query: string;
        route: Record<string, unknown>;
        caseFrame: Record<string, unknown>;
        evidenceBundle: {
          primary: Array<Record<string, unknown>>;
          supplemental: Array<Record<string, unknown>>;
        };
      },
      idempotencyKey: string,
      runtime?: OpenClawRuntimeContext
    ) => Promise<{
      render_variant: string;
      claims: Array<{ text: string; evidence_ids: string[] }>;
    }>;
    runJsonPrompt: (prompt: string) => Promise<unknown>;
  };
  let capturedPrompt = "";

  adapter.runJsonPrompt = async (prompt) => {
    capturedPrompt = prompt;
    return {
      question_type: "config_setup",
      render_variant: "how_to",
      direct_answer: "Reset the administrator password from the documented private-deployment recovery path.",
      claims: [
        {
          text: "The deployment recovery guide documents the administrator password reset path.",
          kind: "verified_fact",
          evidence_ids: ["chunk:deployment-reset"],
          authority: "canonical"
        }
      ],
      next_actions: ["Follow the documented recovery steps."],
      unknowns: [],
      escalation_needed: false,
      steps: ["Open the private deployment recovery flow."],
      prerequisites: ["Administrator host access"],
      limits_or_notes: ["Do not rely on email reset when SMTP is unavailable."]
    };
  };

  const result = await adapter.writeDeploymentDomainAnswer(
    {
      contextType: "search",
      language: "en",
      query: "How do I reset the administrator password in a private deployment?",
      route: {
        question_type: "config_setup",
        user_goal: "Reset the administrator password in a private deployment.",
        answer_contract: "Give the direct recovery steps first.",
        specialist_agent: "howto-specialist",
        routing_confidence: 0.93,
        primary_domain: "deployment"
      },
      caseFrame: {
        goal: "Reset the administrator password in a private deployment.",
        symptom: "Administrator password reset is blocked.",
        object: "administrator password reset",
        action_type: "recovery",
        deployment_model: "private_deployment",
        product_area: "deployment",
        constraints: [],
        missing_critical_info: [],
        retrieval_queries: ["private deployment administrator password reset"],
        question_type: "config_setup",
        specialist_agent: "howto-specialist",
        primary_domain: "deployment"
      },
      evidenceBundle: {
        primary: [
          {
            documentId: "doc:deployment-reset",
            evidenceId: "chunk:deployment-reset",
            title: "Deployment recovery",
            snippet: "Use the deployment recovery path to reset the administrator password.",
            sourceUrl: "https://docs.ones.com/private-deployment/recovery",
            path: "docs/private-deployment/recovery.mdx",
            headingPath: "Administrator recovery",
            authority: "canonical_visible",
            sourceType: "github_kb",
            score: 0.99,
            retrievedAt: "2026-04-09T02:00:00.000Z"
          }
        ],
        supplemental: []
      }
    },
    "ws-adapter:deployment-domain"
  );

  assert.match(capturedPrompt, /provided_evidence/);
  assert.match(capturedPrompt, /Do not retrieve/i);
  assert.equal(result.render_variant, "how_to");
  assert.deepEqual(result.claims[0]?.evidence_ids, ["chunk:deployment-reset"]);
});

test("writeDeploymentDomainAnswer routes deployment capability questions through the behavior specialist contract", async () => {
  const adapter = new WsOpenClawAdapter() as never as {
    writeDeploymentDomainAnswer: (
      input: {
        contextType: "search" | "triage";
        language: "zh" | "en";
        query: string;
        route: Record<string, unknown>;
        caseFrame: Record<string, unknown>;
        evidenceBundle: {
          primary: Array<Record<string, unknown>>;
          supplemental: Array<Record<string, unknown>>;
        };
      },
      idempotencyKey: string,
      runtime?: OpenClawRuntimeContext
    ) => Promise<{
      render_variant: string;
      claims: Array<{ text: string; evidence_ids: string[] }>;
      most_likely_explanation?: string;
      confirmed_facts?: string[];
      what_to_check_next?: string[];
    }>;
    runJsonPrompt: (prompt: string, idempotencyKey: string) => Promise<unknown>;
  };
  let capturedPrompt = "";
  let capturedIdempotencyKey = "";

  adapter.runJsonPrompt = async (prompt, callIdempotencyKey) => {
    capturedPrompt = prompt;
    capturedIdempotencyKey = callIdempotencyKey;
    return {
      question_type: "capability_confirmation",
      render_variant: "behavior",
      direct_answer: "The deployment docs describe a unified topology by default.",
      claims: [
        {
          text: "The deployment guide describes the self-hosted topology as unified by default.",
          kind: "verified_fact",
          evidence_ids: ["chunk:deployment-topology"],
          authority: "canonical"
        }
      ],
      next_actions: ["Plan capacity on the assumption of a unified deployment topology first."],
      unknowns: [],
      escalation_needed: false,
      most_likely_explanation: "The current deployment docs describe a unified topology rather than independent service chains.",
      confirmed_facts: ["The deployment guide describes the self-hosted topology as unified by default."],
      what_to_check_next: ["Check whether storage or database externalization is documented for the target environment."]
    };
  };

  const result = await adapter.writeDeploymentDomainAnswer(
    {
      contextType: "search",
      language: "en",
      query: "Can requirements and issues use isolated backend services in self-hosted deployment?",
      route: {
        question_type: "capability_confirmation",
        user_goal: "Understand the supported self-hosted deployment topology.",
        answer_contract: "State the documented architecture first.",
        specialist_agent: "behavior-specialist",
        routing_confidence: 0.93,
        primary_domain: "deployment"
      },
      caseFrame: {
        goal: "Understand the supported self-hosted deployment topology.",
        symptom: "Need to know whether requirements and issues can be isolated.",
        object: "self-hosted deployment topology",
        action_type: "capability_confirmation",
        deployment_model: "private_deployment",
        product_area: "deployment",
        constraints: [],
        missing_critical_info: [],
        retrieval_queries: ["self-hosted deployment architecture isolation"],
        question_type: "capability_confirmation",
        specialist_agent: "behavior-specialist",
        primary_domain: "deployment"
      },
      evidenceBundle: {
        primary: [
          {
            documentId: "doc:deployment-topology",
            evidenceId: "chunk:deployment-topology",
            title: "Deployment architecture",
            snippet: "ONES self-hosted deployment uses a unified topology by default.",
            sourceUrl: "https://docs.ones.com/private-deployment/architecture",
            path: "docs/private-deployment/architecture.mdx",
            headingPath: "Topology",
            authority: "canonical_visible",
            sourceType: "github_kb",
            score: 0.99,
            retrievedAt: "2026-04-10T02:20:00.000Z"
          }
        ],
        supplemental: []
      }
    },
    "ws-adapter:deployment-domain-behavior"
  );

  assert.match(capturedPrompt, /most_likely_explanation/);
  assert.match(capturedPrompt, /confirmed_facts/);
  assert.match(capturedPrompt, /what_to_check_next/);
  assert.match(capturedPrompt, /Support Deploy Docs Agent Contract/);
  assert.match(capturedPrompt, /deployment architecture, topology, isolation, externalization/i);
  assert.match(capturedIdempotencyKey, /behavior-specialist(?::schema-attempt-\d+)?$/);
  assert.equal(result.render_variant, "behavior");
  assert.deepEqual(result.claims[0]?.evidence_ids, ["chunk:deployment-topology"]);
  assert.equal(
    result.most_likely_explanation,
    "The current deployment docs describe a unified topology rather than independent service chains."
  );
  assert.deepEqual(result.confirmed_facts, ["The deployment guide describes the self-hosted topology as unified by default."]);
  assert.deepEqual(result.what_to_check_next, [
    "Check whether storage or database externalization is documented for the target environment."
  ]);
});

test("writeDocsDomainAnswer supports troubleshooting fields from provided evidence without triggering retrieval", async () => {
  const adapter = new WsOpenClawAdapter() as never as {
    writeDocsDomainAnswer: (
      input: {
        contextType: "search" | "triage";
        language: "zh" | "en";
        query: string;
        route: Record<string, unknown>;
        caseFrame: Record<string, unknown>;
        evidenceBundle: {
          primary: Array<Record<string, unknown>>;
          supplemental: Array<Record<string, unknown>>;
        };
      },
      idempotencyKey: string,
      runtime?: OpenClawRuntimeContext
    ) => Promise<{
      render_variant: string;
      claims: Array<{ text: string; evidence_ids: string[] }>;
      most_likely_causes?: string[];
      recommended_checks?: string[];
      required_followup_info?: string[];
      when_to_handoff?: string;
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
      claims: [
        {
          text: "The callback troubleshooting guide states that callback URL mismatch causes the integration to fail.",
          kind: "verified_fact",
          evidence_ids: ["chunk:callback-mismatch"],
          authority: "canonical"
        }
      ],
      next_actions: ["Compare the redirect URI in ONES with the callback URL registered in the provider."],
      unknowns: [],
      escalation_needed: false,
      most_likely_causes: ["Callback URL mismatch between ONES and the provider registration."],
      recommended_checks: ["Compare the redirect URI in ONES with the provider-side callback URL."],
      required_followup_info: ["The exact redirect URI configured in ONES and in the provider console."],
      when_to_handoff: "Escalate only if both callback URLs match and the issue still reproduces."
    };
  };

  const result = await adapter.writeDocsDomainAnswer(
    {
      contextType: "search",
      language: "en",
      query: "GitHub callback keeps failing after OAuth setup",
      route: {
        question_type: "troubleshooting",
        user_goal: "Diagnose the failing callback flow.",
        answer_contract: "Start with the most likely documented cause and the checks to run now.",
        specialist_agent: "troubleshooting-specialist",
        routing_confidence: 0.91,
        primary_domain: "docs"
      },
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
        primary_domain: "docs"
      },
      evidenceBundle: {
        primary: [
          {
            documentId: "doc:callback-troubleshooting",
            evidenceId: "chunk:callback-mismatch",
            title: "GitHub callback troubleshooting",
            snippet: "Callback URL mismatch causes the integration to fail.",
            sourceUrl: "https://docs.ones.com/integrations/github/callback-troubleshooting",
            path: "docs/integrations/github/callback-troubleshooting.mdx",
            headingPath: "Most common cause",
            authority: "canonical_visible",
            sourceType: "github_kb",
            score: 0.99,
            retrievedAt: "2026-04-10T02:00:00.000Z"
          }
        ],
        supplemental: []
      }
    },
    "ws-adapter:docs-domain-troubleshooting"
  );

  assert.match(capturedPrompt, /provided_evidence/);
  assert.match(capturedPrompt, /Do not retrieve/i);
  assert.match(capturedPrompt, /most_likely_causes/);
  assert.match(capturedPrompt, /recommended_checks/);
  assert.match(capturedPrompt, /required_followup_info/);
  assert.equal(result.render_variant, "troubleshooting");
  assert.deepEqual(result.claims[0]?.evidence_ids, ["chunk:callback-mismatch"]);
  assert.deepEqual(result.most_likely_causes, ["Callback URL mismatch between ONES and the provider registration."]);
  assert.deepEqual(result.recommended_checks, ["Compare the redirect URI in ONES with the provider-side callback URL."]);
  assert.deepEqual(result.required_followup_info, ["The exact redirect URI configured in ONES and in the provider console."]);
});

test("writeDocsDomainAnswer loads the integrations contract when the routed domain is integrations", async () => {
  const adapter = new WsOpenClawAdapter() as never as {
    writeDocsDomainAnswer: (
      input: {
        contextType: "search" | "triage";
        language: "zh" | "en";
        query: string;
        route: {
          question_type: string;
          user_goal: string;
          answer_contract: string;
          specialist_agent: "api-specialist" | "howto-specialist" | "behavior-specialist" | "troubleshooting-specialist";
          routing_confidence: number;
          primary_domain?: string;
        };
        caseFrame: Record<string, unknown>;
        evidenceBundle: Record<string, unknown>;
      },
      idempotencyKey: string,
      runtime?: OpenClawRuntimeContext
    ) => Promise<{
      render_variant: string;
      claims: Array<{ evidence_ids: string[] }>;
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
      claims: [
        {
          text: "The callback troubleshooting guide states that callback URL mismatch causes the integration to fail.",
          kind: "verified_fact",
          evidence_ids: ["chunk:callback-mismatch"],
          authority: "canonical"
        }
      ],
      next_actions: ["Compare the redirect URI in ONES with the callback URL registered in the provider."],
      unknowns: [],
      escalation_needed: false
    };
  };

  const result = await adapter.writeDocsDomainAnswer(
    {
      contextType: "search",
      language: "en",
      query: "GitHub callback keeps failing after OAuth setup",
      route: {
        question_type: "troubleshooting",
        user_goal: "Diagnose the failing callback flow.",
        answer_contract: "Start with the most likely documented cause and the checks to run now.",
        specialist_agent: "troubleshooting-specialist",
        routing_confidence: 0.91,
        primary_domain: "integrations"
      },
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
        primary: [
          {
            documentId: "doc:callback-troubleshooting",
            evidenceId: "chunk:callback-mismatch",
            title: "GitHub callback troubleshooting",
            snippet: "Callback URL mismatch causes the integration to fail.",
            sourceUrl: "https://docs.ones.com/integrations/github/callback-troubleshooting",
            path: "docs/integrations/github/callback-troubleshooting.mdx",
            headingPath: "Most common cause",
            authority: "canonical_visible",
            sourceType: "github_kb",
            score: 0.99,
            retrievedAt: "2026-04-10T02:00:00.000Z"
          }
        ],
        supplemental: []
      }
    },
    "ws-adapter:integrations-domain-contract"
  );

  assert.match(capturedPrompt, /Support Integrations Agent Contract/);
  assert.equal(result.render_variant, "troubleshooting");
  assert.deepEqual(result.claims[0]?.evidence_ids, ["chunk:callback-mismatch"]);
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
      still_need_to_confirm: []
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
