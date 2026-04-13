import crypto from "node:crypto";
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
  | "support-main"
  | "router"
  | "evidence-planner"
  | "planner"
  | "support-evidence-selector"
  | "api-specialist"
  | "howto-specialist"
  | "behavior-specialist"
  | "troubleshooting-specialist"
  | "evidence-judge"
  | "support-citation-binder"
  | "citation-curator"
  | "support-citation-selector"
  | "answer-composer";

type StageBinding = {
  stage: RoutedSupportStage;
  agentId: string;
  model: string | null;
  dedicated: boolean;
  fallback: "stage_binding" | "stage_level_fallback" | "runtime_override" | "default_topology" | "global_default";
};

type SearchStage = "retrieval" | "clarify" | "execution";

type SearchStageBinding = {
  stage: SearchStage;
  agentId: string;
  model: string | null;
  fallback: "stage_binding" | "default_topology" | "global_default";
};

export type AiTopologyConflict = {
  type: "duplicate_agent";
  agentId: string;
  stages: string[];
  detail: string;
};

export type AiTopologySnapshot = {
  searchStages: SearchStageBinding[];
  supportStages: {
    dedicatedCount: number;
    executionFallbackAgentId: string;
    stages: StageBinding[];
  };
  configuredAgents: string[];
  conflicts: AiTopologyConflict[];
  multiAgentReady: boolean;
  topologyHash: string;
};

export type AiRuntimeReadinessProfile = {
  requiredAgents: string[];
  optionalAgents: string[];
};

const DEFAULT_SEARCH_AGENT_IDS = {
  retrieval: "search-retrieval",
  clarify: "search-clarify",
  execution: "ticket-execution"
} as const;

const DEFAULT_SUPPORT_STAGE_AGENT_IDS: Record<RoutedSupportStage, string> = {
  "support-main": "support-main",
  router: "support-router",
  "evidence-planner": "support-evidence-planner",
  planner: "support-planner",
  "support-evidence-selector": "support-evidence-selector",
  "api-specialist": "support-api-specialist",
  "howto-specialist": "support-howto-specialist",
  "behavior-specialist": "support-behavior-specialist",
  "troubleshooting-specialist": "support-troubleshooting-specialist",
  "evidence-judge": "support-evidence-judge",
  "support-citation-binder": "support-citation-curator",
  "citation-curator": "support-citation-curator",
  "support-citation-selector": "support-citation-selector",
  "answer-composer": "support-answer-composer"
};

function citationBinderFallbackAgentId() {
  return env.OPENCLAW_AGENT_ID_CITATION_CURATOR.trim() || DEFAULT_SUPPORT_STAGE_AGENT_IDS["citation-curator"];
}

function citationBinderFallbackModel() {
  return env.OPENCLAW_AGENT_MODEL_CITATION_CURATOR.trim() || globalDefaultModel();
}

function globalDefaultAgentId() {
  return env.OPENCLAW_AGENT_ID.trim() || "main";
}

function globalDefaultModel() {
  return env.OPENCLAW_AGENT_MODEL.trim() || undefined;
}

function executionFallbackAgentId() {
  return env.OPENCLAW_AGENT_ID_EXECUTION.trim() || DEFAULT_SEARCH_AGENT_IDS.execution;
}

function executionFallbackModel() {
  return env.OPENCLAW_AGENT_MODEL_EXECUTION.trim() || env.OPENCLAW_AGENT_MODEL.trim() || undefined;
}

export function isSupportMainRuntimeEnabled(): boolean {
  return env.FEATURE_SUPPORT_AGENT_SINGLE_AGENT_RUNTIME || Boolean(env.OPENCLAW_AGENT_ID_SUPPORT_MAIN.trim());
}

