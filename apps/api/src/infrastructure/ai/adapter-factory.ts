import type { OpenClawAdapter } from "../openclaw/types.js";
import { MockOpenClawAdapter } from "../openclaw/mock-adapter.js";
import { WsOpenClawAdapter } from "../openclaw/ws-adapter.js";
import { HermesOpenClawAdapter } from "../hermes/adapter.js";
import { HermesNativeAdapter } from "../hermes/native-adapter.js";
import type { HermesRuntimeMode } from "./auth-policy.js";

export type AiAgentProvider = "openclaw" | "hermes";

export function resolveAiRuntimeProvider(input: string | null | undefined): AiAgentProvider {
  const normalized = String(input ?? "")
    .trim()
    .toLowerCase();
  if (normalized === "hermes") return "hermes";
  return "openclaw";
}

export function createAiAdapter(input: {
  nodeEnv: "development" | "test" | "production";
  provider: AiAgentProvider;
  hermesMode?: HermesRuntimeMode;
}): OpenClawAdapter {
  if (input.nodeEnv === "test") {
    return new MockOpenClawAdapter();
  }
  if (input.provider === "hermes") {
    if (input.hermesMode === "native") {
      return new HermesNativeAdapter();
    }
    return new HermesOpenClawAdapter();
  }
  return new WsOpenClawAdapter();
}
