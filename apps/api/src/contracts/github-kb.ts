import { z } from "zod";

const kbKnowledgeSpaceSchema = z.enum(["support-prod", "support-preview", "support-local", "support-shadow", "support-eval"]);
const kbPublicationModeSchema = z.enum(["build_only", "publish_inline"]);
const kbEmbeddingModeSchema = z.enum(["disabled", "best_effort", "required"]);

export const kbRepoRegistrationSchema = z.object({
  repoUrl: z.string().min(1),
  publicBaseUrl: z.string().url().optional(),
  defaultBranch: z.string().min(1).default("main"),
  includePaths: z.array(z.string().min(1)).default(["**/*.md", "**/*.mdx"]),
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

export const kbDocsComEnsureSchema = z.object({
  mode: z.enum(["incremental", "full", "reindex"]).default("incremental"),
  actor: z.string().min(1).default("internal_operator"),
  runLimit: z.coerce.number().int().min(0).max(20).default(0),
  publicationMode: kbPublicationModeSchema.default("build_only"),
  embeddingMode: kbEmbeddingModeSchema.default("best_effort")
});

export const kbDocsComStatusQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(10)
});

export const kbBuildsFullSchema = z.object({
  repoId: z.string().uuid(),
  branch: z.string().min(1).optional(),
  actor: z.string().min(1).default("internal_operator"),
  knowledgeSpace: kbKnowledgeSpaceSchema.optional(),
  publicationMode: kbPublicationModeSchema.default("build_only"),
  embeddingMode: kbEmbeddingModeSchema.default("best_effort")
});

export const kbBuildsIncrementalSchema = z.object({
  repoId: z.string().uuid(),
  branch: z.string().min(1).optional(),
  actor: z.string().min(1).default("internal_operator"),
  knowledgeSpace: kbKnowledgeSpaceSchema.optional(),
  publicationMode: kbPublicationModeSchema.default("build_only"),
  embeddingMode: kbEmbeddingModeSchema.default("best_effort")
});

export const kbPublicationPromoteSchema = z.object({
  buildId: z.string().uuid(),
  actor: z.string().min(1).default("internal_operator")
});

export const kbPublicationStatusQuerySchema = z.object({
  repoId: z.string().uuid().optional(),
  branch: z.string().min(1).optional(),
  knowledgeSpace: kbKnowledgeSpaceSchema.optional()
});

export const kbCleanupDryRunQuerySchema = z.object({
  repoId: z.string().uuid().optional(),
  branch: z.string().min(1).optional(),
  knowledgeSpace: kbKnowledgeSpaceSchema.optional(),
  staleAgeHours: z.coerce.number().int().min(1).max(24 * 365).default(72)
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
