import { z } from "zod";

export const kbRepoRegistrationSchema = z.object({
  repoUrl: z.string().min(1),
  defaultBranch: z.string().min(1).default("main"),
  includePaths: z.array(z.string().min(1)).default(["**/*.md"]),
  excludePaths: z.array(z.string().min(1)).default([]),
  pollingIntervalSeconds: z.coerce.number().int().min(30).max(86400).default(300),
  actor: z.string().min(1).default("internal_operator")
});

export const kbEnqueueSyncSchema = z.object({
  repoId: z.string().uuid(),
  branch: z.string().min(1).default("main"),
  mode: z.enum(["full", "incremental", "reindex"]).default("full"),
  source: z.enum(["manual", "webhook", "polling", "system"]).default("manual"),
  beforeCommitSha: z.string().min(6).optional(),
  afterCommitSha: z.string().min(6).optional(),
  idempotencyKey: z.string().min(1).optional(),
  payload: z.record(z.string(), z.unknown()).default({})
});

export const kbRunJobsSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(10)
});

export const kbRetrievalQuerySchema = z.object({
  query: z.string().min(2),
  profile: z.enum(["search", "agent"]).default("search"),
  repoId: z.string().uuid().optional(),
  branch: z.string().min(1).optional(),
  topK: z.coerce.number().int().min(1).max(30).optional(),
  includeFallback: z.coerce.boolean().default(true)
});

export const kbWebhookHeadersSchema = z.object({
  event: z.string().min(1),
  delivery: z.string().min(1),
  signature256: z.string().min(1).optional()
});

export const kbEvaluateQuerySetSchema = z.object({
  repoId: z.string().uuid(),
  branch: z.string().default("main"),
  profile: z.enum(["search", "agent"]).default("search"),
  datasetPath: z.string().min(1),
  topK: z.coerce.number().int().min(1).max(30).default(5)
});
