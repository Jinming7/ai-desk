import { z } from "zod";

export const ticketStatusSchema = z.enum([
  "OPEN",
  "IN_PROGRESS",
  "WAITING_CUSTOMER",
  "ESCALATED_RND",
  "RESOLVED",
  "CLOSED"
]);

export const ticketPrioritySchema = z.enum(["P1", "P2", "P3", "P4"]);

export const ticketCreateSchema = z.object({
  title: z.string().min(3).max(200),
  description: z.string().min(5),
  serviceCategory: z.enum(["technical_support", "feature_consulting", "account_issue"]),
  priority: ticketPrioritySchema.default("P3"),
  customer: z.object({
    id: z.string().min(1),
    name: z.string().min(1),
    email: z.string().email().optional()
  }),
  environment: z.enum(["production", "staging", "test", "unknown"]).default("unknown"),
  reproducibility: z.enum(["always", "sometimes", "once", "unknown"]).default("unknown"),
  impactSummary: z.string().max(500).default("")
});

export const ticketReplySchema = z.object({
  body: z.string().min(1),
  authorType: z.enum(["CUSTOMER", "AGENT"]),
  authorName: z.string().min(1),
  attachments: z.array(z.string()).default([])
});

export const ticketListQuerySchema = z.object({
  customerId: z.string().optional(),
  status: ticketStatusSchema.optional(),
  sort: z.enum(["created_desc", "updated_desc"]).default("updated_desc")
});

export const agentQueueQuerySchema = z.object({
  queue: z.enum(["pending", "mine", "all"]).default("pending"),
  assignee: z.string().optional()
});

export const ticketAssignSchema = z.object({
  assigneeType: z.enum(["SUPPORT_TEAM", "RND_TEAM"]),
  assigneeName: z.string().min(1),
  reasonCode: z.enum([
    "manual_claim",
    "manual_escalation",
    "manual_resolution",
    "manual_waiting_customer",
    "ai_model_escalation",
    "integration_failure",
    "customer_reply"
  ])
});

export const ticketInternalTransitionSchema = z.object({
  to: ticketStatusSchema,
  reasonCode: z.enum([
    "manual_escalation",
    "manual_resolution",
    "manual_waiting_customer",
    "customer_reply"
  ])
});

export type TicketStatus = z.infer<typeof ticketStatusSchema>;
export type TicketCreateInput = z.infer<typeof ticketCreateSchema>;
export type TicketReplyInput = z.infer<typeof ticketReplySchema>;
export type TicketAssignInput = z.infer<typeof ticketAssignSchema>;
export type TicketInternalTransitionInput = z.infer<typeof ticketInternalTransitionSchema>;
