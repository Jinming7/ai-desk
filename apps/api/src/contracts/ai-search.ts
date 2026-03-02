import { z } from "zod";

export const aiSearchRequestSchema = z.object({
  query: z.string().min(2),
  conversation: z.array(z.string()).optional()
});

export const aiEscalateRequestSchema = z.object({
  sessionId: z.string().uuid(),
  question: z.string().min(2),
  conversation: z.array(z.string()).default([]),
  reasonCode: z.enum(["NO_MATCHING_KB", "LOW_CONFIDENCE", "KB_RETRIEVAL_UNAVAILABLE"])
});

export type AiEscalationStatus = "ESCALATED" | "DEEP_RETRIEVING" | "RESOLVED_BY_AI" | "TICKET_CREATED";
