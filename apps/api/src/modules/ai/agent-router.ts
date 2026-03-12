import { env } from "../../config/env.js";
import type { OpenClawRuntimeContext } from "../../infrastructure/openclaw/types.js";

export type AiAgentIntent = "retrieval" | "clarify" | "execution";

function sanitizeSessionPart(input: string): string {
  return input.replace(/[^a-zA-Z0-9:_-]/g, "_").slice(0, 120);
}

export function buildSessionKey(intent: AiAgentIntent, sessionId: string): string {
  const prefix = env.OPENCLAW_AGENT_SESSION_PREFIX.trim() || "nf";
  return `${prefix}:${intent}:${sanitizeSessionPart(sessionId)}`;
}

export function resolveOpenClawRuntime(input: { intent: AiAgentIntent; sessionId: string }): OpenClawRuntimeContext {
  const agentId =
    input.intent === "retrieval"
      ? env.OPENCLAW_AGENT_ID_RETRIEVAL
      : input.intent === "clarify"
        ? env.OPENCLAW_AGENT_ID_CLARIFY
        : env.OPENCLAW_AGENT_ID_EXECUTION;

  return {
    intent: input.intent,
    agentId,
    sessionKey: buildSessionKey(input.intent, input.sessionId)
  };
}