function resolveSearchStageBinding(stage: SearchStage): SearchStageBinding {
  const envAgentId =
    stage === "retrieval"
      ? env.OPENCLAW_AGENT_ID_RETRIEVAL.trim()
      : stage === "clarify"
      ? env.OPENCLAW_AGENT_ID_CLARIFY.trim()
      : env.OPENCLAW_AGENT_ID_EXECUTION.trim();
  const envModel =
    stage === "retrieval"
      ? env.OPENCLAW_AGENT_MODEL_RETRIEVAL.trim()
      : stage === "clarify"
      ? env.OPENCLAW_AGENT_MODEL_CLARIFY.trim()
      : env.OPENCLAW_AGENT_MODEL_EXECUTION.trim();
  const defaultAgentId =
    stage === "retrieval"
      ? DEFAULT_SEARCH_AGENT_IDS.retrieval
      : stage === "clarify"
      ? DEFAULT_SEARCH_AGENT_IDS.clarify
      : DEFAULT_SEARCH_AGENT_IDS.execution;
  const agentId = envAgentId || defaultAgentId || globalDefaultAgentId();
  const fallback: SearchStageBinding["fallback"] = envAgentId
    ? "stage_binding"
    : agentId === defaultAgentId
    ? "default_topology"
    : "global_default";
  return {
    stage,
    agentId,
    model: envModel || globalDefaultModel() || null,
    fallback
  };
}

