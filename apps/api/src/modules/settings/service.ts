import { z } from "zod";
import * as settings from "./repository.js";

const modeInputSchema = z.object({
  enabled: z.boolean(),
  actor: z.string().min(1).default("internal_operator")
});

export async function getAiAgentMode() {
  return settings.getAiAgentMode();
}

export async function setAiAgentMode(input: unknown) {
  const parsed = modeInputSchema.parse(input);
  return settings.setAiAgentMode(parsed.enabled, parsed.actor);
}
