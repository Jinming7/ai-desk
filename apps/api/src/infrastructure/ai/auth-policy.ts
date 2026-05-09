import type { AiAgentProvider } from "./adapter-factory.js";

export type HermesRuntimeMode = "bridge" | "native";

export interface EvaluateAiGatewayAuthInput {
  provider: AiAgentProvider;
  openClawAuthConfigured: boolean;
  hermesMode?: HermesRuntimeMode;
  hermesNativeConfigured?: boolean;
}

export interface AiGatewayAuthEvaluation {
  ok: boolean;
  message: string;
}

export function resolveHermesRuntimeMode(input: string | null | undefined): HermesRuntimeMode {
  const normalized = String(input ?? "")
    .trim()
    .toLowerCase();
  return normalized === "native" ? "native" : "bridge";
}

export function evaluateAiGatewayAuth(input: EvaluateAiGatewayAuthInput): AiGatewayAuthEvaluation {
  if (input.provider === "openclaw") {
    return input.openClawAuthConfigured
      ? { ok: true, message: "OpenClaw gateway auth is configured" }
      : { ok: false, message: "OpenClaw gateway auth is not configured" };
  }

  const hermesMode = input.hermesMode ?? "bridge";
  if (hermesMode === "native") {
    return input.hermesNativeConfigured
      ? { ok: true, message: "Hermes native runtime auth is configured" }
      : { ok: false, message: "Hermes native runtime auth is not configured; set HERMES_LLM_API_KEY" };
  }

  return input.openClawAuthConfigured
    ? { ok: true, message: "Hermes bridge mode is using OpenClaw gateway auth" }
    : {
        ok: false,
        message:
          "Hermes bridge mode currently depends on OpenClaw gateway auth; configure OPENCLAW_GATEWAY_TOKEN or OPENCLAW_BASIC_PASS"
      };
}
