import { z } from "zod";

export const aiSearchRequestSchema = z.object({
  query: z.string().default(""),
  imageAttachments: z.array(z.string()).default([]),
  attachments: z.array(z.string()).default([]),
  sessionId: z.string().uuid().optional(),
  conversation: z.array(z.string()).default([]),
  answerLanguage: z.enum(["zh", "en"]).optional()
}).refine((input) => input.query.trim().length >= 2 || input.imageAttachments.length > 0 || input.attachments.length > 0, {
  message: "query or attachments is required"
});

export const aiEscalateRequestSchema = z.object({
  sessionId: z.string().uuid(),
  question: z.string().min(2),
  conversation: z.array(z.string()).default([]),
  reasonCode: z.enum(["NO_MATCHING_KB", "LOW_CONFIDENCE", "KB_RETRIEVAL_UNAVAILABLE"])
});

export const aiTicketDraftRequestSchema = z.object({
  sessionId: z.string().uuid(),
  question: z.string().min(2),
  conversation: z.array(z.string()).default([]),
  retrievalTraces: z.array(z.any()).default([])
});

export const aiTicketSubmitRequestSchema = z.object({
  draftId: z.string().uuid(),
  customer: z
    .object({
      id: z.string().min(1),
      name: z.string().min(1),
      email: z.string().email().optional()
    })
    .optional(),
  title: z.string().min(3).max(200).optional(),
  description: z.string().min(5).optional(),
  attachments: z.array(z.string()).default([]),
  serviceCategory: z.enum(["technical_support", "feature_consulting", "account_issue"]).optional(),
  onesTicketTypeKey: z.string().min(1).optional(),
  onesFields: z.record(z.string(), z.any()).default({})
});

export type AiEscalationStatus = "ESCALATED" | "DEEP_RETRIEVING" | "RESOLVED_BY_AI" | "TICKET_CREATED";
