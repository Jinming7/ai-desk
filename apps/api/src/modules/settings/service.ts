import { z } from "zod";
import * as settings from "./repository.js";

const modeInputSchema = z.object({
  enabled: z.boolean(),
  actor: z.string().min(1).default("internal_operator"),
  reason: z.string().default("unspecified")
});

export async function getAiAgentMode() {
  return settings.getAiAgentMode();
}

export async function setAiAgentMode(input: unknown) {
  const parsed = modeInputSchema.parse(input);
  const before = await settings.getAiAgentMode();
  const after = await settings.setAiAgentMode(parsed.enabled, parsed.actor);
  await settings.addAiModeAudit({
    actor: parsed.actor,
    previous: before.enabled,
    next: after.enabled,
    reason: parsed.reason
  });
  return after;
}
