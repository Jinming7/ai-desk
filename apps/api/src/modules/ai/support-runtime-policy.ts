import { env } from "../../config/env.js";
import { isServerlessRuntime } from "../../config/runtime-env.js";
import type { OpenClawRuntimeContext } from "../../infrastructure/openclaw/types.js";

export interface SupportRuntimePolicy {
  deliveryMode: "interactive" | "async_job";
  tighteningEnabled: boolean;
  fastPathAllowed: boolean;
  profile: "latency_optimized" | "quality_optimized" | "tightened";
}

export function resolveSupportRuntimePolicy(runtime?: OpenClawRuntimeContext): SupportRuntimePolicy {
  const deliveryMode = runtime?.deliveryMode === "async_job" ? "async_job" : "interactive";
  const tighteningEnabled = env.FEATURE_SUPPORT_AGENT_RUNTIME_TIGHTENING;

  if (tighteningEnabled) {
    return {
      deliveryMode,
      tighteningEnabled,
      fastPathAllowed: false,
      profile: "tightened"
    };
  }

  if (deliveryMode === "async_job") {
    return {
      deliveryMode,
      tighteningEnabled,
      fastPathAllowed: false,
      profile: "quality_optimized"
    };
  }

  // On serverless interactive requests (especially preview/prod), prioritize answer quality over latency.
  if (isServerlessRuntime()) {
    return {
      deliveryMode,
      tighteningEnabled,
      fastPathAllowed: false,
      profile: "quality_optimized"
    };
  }

  return {
    deliveryMode,
    tighteningEnabled,
    fastPathAllowed: true,
    profile: "latency_optimized"
  };
}
