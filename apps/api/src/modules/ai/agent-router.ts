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

type SupportStage = NonNullable<OpenClawRuntimeContext["stage"]>;
type RoutedSupportStage =
  | "router"
  | "evidence-planner"
  | "planner"
  | "api-specialist"
  | "howto-specialist"
  | "behavior-specialist"
  | "troubleshooting-specialist"
  | "evidence-judge"
  | "citation-curator"
  | "answer-composer";

type StageBinding = {
  stage: RoutedSupportStage;
  agentId: string;
  model: string | null;
  dedicated: boolean;
  fallback: "stage_binding" | "runtime_override" | "execution_default";
};

function executionFallbackAgentId() {
  return env.OPENCLAW_AGENT_ID_EXECUTION.trim() || env.OPENCLAW_AGENT_ID.trim() || "main";
}

function executionFallbackModel() {
  return env.OPENCLAW_AGENT_MODEL_EXECUTION.trim() || env.OPENCLAW_AGENT_MODEL.trim() || undefined;
}

export function resolveStageSpecificAgent(stage: SupportStage, runtime?: OpenClawRuntimeContext): {
  agentId: string;
  model?: string;
} {
  const explicitRuntimeAgentId = runtime?.agentId?.trim();
  const explicitRuntimeModel = runtime?.model?.trim();

  const stageBinding = (() => {
    switch (stage) {
      case "router":
        return {
          agentId: env.OPENCLAW_AGENT_ID_ROUTER.trim(),
          model: env.OPENCLAW_AGENT_MODEL_ROUTER.trim()
        };
      case "evidence-planner":
        return {
          agentId: env.OPENCLAW_AGENT_ID_EVIDENCE_PLANNER.trim(),
          model: env.OPENCLAW_AGENT_MODEL_EVIDENCE_PLANNER.trim()
        };
      case "planner":
        return {
          agentId: env.OPENCLAW_AGENT_ID_PLANNER.trim(),
          model: env.OPENCLAW_AGENT_MODEL_PLANNER.trim()
        };
      case "api-specialist":
        return {
          agentId: env.OPENCLAW_AGENT_ID_API_SPECIALIST.trim(),
          model: env.OPENCLAW_AGENT_MODEL_API_SPECIALIST.trim()
        };
      case "howto-specialist":
        return {
          agentId: env.OPENCLAW_AGENT_ID_HOWTO_SPECIALIST.trim(),
          model: env.OPENCLAW_AGENT_MODEL_HOWTO_SPECIALIST.trim()
        };
      case "behavior-specialist":
        return {
          agentId: env.OPENCLAW_AGENT_ID_BEHAVIOR_SPECIALIST.trim(),
          model: env.OPENCLAW_AGENT_MODEL_BEHAVIOR_SPECIALIST.trim()
        };
      case "troubleshooting-specialist":
        return {
          agentId: env.OPENCLAW_AGENT_ID_TROUBLESHOOTING_SPECIALIST.trim(),
          model: env.OPENCLAW_AGENT_MODEL_TROUBLESHOOTING_SPECIALIST.trim()
        };
      case "evidence-judge":
        return {
          agentId: env.OPENCLAW_AGENT_ID_EVIDENCE_JUDGE.trim(),
          model: env.OPENCLAW_AGENT_MODEL_EVIDENCE_JUDGE.trim()
        };
      case "citation-curator":
        return {
          agentId: env.OPENCLAW_AGENT_ID_CITATION_CURATOR.trim(),
          model: env.OPENCLAW_AGENT_MODEL_CITATION_CURATOR.trim()
        };
      case "answer-composer":
        return {
          agentId: env.OPENCLAW_AGENT_ID_ANSWER_COMPOSER.trim(),
          model: env.OPENCLAW_AGENT_MODEL_ANSWER_COMPOSER.trim()
        };
      default:
        return {
          agentId: "",
          model: ""
        };
    }
  })();

  return {
    agentId: stageBinding.agentId || explicitRuntimeAgentId || executionFallbackAgentId(),
    model: stageBinding.model || explicitRuntimeModel || executionFallbackModel()
  };
}

function resolveStageBinding(stage: RoutedSupportStage): StageBinding {
  const executionAgentId = executionFallbackAgentId();
  const executionModel = executionFallbackModel() ?? null;
  const runtime = resolveStageSpecificAgent(stage);
  const dedicated = runtime.agentId !== executionAgentId;
  const fallback: StageBinding["fallback"] = dedicated ? "stage_binding" : "execution_default";
  return {
    stage,
    agentId: runtime.agentId,
    model: runtime.model ?? executionModel,
    dedicated,
    fallback
  };
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
  const executionAgentId = executionFallbackAgentId();
  const executionAgentModel = executionFallbackModel();
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
  const supportStages = [
    resolveStageBinding("router"),
    resolveStageBinding("evidence-planner"),
    resolveStageBinding("planner"),
    resolveStageBinding("api-specialist"),
    resolveStageBinding("howto-specialist"),
    resolveStageBinding("behavior-specialist"),
    resolveStageBinding("troubleshooting-specialist"),
    resolveStageBinding("evidence-judge"),
    resolveStageBinding("citation-curator"),
    resolveStageBinding("answer-composer")
  ];
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
    supportStages: {
      dedicatedCount: supportStages.filter((stage) => stage.dedicated).length,
      executionFallbackAgentId: executionAgentId,
      stages: supportStages
    },
    deprecatedConfig: {
      retrievalAgentId: env.OPENCLAW_AGENT_ID_RETRIEVAL,
      clarifyAgentId: env.OPENCLAW_AGENT_ID_CLARIFY
    }
  };
}
