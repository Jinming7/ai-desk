import { env } from "../../config/env.js";
import type { OpenClawRuntimeContext } from "../../infrastructure/openclaw/types.js";
import { buildRegistryTopology, buildSupportAgentRuntime, getSupportAgentRegistry } from "./agent-registry.js";

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
  const registry = getSupportAgentRegistry();
  const legacyAgentId = (input.intent === "clarify" ? env.OPENCLAW_AGENT_ID_CLARIFY : env.OPENCLAW_AGENT_ID_RETRIEVAL).trim();
  const legacyModel = (
    input.intent === "clarify" ? env.OPENCLAW_AGENT_MODEL_CLARIFY : env.OPENCLAW_AGENT_MODEL_RETRIEVAL
  ).trim();
  const base = buildSupportAgentRuntime({
    registry,
    role: input.intent === "clarify" ? "answer_composer" : "router",
    caseId: input.sessionId
  });
  return {
    intent: input.intent,
    agentId: legacyAgentId || base.agentId,
    model: legacyModel || base.model,
    sessionKey: legacyAgentId
      ? buildAgentScopedSessionKey(legacyAgentId, `${registry.prefix}:${input.intent}:${input.sessionId}`)
      : base.sessionKey
  };
}

export function resolveExecutionRuntime(sessionId: string): OpenClawRuntimeContext {
  return {
    ...buildSupportAgentRuntime({
      role: "ticket_agent",
      caseId: sessionId
    }),
    intent: "execution"
  };
}

export function getAiTopology() {
  return buildRegistryTopology();
}