export function resolveStageSpecificAgent(stage: SupportStage, runtime?: OpenClawRuntimeContext): {
  agentId: string;
  model?: string;
} {
  const explicitRuntimeAgentId = runtime?.agentId?.trim();
  const explicitRuntimeModel = runtime?.model?.trim();

  const stageBinding = (() => {
    switch (stage) {
      case "support-main":
        return {
          agentId: env.OPENCLAW_AGENT_ID_SUPPORT_MAIN.trim(),
          model: env.OPENCLAW_AGENT_MODEL_SUPPORT_MAIN.trim()
        };
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
      case "support-evidence-selector":
        return {
          agentId: env.OPENCLAW_AGENT_ID_SUPPORT_EVIDENCE_SELECTOR.trim(),
          model: env.OPENCLAW_AGENT_MODEL_SUPPORT_EVIDENCE_SELECTOR.trim()
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
      case "support-citation-binder":
        return {
          agentId: env.OPENCLAW_AGENT_ID_SUPPORT_CITATION_BINDER.trim(),
          model: env.OPENCLAW_AGENT_MODEL_SUPPORT_CITATION_BINDER.trim()
        };
      case "citation-curator":
        return {
          agentId: env.OPENCLAW_AGENT_ID_CITATION_CURATOR.trim(),
          model: env.OPENCLAW_AGENT_MODEL_CITATION_CURATOR.trim()
        };
      case "support-citation-selector":
        return {
          agentId: env.OPENCLAW_AGENT_ID_SUPPORT_CITATION_SELECTOR.trim(),
          model: env.OPENCLAW_AGENT_MODEL_SUPPORT_CITATION_SELECTOR.trim()
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

  const defaultTopologyAgentId = stage in DEFAULT_SUPPORT_STAGE_AGENT_IDS ? DEFAULT_SUPPORT_STAGE_AGENT_IDS[stage as RoutedSupportStage] : "";
  const stageLevelFallbackAgentId = stage === "support-citation-binder" ? citationBinderFallbackAgentId() : "";
  const stageLevelFallbackModel = stage === "support-citation-binder" ? citationBinderFallbackModel() : undefined;
  return {
    agentId: stageBinding.agentId || explicitRuntimeAgentId || stageLevelFallbackAgentId || defaultTopologyAgentId || globalDefaultAgentId(),
    model: stageBinding.model || explicitRuntimeModel || stageLevelFallbackModel || globalDefaultModel()
  };
}

function resolveStageBinding(stage: RoutedSupportStage): StageBinding {
  const envAgentId = (() => {
    switch (stage) {
      case "support-main":
        return env.OPENCLAW_AGENT_ID_SUPPORT_MAIN.trim();
      case "router":
        return env.OPENCLAW_AGENT_ID_ROUTER.trim();
      case "evidence-planner":
        return env.OPENCLAW_AGENT_ID_EVIDENCE_PLANNER.trim();
      case "planner":
        return env.OPENCLAW_AGENT_ID_PLANNER.trim();
      case "support-evidence-selector":
        return env.OPENCLAW_AGENT_ID_SUPPORT_EVIDENCE_SELECTOR.trim();
      case "api-specialist":
        return env.OPENCLAW_AGENT_ID_API_SPECIALIST.trim();
      case "howto-specialist":
        return env.OPENCLAW_AGENT_ID_HOWTO_SPECIALIST.trim();
      case "behavior-specialist":
        return env.OPENCLAW_AGENT_ID_BEHAVIOR_SPECIALIST.trim();
      case "troubleshooting-specialist":
        return env.OPENCLAW_AGENT_ID_TROUBLESHOOTING_SPECIALIST.trim();
      case "evidence-judge":
        return env.OPENCLAW_AGENT_ID_EVIDENCE_JUDGE.trim();
      case "support-citation-binder":
        return env.OPENCLAW_AGENT_ID_SUPPORT_CITATION_BINDER.trim();
      case "citation-curator":
        return env.OPENCLAW_AGENT_ID_CITATION_CURATOR.trim();
      case "support-citation-selector":
        return env.OPENCLAW_AGENT_ID_SUPPORT_CITATION_SELECTOR.trim();
      case "answer-composer":
        return env.OPENCLAW_AGENT_ID_ANSWER_COMPOSER.trim();
    }
  })();
  const envModel = (() => {
    switch (stage) {
      case "support-main":
        return env.OPENCLAW_AGENT_MODEL_SUPPORT_MAIN.trim();
      case "router":
        return env.OPENCLAW_AGENT_MODEL_ROUTER.trim();
      case "evidence-planner":
        return env.OPENCLAW_AGENT_MODEL_EVIDENCE_PLANNER.trim();
      case "planner":
        return env.OPENCLAW_AGENT_MODEL_PLANNER.trim();
      case "support-evidence-selector":
        return env.OPENCLAW_AGENT_MODEL_SUPPORT_EVIDENCE_SELECTOR.trim();
      case "api-specialist":
        return env.OPENCLAW_AGENT_MODEL_API_SPECIALIST.trim();
      case "howto-specialist":
        return env.OPENCLAW_AGENT_MODEL_HOWTO_SPECIALIST.trim();
      case "behavior-specialist":
        return env.OPENCLAW_AGENT_MODEL_BEHAVIOR_SPECIALIST.trim();
      case "troubleshooting-specialist":
        return env.OPENCLAW_AGENT_MODEL_TROUBLESHOOTING_SPECIALIST.trim();
      case "evidence-judge":
        return env.OPENCLAW_AGENT_MODEL_EVIDENCE_JUDGE.trim();
      case "support-citation-binder":
        return env.OPENCLAW_AGENT_MODEL_SUPPORT_CITATION_BINDER.trim();
      case "citation-curator":
        return env.OPENCLAW_AGENT_MODEL_CITATION_CURATOR.trim();
      case "support-citation-selector":
        return env.OPENCLAW_AGENT_MODEL_SUPPORT_CITATION_SELECTOR.trim();
      case "answer-composer":
        return env.OPENCLAW_AGENT_MODEL_ANSWER_COMPOSER.trim();
    }
  })();
  const runtime = resolveStageSpecificAgent(stage);
  if (stage === "support-citation-binder" && !envAgentId) {
    return {
      stage,
      agentId: runtime.agentId,
      model: runtime.model ?? envModel ?? citationBinderFallbackModel() ?? null,
      dedicated: false,
      fallback: "stage_level_fallback"
    };
  }
  const defaultAgentId = DEFAULT_SUPPORT_STAGE_AGENT_IDS[stage];
  const dedicated = runtime.agentId !== executionFallbackAgentId();
  const fallback: StageBinding["fallback"] = envAgentId
    ? "stage_binding"
    : defaultAgentId === runtime.agentId
    ? "default_topology"
    : runtime.agentId === globalDefaultAgentId()
    ? "global_default"
    : "runtime_override";
  return {
    stage,
    agentId: runtime.agentId,
    model: runtime.model ?? envModel ?? globalDefaultModel() ?? null,
    dedicated,
    fallback
  };
}

export function buildSearchRuntime(input: {
  intent: Exclude<AiAgentIntent, "execution">;
  sessionId: string;
  delivery?: "interactive" | "async_job";
}): OpenClawRuntimeContext {
  const searchAgentId = (input.intent === "clarify" ? env.OPENCLAW_AGENT_ID_CLARIFY : env.OPENCLAW_AGENT_ID_RETRIEVAL).trim();
  const searchAgentModel = (
    input.intent === "clarify" ? env.OPENCLAW_AGENT_MODEL_CLARIFY : env.OPENCLAW_AGENT_MODEL_RETRIEVAL
  ).trim();
  const fallbackAgentId =
    searchAgentId || (input.intent === "clarify" ? DEFAULT_SEARCH_AGENT_IDS.clarify : DEFAULT_SEARCH_AGENT_IDS.retrieval);
  const fallbackAgentModel = searchAgentModel || globalDefaultModel();
  const prefix = env.OPENCLAW_AGENT_SESSION_PREFIX.trim() || "nf";
  const serverless = isServerlessRuntime();
  const asyncJobDelivery = input.delivery === "async_job";
  return {
    intent: input.intent,
    deliveryMode: input.delivery ?? "interactive",
    agentId: fallbackAgentId,
    model: fallbackAgentModel,
    sessionKey: buildAgentScopedSessionKey(fallbackAgentId, `${prefix}:${input.intent}:${input.sessionId}`),
    ...(serverless
      ? {
          overallTimeoutMs: asyncJobDelivery ? env.AI_SUPPORT_JOB_TIMEOUT_MS : env.AI_SUPPORT_INTERACTIVE_TIMEOUT_MS,
          requestStartedAtMs: Date.now(),
          disableLocalDocs: true,
          allowMultiPassRetrieval: true,
          allowRefinement: true,
          kbTopK: 8,
          queryLimit: asyncJobDelivery ? 4 : 2
        }
      : {
          overallTimeoutMs: asyncJobDelivery ? env.AI_SUPPORT_JOB_TIMEOUT_MS : 90000,
          requestStartedAtMs: Date.now(),
          disableLocalDocs: true,
          allowMultiPassRetrieval: true,
          allowRefinement: true,
          kbTopK: 8,
          queryLimit: 4
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
    deliveryMode: "interactive",
    agentId: executionAgentId,
    model: executionAgentModel,
    sessionKey: buildAgentScopedSessionKey(executionAgentId, `${prefix}:execution:${sessionId}`),
    ...(serverless
      ? {
          overallTimeoutMs: env.AI_SUPPORT_INTERACTIVE_TIMEOUT_MS,
          requestStartedAtMs: Date.now(),
          disableLocalDocs: true,
          allowMultiPassRetrieval: false,
          allowRefinement: false,
          kbTopK: 6,
          queryLimit: 1
        }
      : {
          disableLocalDocs: true
        })
  };
}

function buildTopologyConflicts(searchStages: SearchStageBinding[], supportStages: StageBinding[]): AiTopologyConflict[] {
  const stageByAgent = new Map<string, string[]>();
  for (const stage of searchStages) {
    const agentId = stage.agentId.trim();
    if (!agentId) continue;
    stageByAgent.set(agentId, [...(stageByAgent.get(agentId) ?? []), stage.stage]);
  }
  for (const stage of supportStages.filter((item) => item.fallback !== "stage_level_fallback")) {
    const agentId = stage.agentId.trim();
    if (!agentId) continue;
    stageByAgent.set(agentId, [...(stageByAgent.get(agentId) ?? []), stage.stage]);
  }
  return [...stageByAgent.entries()]
    .filter(([, stages]) => stages.length > 1)
    .map(([agentId, stages]) => ({
      type: "duplicate_agent" as const,
      agentId,
      stages,
      detail: `Agent '${agentId}' is bound to multiple stages: ${stages.join(", ")}`
    }));
}

function buildTopologyHash(searchStages: SearchStageBinding[], supportStages: StageBinding[]) {
  const payload = {
    searchStages: searchStages.map((stage) => ({ stage: stage.stage, agentId: stage.agentId, model: stage.model })),
    supportStages: supportStages.map((stage) => ({ stage: stage.stage, agentId: stage.agentId, model: stage.model }))
  };
  return crypto.createHash("sha1").update(JSON.stringify(payload)).digest("hex").slice(0, 12);
}

export function getAiTopology(): AiTopologySnapshot {
  const supportStages = [
    ...(isSupportMainRuntimeEnabled() ? [resolveStageBinding("support-main")] : []),
    resolveStageBinding("router"),
    resolveStageBinding("evidence-planner"),
    resolveStageBinding("planner"),
    resolveStageBinding("api-specialist"),
    resolveStageBinding("howto-specialist"),
    resolveStageBinding("behavior-specialist"),
    resolveStageBinding("troubleshooting-specialist"),
    resolveStageBinding("evidence-judge"),
    resolveStageBinding("answer-composer")
  ];
  const searchStages = [
    resolveSearchStageBinding("retrieval"),
    resolveSearchStageBinding("clarify"),
    resolveSearchStageBinding("execution")
  ];
  const conflicts = buildTopologyConflicts(searchStages, supportStages);
  return {
    searchStages,
    supportStages: {
      dedicatedCount: supportStages.filter((stage) => stage.dedicated).length,
      executionFallbackAgentId: searchStages.find((stage) => stage.stage === "execution")?.agentId ?? executionFallbackAgentId(),
      stages: supportStages
    },
    configuredAgents: [...new Set([...searchStages, ...supportStages].map((stage) => stage.agentId).filter(Boolean))],
    conflicts,
    multiAgentReady: conflicts.length === 0,
    topologyHash: buildTopologyHash(searchStages, supportStages)
  };
}

function uniqueAgentIds(bindings: Array<{ agentId: string }>): string[] {
  return [...new Set(bindings.map((binding) => binding.agentId.trim()).filter(Boolean))];
}

export function getAiRuntimeReadinessProfile(input?: {
  supervisorDomainAvailable?: boolean;
  supportMainAvailable?: boolean;
  customerAnswerComposerAvailable?: boolean;
}): AiRuntimeReadinessProfile {
  const searchStages = [
    resolveSearchStageBinding("retrieval"),
    resolveSearchStageBinding("clarify"),
    resolveSearchStageBinding("execution")
  ];
  const supervisorBindings = [
    resolveStageBinding("planner"),
    resolveStageBinding("api-specialist"),
    resolveStageBinding("howto-specialist"),
    resolveStageBinding("behavior-specialist"),
    resolveStageBinding("troubleshooting-specialist")
  ];
  const supportMainBindings = [resolveStageBinding("support-main")];
  const legacyBindings = [
    resolveStageBinding("router"),
    resolveStageBinding("evidence-planner"),
    resolveStageBinding("planner"),
    resolveStageBinding("api-specialist"),
    resolveStageBinding("howto-specialist"),
    resolveStageBinding("behavior-specialist"),
    resolveStageBinding("troubleshooting-specialist"),
    resolveStageBinding("evidence-judge")
  ];

  const requiredSupportBindings = input?.supervisorDomainAvailable
    ? supervisorBindings
    : input?.supportMainAvailable
    ? supportMainBindings
    : legacyBindings;

  const optionalSupportBindings = input?.supervisorDomainAvailable
    ? [
        ...(input.supportMainAvailable ? supportMainBindings : []),
        resolveStageBinding("router"),
        resolveStageBinding("evidence-planner"),
        resolveStageBinding("evidence-judge"),
        ...(input.customerAnswerComposerAvailable ? [resolveStageBinding("answer-composer")] : [])
      ]
    : input?.supportMainAvailable
    ? [
        resolveStageBinding("planner"),
        resolveStageBinding("api-specialist"),
        resolveStageBinding("howto-specialist"),
        resolveStageBinding("behavior-specialist"),
        resolveStageBinding("troubleshooting-specialist"),
        ...(input.customerAnswerComposerAvailable ? [resolveStageBinding("answer-composer")] : [])
      ]
    : input?.customerAnswerComposerAvailable
    ? [resolveStageBinding("answer-composer")]
    : [];

  return {
    requiredAgents: uniqueAgentIds([...searchStages, ...requiredSupportBindings]),
    optionalAgents: uniqueAgentIds(optionalSupportBindings)
  };
}
