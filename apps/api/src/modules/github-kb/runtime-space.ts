import { env } from "../../config/env.js";
import type { KbKnowledgeSpace, KbRequestedFromEnv } from "./types.js";

export function resolveRequestedFromEnv(): KbRequestedFromEnv {
  const vercelEnv = String(process.env.VERCEL_ENV ?? "").trim().toLowerCase();
  if (vercelEnv === "preview") return "preview";
  if (vercelEnv === "production") return "prod";
  if (env.NODE_ENV === "production") return "prod";
  return "local";
}

export function mapRequestedEnvToKnowledgeSpace(requestedFromEnv: KbRequestedFromEnv): KbKnowledgeSpace {
  if (requestedFromEnv === "prod") return "support-prod";
  if (requestedFromEnv === "preview") return "support-preview";
  return "support-local";
}

export function resolveRuntimeKnowledgeSpace(): KbKnowledgeSpace {
  return mapRequestedEnvToKnowledgeSpace(resolveRequestedFromEnv());
}

export function canPublishToKnowledgeSpace(requestedFromEnv: KbRequestedFromEnv, knowledgeSpace: KbKnowledgeSpace): boolean {
  if (requestedFromEnv === "operator") return true;
  return mapRequestedEnvToKnowledgeSpace(requestedFromEnv) === knowledgeSpace;
}
