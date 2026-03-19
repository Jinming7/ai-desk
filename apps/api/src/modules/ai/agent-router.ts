import { env } from "../../config/env.js";
import { isServerlessRuntime } from "../../config/runtime-env.js";
import type { OpenClawRuntimeContext } from "../../infrastructure/openclaw/types.js";

export type AiAgentIntent = "retrieval" | "clarify" | "execution";

function sanitizeSessionPart(input: string): string {
  return input.replace(/[^a-zA-Z0-9:_-]/g, "_").slice(0, 120);
}

function buildAgentScopedSessionKey(agentId: string, mainKey: string): string {
  return `agent:${agentId}:${sanitizeSessionPart(mainKey)}`;
}

export function buildSearchRuntime(input: {
  intent: Exclude<AiAgentIntent, "execution">;
  sessionId: string;
}): OpenClawRuntimeContext {
  const searchAgentId = (input.intent === "clarify" ? env.OPENCLAW_AGENT_ID_CLARIFY : env.OPENCLAW_AGENT_ID_RETRIEVAL).trim();
  const searchAgentModel = (
    input.intent === "clarify" ? env.OPENCLAW_AGENT_MODEL_CLARIFY : env.OPENCLAW_AGENT_MODEL_RETRIEVAL
  ).trim();
  const fallbackAgentId = searchAgentId || env.OPENCLAW_AGENT_ID.trim() || "main";
  const fallbackAgentModel = searchAgentModel || env.OPENCLAW_AGENT_MODEL.trim() || undefined;
  const prefix = env.OPENCLAW_AGENT_SESSION_PREFIX.trim() || "nf";
  const serverless = isServerlessRuntime();
  return {
    intent: input.intent,
    agentId: fallbackAgentId,
    model: fallbackAgentModel,
    sessionKey: buildAgentScopedSessionKey(fallbackAgentId, `${prefix}:${input.intent}:${input.sessionId}`),
    ...(serverless
      ? {
          overallTimeoutMs: 22000,
          requestStartedAtMs: Date.now(),
          disableLocalDocs: true,
          allowMultiPassRetrieval: false,
          allowRefinement: false,
          kbTopK: 6,
          queryLimit: 1
        }
      : {
          overallTimeoutMs: 90000,
          requestStartedAtMs: Date.now(),
          allowMultiPassRetrieval: true,
          allowRefinement: false,
          kbTopK: 8,
          queryLimit: 3
        })
  };
}

export function resolveExecutionRuntime(sessionId: string): OpenClawRuntimeContext {
  const executionAgentId = env.OPENCLAW_AGENT_ID_EXECUTION.trim() || env.OPENCLAW_AGENT_ID.trim() || "main";
  const executionAgentModel = env.OPENCLAW_AGENT_MODEL_EXECUTION.trim() || env.OPENCLAW_AGENT_MODEL.trim() || undefined;
  const prefix = env.OPENCLAW_AGENT_SESSION_PREFIX.trim() || "nf";
  const serverless = isServerlessRuntime();
  return {
    intent: "execution",
    agentId: executionAgentId,
    model: executionAgentModel,
    sessionKey: buildAgentScopedSessionKey(executionAgentId, `${prefix}:execution:${sessionId}`),
    ...(serverless
      ? {
          overallTimeoutMs: 22000,
          requestStartedAtMs: Date.now(),
          disableLocalDocs: true,
          allowMultiPassRetrieval: false,
          allowRefinement: false,
          kbTopK: 6,
          queryLimit: 1
        }
      : {})
  };
}

export function getAiTopology() {
  const searchAgentId = env.OPENCLAW_AGENT_ID_RETRIEVAL?.trim() || env.OPENCLAW_AGENT_ID?.trim() || "main";
  const executionAgentId = env.OPENCLAW_AGENT_ID_EXECUTION?.trim() || env.OPENCLAW_AGENT_ID?.trim() || "main";
  const searchAgentModel = env.OPENCLAW_AGENT_MODEL_RETRIEVAL?.trim() || env.OPENCLAW_AGENT_MODEL?.trim() || "";
  const executionAgentModel = env.OPENCLAW_AGENT_MODEL_EXECUTION?.trim() || env.OPENCLAW_AGENT_MODEL?.trim() || "";
  const prefix = env.OPENCLAW_AGENT_SESSION_PREFIX.trim() || "nf";
  return {
    searchBot: {
      orchestration: "openclaw_search_agent_with_local_grounding_context",
      openclawAgentBound: true,
      agentId: searchAgentId,
      model: searchAgentModel || null,
      sessionPrefix: `agent:${searchAgentId}:${prefix}:retrieval|clarify:*`
    },
    ticketAgent: {
      orchestration: "openclaw_execution_agent",
      openclawAgentBound: true,
      agentId: executionAgentId,
      model: executionAgentModel || null,
      sessionPrefix: `agent:${executionAgentId}:${prefix}:execution:*`
    },
    deprecatedConfig: {
      retrievalAgentId: env.OPENCLAW_AGENT_ID_RETRIEVAL,
      clarifyAgentId: env.OPENCLAW_AGENT_ID_CLARIFY
    }
  };
}
