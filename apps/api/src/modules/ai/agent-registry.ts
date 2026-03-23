import crypto from "node:crypto";
import { env } from "../../config/env.js";
import type { OpenClawRuntimeContext } from "../../infrastructure/openclaw/types.js";

export type SupportAgentRole =
  | "router"
  | "evidence_planner"
  | "planner"
  | "api_specialist"
  | "howto_specialist"
  | "behavior_specialist"
  | "troubleshooting_specialist"
  | "evidence_judge"
  | "citation_curator"
  | "answer_composer"
  | "ticket_agent";

export interface SupportAgentConfig {
  role: SupportAgentRole;
  label: string;
  agentId: string;
  model?: string;
  envKey: string;
  modelEnvKey?: string;
  fallbackRole?: SupportAgentRole;
  configured: boolean;
  usingFallback: boolean;
}

export interface SupportAgentRegistry {
  prefix: string;
  agents: Record<SupportAgentRole, SupportAgentConfig>;
}

function normalize(value?: string | null): string {
  return String(value ?? "").trim();
}

function sanitizeSessionPart(input: string): string {
  return input.replace(/[^a-zA-Z0-9:_-]/g, "_").slice(0, 180);
}

function buildAgentScopedSessionKey(agentId: string, mainKey: string): string {
  return `agent:${agentId}:${sanitizeSessionPart(mainKey)}`;
}

function readRoleConfig(role: SupportAgentRole): { envKey: string; modelEnvKey?: string; label: string; value: string; model?: string } {
  const byRole: Record<SupportAgentRole, { envKey: string; modelEnvKey?: string; label: string }> = {
    router: {
      envKey: "OPENCLAW_AGENT_ID_ROUTER",
      modelEnvKey: "OPENCLAW_AGENT_MODEL_ROUTER",
      label: "Support Router"
    },
    evidence_planner: {
      envKey: "OPENCLAW_AGENT_ID_EVIDENCE_PLANNER",
      modelEnvKey: "OPENCLAW_AGENT_MODEL_EVIDENCE_PLANNER",
      label: "Evidence Planner"
    },
    planner: {
      envKey: "OPENCLAW_AGENT_ID_PLANNER",
      modelEnvKey: "OPENCLAW_AGENT_MODEL_PLANNER",
      label: "Support Planner"
    },
    api_specialist: {
      envKey: "OPENCLAW_AGENT_ID_API_SPECIALIST",
      modelEnvKey: "OPENCLAW_AGENT_MODEL_API_SPECIALIST",
      label: "API Specialist"
    },
    howto_specialist: {
      envKey: "OPENCLAW_AGENT_ID_HOWTO_SPECIALIST",
      modelEnvKey: "OPENCLAW_AGENT_MODEL_HOWTO_SPECIALIST",
      label: "How-to Specialist"
    },
    behavior_specialist: {
      envKey: "OPENCLAW_AGENT_ID_BEHAVIOR_SPECIALIST",
      modelEnvKey: "OPENCLAW_AGENT_MODEL_BEHAVIOR_SPECIALIST",
      label: "Behavior Specialist"
    },
    troubleshooting_specialist: {
      envKey: "OPENCLAW_AGENT_ID_TROUBLESHOOTING_SPECIALIST",
      modelEnvKey: "OPENCLAW_AGENT_MODEL_TROUBLESHOOTING_SPECIALIST",
      label: "Troubleshooting Specialist"
    },
    evidence_judge: {
      envKey: "OPENCLAW_AGENT_ID_EVIDENCE_JUDGE",
      modelEnvKey: "OPENCLAW_AGENT_MODEL_EVIDENCE_JUDGE",
      label: "Evidence Judge"
    },
    citation_curator: {
      envKey: "OPENCLAW_AGENT_ID_CITATION_CURATOR",
      modelEnvKey: "OPENCLAW_AGENT_MODEL_CITATION_CURATOR",
      label: "Citation Curator"
    },
    answer_composer: {
      envKey: "OPENCLAW_AGENT_ID_ANSWER_COMPOSER",
      modelEnvKey: "OPENCLAW_AGENT_MODEL_ANSWER_COMPOSER",
      label: "Answer Composer"
    },
    ticket_agent: {
      envKey: "OPENCLAW_AGENT_ID_EXECUTION",
      modelEnvKey: "OPENCLAW_AGENT_MODEL_EXECUTION",
      label: "Ticket Agent"
    }
  };

  const config = byRole[role];
  const source = env as unknown as Record<string, string>;
  return {
    ...config,
    value: normalize(source[config.envKey]),
    model: config.modelEnvKey ? normalize(source[config.modelEnvKey]) || undefined : undefined
  };
}

