import { env } from "../../config/env.js";
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
  const fallbackAgentId = searchAgentId || env.OPENCLAW_AGENT_ID.trim() || "main";
  const prefix = env.OPENCLAW_AGENT_SESSION_PREFIX.trim() || "nf";
  return {
    intent: input.intent,
    agentId: fallbackAgentId,
    sessionKey: buildAgentScopedSessionKey(fallbackAgentId, `${prefix}:${input.intent}:${input.sessionId}`)
  };
}

export function resolveExecutionRuntime(sessionId: string): OpenClawRuntimeContext {
  const executionAgentId = env.OPENCLAW_AGENT_ID_EXECUTION.trim() || env.OPENCLAW_AGENT_ID.trim() || "main";
  const prefix = env.OPENCLAW_AGENT_SESSION_PREFIX.trim() || "nf";
  return {
    intent: "execution",
    agentId: executionAgentId,
    sessionKey: buildAgentScopedSessionKey(executionAgentId, `${prefix}:execution:${sessionId}`)
  };
}

export function getAiTopology() {
  const searchAgentId = env.OPENCLAW_AGENT_ID_RETRIEVAL?.trim() || env.OPENCLAW_AGENT_ID?.trim() || "main";
  const executionAgentId = env.OPENCLAW_AGENT_ID_EXECUTION?.trim() || env.OPENCLAW_AGENT_ID?.trim() || "main";
  const prefix = env.OPENCLAW_AGENT_SESSION_PREFIX.trim() || "nf";
  return {
    searchBot: {
      orchestration: "openclaw_search_agent_with_local_grounding_context",
      openclawAgentBound: true,
      agentId: searchAgentId,
      sessionPrefix: `agent:${searchAgentId}:${prefix}:retrieval|clarify:*`
    },
    ticketAgent: {
      orchestration: "openclaw_execution_agent",
      openclawAgentBound: true,
      agentId: executionAgentId,
      sessionPrefix: `agent:${executionAgentId}:${prefix}:execution:*`
    },
    deprecatedConfig: {
      retrievalAgentId: env.OPENCLAW_AGENT_ID_RETRIEVAL,
      clarifyAgentId: env.OPENCLAW_AGENT_ID_CLARIFY
    }
  };
}