function resolveDefaultAgentId(): string {
  return normalize(env.OPENCLAW_AGENT_ID) || "main";
}

function resolveDefaultModel(): string | undefined {
  const value = normalize(env.OPENCLAW_AGENT_MODEL);
  return value || undefined;
}

export function getSupportAgentRegistry(): SupportAgentRegistry {
  const prefix = normalize(env.OPENCLAW_AGENT_SESSION_PREFIX) || "nf";
  const defaultAgentId = resolveDefaultAgentId();
  const defaultModel = resolveDefaultModel();

  const resolved = new Map<SupportAgentRole, SupportAgentConfig>();
  const baseRoles: Array<{ role: SupportAgentRole; fallbackRole?: SupportAgentRole }> = [
    { role: "planner" },
    { role: "router", fallbackRole: "planner" },
    { role: "evidence_planner", fallbackRole: "planner" },
    { role: "api_specialist", fallbackRole: "planner" },
    { role: "howto_specialist", fallbackRole: "planner" },
    { role: "behavior_specialist", fallbackRole: "planner" },
    { role: "troubleshooting_specialist", fallbackRole: "planner" },
    { role: "evidence_judge", fallbackRole: "planner" },
    { role: "citation_curator", fallbackRole: "planner" },
    { role: "answer_composer", fallbackRole: "planner" },
    { role: "ticket_agent" }
  ];

  for (const item of baseRoles) {
    const raw = readRoleConfig(item.role);
    let fallbackAgentId = defaultAgentId;
    let fallbackModel = defaultModel;
    if (item.fallbackRole && resolved.has(item.fallbackRole)) {
      fallbackAgentId = resolved.get(item.fallbackRole)?.agentId ?? defaultAgentId;
      fallbackModel = resolved.get(item.fallbackRole)?.model ?? defaultModel;
    } else if (item.role === "planner") {
      fallbackAgentId = normalize(env.OPENCLAW_AGENT_ID_RETRIEVAL) || defaultAgentId;
      fallbackModel = normalize(env.OPENCLAW_AGENT_MODEL_RETRIEVAL) || defaultModel;
    }
    const agentId = raw.value || fallbackAgentId;
    const model = raw.model || fallbackModel;
    resolved.set(item.role, {
      role: item.role,
      label: raw.label,
      envKey: raw.envKey,
      modelEnvKey: raw.modelEnvKey,
      agentId,
      model,
      configured: Boolean(raw.value),
      usingFallback: !raw.value && Boolean(agentId),
      fallbackRole: item.fallbackRole
    });
  }

  return {
    prefix,
    agents: Object.fromEntries(resolved.entries()) as Record<SupportAgentRole, SupportAgentConfig>
  };
}

export function buildSupportAgentRuntime(input: {
  registry?: SupportAgentRegistry;
  role: SupportAgentRole;
  caseId: string;
}): OpenClawRuntimeContext {
  const registry = input.registry ?? getSupportAgentRegistry();
  const config = registry.agents[input.role];
  const sessionKey = buildAgentScopedSessionKey(config.agentId, `${registry.prefix}:case:${input.caseId}:${input.role}`);
  return {
    agentId: config.agentId,
    model: config.model,
    sessionKey,
    intent: input.role === "ticket_agent" ? "execution" : "retrieval"
  };
}

export function buildRegistryTopology(registry = getSupportAgentRegistry()) {
  const allAgents = Object.values(registry.agents).map((item) => ({
    role: item.role,
    label: item.label,
    agentId: item.agentId,
    model: item.model ?? null,
    configured: item.configured,
    usingFallback: item.usingFallback,
    fallbackRole: item.fallbackRole ?? null,
    sessionPrefix: buildAgentScopedSessionKey(item.agentId, `${registry.prefix}:case:*:${item.role}`)
  }));

  return {
    orchestration: "openclaw_multi_agent_support_orchestrator",
    prefix: registry.prefix,
    agents: {
      router: allAgents.find((item) => item.role === "router") ?? null,
      evidencePlanner: allAgents.find((item) => item.role === "evidence_planner") ?? null,
      planner: allAgents.find((item) => item.role === "planner") ?? null,
      specialists: allAgents.filter((item) => item.role.endsWith("_specialist")),
      evidenceJudge: allAgents.find((item) => item.role === "evidence_judge") ?? null,
      citationCurator: allAgents.find((item) => item.role === "citation_curator") ?? null,
      answerComposer: allAgents.find((item) => item.role === "answer_composer") ?? null,
      ticketAgent: allAgents.find((item) => item.role === "ticket_agent") ?? null
    },
    topologyHash: crypto.createHash("sha256").update(JSON.stringify(allAgents)).digest("hex").slice(0, 16)
  };
}
