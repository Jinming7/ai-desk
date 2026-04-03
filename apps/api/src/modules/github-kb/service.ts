import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { access, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import zlib from "node:zlib";
import { env } from "../../config/env.js";
import { buildChunks } from "./chunker.js";
import { embedText, toVectorLiteral } from "./embedding.js";
import { buildRepositoryKnowledgeArtifacts } from "./builders/repository-knowledge-builder.js";
import { buildDocumentRetrievalUnits } from "./builders/document-builder.js";
import { classifySourceFamily } from "./parsers/source-classifier.js";
import { buildDocsComSourceManifest, type DocsComSourceManifest } from "./source/manifest-builder.js";
import { isPathIncluded } from "./source/path-glob.js";
import {
  assertGithubReadOnlyMethod,
  buildSourceUrl,
  compareCommits,
  getBranchHead,
  getFileContentAtCommit,
  getFileContentBufferAtCommit,
  getRepositoryDefaultBranch,
  getRepoFullName,
  getDocsComCanonicalSource,
  listFilesAtCommit,
  resolveRepoProviderKind,
  validateReadOnlyAccess
} from "./repo-provider.js";
import { parseMarkdownSections } from "./markdown.js";
import { buildDocChunkCitations } from "./chunkers/doc-citation-builder.js";
import { generateMemoryEntriesFromRetrievalUnits } from "./memory/generate-memory-entries.js";
import type { MemoryCaseFrame, SupportExactSignals } from "./memory-types.js";
import { retrieveGroundedMemoryHits, syncDocumentMemoryGraph } from "./memory-service.js";
import { buildPublicSourceUrl } from "./public-url.js";
import * as repo from "./repository.js";
import { canPublishToKnowledgeSpace, resolveRequestedFromEnv, resolveRuntimeKnowledgeSpace } from "./runtime-space.js";
import type {
  GitHubTreeFile,
  KbBuild,
  KbBuildPublicationMode,
  KbEmbeddingMode,
  KbFullSyncShardKey,
  KbKnowledgeSpace,
  KbPublication,
  KbRequestedFromEnv,
  KbSyncJobStatus,
  SyncCheckpoint,
  KbSyncManifestItem,
  KbSyncRun,
  KbSyncRunShard,
  KbSyncSource,
  RepoRegistration,
  RetrievalHit,
  RetrievalProfile,
  RetrievalResponse,
  SyncJob
} from "./types.js";

const RETRIEVAL_CACHE_TTL_MS = 90_000;
const RETRIEVAL_CACHE_MAX = 300;
const retrievalCache = new Map<string, { expiresAt: number; value: RetrievalResponse }>();
const EMBEDDING_CIRCUIT_BREAKER_MS = 10 * 60 * 1000;
let embeddingDisabledUntil = 0;
let embeddingDisabledReason = "";
const LOCAL_DOCS_SUPPORTED_ROOTS = ["docs", "deploy-docs", "open-docs", "i18n", "blog"];
const LOCAL_DOCS_SKIP_DIRS = new Set([".git", ".github", ".claude", "node_modules", ".docusaurus", "build", "dist"]);
const SUPPORTED_KNOWLEDGE_FILE_RE = /\.(md|mdx|ya?ml|json|toml|sql|ddl|ts|tsx|js|jsx|mjs|cjs|go|py|java|rb|php|rs)$/i;
const DEFAULT_BOOTSTRAP_INCLUDE_PATHS = ["**/*.md", "**/*.mdx"];
const DEFAULT_BOOTSTRAP_EXCLUDE_PATHS = [".claude/**", ".github/**", ".docusaurus/**", "node_modules/**", "build/**", "dist/**"];
const MAX_BOOTSTRAP_INCLUDE_PATHS = 64;
const DOCS_COM_REQUIRED_PREFIXES = ["docs/", "deploy-docs/", "open-docs/"];
const DOCS_COM_CANONICAL_SOURCE = getDocsComCanonicalSource();
const DOCS_COM_CANONICAL_PROJECT_PARTS = DOCS_COM_CANONICAL_SOURCE.projectPath.split("/").filter(Boolean);
if (DOCS_COM_CANONICAL_PROJECT_PARTS.length < 2) {
  throw new Error(`Invalid docs-com canonical project path: ${DOCS_COM_CANONICAL_SOURCE.projectPath}`);
}
const DOCS_COM_REPO_OWNER = DOCS_COM_CANONICAL_PROJECT_PARTS[0];
const DOCS_COM_REPO_NAME = DOCS_COM_CANONICAL_PROJECT_PARTS[1];
const DOCS_COM_LEGACY_REPO_OWNERS = new Set(["bangwork"]);
const DOCS_COM_DEFAULT_BRANCH = DOCS_COM_CANONICAL_SOURCE.defaultBranch;
const DOCS_COM_REPO_URL = DOCS_COM_CANONICAL_SOURCE.repoUrl;
const DOCS_COM_PUBLIC_BASE_URL = DOCS_COM_CANONICAL_SOURCE.publicBaseUrl;
const DEFAULT_EMBEDDING_MODE: KbEmbeddingMode = "best_effort";
const REMOTE_MANIFEST_CHECKSUM_CONCURRENCY = 4;
const DOCUMENT_MUTATION_LOCK_TTL_SECONDS = 300;
const DOCUMENT_MUTATION_LOCK_RETRY_MS = 100;
const DOCUMENT_MUTATION_LOCK_MAX_WAIT_MS = 300_000;

export { buildGitLabSourceUrl, getDocsComCanonicalSource, resolveRepoProviderKind, validateGitLabPatScopes } from "./repo-provider.js";

interface GithubKbIndexDocumentInput {
  registration: RepoRegistration;
  knowledgeSpace: KbKnowledgeSpace;
  branch: string;
  commitSha: string;
  path: string;
  buildVersion?: string;
  publicationMode?: KbBuildPublicationMode;
  embeddingMode?: KbEmbeddingMode;
}

export const githubKbServiceDeps = {
  updateManifestItemBuildStatus(input: Parameters<typeof repo.updateManifestItemBuildStatus>[0]) {
    return repo.updateManifestItemBuildStatus(input);
  },
  indexDocument(input: GithubKbIndexDocumentInput) {
    return indexDocument(input.registration, input.knowledgeSpace, input.branch, input.commitSha, input.path, {
      buildVersion: input.buildVersion,
      publicationMode: input.publicationMode,
      embeddingMode: input.embeddingMode
    });
  },
  getBuildByVersion(input: Parameters<typeof repo.getBuildByVersion>[0]) {
    return repo.getBuildByVersion(input);
  },
  updateBuildStatus(input: Parameters<typeof repo.updateBuildStatus>[0]) {
    return repo.updateBuildStatus(input);
  },
  acquireIngestLease(input: Parameters<typeof repo.acquireIngestLease>[0]) {
    return repo.acquireIngestLease(input);
  },
  releaseIngestLease(leaseKey: string, ownerId?: string) {
    return repo.releaseIngestLease(leaseKey, ownerId);
  }
};

interface SyncExecutionResult {
  indexed: number;
  head: string;
  finished: boolean;
  nextCursor: string | null;
  deactivated?: number;
  removed?: number;
}

interface LocalMirrorBatchResult extends SyncExecutionResult {
  deactivated: number;
  total: number;
  remaining: number;
}

interface RemoteBatchResult extends SyncExecutionResult {
  deactivated: number;
  total: number;
  remaining: number;
}

interface LocalDocsMirrorState {
  rootDir: string;
  head: string;
  branch: string;
  markdownCount: number;
}

interface LocalDocsMirrorDiagnostics {
  enabled: boolean;
  path: string;
  available: boolean;
  valid: boolean;
  reason: string | null;
  head: string | null;
  branch: string | null;
  markdownCount: number;
}

interface DocsComSourceCorpusSnapshot {
  mode: "local_mirror" | "remote";
  branch: string;
  head: string;
  total: number;
  corpus: Array<{ prefix: string; total: number }>;
  diagnostics?: {
    localMirror: LocalDocsMirrorDiagnostics;
  };
  errorMessage?: string;
}

interface FrozenDocsComSourceSnapshot {
  mode: "local_mirror" | "remote";
  branch: string;
  head: string;
  files: GitHubTreeFile[];
  localMirror?: LocalDocsMirrorState;
}

type LocalMirrorRegistrationTarget = Pick<
  RepoRegistration,
  "repo_owner" | "repo_name" | "default_branch" | "include_paths" | "exclude_paths"
>;

function sha256(input: string): string {
  return crypto.createHash("sha256").update(input).digest("hex");
}

function sha256Buffer(input: Buffer): string {
  return crypto.createHash("sha256").update(input).digest("hex");
}

function gitBlobSha(input: Buffer): string {
  return crypto
    .createHash("sha1")
    .update(`blob ${input.byteLength}\0`)
    .update(input)
    .digest("hex");
}

function parseRepoOwnerName(repoUrl: string): { owner: string; name: string } {
  if (repoUrl.startsWith("mock://")) {
    const parts = repoUrl.replace("mock://", "").split("/").filter(Boolean);
    if (parts.length < 2) throw new Error(`Invalid mock repo url: ${repoUrl}`);
    return { owner: parts[0], name: parts[1] };
  }

  const url = new URL(repoUrl);
  const parts = url.pathname.replace(/^\//, "").replace(/\.git$/i, "").split("/").filter(Boolean);
  if (parts.length < 2) throw new Error(`Invalid repository url: ${repoUrl}`);
  return { owner: parts[0], name: parts[1] };
}

function isCanonicalDocsComRepo(owner: string, name: string): boolean {
  return owner.toLowerCase() === DOCS_COM_REPO_OWNER.toLowerCase() && name.toLowerCase() === DOCS_COM_REPO_NAME.toLowerCase();
}

function isDocsComRepo(owner: string, name: string): boolean {
  const normalizedOwner = owner.toLowerCase();
  return name.toLowerCase() === DOCS_COM_REPO_NAME.toLowerCase() &&
    (normalizedOwner === DOCS_COM_REPO_OWNER.toLowerCase() || DOCS_COM_LEGACY_REPO_OWNERS.has(normalizedOwner));
}

function isDocsComRegistration(registration: RepoRegistration): boolean {
  return isDocsComRepo(registration.repo_owner, registration.repo_name);
}

function isCanonicalDocsComRegistration(registration: RepoRegistration): boolean {
  return (
    isCanonicalDocsComRepo(registration.repo_owner, registration.repo_name) &&
    registration.repo_url === DOCS_COM_REPO_URL &&
    registration.default_branch === DOCS_COM_DEFAULT_BRANCH &&
    registration.public_base_url === DOCS_COM_PUBLIC_BASE_URL
  );
}

function hasIncludePattern(includePaths: string[], extension: "md" | "mdx"): boolean {
  const normalizedExtension = extension.toLowerCase();
  return includePaths.some((item) => {
    const pattern = String(item ?? "").trim().toLowerCase();
    if (!pattern) return false;
    return pattern.includes(`.${normalizedExtension}`) || pattern.includes(`*.${normalizedExtension}`);
  });
}

export function ensureMarkdownCoverage(includePaths: string[]): string[] {
  const next = [...includePaths];
  if (!hasIncludePattern(next, "md")) next.push("**/*.md");
  if (!hasIncludePattern(next, "mdx")) next.push("**/*.mdx");
  return uniqueStrings(next, MAX_BOOTSTRAP_INCLUDE_PATHS);
}

export function isValidGitCommitSha(value: string | null | undefined): boolean {
  return /^[0-9a-f]{7,40}$/i.test(String(value ?? "").trim());
}

export function resolveBootstrapIncludePaths(raw: string): string[] {
  const parsed = raw
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  const includePaths = uniqueStrings(parsed, MAX_BOOTSTRAP_INCLUDE_PATHS);
  return includePaths.length ? includePaths : [...DEFAULT_BOOTSTRAP_INCLUDE_PATHS];
}

function deriveSyncExecutionId(seed: string): string {
  const normalized = String(seed ?? "").trim() || "sync-execution";
  return `sync-exec:${sha256(normalized).slice(0, 24)}`;
}

function buildExecutionScopedBuildVersion(targetHead: string, executionId: string): string {
  const normalizedHead = String(targetHead ?? "").trim();
  const normalizedExecutionId = String(executionId ?? "").trim();
  if (!normalizedHead) return normalizedExecutionId;
  if (!normalizedExecutionId) return normalizedHead;
  return `${normalizedHead}:${normalizedExecutionId}`;
}

export function resolveSyncExecutionId(payload: Record<string, unknown> | null | undefined, fallbackSeed: string): string {
  const explicit = String(payload?.executionId ?? "").trim();
  return explicit || deriveSyncExecutionId(fallbackSeed);
}

export function buildEnqueuedSyncPayload(input: {
  mode: "full" | "incremental" | "reindex";
  idempotencyKey: string;
  knowledgeSpace: KbKnowledgeSpace;
  requestedFromEnv?: KbRequestedFromEnv;
  afterCommitSha?: string;
  payload?: Record<string, unknown>;
}): Record<string, unknown> {
  const executionId = resolveSyncExecutionId(input.payload, input.idempotencyKey);
  return {
    ...(input.payload ?? {}),
    knowledgeSpace: input.knowledgeSpace,
    requestedFromEnv: input.requestedFromEnv ?? resolveRequestedFromEnv(),
    executionId,
    ...(input.mode === "full" && input.afterCommitSha
      ? {
          buildVersion:
            String(input.payload?.buildVersion ?? "").trim() || buildExecutionScopedBuildVersion(input.afterCommitSha, executionId)
        }
      : {})
  };
}

export function buildDocsComIncludePaths(raw: string): string[] {
  const parsed = resolveBootstrapIncludePaths(raw);
  const docsComPrefixes = DOCS_COM_REQUIRED_PREFIXES.map((prefix) => prefix.toLowerCase());
  const filtered = parsed.filter((item) => docsComPrefixes.some((prefix) => item.toLowerCase().startsWith(prefix)));
  const defaults = DOCS_COM_REQUIRED_PREFIXES.flatMap((prefix) => [`${prefix}*.md`, `${prefix}*.mdx`, `${prefix}**/*.md`, `${prefix}**/*.mdx`]);
  return ensureMarkdownCoverage(filtered.length ? filtered : defaults);
}

function resolveBootstrapExcludePaths(raw: string): string[] {
  const parsed = raw
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  const excludePaths = uniqueStrings(parsed, 16);
  return excludePaths.length ? excludePaths : [...DEFAULT_BOOTSTRAP_EXCLUDE_PATHS];
}

function buildDocsComRegistrationInput(actor: string) {
  return {
    repoUrl: DOCS_COM_REPO_URL,
    publicBaseUrl: DOCS_COM_PUBLIC_BASE_URL,
    defaultBranch: DOCS_COM_DEFAULT_BRANCH,
    includePaths: buildDocsComIncludePaths(env.GITHUB_KB_BOOTSTRAP_INCLUDE_PATHS),
    excludePaths: resolveBootstrapExcludePaths(env.GITHUB_KB_BOOTSTRAP_EXCLUDE_PATHS),
    pollingIntervalSeconds: env.GITHUB_KB_BOOTSTRAP_POLLING_INTERVAL_SECONDS,
    actor
  };
}

async function getDocsComRegistration(): Promise<RepoRegistration | null> {
  const registrations = (await repo.listActiveRepoRegistrations())
    .filter((item) => item.default_branch === DOCS_COM_DEFAULT_BRANCH && isDocsComRegistration(item))
    .sort((left, right) => {
      const canonicalDiff = Number(isCanonicalDocsComRegistration(right)) - Number(isCanonicalDocsComRegistration(left));
      if (canonicalDiff !== 0) {
        return canonicalDiff;
      }
      return new Date(right.updated_at).getTime() - new Date(left.updated_at).getTime();
    });

  return registrations[0] ?? null;
}

async function deactivateLegacyDocsComRegistrations(keepRepoId: string, actor: string): Promise<void> {
  const registrations = await repo.listActiveRepoRegistrations();
  for (const registration of registrations) {
    if (registration.id === keepRepoId) continue;
    if (registration.default_branch !== DOCS_COM_DEFAULT_BRANCH) continue;
    if (!isDocsComRegistration(registration)) continue;
    await repo.deactivateRepoRegistration(registration.id, actor);
  }
}

function summarizePrefixTotals(paths: string[]): Array<{ prefix: string; total: number }> {
  return DOCS_COM_REQUIRED_PREFIXES.map((prefix) => ({
    prefix,
    total: paths.filter((item) => item.startsWith(prefix)).length
  }));
}

function classifyDocsComShard(pathname: string): KbFullSyncShardKey | null {
  if (pathname.startsWith("deploy-docs/")) return "deploy-docs";
  if (pathname.startsWith("docs/")) return "docs";
  if (pathname.startsWith("open-docs/")) return "open-docs";
  return null;
}

function buildFullRunBuildVersion(targetHead: string, runId: string): string {
  return `${targetHead}:${runId}`;
}

function buildKnowledgeSpaceLeaseKey(knowledgeSpace: KbKnowledgeSpace, repoId: string, branch: string): string {
  return `build:${knowledgeSpace}:${repoId}:${branch}`;
}

function buildPublicationLeaseKey(knowledgeSpace: KbKnowledgeSpace, repoId: string, branch: string): string {
  return `publish:${knowledgeSpace}:${repoId}:${branch}`;
}

function buildDocumentMutationLockKey(input: {
  knowledgeSpace: KbKnowledgeSpace;
  repoId: string;
  branch: string;
  buildVersion: string;
  path: string;
}): string {
  return `document:${input.knowledgeSpace}:${input.repoId}:${input.branch}:${input.buildVersion}:${input.path}`;
}

function buildGenericBuildBatchLockKey(input: {
  knowledgeSpace: KbKnowledgeSpace;
  repoId: string;
  branch: string;
  buildVersion: string;
}): string {
  return `build-batch:${input.knowledgeSpace}:${input.repoId}:${input.branch}:${input.buildVersion}`;
}

async function withLeaseMutex<T>(input: {
  leaseKey: string;
  ownerPrefix: string;
  metadata: Record<string, unknown>;
}, work: () => Promise<T>): Promise<T> {
  const lockKey = input.leaseKey;
  const ownerId = `${input.ownerPrefix}:${crypto.randomUUID()}`;
  const ownerEnv = resolveRequestedFromEnv();
  const leaseInput = {
    leaseKey: lockKey,
    ownerId,
    ownerEnv,
    ttlSeconds: DOCUMENT_MUTATION_LOCK_TTL_SECONDS,
    metadata: input.metadata
  };
  const startedAt = Date.now();

  while (true) {
    try {
      await githubKbServiceDeps.acquireIngestLease(leaseInput);
      break;
    } catch (error) {
      const message = (error as Error).message;
      if (!/lease is already held/i.test(message)) {
        throw error;
      }
      if (Date.now() - startedAt >= DOCUMENT_MUTATION_LOCK_MAX_WAIT_MS) {
        throw new Error(`Timed out waiting for document mutation lock ${lockKey}`);
      }
      await new Promise((resolve) => setTimeout(resolve, DOCUMENT_MUTATION_LOCK_RETRY_MS));
    }
  }

  const renewTimer = setInterval(() => {
    void githubKbServiceDeps.acquireIngestLease(leaseInput).catch(() => undefined);
  }, Math.max(30_000, Math.floor((DOCUMENT_MUTATION_LOCK_TTL_SECONDS * 1000) / 2)));
  renewTimer.unref?.();

  try {
    return await work();
  } finally {
    clearInterval(renewTimer);
    await githubKbServiceDeps.releaseIngestLease(lockKey, ownerId).catch(() => undefined);
  }
}

export async function withBuildDocumentMutationLock<T>(
  input: {
    knowledgeSpace: KbKnowledgeSpace;
    repoId: string;
    branch: string;
    buildVersion: string;
    path: string;
  },
  work: () => Promise<T>
): Promise<T> {
  return withLeaseMutex(
    {
      leaseKey: buildDocumentMutationLockKey(input),
      ownerPrefix: "document-lock",
      metadata: {
        buildVersion: input.buildVersion,
        path: input.path,
        scope: "document_mutation"
      }
    },
    work
  );
}

export async function withGenericBuildBatchLock<T>(
  input: {
    knowledgeSpace: KbKnowledgeSpace;
    repoId: string;
    branch: string;
    buildVersion: string;
  },
  work: () => Promise<T>
): Promise<T> {
  return withLeaseMutex(
    {
      leaseKey: buildGenericBuildBatchLockKey(input),
      ownerPrefix: "build-batch-lock",
      metadata: {
        buildVersion: input.buildVersion,
        scope: "generic_build_batch"
      }
    },
    work
  );
}

function parseKnowledgeSpace(value: unknown): KbKnowledgeSpace | null {
  if (
    value === "support-prod" ||
    value === "support-preview" ||
    value === "support-local" ||
    value === "support-shadow" ||
    value === "support-eval"
  ) {
    return value;
  }
  return null;
}

function parseRequestedFromEnv(value: unknown): KbRequestedFromEnv | null {
  if (value === "local" || value === "preview" || value === "prod" || value === "operator") {
    return value;
  }
  return null;
}

function parsePublicationMode(value: unknown): KbBuildPublicationMode | null {
  return value === "build_only" || value === "publish_inline" ? value : null;
}

function parseEmbeddingMode(value: unknown): KbEmbeddingMode | null {
  return value === "disabled" || value === "best_effort" || value === "required" ? value : null;
}

function resolvePublicationModeFromPayload(
  payload: Record<string, unknown> | undefined,
  fallback: KbBuildPublicationMode
): KbBuildPublicationMode {
  return parsePublicationMode(payload?.publicationMode) ?? fallback;
}

function resolveEmbeddingModeFromPayload(payload: Record<string, unknown> | undefined): KbEmbeddingMode {
  return parseEmbeddingMode(payload?.embeddingMode) ?? DEFAULT_EMBEDDING_MODE;
}

function resolveJobKnowledgeSpace(job: SyncJob): KbKnowledgeSpace {
  return parseKnowledgeSpace(job.payload_json?.knowledgeSpace) ?? resolveRuntimeKnowledgeSpace();
}

export function shouldAdvanceFullSyncCheckpoint(publicationMode: KbBuildPublicationMode): boolean {
  return publicationMode === "publish_inline";
}

export function buildGenericSyncContinuationPayload(
  job: SyncJob,
  result: Pick<SyncExecutionResult, "head" | "nextCursor">
): Record<string, unknown> {
  const executionId = resolveSyncExecutionId(job.payload_json, job.id);
  const explicitBuildVersion = String(job.payload_json?.buildVersion ?? "").trim();
  return {
    ...job.payload_json,
    cursor: result.nextCursor,
    buildVersion: explicitBuildVersion || buildExecutionScopedBuildVersion(result.head, executionId),
    knowledgeSpace: String(job.payload_json?.knowledgeSpace ?? "").trim() || resolveRuntimeKnowledgeSpace(),
    requestedFromEnv: String(job.payload_json?.requestedFromEnv ?? "").trim() || resolveRequestedFromEnv(),
    executionId
  };
}

function resolveRequestedFromEnvForOperation(operatorOverride = false): KbRequestedFromEnv {
  return operatorOverride ? "operator" : resolveRequestedFromEnv();
}

function resolveRequestedFromEnvFromPayload(payload: Record<string, unknown> | null | undefined): KbRequestedFromEnv {
  return parseRequestedFromEnv(payload?.requestedFromEnv) ?? resolveRequestedFromEnv();
}

export async function renewBuildIngestLease(input: {
  knowledgeSpace: KbKnowledgeSpace;
  repoId: string;
  branch: string;
  ownerId: string;
  ownerEnv: KbRequestedFromEnv;
  buildVersion: string;
  source: "local_mirror" | "remote";
}): Promise<void> {
  try {
    await githubKbServiceDeps.acquireIngestLease({
      leaseKey: buildKnowledgeSpaceLeaseKey(input.knowledgeSpace, input.repoId, input.branch),
      ownerId: input.ownerId,
      ownerEnv: input.ownerEnv,
      ttlSeconds: 300,
      metadata: {
        buildVersion: input.buildVersion,
        source: input.source,
        executionId: input.ownerId
      }
    });
  } catch (error) {
    const message = (error as Error).message;
    if (/lease is already held/i.test(message)) {
      throw new Error(
        `Lost build ingest lease for ${input.knowledgeSpace}/${input.repoId}/${input.branch}/${input.buildVersion}: ${message}`
      );
    }
    throw error;
  }
}

export function resolvePublicationAwareIncrementalBase(input: {
  publication: Pick<KbPublication, "published_head" | "published_build_version"> | null;
  checkpoint?: Pick<SyncCheckpoint, "last_synced_commit_sha" | "last_full_synced_commit_sha"> | null;
}): { kind: "published"; commitSha: string; buildVersion: string } | { kind: "unavailable" } {
  const publishedHead = String(input.publication?.published_head ?? "").trim();
  const publishedBuildVersion = String(input.publication?.published_build_version ?? "").trim();
  if (!publishedHead || !publishedBuildVersion) {
    return { kind: "unavailable" };
  }
  return {
    kind: "published",
    commitSha: publishedHead,
    buildVersion: publishedBuildVersion
  };
}

export function buildPollingSyncRequestFromPublication(input: {
  latestHead: string;
  publication: Pick<KbPublication, "published_head" | "published_build_version"> | null;
  checkpoint?: Pick<SyncCheckpoint, "last_synced_commit_sha" | "last_full_synced_commit_sha"> | null;
}): { mode: "full" } | { mode: "incremental"; beforeCommitSha: string } | null {
  const baseline = resolvePublicationAwareIncrementalBase({
    publication: input.publication,
    checkpoint: input.checkpoint
  });
  if (baseline.kind === "unavailable") {
    return { mode: "full" };
  }
  if (baseline.commitSha === input.latestHead) {
    return null;
  }
  return {
    mode: "incremental",
    beforeCommitSha: baseline.commitSha
  };
}

async function ensureBuildRecord(input: {
  knowledgeSpace: KbKnowledgeSpace;
  repoId: string;
  branch: string;
  buildVersion: string;
  targetHead: string;
  buildKind: KbBuild["build_kind"];
  requestedBy: string;
  requestedFromEnv: KbRequestedFromEnv;
  sourceSnapshotTotal?: number;
}): Promise<KbBuild> {
  return repo.ensureBuild({
    knowledgeSpace: input.knowledgeSpace,
    repoId: input.repoId,
    branch: input.branch,
    buildVersion: input.buildVersion,
    targetHead: input.targetHead,
    buildKind: input.buildKind,
    requestedBy: input.requestedBy,
    requestedFromEnv: input.requestedFromEnv,
    sourceSnapshotTotal: input.sourceSnapshotTotal
  });
}

async function validateBuildForPublication(input: {
  knowledgeSpace: KbKnowledgeSpace;
  repoId: string;
  branch: string;
  buildVersion: string;
  buildId: string;
  requiredPrefixes?: string[];
}): Promise<{
  passed: boolean;
  summary: Record<string, unknown>;
}> {
  const snapshot = await repo.getBuildValidationSnapshot({
    knowledgeSpace: input.knowledgeSpace,
    repoId: input.repoId,
    branch: input.branch,
    buildVersion: input.buildVersion
  });
  const artifactSummary = await repo.getBuildArtifactSummary({
    knowledgeSpace: input.knowledgeSpace,
    repoId: input.repoId,
    branch: input.branch,
    buildVersion: input.buildVersion
  });
  const prefixRows = input.requiredPrefixes?.length
    ? await repo.countDocumentsByPathPrefixes({
        knowledgeSpace: input.knowledgeSpace,
        repoId: input.repoId,
        branch: input.branch,
        buildVersion: input.buildVersion,
        prefixes: input.requiredPrefixes
      })
    : [];

  const results: Array<{
    validationKind: string;
    passed: boolean;
    severity: "info" | "warn" | "error";
    summary: string;
    details: Record<string, unknown>;
  }> = [
    {
      validationKind: "document_count_match",
      passed: snapshot.totalDocuments > 0,
      severity: "error" as const,
      summary: snapshot.totalDocuments > 0 ? `build contains ${snapshot.totalDocuments} documents` : "build contains 0 documents",
      details: { totalDocuments: snapshot.totalDocuments }
    },
    {
      validationKind: "duplicate_active_guard",
      passed: snapshot.duplicatePaths === 0,
      severity: "error" as const,
      summary:
        snapshot.duplicatePaths === 0
          ? "no duplicate document paths found inside build"
          : `build contains ${snapshot.duplicatePaths} duplicate document paths`,
      details: { duplicatePaths: snapshot.duplicatePaths }
    },
    {
      validationKind: "chunk_orphan_check",
      passed: snapshot.orphanChunks === 0 && snapshot.missingChunkDocuments === 0,
      severity: "error" as const,
      summary:
        snapshot.orphanChunks === 0 && snapshot.missingChunkDocuments === 0
          ? "all chunks resolve to same-build documents"
          : `build contains ${snapshot.orphanChunks + snapshot.missingChunkDocuments} invalid chunk-document links`,
      details: {
        orphanChunks: snapshot.orphanChunks,
        missingChunkDocuments: snapshot.missingChunkDocuments
      }
    },
    {
      validationKind: "memory_source_integrity",
      passed: snapshot.crossBuildMemorySources === 0,
      severity: "error" as const,
      summary:
        snapshot.crossBuildMemorySources === 0
          ? "all memory sources resolve to same-build chunks"
          : `build contains ${snapshot.crossBuildMemorySources} cross-build memory sources`,
      details: { crossBuildMemorySources: snapshot.crossBuildMemorySources }
    },
    {
      validationKind: "manifest_complete",
      passed: true,
      severity: "info" as const,
      summary: "build artifact validation executed",
      details: {
        totalDocuments: snapshot.totalDocuments,
        totalChunks: snapshot.totalChunks,
        totalMemoryEntries: snapshot.totalMemoryEntries
      }
    },
    {
      validationKind: "parser_degradation_summary",
      passed: true,
      severity: artifactSummary.parserDegradation.degradedDocuments > 0 ? ("warn" as const) : ("info" as const),
      summary:
        artifactSummary.parserDegradation.degradedDocuments > 0
          ? `${artifactSummary.parserDegradation.degradedDocuments} documents used degraded parser paths`
          : "all documents used canonical parser paths",
      details: artifactSummary.parserDegradation
    },
    {
      validationKind: "embedding_summary",
      passed: true,
      severity:
        artifactSummary.embeddingSummary.chunkEmbeddings.missing > 0 || artifactSummary.embeddingSummary.citationEmbeddings.missing > 0
          ? ("warn" as const)
          : ("info" as const),
      summary:
        artifactSummary.embeddingSummary.chunkEmbeddings.missing > 0 || artifactSummary.embeddingSummary.citationEmbeddings.missing > 0
          ? "some embeddings are missing for build artifacts"
          : "all chunk and citation embeddings are present",
      details: artifactSummary.embeddingSummary
    }
  ];

  for (const row of prefixRows) {
    results.push({
      validationKind: `required_doc_family:${row.prefix}`,
      passed: row.active > 0,
      severity: "error" as const,
      summary: row.active > 0 ? `${row.prefix} present in build` : `${row.prefix} missing from build`,
      details: { prefix: row.prefix, total: row.total, active: row.active }
    });
  }

  await repo.replaceBuildValidationResults({
    buildId: input.buildId,
    results
  });

  const passed = results.every((item) => item.passed || item.severity !== "error");
  const summary = {
    totalChecks: results.length,
    failedChecks: results.filter((item) => !item.passed).map((item) => item.validationKind),
    snapshot,
    artifactSummary
  };

  await repo.updateBuildStatus({
    buildId: input.buildId,
    status: passed ? "validated" : "failed",
    validationPassed: passed,
    validationSummary: summary,
    errorMessage: passed ? null : `validation failed for build ${input.buildVersion}`,
    finished: !passed
  });

  return { passed, summary };
}

async function publishValidatedBuild(input: {
  knowledgeSpace: KbKnowledgeSpace;
  repoId: string;
  branch: string;
  buildId: string;
  buildVersion: string;
  targetHead: string;
  publishedBy: string;
  publishedFromEnv: KbRequestedFromEnv;
}): Promise<void> {
  const publicationLeaseKey = buildPublicationLeaseKey(input.knowledgeSpace, input.repoId, input.branch);
  await repo.acquireIngestLease({
    leaseKey: publicationLeaseKey,
    ownerId: input.buildId,
    ownerEnv: input.publishedFromEnv,
    ttlSeconds: 300,
    metadata: {
      buildVersion: input.buildVersion,
      branch: input.branch
    }
  });
  try {
    const previousPublication = await repo.getPublication({
      knowledgeSpace: input.knowledgeSpace,
      repoId: input.repoId,
      branch: input.branch
    });
    await repo.upsertPublication({
      knowledgeSpace: input.knowledgeSpace,
      repoId: input.repoId,
      branch: input.branch,
      publishedBuildVersion: input.buildVersion,
      publishedHead: input.targetHead,
      publishedBy: input.publishedBy,
      publishedFromEnv: input.publishedFromEnv
    });
    await repo.upsertServingVersion({
      repoId: input.repoId,
      branch: input.branch,
      activeBuildVersion: input.buildVersion,
      activeHead: input.targetHead
    });
    await repo.updateBuildStatus({
      buildId: input.buildId,
      status: "published",
      validationPassed: true,
      finished: true
    });
    if (previousPublication && previousPublication.published_build_version !== input.buildVersion) {
      const previousBuild = await repo.getBuildByVersion({
        knowledgeSpace: input.knowledgeSpace,
        repoId: input.repoId,
        branch: input.branch,
        buildVersion: previousPublication.published_build_version
      });
      if (previousBuild) {
        await repo.updateBuildStatus({
          buildId: previousBuild.id,
          status: "superseded",
          finished: true
        });
      }
    }
  } finally {
    await repo.releaseIngestLease(publicationLeaseKey, input.buildId).catch(() => undefined);
  }
}

async function finalizeBuild(input: {
  knowledgeSpace: KbKnowledgeSpace;
  repoId: string;
  branch: string;
  buildVersion: string;
  targetHead: string;
  buildKind: KbBuild["build_kind"];
  requestedBy: string;
  requestedFromEnv: KbRequestedFromEnv;
  publicationMode: KbBuildPublicationMode;
  embeddingMode?: KbEmbeddingMode;
  sourceSnapshotTotal?: number;
  requiredPrefixes?: string[];
}): Promise<KbBuild> {
  const build =
    (await repo.getBuildByVersion({
      knowledgeSpace: input.knowledgeSpace,
      repoId: input.repoId,
      branch: input.branch,
      buildVersion: input.buildVersion
    })) ??
    (await ensureBuildRecord({
      knowledgeSpace: input.knowledgeSpace,
      repoId: input.repoId,
      branch: input.branch,
      buildVersion: input.buildVersion,
      targetHead: input.targetHead,
      buildKind: input.buildKind,
      requestedBy: input.requestedBy,
      requestedFromEnv: input.requestedFromEnv,
      sourceSnapshotTotal: input.sourceSnapshotTotal
    }));

  await repo.updateBuildArtifactCounts({
    knowledgeSpace: input.knowledgeSpace,
    repoId: input.repoId,
    branch: input.branch,
    buildVersion: input.buildVersion
  });
  await repo.updateBuildStatus({
    buildId: build.id,
    status: "built",
    finished: false,
    errorMessage: null
  });
  const validation = await validateBuildForPublication({
    knowledgeSpace: input.knowledgeSpace,
    repoId: input.repoId,
    branch: input.branch,
    buildVersion: input.buildVersion,
    buildId: build.id,
    requiredPrefixes: input.requiredPrefixes
  });
  if (!validation.passed) {
    throw new Error(`Build validation failed for ${input.buildVersion}`);
  }
  if (input.publicationMode === "publish_inline") {
    if (!canPublishToKnowledgeSpace(input.requestedFromEnv, input.knowledgeSpace)) {
      throw new Error(`Environment ${input.requestedFromEnv} cannot publish into ${input.knowledgeSpace}`);
    }
    await publishValidatedBuild({
      knowledgeSpace: input.knowledgeSpace,
      repoId: input.repoId,
      branch: input.branch,
      buildId: build.id,
      buildVersion: input.buildVersion,
      targetHead: input.targetHead,
      publishedBy: input.requestedBy,
      publishedFromEnv: input.requestedFromEnv
    });
  }
  return (await repo.getBuildById(build.id)) ?? build;
}

async function freezeDocsComSourceSnapshot(registration: RepoRegistration, branch?: string): Promise<FrozenDocsComSourceSnapshot> {
  const localMirror = await getLocalDocsMirrorState(registration);
  if (localMirror) {
    const visibleFiles = await collectLocalMirrorManifestSnapshot(localMirror);
    const files: GitHubTreeFile[] = [];
    for (const relativePath of visibleFiles) {
      const absolutePath = path.join(localMirror.rootDir, relativePath);
      const content = await readFile(absolutePath);
      files.push({
        path: relativePath,
        sha: gitBlobSha(content),
        contentChecksum: sha256Buffer(content),
        size: content.byteLength,
        type: "blob"
      });
    }
    return {
      mode: "local_mirror",
      branch: branch || registration.default_branch || DOCS_COM_DEFAULT_BRANCH,
      head: localMirror.head,
      files,
      localMirror
    };
  }

  const resolved = await resolveRegistrationBranch(registration, branch || registration.default_branch || DOCS_COM_DEFAULT_BRANCH, "full_run_plan");
  const head = await getBranchHead(resolved.registration, resolved.branch);
  const files = (await listFilesAtCommit(resolved.registration, head)).sort((left, right) => compareSnapshotPaths(left.path, right.path));

  return {
    mode: "remote",
    branch: resolved.branch,
    head,
    files
  };
}

async function mapWithConcurrency<T, R>(items: T[], limit: number, worker: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const normalizedLimit = Math.max(1, Math.min(limit, items.length || 1));
  const results = new Array<R>(items.length);
  let cursor = 0;

  const runWorker = async () => {
    while (true) {
      const current = cursor;
      cursor += 1;
      if (current >= items.length) return;
      results[current] = await worker(items[current], current);
    }
  };

  await Promise.all(Array.from({ length: normalizedLimit }, () => runWorker()));
  return results;
}

export async function populateDocsComManifestEligibleChecksumsForSnapshot(input: {
  registration: RepoRegistration;
  targetHead: string;
  sourceMode: "local_mirror" | "remote";
  manifest: DocsComSourceManifest;
  remoteConcurrency?: number;
  fetchContentBuffer?: (filePath: string) => Promise<Buffer>;
}): Promise<DocsComSourceManifest> {
  if (input.sourceMode !== "remote") {
    return input.manifest;
  }

  const eligibleWithoutChecksum = input.manifest.eligibleItems.filter((item) => !item.contentChecksum);
  if (!eligibleWithoutChecksum.length) {
    return input.manifest;
  }

  const fetchContentBuffer =
    input.fetchContentBuffer ??
    ((filePath: string) => getFileContentBufferAtCommit(input.registration, filePath, input.targetHead));

  const hydrated = await mapWithConcurrency(
    eligibleWithoutChecksum,
    input.remoteConcurrency ?? REMOTE_MANIFEST_CHECKSUM_CONCURRENCY,
    async (item) => ({
      path: item.path,
      contentChecksum: sha256Buffer(await fetchContentBuffer(item.path))
    })
  );

  const checksumByPath = new Map(hydrated.map((item) => [item.path, item.contentChecksum]));

  return {
    eligibleItems: input.manifest.eligibleItems.map((item) => ({
      ...item,
      contentChecksum: item.contentChecksum ?? checksumByPath.get(item.path) ?? null
    })),
    skippedItems: input.manifest.skippedItems
  };
}

function getFullRunPayload(job: SyncJob): null | {
  runId: string;
  shardKey: KbFullSyncShardKey;
  targetHead: string;
  buildVersion: string;
  sourceMode: "local_mirror" | "remote";
  cursor?: string;
} {
  const runId = String(job.payload_json?.runId ?? "").trim();
  const shardKey = String(job.payload_json?.shardKey ?? "").trim() as KbFullSyncShardKey;
  const targetHead = String(job.payload_json?.targetHead ?? "").trim();
  const buildVersion = String(job.payload_json?.buildVersion ?? "").trim();
  const sourceMode = String(job.payload_json?.sourceMode ?? "").trim() as "local_mirror" | "remote";
  const cursor = String(job.payload_json?.cursor ?? "").trim() || undefined;
  if (!runId || !targetHead || !buildVersion || !sourceMode) return null;
  if (!["deploy-docs", "docs", "open-docs"].includes(shardKey)) return null;
  if (sourceMode !== "local_mirror" && sourceMode !== "remote") return null;
  return { runId, shardKey, targetHead, buildVersion, sourceMode, cursor };
}

function resolveGenericSyncJobBuildVersion(job: SyncJob): string | null {
  const explicit = String(job.payload_json?.buildVersion ?? "").trim();
  if (explicit) return explicit;
  const targetHead = String(job.after_commit_sha ?? "").trim();
  if (!targetHead) return null;
  return buildExecutionScopedBuildVersion(targetHead, resolveSyncExecutionId(job.payload_json, job.id));
}

export async function handleTerminalGenericSyncJobFailure(input: {
  job: SyncJob;
  status: KbSyncJobStatus;
  errorMessage: string;
}): Promise<void> {
  if (input.status !== "dead_letter" || getFullRunPayload(input.job)) {
    return;
  }

  const knowledgeSpace = resolveJobKnowledgeSpace(input.job);
  const buildVersion = resolveGenericSyncJobBuildVersion(input.job);
  if (buildVersion) {
    const build = await githubKbServiceDeps.getBuildByVersion({
      knowledgeSpace,
      repoId: input.job.repo_id,
      branch: input.job.branch,
      buildVersion
    });
    if (build && (build.status === "building" || build.status === "built")) {
      await githubKbServiceDeps.updateBuildStatus({
        buildId: build.id,
        status: "failed",
        errorMessage: input.errorMessage,
        finished: true
      });
    }
  }

  await githubKbServiceDeps
    .releaseIngestLease(
      buildKnowledgeSpaceLeaseKey(knowledgeSpace, input.job.repo_id, input.job.branch),
      resolveSyncExecutionId(input.job.payload_json, input.job.id)
    )
    .catch(() => undefined);
}

async function summarizeDocsComSourceCorpus(registration: RepoRegistration): Promise<DocsComSourceCorpusSnapshot> {
  const localMirrorProbe = await inspectLocalDocsMirror(registration);
  if (localMirrorProbe.state) {
    const markdownFiles = await collectLocalMirrorSnapshot(registration, localMirrorProbe.state);
    return {
      mode: "local_mirror",
      branch: localMirrorProbe.state.branch || registration.default_branch || DOCS_COM_DEFAULT_BRANCH,
      head: localMirrorProbe.state.head,
      total: markdownFiles.length,
      corpus: summarizePrefixTotals(markdownFiles),
      diagnostics: {
        localMirror: localMirrorProbe.diagnostics
      }
    };
  }

  const resolved = await resolveRegistrationBranch(registration, registration.default_branch || DOCS_COM_DEFAULT_BRANCH, "status_probe");
  const head = await getBranchHead(resolved.registration, resolved.branch);
  const files = await listFilesAtCommit(resolved.registration, head);
  const markdownFiles = files
    .filter((file) => isSupportedKnowledgePath(file.path))
    .filter((file) => isPathIncluded(file.path, resolved.registration.include_paths, resolved.registration.exclude_paths))
    .map((file) => file.path)
    .sort((left, right) => left.localeCompare(right, "en"));

  return {
    mode: "remote",
    branch: resolved.branch,
    head,
    total: markdownFiles.length,
    corpus: summarizePrefixTotals(markdownFiles),
    diagnostics: {
      localMirror: localMirrorProbe.diagnostics
    }
  };
}

async function summarizeDocsComCorpus(registration: RepoRegistration, recentJobLimit = 10) {
  const branch = registration.default_branch || DOCS_COM_DEFAULT_BRANCH;
  const knowledgeSpace = resolveRuntimeKnowledgeSpace();
  const corpus = await repo.countDocumentsByPathPrefixes({
    knowledgeSpace,
    repoId: registration.id,
    branch,
    prefixes: DOCS_COM_REQUIRED_PREFIXES
  });
  const checkpoints = await repo.getCheckpoint(registration.id, branch);
  const servingVersion = await repo.getServingVersion(registration.id, branch);
  const activeRun = await repo.findActiveFullSyncRun(registration.id, branch);
  const activeRunShards = activeRun ? await repo.listSyncRunShards(activeRun.id) : [];
  const recentJobs = (await repo.listRecentSyncJobs(recentJobLimit)).filter((job) => job.repo_id === registration.id);
  const publications = await repo.listPublications({
    repoId: registration.id,
    branch
  });
  const health = await validateDocsComCorpusCoverage(registration, branch);
  const sourceSnapshot = await summarizeDocsComSourceCorpus(registration).catch((error) => ({
    mode: "remote" as const,
    branch,
    head: "",
    total: 0,
    corpus: DOCS_COM_REQUIRED_PREFIXES.map((prefix) => ({ prefix, total: 0 })),
    errorMessage: (error as Error).message,
    diagnostics: {
      localMirror: buildLocalDocsMirrorDiagnostics()
    }
  }));
  const sourceTotals = new Map(sourceSnapshot.corpus.map((item) => [item.prefix, item.total]));
  const kbTotals = corpus.reduce(
    (acc, item) => {
      acc.total += item.total;
      acc.active += item.active;
      return acc;
    },
    { total: 0, active: 0 }
  );
  return {
    registration: {
      id: registration.id,
      repo: `${registration.repo_owner}/${registration.repo_name}`,
      branch,
      knowledgeSpace,
      repoUrl: registration.repo_url,
      publicBaseUrl: registration.public_base_url,
      includePaths: registration.include_paths,
      excludePaths: registration.exclude_paths,
      lastValidationError: registration.last_validation_error
    },
    corpus: corpus.map((item) => ({
      prefix: item.prefix,
      total: item.total,
      active: item.active,
      sourceTotal: sourceTotals.get(item.prefix) ?? null,
      gap: typeof sourceTotals.get(item.prefix) === "number" ? Math.max(0, (sourceTotals.get(item.prefix) ?? 0) - item.active) : null
    })),
    sourceSnapshot: {
      mode: sourceSnapshot.mode,
      branch: sourceSnapshot.branch,
      head: sourceSnapshot.head || null,
      total: sourceSnapshot.total,
      errorMessage: "errorMessage" in sourceSnapshot ? sourceSnapshot.errorMessage : null,
      corpus: sourceSnapshot.corpus,
      diagnostics: sourceSnapshot.diagnostics ?? null
    },
    overview: {
      kbTotal: kbTotals.total,
      kbActive: kbTotals.active,
      sourceTotal: sourceSnapshot.total,
      activeCoverageRate: sourceSnapshot.total > 0 ? Number((kbTotals.active / sourceSnapshot.total).toFixed(4)) : null,
      syncGap: Math.max(0, sourceSnapshot.total - kbTotals.active)
    },
    checkpoint: checkpoints
      ? {
          lastSyncedCommitSha: checkpoints.last_synced_commit_sha,
          lastSyncedAt: checkpoints.last_synced_at,
          lastFullSyncedCommitSha: checkpoints.last_full_synced_commit_sha,
          lastFullSyncedAt: checkpoints.last_full_synced_at
        }
      : null,
    serving: servingVersion
      ? {
          activeBuildVersion: servingVersion.active_build_version,
          activeHead: servingVersion.active_head,
          activatedAt: servingVersion.activated_at
        }
      : null,
    publications: publications.map((item) => ({
      knowledgeSpace: item.knowledge_space,
      publishedBuildVersion: item.published_build_version,
      publishedHead: item.published_head,
      publishedBy: item.published_by,
      publishedFromEnv: item.published_from_env,
      publishedAt: item.published_at
    })),
    activeFullRun: activeRun
      ? {
          id: activeRun.id,
          targetHead: activeRun.target_head,
          status: activeRun.status,
          startedAt: activeRun.started_at,
          updatedAt: activeRun.updated_at,
          shards: activeRunShards.map((shard) => ({
            shardKey: shard.shard_key,
            totalDocs: shard.total_docs,
            completedDocs: shard.completed_docs,
            reusableDocs: shard.reusable_docs,
            rebuiltDocs: shard.rebuilt_docs,
            failedDocs: shard.failed_docs,
            nextCursor: shard.next_cursor,
            status: shard.status,
            lastHeartbeatAt: shard.last_heartbeat_at
          }))
        }
      : null,
    health,
    recentJobs: recentJobs.map((job) => ({
      id: job.id,
      mode: job.sync_mode,
      status: job.status,
      branch: job.branch,
      errorMessage: job.error_message,
      startedAt: job.started_at,
      finishedAt: job.finished_at,
      updatedAt: job.updated_at
    }))
  };
}

async function validateDocsComCorpusCoverage(
  registration: RepoRegistration,
  branch: string
): Promise<{ ok: boolean; message: string | null }> {
  if (!isDocsComRegistration(registration)) return { ok: true, message: null };

  const issues: string[] = [];
  if (!hasIncludePattern(registration.include_paths, "mdx")) {
    issues.push("include_paths do not cover *.mdx, so open-docs pages can be skipped during sync");
  }

  const counts = await repo
    .countDocumentsByPathPrefixes({
      knowledgeSpace: resolveRuntimeKnowledgeSpace(),
      repoId: registration.id,
      branch,
      prefixes: DOCS_COM_REQUIRED_PREFIXES
    })
    .catch(() => []);

  for (const prefix of DOCS_COM_REQUIRED_PREFIXES) {
    const row = counts.find((item) => item.prefix === prefix);
    if (!row) {
      issues.push(`${prefix} coverage could not be measured`);
      continue;
    }
    if (row.total === 0) {
      issues.push(`${prefix} has 0 indexed docs`);
      continue;
    }
    if (row.active === 0) {
      issues.push(`${prefix} has ${row.total} indexed docs but 0 active docs`);
    }
  }

  return {
    ok: issues.length === 0,
    message: issues.length ? issues.join("; ") : null
  };
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await access(targetPath);
    return true;
  } catch {
    return false;
  }
}

function readGitValue(rootDir: string, args: string[]): string | null {
  try {
    const value = execFileSync("git", ["-C", rootDir, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    return value || null;
  } catch {
    return null;
  }
}

function buildLocalDocsMirrorDiagnostics(): LocalDocsMirrorDiagnostics {
  return {
    enabled: env.GITHUB_KB_ENABLE_LOCAL_DOCS_MIRROR,
    path: env.LOCAL_DOCS_COM_PATH.trim(),
    available: false,
    valid: false,
    reason: null,
    head: null,
    branch: null,
    markdownCount: 0
  };
}

function warnLocalDocsMirror(reason: string, diagnostics: LocalDocsMirrorDiagnostics): void {
  console.warn(
    `[github-kb] ignoring local docs-com mirror: ${reason} (path=${diagnostics.path || "<empty>"} head=${diagnostics.head ?? "<none>"})`
  );
}

async function inspectLocalDocsMirror(
  registration: LocalMirrorRegistrationTarget
): Promise<{ state: LocalDocsMirrorState | null; diagnostics: LocalDocsMirrorDiagnostics }> {
  const diagnostics = buildLocalDocsMirrorDiagnostics();
  if (!isDocsComRepo(registration.repo_owner, registration.repo_name)) {
    diagnostics.reason = "not_docs_com_registration";
    return { state: null, diagnostics };
  }
  if (!diagnostics.enabled) {
    diagnostics.reason = "disabled_by_flag";
    return { state: null, diagnostics };
  }

  const rootDir = diagnostics.path;
  if (!rootDir) {
    diagnostics.reason = "missing_path";
    warnLocalDocsMirror(diagnostics.reason, diagnostics);
    return { state: null, diagnostics };
  }
  if (!(await pathExists(rootDir))) {
    diagnostics.reason = "path_not_found";
    warnLocalDocsMirror(diagnostics.reason, diagnostics);
    return { state: null, diagnostics };
  }
  diagnostics.available = true;

  const isWorkTree = readGitValue(rootDir, ["rev-parse", "--is-inside-work-tree"]);
  if (isWorkTree !== "true") {
    diagnostics.reason = "not_git_worktree";
    warnLocalDocsMirror(diagnostics.reason, diagnostics);
    return { state: null, diagnostics };
  }

  const head = readGitValue(rootDir, ["rev-parse", "HEAD"]);
  diagnostics.head = head;
  if (!isValidGitCommitSha(head)) {
    diagnostics.reason = "invalid_head";
    warnLocalDocsMirror(diagnostics.reason, diagnostics);
    return { state: null, diagnostics };
  }
  const validatedHead = String(head);

  const branch = readGitValue(rootDir, ["rev-parse", "--abbrev-ref", "HEAD"]) || registration.default_branch || DOCS_COM_DEFAULT_BRANCH;
  diagnostics.branch = branch;

  const state: LocalDocsMirrorState = {
    rootDir,
    head: validatedHead,
    branch,
    markdownCount: 0
  };
  const markdownFiles = await collectLocalMirrorSnapshot(registration, state);
  diagnostics.markdownCount = markdownFiles.length;
  if (!markdownFiles.length) {
    diagnostics.reason = "empty_markdown_snapshot";
    warnLocalDocsMirror(diagnostics.reason, diagnostics);
    return { state: null, diagnostics };
  }

  diagnostics.valid = true;
  state.markdownCount = markdownFiles.length;
  return { state, diagnostics };
}

export async function getLocalDocsMirrorState(registration: LocalMirrorRegistrationTarget): Promise<LocalDocsMirrorState | null> {
  const result = await inspectLocalDocsMirror(registration);
  return result.state;
}

async function collectLocalMirrorMarkdownFiles(
  rootDir: string,
  includePaths: string[],
  excludePaths: string[],
  relativeDir = ""
): Promise<string[]> {
  const dirPath = path.join(rootDir, relativeDir);
  const entries = await readdir(dirPath, { withFileTypes: true });
  const output: string[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".") && entry.name !== ".well-known") continue;
    if (entry.isDirectory()) {
      if (LOCAL_DOCS_SKIP_DIRS.has(entry.name)) continue;
      output.push(...(await collectLocalMirrorMarkdownFiles(rootDir, includePaths, excludePaths, path.join(relativeDir, entry.name))));
      continue;
    }
    if (!entry.isFile() || !(SUPPORTED_KNOWLEDGE_FILE_RE.test(entry.name) || /(^|\/)\.env(\.|$)/.test(entry.name))) continue;
    const relativePath = path.posix.join(relativeDir.split(path.sep).join(path.posix.sep), entry.name);
    if (isPathIncluded(relativePath, includePaths, excludePaths)) {
      output.push(relativePath);
    }
  }
  return output;
}

async function collectLocalMirrorVisibleFiles(rootDir: string, relativeDir = ""): Promise<string[]> {
  const dirPath = path.join(rootDir, relativeDir);
  const entries = await readdir(dirPath, { withFileTypes: true });
  const output: string[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".") && entry.name !== ".well-known") continue;
    if (entry.isDirectory()) {
      if (LOCAL_DOCS_SKIP_DIRS.has(entry.name)) continue;
      output.push(...(await collectLocalMirrorVisibleFiles(rootDir, path.join(relativeDir, entry.name))));
      continue;
    }
    if (!entry.isFile()) continue;
    output.push(path.posix.join(relativeDir.split(path.sep).join(path.posix.sep), entry.name));
  }
  return output;
}

async function collectLocalMirrorSnapshot(
  registration: LocalMirrorRegistrationTarget,
  localMirror: LocalDocsMirrorState
): Promise<string[]> {
  const fileGroups = await Promise.all(
    LOCAL_DOCS_SUPPORTED_ROOTS.map(async (subdir) =>
      ((await pathExists(path.join(localMirror.rootDir, subdir)))
        ? collectLocalMirrorMarkdownFiles(localMirror.rootDir, registration.include_paths, registration.exclude_paths, subdir)
        : Promise.resolve([]))
    )
  );
  return fileGroups.flat().sort((left, right) => left.localeCompare(right, "en"));
}

async function collectLocalMirrorManifestSnapshot(localMirror: LocalDocsMirrorState): Promise<string[]> {
  return (await collectLocalMirrorVisibleFiles(localMirror.rootDir)).sort(compareSnapshotPaths);
}

function compareSnapshotPaths(left: string, right: string): number {
  return left.localeCompare(right, "en");
}

export function sliceSnapshotForBackfill(paths: string[], cursor?: string, limit?: number): {
  files: string[];
  total: number;
  remaining: number;
  nextCursor: string | null;
  finished: boolean;
} {
  const normalizedLimit = Number.isFinite(limit) && (limit ?? 0) > 0 ? Math.max(1, Math.floor(limit as number)) : paths.length;
  const startIndex = cursor ? paths.findIndex((item) => compareSnapshotPaths(item, cursor) > 0) : 0;
  const safeStart = startIndex >= 0 ? startIndex : paths.length;
  const files = paths.slice(safeStart, safeStart + normalizedLimit);
  const consumed = safeStart + files.length;
  const remaining = Math.max(0, paths.length - consumed);
  return {
    files,
    total: paths.length,
    remaining,
    nextCursor: remaining > 0 ? files[files.length - 1] ?? cursor ?? null : null,
    finished: remaining === 0
  };
}

async function indexLocalMirrorPaths(input: {
  registration: RepoRegistration;
  knowledgeSpace: KbKnowledgeSpace;
  branch: string;
  commitSha: string;
  rootDir: string;
  buildVersion?: string;
  publicationMode?: KbBuildPublicationMode;
  embeddingMode?: KbEmbeddingMode;
  paths: string[];
}): Promise<number> {
  let indexed = 0;
  for (const relativePath of input.paths) {
    const absolutePath = path.join(input.rootDir, relativePath);
    const content = await readFile(absolutePath, "utf8").catch(() => "");
    if (!content.trim()) continue;
    await indexDocumentContent({
      registration: input.registration,
      knowledgeSpace: input.knowledgeSpace,
      branch: input.branch,
      commitSha: input.commitSha,
      buildVersion: input.buildVersion,
      publicationMode: input.publicationMode,
      embeddingMode: input.embeddingMode,
      path: relativePath,
      content
    });
    indexed += 1;
  }
  return indexed;
}

function getLocalMirrorCursor(job: SyncJob): string | undefined {
  const cursor = job.payload_json?.cursor;
  return typeof cursor === "string" && cursor.trim() ? cursor.trim() : undefined;
}

function pickDefaultPublicBaseUrl(repoUrl: string, explicit?: string): string | undefined {
  if (explicit) return explicit;
  try {
    const parsed = parseRepoOwnerName(repoUrl);
    if (isDocsComRepo(parsed.owner, parsed.name)) {
      return "https://docs.ones.com";
    }
  } catch {
    return explicit;
  }
  return explicit;
}

function isSupportedKnowledgePath(pathname: string): boolean {
  return SUPPORTED_KNOWLEDGE_FILE_RE.test(pathname) || /(^|\/)\.env(\.|$)/.test(pathname);
}

function pickTitle(path: string, content: string): string {
  const frontmatterTitle = /^---\s*\n[\s\S]*?^\s*title:\s*["']?(.+?)["']?\s*$[\s\S]*?\n---\s*(?:\n|$)/im.exec(content);
  if (frontmatterTitle?.[1]) return frontmatterTitle[1].trim();
  const heading = /^(#{1,6})\s+(.+)$/m.exec(content);
  if (heading?.[2]) return heading[2].trim();
  return path.split("/").pop() ?? path;
}

function stripFrontmatter(content: string): string {
  return content.replace(/^---\s*\n[\s\S]*?\n---\s*(?:\n|$)/, "");
}

function stripIndexNoise(content: string): string {
  return stripFrontmatter(content)
    .replace(/^import\s+.+$/gm, " ")
    .replace(/^\s*(slug|sidebarposition|sidebar_position|sidebar_label|hide_title|hide_table_of_contents|custom_edit_url|info_path)\s*:\s*.+$/gim, " ")
    .trim();
}

function decodeBase64Url(input: string): Buffer {
  let value = input.trim().replace(/-/g, "+").replace(/_/g, "/");
  while (value.length % 4 !== 0) value += "=";
  return Buffer.from(value, "base64");
}

function looksLikeGithubBlobUrl(url: string): boolean {
  try {
    return new URL(url).hostname === "github.com";
  } catch {
    return false;
  }
}

function isBranchNotFoundError(error: unknown): boolean {
  const message = (error as Error)?.message?.toLowerCase?.() ?? "";
  return message.includes("failed to get branch head: 404") || message.includes("branch not found");
}

async function resolveRegistrationBranch(
  registration: RepoRegistration,
  requestedBranch?: string,
  actor = "system"
): Promise<{ registration: RepoRegistration; branch: string; corrected: boolean }> {
  const localMirror = await getLocalDocsMirrorState(registration);
  if (localMirror) {
    return {
      registration,
      branch: requestedBranch?.trim() || localMirror.branch || registration.default_branch,
      corrected: false
    };
  }
  const candidate = requestedBranch?.trim() || registration.default_branch;
  try {
    await getBranchHead(registration, candidate);
    return { registration, branch: candidate, corrected: false };
  } catch (error) {
    if (!isBranchNotFoundError(error)) {
      throw error;
    }
  }

  const actualBranch = await getRepositoryDefaultBranch(registration);
  const existing = await repo.findActiveRepoByOwnerNameBranch(registration.repo_owner, registration.repo_name, actualBranch);
  if (existing && existing.id !== registration.id) {
    await repo.deactivateRepoRegistration(registration.id, actor);
    return { registration: existing, branch: actualBranch, corrected: true };
  }

  await repo.updateRepoDefaultBranch(registration.id, actualBranch, actor);
  await repo.deactivateOtherRepoRegistrations(registration.repo_owner, registration.repo_name, registration.id);
  const updated = (await repo.getRepoRegistrationById(registration.id)) ?? { ...registration, default_branch: actualBranch };
  return { registration: updated, branch: actualBranch, corrected: actualBranch !== candidate };
}

async function resolveBranchForRegistrationInput(input: {
  repoUrl: string;
  repoOwner: string;
  repoName: string;
  publicBaseUrl?: string;
  defaultBranch?: string;
  includePaths: string[];
  excludePaths: string[];
  pollingIntervalSeconds: number;
  actor: string;
}): Promise<string> {
  const localMirror = await getLocalDocsMirrorState({
    repo_owner: input.repoOwner,
    repo_name: input.repoName,
    default_branch: input.defaultBranch?.trim() || "main",
    include_paths: input.includePaths,
    exclude_paths: input.excludePaths
  });
  if (localMirror) {
    return input.defaultBranch?.trim() || localMirror.branch;
  }
  const candidate = input.defaultBranch?.trim();
  const probe: RepoRegistration = {
    id: "probe",
    repo_owner: input.repoOwner,
    repo_name: input.repoName,
    repo_url: input.repoUrl,
    public_base_url: input.publicBaseUrl ?? null,
    default_branch: candidate || "main",
    include_paths: input.includePaths,
    exclude_paths: input.excludePaths,
    polling_interval_seconds: input.pollingIntervalSeconds,
    auth_mode: "github_token_readonly",
    is_active: true,
    last_validated_at: null,
    last_validation_error: null,
    created_by: input.actor,
    created_at: new Date(0).toISOString(),
    updated_at: new Date(0).toISOString()
  };

  if (candidate) {
    try {
      await getBranchHead(probe, candidate);
      return candidate;
    } catch (error) {
      if (!isBranchNotFoundError(error)) {
        throw error;
      }
    }
  }

  return getRepositoryDefaultBranch(probe);
}

async function hydratePublicSourceUrls(hits: RetrievalHit[]): Promise<RetrievalHit[]> {
  if (!hits.length) return hits;
  const repoIds = [...new Set(hits.map((item) => item.repoId).filter(Boolean))];
  const registrations = new Map<string, RepoRegistration | null>();
  await Promise.all(
    repoIds.map(async (repoId) => {
      registrations.set(repoId, await repo.getRepoRegistrationById(repoId).catch(() => null));
    })
  );

  return Promise.all(
    hits.map(async (hit) => {
      const registration = registrations.get(hit.repoId);
      if (!registration?.public_base_url) return hit;
      const isPublicDocUrl = hit.sourceUrl.startsWith(registration.public_base_url);
      if (!(looksLikeGithubBlobUrl(hit.sourceUrl) || isPublicDocUrl)) return hit;

      const content = await getFileContentAtCommit(registration, hit.path, hit.commitSha).catch(() => "");
      const publicSourceUrl = buildPublicSourceUrl(registration, hit.path, content);
      if (!publicSourceUrl) return hit;
      if (publicSourceUrl === hit.sourceUrl) return hit;
      return { ...hit, sourceUrl: publicSourceUrl };
    })
  );
}

function decodeOpenApiBlob(content: string): Record<string, unknown> | null {
  const matched = /^api:\s*(\S+)$/m.exec(content);
  if (!matched?.[1]) return null;
  const payload = decodeBase64Url(matched[1]);
  const decompressors = [zlib.inflateSync, zlib.inflateRawSync, zlib.gunzipSync];
  for (const fn of decompressors) {
    try {
      const decoded = fn(payload).toString("utf8");
      const parsed = JSON.parse(decoded) as Record<string, unknown>;
      return parsed;
    } catch {
      // try next decompressor
    }
  }
  return null;
}

function toSearchableApiText(apiDoc: Record<string, unknown>): string {
  const method = String(apiDoc.method ?? "").toUpperCase();
  const path = String(apiDoc.path ?? "");
  const operationId = String(apiDoc.operationId ?? "");
  const description = String(apiDoc.description ?? "");
  const tags = Array.isArray(apiDoc.tags) ? apiDoc.tags.map((item) => String(item)).join(", ") : "";
  const params = Array.isArray(apiDoc.parameters)
    ? apiDoc.parameters
        .map((item) => {
          const row = item as Record<string, unknown>;
          return `${String(row.in ?? "")}:${String(row.name ?? "")}`;
        })
        .join(", ")
    : "";
  return [
    "OPENAPI_OPERATION",
    `operation_id: ${operationId}`,
    `method: ${method}`,
    `path: ${path}`,
    tags ? `tags: ${tags}` : "",
    params ? `parameters: ${params}` : "",
    description ? `description: ${description}` : ""
  ]
    .filter(Boolean)
    .join("\n");
}

function uniqueStrings(input: Array<string | undefined | null>, limit = 6): string[] {
  const seen = new Set<string>();
  const values: string[] = [];
  for (const item of input) {
    const value = String(item ?? "").trim();
    if (!value || seen.has(value)) continue;
    seen.add(value);
    values.push(value);
    if (values.length >= limit) break;
  }
  return values;
}

function findMatches(input: string, pattern: RegExp, limit = 6): string[] {
  const matches = [...input.matchAll(pattern)].map((item) => item[1]?.trim()).filter(Boolean);
  return uniqueStrings(matches, limit);
}

function inferProductArea(path: string, content: string): string {
  const normalizedPath = path.toLowerCase();
  const normalizedContent = content.toLowerCase();
  if (
    /<methodendpoint|<paramsitem|<schemaitem|\b(get|post|put|patch|delete)\s+\/[a-z0-9_/{}/.-]+|openapi|oauth|scope|token|credential/.test(
      normalizedContent
    )
  ) return "openapi";
  if (normalizedPath.includes("/integrations/") || /oauth|sso|webhook|github|gitlab|slack|teams/.test(normalizedContent)) return "integrations";
  if (normalizedPath.includes("/wiki/") || /wiki|page group|space/.test(normalizedContent)) return "wiki";
  if (/deploy|deployment|self-hosted|on-prem|kubernetes|pod|pvc|volume|cluster|database|storage|topology|architecture|私有部署/.test(normalizedContent)) {
    return "deployment";
  }
  if (/issue|project|sprint|field|comment|attachment/.test(normalizedContent)) return "project_management";
  if (normalizedPath.includes("/openapi/")) return "openapi";
  return "general";
}

function inferDeploymentModel(path: string, content: string): string {
  const normalizedContent = content.toLowerCase();
  if (/private deployment|self-hosted|私有部署|本地部署|on-prem|air-gapped|closed network|offline/i.test(content)) return "private_deployment";
  if (/public cloud|公有云|saas/i.test(content)) return "public_cloud";
  return "shared";
}

function inferEvidenceKind(path: string, title: string, content: string): string {
  const normalizedPath = path.toLowerCase();
  const normalizedTitle = title.toLowerCase();
  const normalizedContent = content.toLowerCase();
  if (
    /<methodendpoint|<paramsitem|<schemaitem|\b(get|post|put|patch|delete)\s+\/[a-z0-9_/{}/.-]+/.test(normalizedContent) ||
    normalizedPath.includes(".api.")
  ) return "api_operation";
  if (normalizedPath.includes("/troubleshooting/") || /troubleshoot|troubleshooting|排查|故障/.test(normalizedTitle)) return "troubleshooting";
  if (/limitation|限制|注意事项|not supported|unsupported/.test(normalizedContent)) return "constraint";
  if (/how to|步骤|guide|配置|setup|configure/.test(normalizedTitle) || normalizedPath.includes("/guide/")) return "procedure";
  return "capability";
}

function extractVersionScope(content: string): string[] {
  return uniqueStrings(
    [
      ...findMatches(content, /Added in:\s*([^\n|]+)/gi, 4),
      ...findMatches(content, /版本[：:]\s*([^\n]+)/gi, 2)
    ],
    6
  );
}

function extractSupportEvidenceMetadata(input: {
  path: string;
  title: string;
  content: string;
  apiDoc?: Record<string, unknown> | null;
  inherited?: Record<string, unknown>;
}): Record<string, unknown> {
  const inherited = input.inherited ?? {};
  const evidenceKind = inferEvidenceKind(input.path, input.title, input.content);
  const productArea = inferProductArea(input.path, input.content);
  const deploymentModel = inferDeploymentModel(input.path, input.content);
  const permissions = uniqueStrings([
    ...(Array.isArray(input.apiDoc?.security)
      ? (input.apiDoc?.security as Array<Record<string, unknown>>).flatMap((item) =>
          Object.values(item).flatMap((value) => (Array.isArray(value) ? value.map((scope) => String(scope)) : []))
        )
      : []),
    ...findMatches(input.content, /(?:scope|权限)[：:\s`]*([A-Za-z0-9:_-]+)/gi, 6)
  ]);
  const appliesTo = uniqueStrings([
    deploymentModel === "public_cloud" ? "public_cloud" : undefined,
    deploymentModel === "private_deployment" ? "private_deployment" : undefined,
    productArea !== "general" ? productArea : undefined
  ]);
  const limitations = uniqueStrings([
    ...findMatches(input.content, /(?:限制|注意|Limitations?|Notes?)[：:\s-]*([^\n.。]+)/gi, 6),
    ...(String(input.content).includes("not a bulk export") ? ["not a bulk export endpoint"] : [])
  ]);
  const prerequisites = uniqueStrings([
    ...findMatches(input.content, /(?:Prerequisites?|前提|需要|必须)[：:\s-]*([^\n.。]+)/gi, 6),
    ...permissions.map((scope) => `scope:${scope}`)
  ]);
  const actions = uniqueStrings([
    String(input.apiDoc?.method ?? ""),
    ...findMatches(input.content, /\b(create|update|delete|get|list|search|export|import|configure|deploy|escalate)\b/gi, 6)
  ]);
  const objects = uniqueStrings([
    String(input.apiDoc?.path ?? "")
      .split("/")
      .filter((segment) => segment && !segment.startsWith("{"))
      .slice(-2)
      .join("/"),
    ...findMatches(input.content, /\b(issue|comment|attachment|project|wiki|space|page|sprint|field|token|oauth|ticket)\b/gi, 6)
  ]);
  const versionScope = extractVersionScope(input.content);

  return {
    ...inherited,
    evidence_kind: evidenceKind,
    applies_to: appliesTo,
    product_area: productArea,
    deployment_model: deploymentModel,
    objects,
    actions,
    permissions,
    prerequisites,
    limitations,
    version_scope: versionScope
  };
}

function enrichIndexableContent(path: string, rawContent: string): string {
  const cleanedContent = stripIndexNoise(rawContent);
  if (!/open-docs\/docs\/openapi\/api\/.+\.api\.mdx$/i.test(path)) {
    return cleanedContent;
  }
  const apiDoc = decodeOpenApiBlob(rawContent);
  if (!apiDoc) return cleanedContent;
  const apiText = toSearchableApiText(apiDoc);
  return `${cleanedContent}\n\n${apiText}`;
}

function getProfileConfig(profile: RetrievalProfile): {
  topK: number;
  threshold: number;
  vectorWeight: number;
  keywordWeight: number;
} {
  if (profile === "agent") {
    return {
      topK: env.GITHUB_KB_PROFILE_AGENT_TOPK,
      threshold: env.GITHUB_KB_PROFILE_AGENT_CONFIDENCE_THRESHOLD,
      vectorWeight: 0.55,
      keywordWeight: 0.45
    };
  }

  return {
    topK: env.GITHUB_KB_PROFILE_SEARCH_TOPK,
    threshold: env.GITHUB_KB_PROFILE_SEARCH_CONFIDENCE_THRESHOLD,
    vectorWeight: 0.6,
    keywordWeight: 0.4
  };
}

function detectQueryLanguage(query: string): "zh" | "en" {
  return /[\u3400-\u9FBF]/.test(query) ? "zh" : "en";
}

function normalizeSpaces(input: string): string {
  return input.replace(/\s+/g, " ").trim();
}

function isApiIntent(query: string): boolean {
  return /\b(api|openapi|endpoint|rest|request|response|method|path|scope|token|onesql)\b/i.test(query) || /接口|开放平台|接口文档|请求方法|路径参数|响应字段/.test(query);
}

function tokenizeRetrievalQuery(query: string): string[] {
  const normalized = normalizeSpaces(query).toLowerCase();
  if (!normalized) return [];

  const asciiTokens = [...normalized.matchAll(/[a-z0-9][a-z0-9._/-]{1,}/g)]
    .map((match) => match[0])
    .filter((token) => token.length >= 2);
  const cjkRuns = [...normalized.matchAll(/[\u3400-\u9FBF]{2,}/g)].map((match) => match[0]);
  const cjkTokens: string[] = [];

  for (const run of cjkRuns) {
    cjkTokens.push(run);
    if (run.length <= 4) continue;
    for (let size = 3; size >= 2; size -= 1) {
      for (let index = 0; index <= run.length - size && cjkTokens.length < 32; index += 1) {
        cjkTokens.push(run.slice(index, index + size));
      }
    }
  }

  return uniqueStrings([...asciiTokens, ...cjkTokens], 24);
}

function normalizeSnippetText(raw: string): string {
  return raw
    .replace(/^---\s*\n[\s\S]*?\n---\s*(?:\n|$)/, " ")
    .replace(/^import\s+.+$/gm, " ")
    .replace(/^\s*(slug|sidebarposition|sidebar_position|sidebar_label|hide_title|hide_table_of_contents|custom_edit_url|info_path|title|description)\s*:\s*.+$/gim, " ")
    .replace(/<JsonSchemaViewer[^>]*\/>/gi, " ")
    .replace(/<SchemaItem[^>]*\/>/gi, " ")
    .replace(/api\s*:\s*eJ[0-9A-Za-z+/_=-]{16,}/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/<\w[^\n]*/g, " ")
    .replace(/\b(className|id|schemaPath|collapsible|required|schemaName|qualifierMessage|param)\s*=\s*\{[^}]*\}/gi, " ")
    .replace(/\{[^}]{0,120}\}/g, " ")
    .replace(/`{1,3}/g, "")
    .replace(/\*\*/g, "")
    .replace(/\[(.*?)\]\((.*?)\)/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

function cleanSnippet(raw: string): string {
  return normalizeSnippetText(raw).slice(0, 600);
}

function scoreSnippetTerm(term: string): number {
  const normalized = term.toLowerCase();
  let score = Math.min(normalized.length, 24);
  if (/[/{}`:]/.test(normalized)) score += 18;
  if (/redirect|callback|webhook|baseurl|oauth|scope|permission|token|page|404|onesql|group|order/.test(normalized)) {
    score += 36;
  }
  if (/[\u3400-\u9fff]/.test(normalized)) score += Math.min(18, normalized.length * 2);
  return score;
}

export function buildQueryAnchoredSnippet(raw: string, terms: string[]): string {
  const cleaned = normalizeSnippetText(raw);
  if (!cleaned) return "";
  const lower = cleaned.toLowerCase();
  const rankedTerms = uniqueStrings(terms.map((item) => item.toLowerCase()), 24)
    .filter((term) => term.length >= 2)
    .sort((a, b) => scoreSnippetTerm(b) - scoreSnippetTerm(a));
  const match = rankedTerms.find((term) => lower.includes(term));
  if (!match) return cleaned.slice(0, 600);
  const index = lower.indexOf(match);
  const start = Math.max(0, index - 180);
  const end = Math.min(cleaned.length, index + 360);
  return cleaned.slice(start, end).trim().slice(0, 600);
}

function isOpenApiPath(path: string): boolean {
  return /open-docs\/docs\/openapi\/api\/.+\.api\.mdx$/i.test(path);
}

function sanitizeApiDescription(raw: string): string {
  return raw
    .replace(/##\s*History[\s\S]*$/i, "")
    .replace(/\|[^\n]*\|[^\n]*\n/g, " ")
    .replace(/:\-+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function buildOpenApiTitle(apiDoc: Record<string, unknown>, fallbackPath: string): string {
  const method = String(apiDoc.method ?? "").toUpperCase();
  const path = String(apiDoc.path ?? "");
  if (method && path) return `${method} ${path}`;
  const operationId = String(apiDoc.operationId ?? "");
  if (operationId) return operationId;
  return fallbackPath.split("/").pop() ?? fallbackPath;
}

function buildOpenApiSnippet(apiDoc: Record<string, unknown>, language: "zh" | "en"): string {
  const method = String(apiDoc.method ?? "").toUpperCase();
  const path = String(apiDoc.path ?? "");
  const description = sanitizeApiDescription(String(apiDoc.description ?? apiDoc.summary ?? ""));
  const params = Array.isArray(apiDoc.parameters)
    ? apiDoc.parameters
        .map((item) => {
          const row = item as Record<string, unknown>;
          return `${String(row.in ?? "")}:${String(row.name ?? "")}`;
        })
        .filter((item) => item !== ":")
        .slice(0, 5)
    : [];

  if (language === "zh") {
    return cleanSnippet(
      [`接口：${method} ${path}`.trim(), description ? `说明：${description}` : "", params.length ? `关键参数：${params.join("，")}` : ""]
        .filter(Boolean)
        .join("。")
    );
  }

  return cleanSnippet(
    [`Endpoint: ${method} ${path}`.trim(), description ? `Description: ${description}` : "", params.length ? `Key params: ${params.join(", ")}` : ""]
      .filter(Boolean)
      .join(". ")
  );
}

async function enrichOpenApiHits(hits: RetrievalHit[], answerLanguage: "zh" | "en"): Promise<RetrievalHit[]> {
  const enriched = await Promise.all(
    hits.map(async (hit) => {
      if (!isOpenApiPath(hit.path)) return hit;
      const registration = await repo.getRepoRegistrationById(hit.repoId).catch(() => null);
      if (!registration) return hit;
      const raw = await getFileContentAtCommit(registration, hit.path, hit.commitSha).catch(() => "");
      if (!raw) return hit;
      const apiDoc = decodeOpenApiBlob(raw);
      if (!apiDoc) return hit;
      return {
        ...hit,
        title: buildOpenApiTitle(apiDoc, hit.path),
        snippet: buildOpenApiSnippet(apiDoc, answerLanguage)
      };
    })
  );
  return enriched;
}

function buildQueryVariants(query: string): string[] {
  const normalized = normalizeSpaces(query);
  const lowered = normalized.toLowerCase();
  const semanticNormalized = normalizeSpaces(
    lowered
      .replace(/open\s*api/g, "openapi")
      .replace(/开放平台/g, "openapi")
      .replace(/接口/g, "api")
      .replace(/重建/g, "rebuild")
      .replace(/索引/g, "index indexes")
      .replace(/导入/g, "import")
      .replace(/导出/g, "export")
      .replace(/重置/g, "reset")
      .replace(/权限/g, "permission")
      .replace(/授权/g, "oauth")
      .replace(/项目标识|标识符|标识/g, "identifier id uuid")
      .replace(/项目列表/g, "project list projects")
      .replace(/工作项/g, "issue work item")
      .replace(/字段|属性/g, "field property")
      .replace(/报错|错误|异常|失败/g, "troubleshooting")
  );
  const compactTokenVariant = tokenizeRetrievalQuery(semanticNormalized || normalized).join(" ").trim();
  return uniqueStrings(
    [
      normalized,
      lowered !== normalized ? lowered : "",
      semanticNormalized && semanticNormalized !== lowered ? semanticNormalized : "",
      compactTokenVariant && compactTokenVariant !== lowered ? compactTokenVariant : ""
    ],
    4
  );
}

function buildRetrievalCacheKey(input: {
  query: string;
  profile: RetrievalProfile;
  repoId?: string;
  branch?: string;
  topK: number;
  includeFallback: boolean;
}): string {
  return [
    input.profile,
    input.repoId ?? "_all",
    input.branch ?? "_all",
    input.topK,
    input.includeFallback ? "1" : "0",
    normalizeSpaces(input.query).toLowerCase()
  ].join("::");
}

async function embedWithRetry(text: string): Promise<{ vectorLiteral: string; model: string; version: string }> {
  if (embeddingDisabledUntil > Date.now()) {
    throw new Error(embeddingDisabledReason || "Embedding temporarily disabled");
  }
  let lastError: Error | null = null;
  for (let attempt = 0; attempt <= env.GITHUB_KB_EMBEDDING_MAX_RETRIES; attempt += 1) {
    try {
      const embedded = await embedText(text);
      embeddingDisabledUntil = 0;
      embeddingDisabledReason = "";
      return {
        vectorLiteral: toVectorLiteral(embedded.vector),
        model: embedded.model,
        version: embedded.version
      };
    } catch (error) {
      lastError = error as Error;
      if (isPermanentEmbeddingError(error)) {
        embeddingDisabledUntil = Date.now() + EMBEDDING_CIRCUIT_BREAKER_MS;
        embeddingDisabledReason = (error as Error)?.message || "Embedding disabled after permanent API error";
        break;
      }
      if (attempt < env.GITHUB_KB_EMBEDDING_MAX_RETRIES) {
        const waitMs = Math.min(2000, 200 * Math.pow(2, attempt));
        await new Promise((resolve) => setTimeout(resolve, waitMs));
      }
    }
  }
  throw lastError ?? new Error("Embedding failed");
}

async function embedTextForBuild(
  text: string,
  embeddingMode: KbEmbeddingMode
): Promise<{ vectorLiteral: string; model: string; version: string } | null> {
  if (embeddingMode === "disabled") return null;
  try {
    return await embedWithRetry(text);
  } catch (error) {
    if (embeddingMode === "required") {
      throw error;
    }
    return null;
  }
}

export function shouldEmbedCitationUnit(input: { metadata?: Record<string, unknown> | null }): boolean {
  return String(input.metadata?.embeddingTarget ?? "")
    .trim()
    .toLowerCase() === "selected";
}

function isPermanentEmbeddingError(error: unknown): boolean {
  const message = (error as Error)?.message?.toLowerCase?.() ?? "";
  return (
    message.includes("insufficient_quota") ||
    message.includes("quota") ||
    message.includes("invalid_api_key") ||
    message.includes("incorrect api key") ||
    message.includes("unauthorized") ||
    message.includes("authentication") ||
    message.includes("forbidden") ||
    message.includes("401") ||
    message.includes("403")
  );
}

function isTransientDbError(error: unknown): boolean {
  const message = (error as Error)?.message?.toLowerCase?.() ?? "";
  return (
    message.includes("connection terminated") ||
    message.includes("econnreset") ||
    message.includes("timeout") ||
    message.includes("too many clients")
  );
}

async function withTransientDbRetry<T>(fn: () => Promise<T>, maxAttempts = 3): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (!isTransientDbError(error) || attempt === maxAttempts) {
        throw error;
      }
      const waitMs = Math.min(1200, 200 * attempt * attempt);
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
  }
  throw lastError;
}

export async function retrieveKnowledgeWithRetry(input: {
  query: string;
  answerLanguage?: "zh" | "en";
  profile: RetrievalProfile;
  repoId?: string;
  branch?: string;
  topK?: number;
  includeFallback: boolean;
  rewrites?: string[];
  supportSignals?: SupportExactSignals;
  caseFrame?: MemoryCaseFrame;
  requiredDocKinds?: string[];
}): Promise<RetrievalResponse> {
  let lastError: unknown;
  const maxAttempts = 3;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await retrieveKnowledge(input);
    } catch (error) {
      lastError = error;
      if (!isTransientDbError(error) || attempt === maxAttempts) {
        throw error;
      }
      const wait = Math.min(1800, 250 * attempt * attempt);
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
  }
  throw lastError;
}

async function indexDocument(
  registration: RepoRegistration,
  knowledgeSpace: KbKnowledgeSpace,
  branch: string,
  commitSha: string,
  path: string,
  options?: { buildVersion?: string; publicationMode?: KbBuildPublicationMode; embeddingMode?: KbEmbeddingMode }
): Promise<void> {
  const content = await getFileContentAtCommit(registration, path, commitSha);
  await indexDocumentContent({
    registration,
    knowledgeSpace,
    branch,
    commitSha,
    buildVersion: options?.buildVersion,
    publicationMode: options?.publicationMode,
    embeddingMode: options?.embeddingMode,
    path,
    content
  });
}

async function indexDocumentContent(input: {
  registration: RepoRegistration;
  knowledgeSpace: KbKnowledgeSpace;
  branch: string;
  commitSha: string;
  buildVersion?: string;
  publicationMode?: KbBuildPublicationMode;
  embeddingMode?: KbEmbeddingMode;
  path: string;
  content: string;
}): Promise<void> {
  const { registration, knowledgeSpace, branch, commitSha, path, content } = input;
  const buildVersion = input.buildVersion?.trim() || commitSha;
  const embeddingMode = input.embeddingMode ?? DEFAULT_EMBEDDING_MODE;
  const normalizedContent = enrichIndexableContent(path, content);
  const contentHash = sha256(content);
  const repoSourceUrl = buildSourceUrl(registration, path, commitSha);
  const publicSourceUrl = buildPublicSourceUrl(registration, path, content);
  let title = pickTitle(path, normalizedContent);
  let apiDoc: Record<string, unknown> | null = null;
  if (isOpenApiPath(path)) {
    apiDoc = decodeOpenApiBlob(content);
    if (apiDoc) {
      title = buildOpenApiTitle(apiDoc, path);
    }
  }
  const sourceClassification = classifySourceFamily(path, normalizedContent);
  const docSupportEvidence = extractSupportEvidenceMetadata({
    path,
    title,
    content: normalizedContent,
    apiDoc
  });
  const doc = await repo.upsertDocument({
    repoId: registration.id,
    knowledgeSpace,
    branch,
    path,
    buildVersion,
    title,
    sourceUrl: publicSourceUrl ?? repoSourceUrl,
    repoSourceUrl,
    publicSourceUrl,
    commitSha,
    contentHash,
    content: normalizedContent,
    metadata: {
      parser: "markdown-ast-lite",
      contentTransform: normalizedContent === content ? "none" : "openapi_api_blob_decode",
      publicSourceUrlResolved: Boolean(publicSourceUrl),
      includePaths: registration.include_paths,
      excludePaths: registration.exclude_paths,
      sourceFamily: sourceClassification.sourceFamily,
      sourceFamilyQuality: sourceClassification.quality,
      sourceFamilyReason: sourceClassification.reason,
      supportEvidence: docSupportEvidence
    }
  });

  const knowledgeContext = {
    knowledgeSpace,
    repoId: registration.id,
    branch,
    buildVersion,
    commitSha,
    docId: doc.id,
    path,
    title,
    content: normalizedContent,
    metadata: {
      supportEvidence: docSupportEvidence,
      source_family: sourceClassification.sourceFamily
    }
  } as const;
  const knowledgeArtifacts = buildRepositoryKnowledgeArtifacts(knowledgeContext);

  await withBuildDocumentMutationLock(
    {
      knowledgeSpace,
      repoId: registration.id,
      branch,
      buildVersion,
      path
    },
    async () => {
      await repo.deactivateChunksByDocument(doc.id);
      await repo.deleteKnowledgeArtifactsForDocument({
        sourceDocId: doc.id,
        knowledgeSpace,
        buildVersion
      });

      const persistedChunks: Array<{
        id: string;
        headingPath: string;
        ordinal: number;
        content: string;
        metadata: Record<string, unknown>;
      }> = [];
      if (
        knowledgeArtifacts.classification.sourceFamily === "doc_page" ||
        knowledgeArtifacts.classification.sourceFamily === "runbook_file" ||
        knowledgeArtifacts.classification.sourceFamily === "openapi_spec"
      ) {
        const sections = parseMarkdownSections(normalizedContent);
        const chunks = buildChunks(doc.doc_key, sections, {
          targetTokens: env.GITHUB_KB_CHUNK_TARGET_TOKENS,
          overlapTokens: env.GITHUB_KB_CHUNK_OVERLAP_TOKENS
        });
        for (const chunk of chunks) {
          const chunkSupportEvidence = extractSupportEvidenceMetadata({
            path,
            title: String(chunk.metadata.sectionTitle ?? title),
            content: chunk.content,
            apiDoc,
            inherited: docSupportEvidence
          });
          const embedded = await embedTextForBuild(chunk.content, embeddingMode);
          await repo.upsertChunk({
            id: chunk.id,
            docId: doc.id,
            repoId: registration.id,
            knowledgeSpace,
            branch,
            path,
            buildVersion,
            commitSha,
            headingPath: chunk.headingPath,
            ordinal: chunk.ordinal,
            content: chunk.content,
            contentHash: chunk.contentHash,
            tokenCount: chunk.tokenCount,
            metadata: {
              ...chunk.metadata,
              sourceFamily: knowledgeArtifacts.classification.sourceFamily,
              supportEvidence: chunkSupportEvidence,
              embeddingState: embedded ? "ready" : "missing"
            },
            embedding: embedded?.vectorLiteral ?? null,
            embeddingModel: embedded?.model ?? null,
            embeddingVersion: embedded?.version ?? null
          });
          persistedChunks.push({
            id: chunk.id,
            headingPath: chunk.headingPath,
            ordinal: chunk.ordinal,
            content: chunk.content,
            metadata: {
              ...chunk.metadata,
              sourceFamily: knowledgeArtifacts.classification.sourceFamily,
              supportEvidence: chunkSupportEvidence,
              embeddingState: embedded ? "ready" : "missing"
            }
          });
        }
      }

      for (const operation of knowledgeArtifacts.openApiOperations) {
        await repo.upsertOpenApiOperation({
          id: operation.id,
          knowledgeSpace,
          repoId: registration.id,
          branch,
          buildVersion,
          sourceDocId: doc.id,
          path: operation.path,
          method: operation.method,
          routePath: operation.routePath,
          operationId: operation.operationId,
          summary: operation.summary,
          description: operation.description,
          requestSchema: operation.requestSchema,
          responseSchema: operation.responseSchema,
          authScopes: operation.authScopes,
          tags: operation.tags,
          errorShapes: operation.errorShapes,
          sourceLocation: operation.sourceLocation,
          metadata: operation.metadata
        });
      }
      for (const symbol of knowledgeArtifacts.codeSymbols) {
        await repo.upsertCodeSymbol({
          id: symbol.id,
          knowledgeSpace,
          repoId: registration.id,
          branch,
          buildVersion,
          sourceDocId: doc.id,
          path: symbol.path,
          language: symbol.language,
          symbolKind: symbol.symbolKind,
          symbolName: symbol.symbolName,
          qualifiedName: symbol.qualifiedName,
          parentSymbol: symbol.parentSymbol,
          startLine: symbol.startLine,
          endLine: symbol.endLine,
          signatureText: symbol.signatureText,
          docComment: symbol.docComment,
          bodySummary: symbol.bodySummary,
          dependencyRefs: symbol.dependencyRefs,
          metadata: symbol.metadata
        });
      }
      for (const surface of knowledgeArtifacts.configSurfaces) {
        await repo.upsertConfigSurface({
          id: surface.id,
          knowledgeSpace,
          repoId: registration.id,
          branch,
          buildVersion,
          sourceDocId: doc.id,
          path: surface.path,
          configKind: surface.configKind,
          configKey: surface.configKey,
          normalizedKey: surface.normalizedKey,
          defaultValue: surface.defaultValue,
          description: surface.description,
          requiredFor: surface.requiredFor,
          relatedComponents: surface.relatedComponents,
          sourceLocation: surface.sourceLocation,
          metadata: surface.metadata
        });
      }
      for (const object of knowledgeArtifacts.schemaObjects) {
        await repo.upsertSchemaObject({
          id: object.id,
          knowledgeSpace,
          repoId: registration.id,
          branch,
          buildVersion,
          sourceDocId: doc.id,
          path: object.path,
          objectKind: object.objectKind,
          schemaName: object.schemaName,
          objectName: object.objectName,
          normalizedName: object.normalizedName,
          definitionSummary: object.definitionSummary,
          relatedTables: object.relatedTables,
          sourceLocation: object.sourceLocation,
          metadata: object.metadata
        });
      }
      for (const behavior of knowledgeArtifacts.testBehaviors) {
        await repo.upsertTestBehavior({
          id: behavior.id,
          knowledgeSpace,
          repoId: registration.id,
          branch,
          buildVersion,
          sourceDocId: doc.id,
          path: behavior.path,
          behaviorKey: behavior.behaviorKey,
          title: behavior.title,
          summary: behavior.summary,
          assertions: behavior.assertions,
          signals: behavior.signals,
          sourceLocation: behavior.sourceLocation,
          metadata: behavior.metadata
        });
      }

      const docChunkCitations = buildDocChunkCitations(
        knowledgeContext,
        persistedChunks,
        knowledgeArtifacts.classification.sourceFamily === "openapi_spec"
          ? "openapi_spec"
          : knowledgeArtifacts.classification.sourceFamily === "runbook_file"
          ? "runbook_file"
          : "doc_page"
      );
      const allCitations = [...docChunkCitations, ...knowledgeArtifacts.citationUnits];
      for (const citation of allCitations) {
        const citationEmbeddingTarget = shouldEmbedCitationUnit(citation) ? "selected" : "disabled";
        const embedded =
          citationEmbeddingTarget === "selected"
            ? await embedTextForBuild(citation.embeddingText ?? citation.snippetText, embeddingMode)
            : null;
        await repo.upsertCitationUnit({
          id: citation.id,
          knowledgeSpace,
          repoId: registration.id,
          branch,
          buildVersion,
          sourceDocId: doc.id,
          citationFamily: citation.citationFamily,
          sourceFamily: citation.sourceFamily,
          sourceArtifactType: citation.sourceArtifactType,
          sourceArtifactId: citation.sourceArtifactId,
          citationKey: citation.citationKey,
          path: citation.path,
          title: citation.title,
          headingPath: citation.headingPath,
          snippetText: citation.snippetText,
          sourceLocation: citation.sourceLocation,
          authority: citation.authority,
          metadata: {
            ...citation.metadata,
            embeddingTarget: citationEmbeddingTarget
          },
          embedding: embedded?.vectorLiteral ?? null,
          embeddingModel: embedded?.model ?? null,
          embeddingVersion: embedded?.version ?? null
        });
      }

      const docCitationByHeading = new Map(
        docChunkCitations.map((citation) => [citation.headingPath ?? "ROOT", citation.id] as const)
      );
      const chunkByHeading = new Map(
        persistedChunks.map((chunk) => [chunk.headingPath ?? "ROOT", chunk] as const)
      );
      const docRetrievalUnits =
        knowledgeArtifacts.docPage && docChunkCitations.length
          ? buildDocumentRetrievalUnits({
              sections: knowledgeArtifacts.docPage.sections,
              docKind: knowledgeArtifacts.docPage.docKind,
              productArea: knowledgeArtifacts.docPage.productArea,
              deploymentModel: knowledgeArtifacts.docPage.deploymentModel,
              citationByHeading: docCitationByHeading,
              title
            })
          : [];
      const structuredMemoryEntries = [
        ...generateMemoryEntriesFromRetrievalUnits(
          {
            ...knowledgeContext,
            metadata: {
              ...knowledgeContext.metadata,
              source_family: knowledgeArtifacts.classification.sourceFamily
            }
          },
          docRetrievalUnits
        ).map((entry) => {
          if (entry.sources.length > 0) return entry;
          const headingPath = String(entry.metadata_json?.heading_path ?? "").trim() || "ROOT";
          const sourceChunk = chunkByHeading.get(headingPath) ?? chunkByHeading.get("ROOT");
          if (!sourceChunk) return entry;
          return {
            ...entry,
            sources: [
              {
                doc_id: doc.id,
                chunk_id: sourceChunk.id,
                heading_path: sourceChunk.headingPath,
                source_score: 1,
                source_metadata_json: {
                  source_family: "doc_chunk",
                  generated_from: "document_retrieval_unit"
                }
              }
            ]
          };
        }),
        ...knowledgeArtifacts.memoryEntries
      ];

      await syncDocumentMemoryGraph({
        knowledgeSpace,
        repoId: registration.id,
        branch,
        commitSha,
        buildVersion,
        activationMode: input.publicationMode === "publish_inline" ? "immediate" : "staged",
        docId: doc.id,
        path,
        title,
        docSupportEvidence,
        chunks: persistedChunks,
        memoryEntries: structuredMemoryEntries
      });
    }
  );
}

async function maybeFinalizeDocsComFullSyncRun(
  runId: string,
  knowledgeSpace: KbKnowledgeSpace,
  requestedFromEnv: KbRequestedFromEnv,
  publicationMode: KbBuildPublicationMode
): Promise<void> {
  const run = await repo.tryStartSyncRunFinalization(runId);
  if (!run) return;
  try {
    const buildVersion = buildFullRunBuildVersion(run.target_head, run.id);
    await finalizeBuild({
      knowledgeSpace,
      repoId: run.repo_id,
      branch: run.branch,
      buildVersion,
      targetHead: run.target_head,
      buildKind: "full",
      requestedBy: "docs-com-full-sync",
      requestedFromEnv,
      publicationMode,
      sourceSnapshotTotal: run.source_snapshot_total,
      requiredPrefixes: DOCS_COM_REQUIRED_PREFIXES
    });
    await repo.finalizeSyncRunSuccess({
      runId: run.id,
      repoId: run.repo_id,
      branch: run.branch,
      buildVersion,
      targetHead: run.target_head,
      publicationMode
    });
    await repo.recordMetric({
      repoId: run.repo_id,
      metricName: "kb_full_run_finalized",
      metricValue: 1,
      tags: { runId: run.id, branch: run.branch, head: run.target_head }
    });
  } catch (error) {
    await repo.markSyncRunFinalizationFailed(run.id, (error as Error).message);
    throw error;
  } finally {
    await repo.releaseIngestLease(buildKnowledgeSpaceLeaseKey(knowledgeSpace, run.repo_id, run.branch), run.id).catch(() => undefined);
  }
}

async function runDocsComFullSyncShardJob(job: SyncJob, registration: RepoRegistration): Promise<SyncExecutionResult> {
  const knowledgeSpace = resolveJobKnowledgeSpace(job);
  const requestedFromEnv = resolveRequestedFromEnvFromPayload(job.payload_json);
  const publicationMode = resolvePublicationModeFromPayload(job.payload_json, "build_only");
  const embeddingMode = resolveEmbeddingModeFromPayload(job.payload_json);
  const payload = getFullRunPayload(job);
  if (!payload) {
    throw new Error(`Missing docs-com full run payload on job ${job.id}`);
  }

  const run = await repo.getSyncRun(payload.runId);
  if (!run) {
    throw new Error(`Full sync run not found: ${payload.runId}`);
  }
  if (run.status === "succeeded" || run.status === "failed" || run.status === "cancelled") {
    return { indexed: 0, head: run.target_head, finished: true, nextCursor: null };
  }
  if (run.target_head !== payload.targetHead) {
    throw new Error(`Run ${run.id} target head mismatch: expected ${run.target_head}, got ${payload.targetHead}`);
  }

  await ensureBuildRecord({
    knowledgeSpace,
    repoId: registration.id,
    branch: run.branch,
    buildVersion: payload.buildVersion,
    targetHead: run.target_head,
    buildKind: "full",
    requestedBy: job.source,
    requestedFromEnv,
    sourceSnapshotTotal: run.source_snapshot_total
  });

  await repo.heartbeatSyncRunShard(run.id, payload.shardKey, "running");

  const limit = env.GITHUB_KB_REMOTE_SYNC_BATCH_SIZE;
  const manifestItems = await repo.listPendingManifestItemsForShard({
    runId: run.id,
    shardKey: payload.shardKey,
    cursor: payload.cursor,
    limit
  });

  if (!manifestItems.length) {
    await repo.advanceSyncRunShard({
      runId: run.id,
      shardKey: payload.shardKey,
      completedDelta: 0,
      reusableDelta: 0,
      rebuiltDelta: 0,
      failedDelta: 0,
      nextCursor: null,
      status: "succeeded"
    });
    await maybeFinalizeDocsComFullSyncRun(run.id, knowledgeSpace, requestedFromEnv, publicationMode);
    return { indexed: 0, head: run.target_head, finished: true, nextCursor: null };
  }

  let rebuilt = 0;
  let reused = 0;

  try {
    if (payload.sourceMode === "local_mirror") {
      const localMirror = await getLocalDocsMirrorState(registration);
      if (!localMirror) {
        throw new Error(`Local mirror is unavailable for run ${run.id}`);
      }
      for (const item of manifestItems) {
        if (!item.needs_rebuild) {
          await withTransientDbRetry(() =>
            githubKbServiceDeps.updateManifestItemBuildStatus({ runId: run.id, path: item.path, status: "reused" })
          );
          reused += 1;
          continue;
        }
        const absolutePath = path.join(localMirror.rootDir, item.path);
        const content = await readFile(absolutePath, "utf8").catch(() => "");
        if (!content.trim()) {
          throw new Error(`Manifest path is missing or empty in local mirror: ${item.path}`);
        }
        await withTransientDbRetry(async () => {
          await indexDocumentContent({
            registration,
            knowledgeSpace,
            branch: run.branch,
            commitSha: run.target_head,
            buildVersion: payload.buildVersion,
            publicationMode: "build_only",
            embeddingMode,
            path: item.path,
            content
          });
          await githubKbServiceDeps.updateManifestItemBuildStatus({ runId: run.id, path: item.path, status: "rebuilt" });
        });
        rebuilt += 1;
      }
    } else {
      for (const item of manifestItems) {
        if (!item.needs_rebuild) {
          await withTransientDbRetry(() =>
            githubKbServiceDeps.updateManifestItemBuildStatus({ runId: run.id, path: item.path, status: "reused" })
          );
          reused += 1;
          continue;
        }
        await withTransientDbRetry(async () => {
          await indexDocument(registration, knowledgeSpace, run.branch, run.target_head, item.path, {
            buildVersion: payload.buildVersion,
            publicationMode: "build_only",
            embeddingMode
          });
          await githubKbServiceDeps.updateManifestItemBuildStatus({ runId: run.id, path: item.path, status: "rebuilt" });
        });
        
        rebuilt += 1;
      }
    }
  } catch (error) {
    if (isTransientDbError(error)) {
      await repo.heartbeatSyncRunShard(run.id, payload.shardKey, "queued").catch(() => undefined);
      throw error;
    }
    const failingPath = manifestItems[rebuilt + reused]?.path;
    if (failingPath) {
      await githubKbServiceDeps.updateManifestItemBuildStatus({
        runId: run.id,
        path: failingPath,
        status: "failed",
        errorMessage: (error as Error).message
      });
    }
    await repo.markSyncRunShardFailed(run.id, payload.shardKey, (error as Error).message);
    await repo.markSyncRunFailed(run.id, (error as Error).message);
    await repo.releaseIngestLease(buildKnowledgeSpaceLeaseKey(knowledgeSpace, registration.id, run.branch), run.id).catch(() => undefined);
    throw error;
  }

  const nextCursor = manifestItems[manifestItems.length - 1]?.path ?? null;
  const remaining = nextCursor
    ? await repo.listPendingManifestItemsForShard({
        runId: run.id,
        shardKey: payload.shardKey,
        cursor: nextCursor,
        limit: 1
      })
    : [];
  const finished = remaining.length === 0;
  await repo.advanceSyncRunShard({
    runId: run.id,
    shardKey: payload.shardKey,
    completedDelta: rebuilt + reused,
    reusableDelta: reused,
    rebuiltDelta: rebuilt,
    failedDelta: 0,
    nextCursor: finished ? null : nextCursor,
    status: finished ? "succeeded" : "queued"
  });

  if (!finished && nextCursor) {
    await enqueueSyncJob({
      repoId: registration.id,
      branch: run.branch,
      mode: "full",
      source: job.source,
      knowledgeSpace,
      requestedFromEnv,
      afterCommitSha: run.target_head,
      payload: {
        ...job.payload_json,
        cursor: nextCursor
      },
      idempotencyKey: `sync-continuation:full:${run.id}:${payload.shardKey}:${run.target_head}:${nextCursor}`
    });
  } else {
    await maybeFinalizeDocsComFullSyncRun(run.id, knowledgeSpace, requestedFromEnv, publicationMode);
  }

  return {
    indexed: rebuilt + reused,
    head: run.target_head,
    finished,
    nextCursor: finished ? null : nextCursor
  };
}

async function runLocalMirrorFullSync(
  job: SyncJob,
  registration: RepoRegistration,
  localMirror: LocalDocsMirrorState,
  leaseOwnerId: string,
  buildVersion: string,
  requestedFromEnv: KbRequestedFromEnv
): Promise<LocalMirrorBatchResult> {
  const branch = job.branch || localMirror.branch || registration.default_branch;
  const knowledgeSpace = resolveJobKnowledgeSpace(job);
  const publicationMode = resolvePublicationModeFromPayload(job.payload_json, "build_only");
  const embeddingMode = resolveEmbeddingModeFromPayload(job.payload_json);
  return runLocalMirrorSyncBatch({
    registration,
    knowledgeSpace,
    requestedFromEnv,
    branch,
    localMirror,
    leaseOwnerId,
    buildVersion,
    publicationMode,
    embeddingMode,
    cursor: getLocalMirrorCursor(job),
    limit: env.GITHUB_KB_LOCAL_MIRROR_BATCH_SIZE
  });
}

async function runLocalMirrorSyncBatch(input: {
  registration: RepoRegistration;
  knowledgeSpace: KbKnowledgeSpace;
  requestedFromEnv: KbRequestedFromEnv;
  branch: string;
  localMirror: LocalDocsMirrorState;
  leaseOwnerId: string;
  buildVersion: string;
  publicationMode: KbBuildPublicationMode;
  embeddingMode: KbEmbeddingMode;
  cursor?: string;
  limit: number;
}): Promise<LocalMirrorBatchResult> {
  const markdownFiles = await collectLocalMirrorSnapshot(input.registration, input.localMirror);
  const window = sliceSnapshotForBackfill(markdownFiles, input.cursor, input.limit);
  const indexed = await indexLocalMirrorPaths({
    registration: input.registration,
    knowledgeSpace: input.knowledgeSpace,
    branch: input.branch,
    commitSha: input.localMirror.head,
    rootDir: input.localMirror.rootDir,
    buildVersion: input.buildVersion,
    publicationMode: "build_only",
    embeddingMode: input.embeddingMode,
    paths: window.files
  });

  let deactivated = 0;
  if (window.finished) {
    await renewBuildIngestLease({
      knowledgeSpace: input.knowledgeSpace,
      repoId: input.registration.id,
      branch: input.branch,
      ownerId: input.leaseOwnerId,
      ownerEnv: input.requestedFromEnv,
      buildVersion: input.buildVersion,
      source: "local_mirror"
    });
    if (!isValidGitCommitSha(input.localMirror.head)) {
      throw new Error(`Refusing to checkpoint invalid local docs-com mirror head: ${input.localMirror.head || "<empty>"}`);
    }
    deactivated = await repo.deactivateDocumentsMissingFromSnapshot(
      input.registration.id,
      input.branch,
      input.knowledgeSpace,
      markdownFiles
    );
    await finalizeBuild({
      knowledgeSpace: input.knowledgeSpace,
      repoId: input.registration.id,
      branch: input.branch,
      buildVersion: input.buildVersion,
      targetHead: input.localMirror.head,
      buildKind: "full",
      requestedBy: "sync_worker",
      requestedFromEnv: input.requestedFromEnv,
      publicationMode: input.publicationMode
    });
    await repo.releaseIngestLease(
      buildKnowledgeSpaceLeaseKey(input.knowledgeSpace, input.registration.id, input.branch),
      input.leaseOwnerId
    ).catch(() => undefined);
    if (shouldAdvanceFullSyncCheckpoint(input.publicationMode)) {
      await repo.upsertCheckpoint({
        repoId: input.registration.id,
        branch: input.branch,
        lastSyncedCommitSha: input.localMirror.head,
        fullSync: true
      });
    }
  }

  return {
    indexed,
    deactivated,
    head: input.localMirror.head,
    total: window.total,
    remaining: window.remaining,
    nextCursor: window.nextCursor,
    finished: window.finished
  };
}

async function runRemoteSnapshotBatch(input: {
  registration: RepoRegistration;
  knowledgeSpace: KbKnowledgeSpace;
  requestedFromEnv: KbRequestedFromEnv;
  branch: string;
  head: string;
  leaseOwnerId: string;
  buildVersion: string;
  publicationMode: KbBuildPublicationMode;
  embeddingMode: KbEmbeddingMode;
  cursor?: string;
  limit: number;
}): Promise<RemoteBatchResult> {
  const files = await listFilesAtCommit(input.registration, input.head);
  const markdownFiles = files
    .filter((file) => isSupportedKnowledgePath(file.path))
    .filter((file) => isPathIncluded(file.path, input.registration.include_paths, input.registration.exclude_paths))
    .map((file) => file.path)
    .sort(compareSnapshotPaths);

  const window = sliceSnapshotForBackfill(markdownFiles, input.cursor, input.limit);
  let indexed = 0;
  for (const relativePath of window.files) {
    await renewBuildIngestLease({
      knowledgeSpace: input.knowledgeSpace,
      repoId: input.registration.id,
      branch: input.branch,
      ownerId: input.leaseOwnerId,
      ownerEnv: input.requestedFromEnv,
      buildVersion: input.buildVersion,
      source: "remote"
    });
    await withTransientDbRetry(() =>
      githubKbServiceDeps.indexDocument({
        registration: input.registration,
        knowledgeSpace: input.knowledgeSpace,
        branch: input.branch,
        commitSha: input.head,
        path: relativePath,
        buildVersion: input.buildVersion,
        publicationMode: "build_only",
        embeddingMode: input.embeddingMode
      })
    );
    indexed += 1;
  }

  let deactivated = 0;
  if (window.finished) {
    await renewBuildIngestLease({
      knowledgeSpace: input.knowledgeSpace,
      repoId: input.registration.id,
      branch: input.branch,
      ownerId: input.leaseOwnerId,
      ownerEnv: input.requestedFromEnv,
      buildVersion: input.buildVersion,
      source: "remote"
    });
    deactivated = await repo.deactivateDocumentsMissingFromSnapshot(
      input.registration.id,
      input.branch,
      input.knowledgeSpace,
      markdownFiles
    );
    await finalizeBuild({
      knowledgeSpace: input.knowledgeSpace,
      repoId: input.registration.id,
      branch: input.branch,
      buildVersion: input.buildVersion,
      targetHead: input.head,
      buildKind: "full",
      requestedBy: "sync_worker",
      requestedFromEnv: input.requestedFromEnv,
      publicationMode: input.publicationMode
    });
    await repo.releaseIngestLease(
      buildKnowledgeSpaceLeaseKey(input.knowledgeSpace, input.registration.id, input.branch),
      input.leaseOwnerId
    ).catch(() => undefined);
    if (shouldAdvanceFullSyncCheckpoint(input.publicationMode)) {
      await repo.upsertCheckpoint({
        repoId: input.registration.id,
        branch: input.branch,
        lastSyncedCommitSha: input.head,
        fullSync: true
      });
    }
  }

  return {
    indexed,
    deactivated,
    head: input.head,
    total: window.total,
    remaining: window.remaining,
    nextCursor: window.nextCursor,
    finished: window.finished
  };
}

function buildSyntheticSyncJob(input: {
  repoId: string;
  branch: string;
  mode: "full" | "incremental" | "reindex";
  source: KbSyncSource;
  payload?: Record<string, unknown>;
}): SyncJob {
  const now = new Date().toISOString();
  return {
    id: `synthetic-${Date.now()}`,
    repo_id: input.repoId,
    branch: input.branch,
    sync_mode: input.mode,
    source: input.source,
    status: "running",
    idempotency_key: `synthetic:${input.repoId}:${input.branch}:${input.mode}:${Date.now()}`,
    before_commit_sha: null,
    after_commit_sha: null,
    payload_json: input.payload ?? {},
    attempts: 0,
    max_attempts: 1,
    next_run_at: now,
    started_at: now,
    finished_at: null,
    error_message: null,
    created_at: now,
    updated_at: now
  };
}

async function runFullSync(job: SyncJob, registration: RepoRegistration): Promise<SyncExecutionResult> {
  const knowledgeSpace = resolveJobKnowledgeSpace(job);
  const requestedFromEnv = resolveRequestedFromEnvFromPayload(job.payload_json);
  const publicationMode = resolvePublicationModeFromPayload(job.payload_json, "build_only");
  const embeddingMode = resolveEmbeddingModeFromPayload(job.payload_json);
  const leaseOwnerId = resolveSyncExecutionId(job.payload_json, job.id);
  const localMirror = await getLocalDocsMirrorState(registration);
  if (localMirror) {
    const buildVersion =
      String(job.payload_json?.buildVersion ?? "").trim() || buildExecutionScopedBuildVersion(localMirror.head, leaseOwnerId);
    await renewBuildIngestLease({
      knowledgeSpace,
      repoId: registration.id,
      branch: job.branch || localMirror.branch || registration.default_branch,
      ownerId: leaseOwnerId,
      ownerEnv: requestedFromEnv,
      buildVersion,
      source: "local_mirror"
    });
    await ensureBuildRecord({
      knowledgeSpace,
      repoId: registration.id,
      branch: job.branch || localMirror.branch || registration.default_branch,
      buildVersion,
      targetHead: localMirror.head,
      buildKind: "full",
      requestedBy: job.source,
      requestedFromEnv
    });
    return withGenericBuildBatchLock(
      {
        knowledgeSpace,
        repoId: registration.id,
        branch: job.branch || localMirror.branch || registration.default_branch,
        buildVersion
      },
      () => runLocalMirrorFullSync(job, registration, localMirror, leaseOwnerId, buildVersion, requestedFromEnv)
    );
  }
  const resolved = await resolveRegistrationBranch(registration, job.branch, "sync_worker");
  const branch = resolved.branch;
  const effectiveRegistration = resolved.registration;
  const head = job.after_commit_sha ?? (await getBranchHead(effectiveRegistration, branch));
  const buildVersion =
    String(job.payload_json?.buildVersion ?? "").trim() || buildExecutionScopedBuildVersion(head, leaseOwnerId);
  await renewBuildIngestLease({
    knowledgeSpace,
    repoId: effectiveRegistration.id,
    branch,
    ownerId: leaseOwnerId,
    ownerEnv: requestedFromEnv,
    buildVersion,
    source: "remote"
  });
  await ensureBuildRecord({
    knowledgeSpace,
    repoId: effectiveRegistration.id,
    branch,
    buildVersion,
    targetHead: head,
    buildKind: "full",
    requestedBy: job.source,
    requestedFromEnv
  });
  const cursor = getLocalMirrorCursor(job);
  return withGenericBuildBatchLock(
    {
      knowledgeSpace,
      repoId: effectiveRegistration.id,
      branch,
      buildVersion
    },
    () =>
      runRemoteSnapshotBatch({
        registration: effectiveRegistration,
        knowledgeSpace,
        requestedFromEnv,
        branch,
        head,
        leaseOwnerId,
        buildVersion,
        publicationMode,
        embeddingMode,
        cursor,
        limit: env.GITHUB_KB_REMOTE_SYNC_BATCH_SIZE
      })
  );
}

async function runIncrementalSync(job: SyncJob, registration: RepoRegistration): Promise<SyncExecutionResult> {
  // Conservative Part 02 implementation: until patch-build safety is proven, all incremental work falls back to a new full build.
  return runFullSync({ ...job, sync_mode: "full" }, registration);
}

async function runReindex(job: SyncJob, registration: RepoRegistration): Promise<SyncExecutionResult> {
  const full = await runFullSync({ ...job, sync_mode: "full" }, registration);
  return { indexed: full.indexed, head: full.head, finished: full.finished, nextCursor: full.nextCursor };
}

export async function runRepositorySyncDirect(input: {
  repoId: string;
  branch?: string;
  mode: "full" | "incremental" | "reindex";
  source?: KbSyncSource;
  knowledgeSpace?: KbKnowledgeSpace;
  operatorOverride?: boolean;
  cursor?: string;
  executionId?: string;
}): Promise<SyncExecutionResult> {
  const registration = await repo.getRepoRegistrationById(input.repoId);
  if (!registration || !registration.is_active) {
    throw new Error(`Repository registration not found or inactive: ${input.repoId}`);
  }

  const branch = input.branch?.trim() || registration.default_branch;
  const executionId = String(input.executionId ?? "").trim() || deriveSyncExecutionId(`direct:${registration.id}:${branch}:${input.mode}`);
  const requestedFromEnv = resolveRequestedFromEnvForOperation(Boolean(input.operatorOverride));
  const syntheticJob: SyncJob = {
    ...buildSyntheticSyncJob({
      repoId: registration.id,
      branch,
      mode: input.mode,
      source: input.source ?? "manual",
      payload: {
        ...(input.knowledgeSpace ? { knowledgeSpace: input.knowledgeSpace } : {}),
        requestedFromEnv,
        ...(input.cursor ? { cursor: input.cursor } : {}),
        executionId
      }
    })
  };

  if (input.mode === "full") {
    return runFullSync(syntheticJob, registration);
  }
  if (input.mode === "incremental") {
    return runIncrementalSync(syntheticJob, registration);
  }
  return runReindex(syntheticJob, registration);
}

async function enqueueSyncContinuation(job: SyncJob, registration: RepoRegistration, result: SyncExecutionResult): Promise<void> {
  if (result.finished || !result.nextCursor) return;
  const continuationPayload = buildGenericSyncContinuationPayload(job, result);
  await enqueueSyncJob({
    repoId: registration.id,
    branch: job.branch,
    mode: job.sync_mode,
    source: job.source,
    knowledgeSpace: resolveJobKnowledgeSpace(job),
    requestedFromEnv: resolveRequestedFromEnvFromPayload(job.payload_json),
    beforeCommitSha: job.before_commit_sha ?? undefined,
    afterCommitSha: result.head,
    payload: continuationPayload,
    idempotencyKey: `sync-continuation:${job.sync_mode}:${registration.id}:${job.branch}:${result.head}:${result.nextCursor}`
  });
}

export async function validateStartupConfig(): Promise<{ healthy: boolean; checkedRepos: number }> {
  if (!env.GITHUB_KB_ENABLED) {
    return { healthy: true, checkedRepos: 0 };
  }

  const repos = await repo.listActiveRepoRegistrations();
  let healthy = true;

  for (const registration of repos) {
    const localMirror = await getLocalDocsMirrorState(registration);
    const branch = localMirror?.branch || registration.default_branch;
    const upstreamValidation = localMirror
      ? {
          ok: true,
          scopes: ["local_mirror"],
          message: "validated via local docs-com mirror"
        }
      : await validateReadOnlyAccess(registration).catch((error) => ({
          ok: false,
          scopes: [],
          message: (error as Error).message
        }));
    const docsCoverage = await validateDocsComCorpusCoverage(registration, branch);
    const validationMessage = [upstreamValidation.ok ? "" : upstreamValidation.message, docsCoverage.ok ? "" : docsCoverage.message]
      .filter(Boolean)
      .join("; ");
    await repo.setRepoValidation(registration.id, validationMessage || null);
    if (!upstreamValidation.ok || !docsCoverage.ok) {
      healthy = false;
    }
  }

  return { healthy, checkedRepos: repos.length };
}

export async function registerRepository(input: {
  repoUrl: string;
  publicBaseUrl?: string;
  defaultBranch?: string;
  includePaths: string[];
  excludePaths: string[];
  pollingIntervalSeconds: number;
  actor: string;
}) {
  const parsed = parseRepoOwnerName(input.repoUrl);
  const includePaths = isDocsComRepo(parsed.owner, parsed.name) ? ensureMarkdownCoverage(input.includePaths) : input.includePaths;
  const publicBaseUrl = pickDefaultPublicBaseUrl(input.repoUrl, input.publicBaseUrl);
  const resolvedBranch = await resolveBranchForRegistrationInput({
    repoUrl: input.repoUrl,
    repoOwner: parsed.owner,
    repoName: parsed.name,
    publicBaseUrl,
    defaultBranch: input.defaultBranch,
    includePaths,
    excludePaths: input.excludePaths,
    pollingIntervalSeconds: input.pollingIntervalSeconds,
    actor: input.actor
  });
  const registration = await repo.upsertRepoRegistration({
    repoOwner: parsed.owner,
    repoName: parsed.name,
    repoUrl: input.repoUrl,
    publicBaseUrl,
    defaultBranch: resolvedBranch,
    includePaths,
    excludePaths: input.excludePaths,
    pollingIntervalSeconds: input.pollingIntervalSeconds,
    createdBy: input.actor
  });
  await repo.deactivateOtherRepoRegistrations(parsed.owner, parsed.name, registration.id);

  const localMirror = await getLocalDocsMirrorState(registration);
  const validation = localMirror
    ? {
        ok: true,
        scopes: ["local_mirror"],
        message: "validated via local docs-com mirror"
      }
    : await validateReadOnlyAccess(registration).catch((error) => ({
        ok: false,
        scopes: [],
        message: (error as Error).message
      }));

  await repo.setRepoValidation(registration.id, validation.ok ? null : validation.message);

  return {
    registration,
    validation
  };
}

export async function listRepositories() {
  return repo.listActiveRepoRegistrations();
}

export async function getDocsComStatus(options?: { recentJobLimit?: number }) {
  const registration = await getDocsComRegistration();
  if (!registration) {
    return {
      exists: false,
      canonical: buildDocsComRegistrationInput("internal_operator"),
      status: null
    };
  }
  return {
    exists: true,
    canonical: buildDocsComRegistrationInput("internal_operator"),
    status: await summarizeDocsComCorpus(registration, options?.recentJobLimit ?? 10)
  };
}

async function createDocsComFullSyncRun(input: {
  registration: RepoRegistration;
  actor: string;
  branch?: string;
  runReason?: string;
  knowledgeSpace?: KbKnowledgeSpace;
  requestedFromEnv?: KbRequestedFromEnv;
  publicationMode: KbBuildPublicationMode;
  embeddingMode: KbEmbeddingMode;
}): Promise<{
  run: KbSyncRun;
  shards: KbSyncRunShard[];
  created: boolean;
  sourceMode: "local_mirror" | "remote";
}> {
  const existing = await repo.findActiveFullSyncRun(input.registration.id, input.branch?.trim() || input.registration.default_branch);
  if (existing) {
    return {
      run: existing,
      shards: await repo.listSyncRunShards(existing.id),
      created: false,
      sourceMode: "remote"
    };
  }

  const snapshot = await freezeDocsComSourceSnapshot(input.registration, input.branch);
  const knowledgeSpace = input.knowledgeSpace ?? resolveRuntimeKnowledgeSpace();
  const requestedFromEnv = input.requestedFromEnv ?? resolveRequestedFromEnv();
  const manifest = buildDocsComSourceManifest({
    sourceMode: snapshot.mode,
    includePaths: input.registration.include_paths,
    excludePaths: input.registration.exclude_paths,
    files: snapshot.files
  });
  const hydratedManifest = await populateDocsComManifestEligibleChecksumsForSnapshot({
    registration: input.registration,
    targetHead: snapshot.head,
    sourceMode: snapshot.mode,
    manifest
  });
  const manifestItems = [
    ...hydratedManifest.eligibleItems,
    ...hydratedManifest.skippedItems.map((item) => ({
      path: item.path,
      shardKey: item.shardKey,
      sourceFamily: item.sourceFamily,
      contentChecksum: item.contentChecksum,
      sourceAcquisitionMode: item.sourceAcquisitionMode,
      blobSha: item.blobSha,
      sizeBytes: item.sizeBytes,
      needsRebuild: false,
      reuseReason: null,
      skipReason: item.skipReason,
      buildStatus: "skipped" as const
    }))
  ];

  const { run, shards } = await repo.createFullSyncRun({
    repoId: input.registration.id,
    branch: snapshot.branch,
    targetHead: snapshot.head,
    requestedBy: input.actor,
    runReason: input.runReason,
    sourceSnapshotTotal: snapshot.files.length,
    manifestItems
  });

  const buildVersion = buildFullRunBuildVersion(run.target_head, run.id);
  await repo.acquireIngestLease({
    leaseKey: buildKnowledgeSpaceLeaseKey(knowledgeSpace, input.registration.id, snapshot.branch),
    ownerId: run.id,
    ownerEnv: requestedFromEnv,
    ttlSeconds: 600,
    metadata: {
      buildVersion,
      targetHead: snapshot.head,
      actor: input.actor
    }
  });
  await ensureBuildRecord({
    knowledgeSpace,
    repoId: input.registration.id,
    branch: snapshot.branch,
    buildVersion,
    targetHead: snapshot.head,
    buildKind: "full",
    requestedBy: input.actor,
    requestedFromEnv,
    sourceSnapshotTotal: snapshot.files.length
  });
  for (const shard of shards) {
    if (shard.total_docs === 0) {
      await repo.advanceSyncRunShard({
        runId: run.id,
        shardKey: shard.shard_key,
        completedDelta: 0,
        reusableDelta: 0,
        rebuiltDelta: 0,
        failedDelta: 0,
        nextCursor: null,
        status: "succeeded"
      });
      continue;
    }
    await enqueueSyncJob({
      repoId: input.registration.id,
      branch: snapshot.branch,
      mode: "full",
      source: "system",
      knowledgeSpace,
      requestedFromEnv,
      afterCommitSha: snapshot.head,
      payload: {
        runId: run.id,
        shardKey: shard.shard_key,
        targetHead: snapshot.head,
        buildVersion,
        sourceMode: snapshot.mode,
        publicationMode: input.publicationMode,
        embeddingMode: input.embeddingMode
      },
      idempotencyKey: `sync-continuation:full:${run.id}:${shard.shard_key}:${snapshot.head}:start`
    });
  }

  return {
    run,
    shards: await repo.listSyncRunShards(run.id),
    created: true,
    sourceMode: snapshot.mode
  };
}

export async function ensureDocsComKnowledgeBase(input?: {
  actor?: string;
  mode?: "incremental" | "full" | "reindex";
  runLimit?: number;
  idempotencySeed?: string;
  publicationMode?: KbBuildPublicationMode;
  embeddingMode?: KbEmbeddingMode;
}) {
  const actor = input?.actor?.trim() || "internal_operator";
  const mode = input?.mode ?? "incremental";
  const registrationInput = buildDocsComRegistrationInput(actor);
  const beforeRegistration = await getDocsComRegistration();
  const beforeStatus = beforeRegistration ? await summarizeDocsComCorpus(beforeRegistration, 5) : null;

  const { registration, validation } = await registerRepository(registrationInput);
  if (isCanonicalDocsComRegistration(registration)) {
    await deactivateLegacyDocsComRegistrations(registration.id, actor);
  }
  let enqueuedJob:
    | {
        id: string;
        mode: string;
        status: string;
        branch: string;
        idempotencyKey: string;
      }
    | null = null;
  let runSummary:
    | {
        id: string;
        targetHead: string;
        status: string;
        created: boolean;
        shardCount: number;
      }
    | null = null;

  if (mode === "full" && isDocsComRegistration(registration)) {
    const run = await createDocsComFullSyncRun({
      registration,
      actor,
      branch: registration.default_branch,
      runReason: `docs-com ensure ${input?.idempotencySeed?.trim() || new Date().toISOString()}`,
      publicationMode: input?.publicationMode ?? "build_only",
      embeddingMode: input?.embeddingMode ?? DEFAULT_EMBEDDING_MODE
    });
    runSummary = {
      id: run.run.id,
      targetHead: run.run.target_head,
      status: run.run.status,
      created: run.created,
      shardCount: run.shards.length
    };
  } else {
    const idempotencyKey = [
      "docs-com",
      mode,
      registration.id,
      registration.default_branch,
      input?.idempotencySeed?.trim() || new Date().toISOString().slice(0, 16)
    ].join(":");

    const job = await enqueueSyncJob({
      repoId: registration.id,
      branch: registration.default_branch,
      mode,
      source: "system",
      idempotencyKey
    });
    enqueuedJob = {
      id: job.id,
      mode: job.sync_mode,
      status: job.status,
      branch: job.branch,
      idempotencyKey: job.idempotency_key
    };
  }
  const runLimit = Math.max(0, Math.min(20, input?.runLimit ?? 0));
  const runResult = runLimit > 0 ? await runDueSyncJobs(runLimit) : { processed: 0, succeeded: 0, failed: 0, deadLetter: 0 };
  const afterStatus = await summarizeDocsComCorpus(registration, 10);

  return {
    registrationChanged:
      !beforeRegistration ||
      beforeRegistration.repo_url !== registration.repo_url ||
      beforeRegistration.public_base_url !== registration.public_base_url ||
      beforeRegistration.default_branch !== registration.default_branch ||
      JSON.stringify(beforeRegistration.include_paths) !== JSON.stringify(registration.include_paths) ||
      JSON.stringify(beforeRegistration.exclude_paths) !== JSON.stringify(registration.exclude_paths),
    validation,
    enqueuedJob,
    fullRun: runSummary,
    runResult,
    beforeStatus,
    afterStatus
  };
}

export async function startKnowledgeBaseFullBuild(input: {
  repoId: string;
  branch?: string;
  actor: string;
  knowledgeSpace?: KbKnowledgeSpace;
  operatorOverride?: boolean;
  publicationMode?: KbBuildPublicationMode;
  embeddingMode?: KbEmbeddingMode;
}): Promise<{
  knowledgeSpace: KbKnowledgeSpace;
  job?: Awaited<ReturnType<typeof enqueueSyncJob>>;
  build?: KbBuild | null;
  fullRun?: { id: string; targetHead: string; created: boolean };
}> {
  const runtimeKnowledgeSpace = resolveRuntimeKnowledgeSpace();
  if (input.knowledgeSpace && input.knowledgeSpace !== runtimeKnowledgeSpace && !input.operatorOverride) {
    throw new Error(`Cross-space full build start requires operator override support. Requested ${input.knowledgeSpace}, runtime ${runtimeKnowledgeSpace}`);
  }
  const requestedFromEnv = resolveRequestedFromEnvForOperation(Boolean(input.operatorOverride));
  const registration = await repo.getRepoRegistrationById(input.repoId);
  if (!registration || !registration.is_active) {
    throw new Error(`Repository registration not found or inactive: ${input.repoId}`);
  }
  const knowledgeSpace = input.knowledgeSpace ?? runtimeKnowledgeSpace;
  if (isDocsComRegistration(registration)) {
    const run = await createDocsComFullSyncRun({
      registration,
      actor: input.actor,
      branch: input.branch ?? registration.default_branch,
      runReason: `api full build ${new Date().toISOString()}`,
      knowledgeSpace,
      requestedFromEnv,
      publicationMode: input.publicationMode ?? "build_only",
      embeddingMode: input.embeddingMode ?? DEFAULT_EMBEDDING_MODE
    });
    const buildVersion = buildFullRunBuildVersion(run.run.target_head, run.run.id);
    const build = await repo.getBuildByVersion({
      knowledgeSpace,
      repoId: registration.id,
      branch: run.run.branch,
      buildVersion
    });
    return {
      knowledgeSpace,
      build,
      fullRun: {
        id: run.run.id,
        targetHead: run.run.target_head,
        created: run.created
      }
    };
  }

  const job = await enqueueSyncJob({
    repoId: registration.id,
    branch: input.branch ?? registration.default_branch,
    mode: "full",
    source: "manual",
    knowledgeSpace,
    requestedFromEnv,
    payload: {
      knowledgeSpace,
      requestedFromEnv,
      publicationMode: input.publicationMode ?? "build_only",
      embeddingMode: input.embeddingMode ?? DEFAULT_EMBEDDING_MODE
    }
  });
  return {
    knowledgeSpace,
    job
  };
}

export async function startKnowledgeBaseIncrementalBuild(input: {
  repoId: string;
  branch?: string;
  actor: string;
  knowledgeSpace?: KbKnowledgeSpace;
  operatorOverride?: boolean;
  publicationMode?: KbBuildPublicationMode;
  embeddingMode?: KbEmbeddingMode;
}): Promise<{
  knowledgeSpace: KbKnowledgeSpace;
  fallbackMode: "full_rebuild";
  job: Awaited<ReturnType<typeof enqueueSyncJob>>;
}> {
  const runtimeKnowledgeSpace = resolveRuntimeKnowledgeSpace();
  if (input.knowledgeSpace && input.knowledgeSpace !== runtimeKnowledgeSpace && !input.operatorOverride) {
    throw new Error(
      `Cross-space incremental build start requires operator override support. Requested ${input.knowledgeSpace}, runtime ${runtimeKnowledgeSpace}`
    );
  }
  const knowledgeSpace = input.knowledgeSpace ?? runtimeKnowledgeSpace;
  const requestedFromEnv = resolveRequestedFromEnvForOperation(Boolean(input.operatorOverride));
  const job = await enqueueSyncJob({
    repoId: input.repoId,
    branch: input.branch,
    mode: "incremental",
    source: "manual",
    knowledgeSpace,
    requestedFromEnv,
    payload: {
      knowledgeSpace,
      requestedFromEnv,
      publicationMode: input.publicationMode ?? "build_only",
      embeddingMode: input.embeddingMode ?? DEFAULT_EMBEDDING_MODE
    }
  });
  return {
    knowledgeSpace,
    fallbackMode: "full_rebuild",
    job
  };
}

export async function promoteValidatedBuild(input: {
  buildId: string;
  actor: string;
  operatorOverride?: boolean;
}): Promise<{
  build: KbBuild;
  publication: Awaited<ReturnType<typeof repo.getPublication>>;
}> {
  const build = await repo.getBuildById(input.buildId);
  if (!build) throw new Error(`Build not found: ${input.buildId}`);
  const registration = await repo.getRepoRegistrationById(build.repo_id);
  const requestedFromEnv = resolveRequestedFromEnvForOperation(Boolean(input.operatorOverride));
  const validation = await validateBuildForPublication({
    knowledgeSpace: build.knowledge_space,
    repoId: build.repo_id,
    branch: build.branch,
    buildVersion: build.build_version,
    buildId: build.id,
    requiredPrefixes: registration && isDocsComRegistration(registration) ? DOCS_COM_REQUIRED_PREFIXES : undefined
  });
  if (!validation.passed) {
    throw new Error(`Build ${build.build_version} is not publishable`);
  }
  if (!canPublishToKnowledgeSpace(requestedFromEnv, build.knowledge_space)) {
    throw new Error(`Environment ${requestedFromEnv} cannot promote build ${build.build_version} into ${build.knowledge_space}`);
  }
  await publishValidatedBuild({
    knowledgeSpace: build.knowledge_space,
    repoId: build.repo_id,
    branch: build.branch,
    buildId: build.id,
    buildVersion: build.build_version,
    targetHead: build.target_head,
    publishedBy: input.actor,
    publishedFromEnv: requestedFromEnv
  });
  return {
    build: (await repo.getBuildById(build.id)) ?? build,
    publication: await repo.getPublication({
      knowledgeSpace: build.knowledge_space,
      repoId: build.repo_id,
      branch: build.branch
    })
  };
}

export async function getKnowledgeBasePublicationStatus(input?: {
  repoId?: string;
  branch?: string;
  knowledgeSpace?: KbKnowledgeSpace;
}) {
  return repo.listPublications({
    repoId: input?.repoId,
    branch: input?.branch,
    knowledgeSpace: input?.knowledgeSpace
  });
}

function buildCleanupHints(input: {
  build: KbBuild;
  publication: Awaited<ReturnType<typeof repo.getPublication>>;
  validationSnapshot: Awaited<ReturnType<typeof repo.getBuildValidationSnapshot>>;
  artifactSummary: Awaited<ReturnType<typeof repo.getBuildArtifactSummary>>;
}): string[] {
  const hints: string[] = [];
  if (!input.publication && (input.build.status === "failed" || input.build.status === "abandoned")) {
    hints.push("terminal_build_without_publication");
  }
  if (input.publication && input.publication.published_build_version !== input.build.build_version) {
    hints.push("superseded_by_newer_publication");
  }
  if (input.validationSnapshot.duplicatePaths > 0) {
    hints.push("duplicate_path_anomaly_present");
  }
  if (input.validationSnapshot.crossBuildMemorySources > 0 || input.validationSnapshot.missingChunkDocuments > 0) {
    hints.push("cross_build_or_orphan_linkage_present");
  }
  if (input.build.status === "abandoned" && input.artifactSummary.embeddingSummary.chunkEmbeddings.ready > 0) {
    hints.push("stale_chunk_embeddings_for_abandoned_build");
  }
  return hints;
}

export async function getKnowledgeBaseBuildDetails(buildId: string) {
  const build = await repo.getBuildById(buildId);
  if (!build) return null;
  const validations = await repo.listBuildValidationResults(buildId);
  const publication = await repo.getPublication({
    knowledgeSpace: build.knowledge_space,
    repoId: build.repo_id,
    branch: build.branch
  });
  const validationSnapshot = await repo.getBuildValidationSnapshot({
    knowledgeSpace: build.knowledge_space,
    repoId: build.repo_id,
    branch: build.branch,
    buildVersion: build.build_version
  });
  const artifactSummary = await repo.getBuildArtifactSummary({
    knowledgeSpace: build.knowledge_space,
    repoId: build.repo_id,
    branch: build.branch,
    buildVersion: build.build_version
  });
  return {
    build,
    validations,
    summary: {
      resolvedSnapshot: {
        knowledgeSpace: build.knowledge_space,
        repoId: build.repo_id,
        branch: build.branch,
        buildVersion: build.build_version,
        targetHead: build.target_head
      },
      artifactCountsByFamily: artifactSummary.artifactCountsByFamily,
      parserDegradation: artifactSummary.parserDegradation,
      embeddingSummary: artifactSummary.embeddingSummary,
      validationSnapshot,
      publicationStatus:
        publication?.published_build_version === build.build_version
          ? "published"
          : publication
            ? "not_currently_published"
            : "not_published",
      cleanupHints: buildCleanupHints({
        build,
        publication,
        validationSnapshot,
        artifactSummary
      })
    }
  };
}

export { buildDocsComSourceManifest };

export async function enqueueSyncJob(input: {
  repoId: string;
  branch?: string;
  mode: "full" | "incremental" | "reindex";
  source: KbSyncSource;
  knowledgeSpace?: KbKnowledgeSpace;
  requestedFromEnv?: KbRequestedFromEnv;
  beforeCommitSha?: string;
  afterCommitSha?: string;
  payload?: Record<string, unknown>;
  idempotencyKey?: string;
}) {
  const registration = await repo.getRepoRegistrationById(input.repoId);
  if (!registration || !registration.is_active) {
    throw new Error(`Repository registration not found or inactive: ${input.repoId}`);
  }
  const localMirror = await getLocalDocsMirrorState(registration);
  const resolved = localMirror
    ? { registration, branch: input.branch?.trim() || localMirror.branch || registration.default_branch }
    : await resolveRegistrationBranch(registration, input.branch, "sync_enqueue");
  const idempotencyKey =
    input.idempotencyKey ??
    `${input.mode}:${resolved.registration.id}:${resolved.branch}:${input.beforeCommitSha ?? "none"}:${input.afterCommitSha ?? Date.now()}`;
  const knowledgeSpace = input.knowledgeSpace ?? resolveRuntimeKnowledgeSpace();
  const payload = buildEnqueuedSyncPayload({
    mode: input.mode,
    idempotencyKey,
    knowledgeSpace,
    requestedFromEnv: input.requestedFromEnv ?? resolveRequestedFromEnv(),
    afterCommitSha: input.afterCommitSha,
    payload: input.payload
  });

  return repo.enqueueSyncJob({
    repoId: resolved.registration.id,
    branch: resolved.branch,
    syncMode: input.mode,
    source: input.source,
    idempotencyKey,
    beforeCommitSha: input.beforeCommitSha,
    afterCommitSha: input.afterCommitSha,
    payload
  });
}

export async function runDueSyncJobs(limit: number): Promise<{ processed: number; succeeded: number; failed: number; deadLetter: number }> {
  await repo.requeueStaleRunningJobs(10);
  const jobs = await repo.claimDueSyncJobs(limit);
  let succeeded = 0;
  let failed = 0;
  let deadLetter = 0;

  for (const job of jobs) {
    const startedAt = Date.now();
    try {
      const registration = await repo.getRepoRegistrationById(job.repo_id);
      if (!registration || !registration.is_active) {
        throw new Error(`Repository registration not found or inactive: ${job.repo_id}`);
      }

      const localMirror = await getLocalDocsMirrorState(registration);
      if (!localMirror) {
        const validation = await validateReadOnlyAccess(registration);
        if (!validation.ok) {
          throw new Error(`Read-only validation failed: ${validation.message}`);
        }
      }

      let executionResult: SyncExecutionResult;
      if (job.sync_mode === "full") {
        const fullRunPayload = getFullRunPayload(job);
        const activeDocsComFullRun =
          !fullRunPayload && isDocsComRegistration(registration)
            ? await repo.findActiveFullSyncRun(registration.id, job.branch)
            : null;
        const result = fullRunPayload
          ? await runDocsComFullSyncShardJob(job, registration)
          : activeDocsComFullRun
            ? { indexed: 0, head: activeDocsComFullRun.target_head, finished: true, nextCursor: null }
            : await runFullSync(job, registration);
        executionResult = result;
        await repo.recordMetric({
          repoId: registration.id,
          metricName: "kb_full_sync_docs",
          metricValue: result.indexed,
          tags: { branch: job.branch, commit: result.head }
        });
      } else if (job.sync_mode === "incremental") {
        const result = await runIncrementalSync(job, registration);
        executionResult = result;
        await repo.recordMetric({
          repoId: registration.id,
          metricName: "kb_incremental_sync_docs",
          metricValue: result.indexed,
          tags: { branch: job.branch, commit: result.head }
        });
      } else {
        const result = await runReindex(job, registration);
        executionResult = result;
        await repo.recordMetric({
          repoId: registration.id,
          metricName: "kb_reindex_docs",
          metricValue: result.indexed,
          tags: { branch: job.branch, commit: result.head }
        });
      }

      if (!getFullRunPayload(job)) {
        await enqueueSyncContinuation(job, registration, executionResult);
      }

      await repo.markSyncJobSucceeded(job.id);
      await repo.recordMetric({
        repoId: job.repo_id,
        metricName: "kb_sync_latency_ms",
        metricValue: Date.now() - startedAt,
        tags: { mode: job.sync_mode }
      });
      succeeded += 1;
    } catch (error) {
      const errorMessage = (error as Error).message;
      const fullRunPayload = getFullRunPayload(job);
      if (fullRunPayload && isTransientDbError(error)) {
        await repo.heartbeatSyncRunShard(fullRunPayload.runId, fullRunPayload.shardKey, "queued").catch(() => undefined);
      }
      const status = await repo.markSyncJobFailed(job, errorMessage);
      await handleTerminalGenericSyncJobFailure({
        job,
        status,
        errorMessage
      });
      failed += 1;
      if (status === "dead_letter") {
        deadLetter += 1;
      }
      await repo.recordMetric({
        repoId: job.repo_id,
        metricName: "kb_sync_failures",
        metricValue: 1,
        tags: { mode: job.sync_mode, status }
      });
    }
  }

  return {
    processed: jobs.length,
    succeeded,
    failed,
    deadLetter
  };
}

export async function pollAndEnqueueIncremental(limit = env.GITHUB_KB_POLL_BATCH_SIZE): Promise<{ polled: number; enqueued: number }> {
  const registrations = await repo.listActiveRepoRegistrations();
  let enqueued = 0;

  for (const registration of registrations.slice(0, limit)) {
    const localMirror = await getLocalDocsMirrorState(registration);
    if (localMirror) {
      if (!isValidGitCommitSha(localMirror.head)) {
        console.warn(`[github-kb] skipping local docs-com polling enqueue because head is invalid: ${localMirror.head || "<empty>"}`);
        continue;
      }
      const branch = localMirror.branch || registration.default_branch;
      const checkpoint = await repo.getCheckpoint(registration.id, branch);
      const publication = await repo.getPublication({
        knowledgeSpace: resolveRuntimeKnowledgeSpace(),
        repoId: registration.id,
        branch
      });
      const request = buildPollingSyncRequestFromPublication({
        latestHead: localMirror.head,
        publication,
        checkpoint
      });
      if (!request) {
        continue;
      }
      await enqueueSyncJob({
        repoId: registration.id,
        branch,
        mode: request.mode,
        source: "polling",
        beforeCommitSha: "beforeCommitSha" in request ? request.beforeCommitSha : undefined,
        afterCommitSha: localMirror.head,
        idempotencyKey: `poll:local:${registration.id}:${branch}:${"beforeCommitSha" in request ? request.beforeCommitSha : "none"}:${localMirror.head}`
      });
      enqueued += 1;
      continue;
    }
    const resolved = await resolveRegistrationBranch(registration, registration.default_branch, "polling");
    const branch = resolved.branch;
    const effectiveRegistration = resolved.registration;
    const latest = await getBranchHead(effectiveRegistration, branch);
    const checkpoint = await repo.getCheckpoint(effectiveRegistration.id, branch);
    const publication = await repo.getPublication({
      knowledgeSpace: resolveRuntimeKnowledgeSpace(),
      repoId: effectiveRegistration.id,
      branch
    });
    const request = buildPollingSyncRequestFromPublication({
      latestHead: latest,
      publication,
      checkpoint
    });
    if (!request) {
      continue;
    }

    await enqueueSyncJob({
      repoId: effectiveRegistration.id,
      branch,
      mode: request.mode,
      source: "polling",
      beforeCommitSha: "beforeCommitSha" in request ? request.beforeCommitSha : undefined,
      afterCommitSha: latest,
      idempotencyKey: `poll:${effectiveRegistration.id}:${branch}:${"beforeCommitSha" in request ? request.beforeCommitSha : "none"}:${latest}`
    });
    enqueued += 1;
  }

  return { polled: registrations.length, enqueued };
}

export async function listSyncJobs(limit = 50) {
  return repo.listRecentSyncJobs(limit);
}

export async function backfillRepositoryFromLocalMirror(
  repoId?: string,
  options?: { cursor?: string; limit?: number }
): Promise<{
  repoId: string;
  repo: string;
  branch: string;
  indexed: number;
  deactivated: number;
  head: string;
  total: number;
  remaining: number;
  nextCursor: string | null;
  finished: boolean;
}> {
  const registration = repoId
    ? await repo.getRepoRegistrationById(repoId)
    : await getDocsComRegistration();
  if (!registration || !registration.is_active) {
    throw new Error(`Repository registration not found or inactive: ${repoId ?? "docs-com"}`);
  }

  const localMirror = await getLocalDocsMirrorState(registration);
  if (!localMirror) {
    throw new Error("Local docs-com mirror is not available");
  }

  const branch = registration.default_branch;
  const knowledgeSpace = resolveRuntimeKnowledgeSpace();
  const requestedFromEnv = resolveRequestedFromEnv();
  const buildVersion = localMirror.head;
  const leaseOwnerId = deriveSyncExecutionId(`local-backfill:${registration.id}:${branch}:${buildVersion}`);

  await repo.acquireIngestLease({
    leaseKey: buildKnowledgeSpaceLeaseKey(knowledgeSpace, registration.id, branch),
    ownerId: leaseOwnerId,
    ownerEnv: requestedFromEnv,
    ttlSeconds: 300,
    metadata: { buildVersion, source: "local_mirror", executionId: leaseOwnerId }
  });
  await ensureBuildRecord({
    knowledgeSpace,
    repoId: registration.id,
    branch,
    buildVersion,
    targetHead: localMirror.head,
    buildKind: "full",
    requestedBy: "local_mirror_backfill",
    requestedFromEnv,
    sourceSnapshotTotal: localMirror.markdownCount
  });

  const batch = await runLocalMirrorSyncBatch({
    registration,
    knowledgeSpace,
    requestedFromEnv,
    branch,
    localMirror,
    leaseOwnerId,
    buildVersion,
    publicationMode: "build_only",
    embeddingMode: DEFAULT_EMBEDDING_MODE,
    cursor: options?.cursor,
    limit: options?.limit ?? env.GITHUB_KB_LOCAL_MIRROR_BATCH_SIZE
  });

  await repo.setRepoValidation(registration.id, null);

  return {
    repoId: registration.id,
    repo: `${registration.repo_owner}/${registration.repo_name}`,
    branch,
    indexed: batch.indexed,
    deactivated: batch.deactivated,
    head: batch.head,
    total: batch.total,
    remaining: batch.remaining,
    nextCursor: batch.nextCursor,
    finished: batch.finished
  };
}

function verifyWebhookSignature(payload: Record<string, unknown>, signature?: string): boolean {
  if (!env.GITHUB_WEBHOOK_SECRET) {
    return true;
  }
  if (!signature) {
    return false;
  }

  const body = JSON.stringify(payload);
  const expected = `sha256=${crypto.createHmac("sha256", env.GITHUB_WEBHOOK_SECRET).update(body).digest("hex")}`;
  const left = Buffer.from(signature);
  const right = Buffer.from(expected);
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

export async function ingestGithubWebhook(input: {
  event: string;
  delivery: string;
  signature256?: string;
  payload: Record<string, unknown>;
}): Promise<{ accepted: boolean; enqueued: boolean; reason?: string }> {
  const repoFullName = String((input.payload.repository as Record<string, unknown> | undefined)?.full_name ?? "");
  await repo.insertWebhookEvent({
    deliveryId: input.delivery,
    eventType: input.event,
    repoFullName,
    payload: input.payload,
    signature: input.signature256
  });

  if (!verifyWebhookSignature(input.payload, input.signature256)) {
    await repo.markWebhookEventProcessed(input.delivery, "failed", "Invalid webhook signature");
    return { accepted: false, enqueued: false, reason: "invalid_signature" };
  }

  if (input.event !== "push") {
    await repo.markWebhookEventProcessed(input.delivery, "processed");
    return { accepted: true, enqueued: false, reason: "ignored_event" };
  }

  const repository = (input.payload.repository ?? {}) as Record<string, unknown>;
  const owner = ((repository.owner ?? {}) as Record<string, unknown>).login as string | undefined;
  const name = repository.name as string | undefined;
  const ref = String(input.payload.ref ?? "");
  const branch = ref.replace("refs/heads/", "");
  const before = String(input.payload.before ?? "");
  const after = String(input.payload.after ?? "");

  if (!owner || !name || !branch) {
    await repo.markWebhookEventProcessed(input.delivery, "failed", "Missing repo owner/name/branch");
    return { accepted: false, enqueued: false, reason: "invalid_payload" };
  }

  const registration = await repo.findActiveRepoByOwnerNameBranch(owner, name, branch);
  if (!registration) {
    await repo.markWebhookEventProcessed(input.delivery, "processed", "No tracked registration");
    return { accepted: true, enqueued: false, reason: "untracked_repo" };
  }

  await enqueueSyncJob({
    repoId: registration.id,
    branch,
    mode: "incremental",
    source: "webhook",
    beforeCommitSha: before,
    afterCommitSha: after,
    idempotencyKey: `webhook:${input.delivery}`
  });

  await repo.markWebhookEventProcessed(input.delivery, "processed");
  return { accepted: true, enqueued: true };
}

function mergeHybridCandidates(
  vectorHits: RetrievalHit[],
  lexicalHits: RetrievalHit[],
  vectorWeight: number,
  keywordWeight: number,
  query: string
): RetrievalHit[] {
  const byChunk = new Map<string, RetrievalHit>();

  vectorHits.forEach((hit, index) => {
    const existing = byChunk.get(hit.chunkId);
    const rr = 1 / (index + 60);
    const score = (existing?.score ?? 0) + rr * vectorWeight;
    byChunk.set(hit.chunkId, {
      ...(existing ?? hit),
      score,
      vectorScore: hit.vectorScore ?? hit.score,
      rankSignals: {
        ...(existing?.rankSignals ?? {}),
        vectorRrf: rr
      }
    });
  });

  lexicalHits.forEach((hit, index) => {
    const existing = byChunk.get(hit.chunkId);
    const rr = 1 / (index + 60);
    const base = existing ?? hit;
    const score = (existing?.score ?? 0) + rr * keywordWeight;
    byChunk.set(hit.chunkId, {
      ...base,
      score,
      lexicalScore: hit.lexicalScore ?? hit.score,
      snippet: hit.snippet || base.snippet,
      rankSignals: {
        ...(base.rankSignals ?? {}),
        lexicalRrf: rr
      }
    });
  });

  const normalizedQuery = query.toLowerCase();
  const apiIntent = isApiIntent(query);
  const troubleshootingInfraIntent =
    /\b(k8s|kubernetes|pod|pvc|pv|pd|disk|volume|oom|crashloop|loadstore|rebuild|index|sync)\b/i.test(normalizedQuery);
  const integrationIntent =
    /\b(integrate|integration|teams|slack|webhook|zapier|oauth|github|gitlab|callback|redirect|baseurl)\b/i.test(normalizedQuery) ||
    /集成|回调|重定向|授权登录|oauth|github|gitlab|baseurl/.test(query);
  const merged = [...byChunk.values()].map((hit) => {
    let boosted = hit.score;
    const metadata = (hit.supportMetadata ?? {}) as Record<string, unknown>;
    const productArea = String(metadata.product_area ?? "").toLowerCase();
    const evidenceKind = String(metadata.evidence_kind ?? "").toLowerCase();
    if (hit.path.toLowerCase().includes(normalizedQuery)) boosted += 0.03;
    if (hit.title.toLowerCase().includes(normalizedQuery)) boosted += 0.05;

    const tokens = normalizedQuery.split(/[\s,，。！？!?.:/_-]+/).filter(Boolean);
    for (const token of tokens) {
      if (!token) continue;
      if (hit.path.toLowerCase().includes(token)) boosted += 0.025;
      if (hit.title.toLowerCase().includes(token)) boosted += 0.03;
    }

    // For API-like questions, prefer OpenAPI endpoint docs over webhook/event docs.
    if (apiIntent) {
      if (/\/openapi\/api\/.+\.api\.mdx$/i.test(hit.path)) boosted += 0.24;
      else if (/\/openapi\//i.test(hit.path) || productArea === "openapi") boosted += 0.1;
      else boosted -= 0.18;
      if (evidenceKind === "api_operation") boosted += 0.12;
      if (/\/abilities\/events\//i.test(hit.path)) boosted -= 0.04;
      if (/create-a-new-issue\.api\.mdx$/i.test(hit.path) && /\b(create|new)\b/i.test(normalizedQuery) && /\bissue\b/i.test(normalizedQuery)) {
        boosted += 0.2;
      }
    }

    // Infra troubleshooting intent should prioritize deploy-docs troubleshooting/runbook content.
    if (troubleshootingInfraIntent) {
      if (/^deploy-docs\/troubleshooting\/infra\//i.test(hit.path)) boosted += 0.2;
      if (/^deploy-docs\/troubleshooting\//i.test(hit.path)) boosted += 0.12;
      if (/\/open-docs\/docs\/abilities\/extensions\//i.test(hit.path) || /^open-docs\/docs\/abilities\/extensions\//i.test(hit.path)) {
        boosted -= 0.18;
      }
    }

    // Integration intent should prioritize integrations directory.
    if (integrationIntent) {
      if (/\/docs\/integrations\//i.test(hit.path) || /^docs\/integrations\//i.test(hit.path)) boosted += 0.14;
      if (/\/openapi\/api\//i.test(hit.path)) boosted -= 0.08;
    }
    return { ...hit, score: boosted };
  });

  merged.sort((a, b) => b.score - a.score);
  return merged;
}

function rerankHitsForIntent(query: string, hits: RetrievalHit[]): RetrievalHit[] {
  if (!hits.length) return hits;
  const apiIntent = isApiIntent(query);
  if (!apiIntent) return hits;

  const tokens = tokenizeRetrievalQuery(buildQueryVariants(query).join(" ")).slice(0, 12);
  return [...hits]
    .map((hit) => {
      const metadata = (hit.supportMetadata ?? {}) as Record<string, unknown>;
      const productArea = String(metadata.product_area ?? "").toLowerCase();
      const evidenceKind = String(metadata.evidence_kind ?? "").toLowerCase();
      const haystack = `${hit.path} ${hit.title}`.toLowerCase();
      let boosted = hit.score;
      if (/\/openapi\/api\/.+\.api\.mdx$/i.test(hit.path)) boosted += 0.4;
      else if (/\/openapi\//i.test(hit.path) || productArea === "openapi") boosted += 0.14;
      else boosted -= 0.24;
      if (evidenceKind === "api_operation") boosted += 0.12;
      if (/\/abilities\/events\//i.test(hit.path)) boosted -= 0.08;
      for (const token of tokens) {
        if (token.length < 2) continue;
        if (haystack.includes(token.toLowerCase())) boosted += 0.018;
      }
      if (/^(root|fallback)$/i.test(hit.headingPath ?? "") && cleanSnippet(hit.snippet).length < 40) boosted -= 0.06;
      return { ...hit, score: boosted };
    })
    .sort((a, b) => b.score - a.score);
}

function estimateConfidence(hit: RetrievalHit | undefined): number {
  if (!hit) return 0;
  // Calibrate for hybrid RRF score range (~0.00-0.20). Do not over-amplify fallback-only hits.
  const raw = Math.max(0, hit.score);
  const fallbackFactor = hit.rankSignals?.fallback ? 0.45 : 1;
  const calibrated = (raw / 0.2) * 0.9;
  return Math.max(0, Math.min(1, calibrated * fallbackFactor));
}

function dedupeHitsByPath(hits: RetrievalHit[]): RetrievalHit[] {
  const bestByPath = new Map<string, RetrievalHit>();
  for (const hit of hits) {
    const current = bestByPath.get(hit.path);
    if (!current || hit.score > current.score) {
      bestByPath.set(hit.path, hit);
    }
  }
  return [...bestByPath.values()].sort((a, b) => b.score - a.score);
}

function buildLocalizedAnswer(language: "zh" | "en", hits: RetrievalHit[], confidence: number): string {
  if (!hits.length) {
    return language === "zh"
      ? "未检索到高置信文档，请换一个更具体的问题或关键词。"
      : "No high-confidence documents were retrieved. Please provide a more specific query.";
  }
  const top = hits[0];
  if (language === "zh") {
    return `已检索到 ${hits.length} 条相关文档，优先参考《${top.title}》（路径：${top.path}）。当前置信度 ${confidence.toFixed(2)}。`;
  }
  return `Retrieved ${hits.length} relevant documents. Start with \"${top.title}\" (path: ${top.path}). Confidence: ${confidence.toFixed(2)}.`;
}

async function buildGroundedAnswerFromTopHit(
  language: "zh" | "en",
  hits: RetrievalHit[],
  confidence: number,
  query: string
): Promise<string> {
  if (!hits.length) {
    return buildLocalizedAnswer(language, hits, confidence);
  }

  const top =
    (isApiIntent(query)
      ? hits.find((item) => /\/openapi\/api\/.+\.api\.mdx$/i.test(item.path))
      : null) ?? hits[0];
  if (/\/openapi\/api\/.+\.api\.mdx$/i.test(top.path)) {
    const registration = await repo.getRepoRegistrationById(top.repoId).catch(() => null);
    if (registration) {
      const content = await getFileContentAtCommit(registration, top.path, top.commitSha).catch(() => "");
      if (content) {
        const parsed = decodeOpenApiBlob(content);
        if (parsed) {
          const method = String(parsed.method ?? "").toUpperCase();
          const path = String(parsed.path ?? "");
          const descRaw = sanitizeApiDescription(String(parsed.description ?? parsed.summary ?? ""));
          const desc = descRaw.length > 180 ? `${descRaw.slice(0, 179)}...` : descRaw;
          const params = Array.isArray(parsed.parameters)
            ? parsed.parameters
                .map((item) => {
                  const row = item as Record<string, unknown>;
                  return `${String(row.in ?? "")}:${String(row.name ?? "")}`;
                })
                .filter((item) => item !== ":")
                .slice(0, 4)
            : [];

          if (language === "zh") {
            const base = method && path ? `根据 OpenAPI 文档，使用 \`${method} ${path}\`。` : `根据 OpenAPI 文档，请参考接口 ${top.path}。`;
            const detail = desc ? `说明：${desc}` : "";
            const paramHint = params.length ? `关键参数：${params.join("，")}。` : "";
            return [base, detail, paramHint].filter(Boolean).join(" ");
          }

          const base = method && path ? `Use \`${method} ${path}\` according to the OpenAPI doc.` : `Refer to endpoint definition in ${top.path}.`;
          const detail = desc ? `Description: ${desc}` : "";
          const paramHint = params.length ? `Key params: ${params.join(", ")}.` : "";
          return [base, detail, paramHint].filter(Boolean).join(" ");
        }
      }
    }
  }

  const summary = cleanSnippet(top.snippet || "");
  if (language === "zh") {
    return summary
      ? `根据知识库文档，优先参考 ${top.path}。要点：${summary}`
      : `根据知识库文档，优先参考 ${top.path}。`;
  }
  return summary
    ? `Based on knowledge base content, start with ${top.path}. Key point: ${summary}`
    : `Based on knowledge base content, start with ${top.path}.`;
}

export async function retrieveKnowledge(input: {
  query: string;
  answerLanguage?: "zh" | "en";
  profile: RetrievalProfile;
  repoId?: string;
  branch?: string;
  topK?: number;
  includeFallback: boolean;
  rewrites?: string[];
  supportSignals?: SupportExactSignals;
  caseFrame?: MemoryCaseFrame;
  requiredDocKinds?: string[];
}): Promise<RetrievalResponse> {
  const topK = input.topK ?? getProfileConfig(input.profile).topK;
  const knowledgeSpace = resolveRuntimeKnowledgeSpace();
  const effectiveBranch =
    input.branch?.trim() ||
    (input.repoId ? ((await repo.getRepoRegistrationById(input.repoId))?.default_branch ?? undefined) : undefined);
  const publicationCount = await repo.countPublications({
    knowledgeSpace,
    repoId: input.repoId,
    branch: effectiveBranch
  });
  if (publicationCount === 0) {
    return {
      query: input.query,
      profile: input.profile,
      answerLanguage: input.answerLanguage ?? detectQueryLanguage(input.query),
      retrievalStatus: "kb_unavailable",
      answer:
        (input.answerLanguage ?? detectQueryLanguage(input.query)) === "zh"
          ? "当前知识库不可用，无法给出可靠引用答案。请先完成对应 knowledge space 的发布，再重试。"
          : "The knowledge base is currently unavailable. Publish a validated build for this knowledge space before retrying.",
      resolvedQueries: [input.query],
      confidence: 0,
      fallbackUsed: false,
      hits: [],
      debug: {
        vectorCandidates: 0,
        keywordCandidates: 0,
        mergedCandidates: 0,
        rewrittenQueries: [input.query]
      }
    };
  }
  const cacheKey = buildRetrievalCacheKey({
    query: input.query,
    profile: input.profile,
    repoId: input.repoId,
    branch: effectiveBranch,
    topK,
    includeFallback: input.includeFallback
  });
  const now = Date.now();
  const cached = retrievalCache.get(cacheKey);
  if (cached && cached.expiresAt > now) {
    return cached.value;
  }

  const startedAt = Date.now();
  const cfg = getProfileConfig(input.profile);
  const effectiveTopK = input.topK ?? cfg.topK;
  const answerLanguage = input.answerLanguage ?? detectQueryLanguage(input.query);
  const queryVariants = uniqueStrings([...(input.rewrites ?? []), ...buildQueryVariants(input.query)], 6);

  const [memoryResult, variantBuckets] = await Promise.all([
    retrieveGroundedMemoryHits({
      query: input.query,
      rewrites: queryVariants,
      knowledgeSpace,
      repoId: input.repoId,
      branch: effectiveBranch,
      supportSignals: input.supportSignals,
      caseFrame: input.caseFrame,
      requiredDocKinds: input.requiredDocKinds,
      limit: effectiveTopK
    }).catch(() => ({
      hits: [],
      diagnostics: {
        rewrittenQueries: queryVariants,
        extractedSignals: input.supportSignals ?? {
          methods: [],
          apiPaths: [],
          scopes: [],
          callbacks: [],
          redirectUris: [],
          baseUrls: [],
          errorCodes: [],
          errorTexts: [],
          pageTexts: [],
          objects: [],
          actions: [],
          all: []
        },
        candidateCounts: {
          entry: 0,
          alias: 0,
          signal: 0,
          profile: 0,
          relation: 0,
          grounded: 0
        },
        topMemoryReasons: []
      }
    })),
    Promise.all(
      queryVariants.map(async (variant) => {
      const lexicalPromise = repo
        .searchKeywordCandidates({
          knowledgeSpace,
          repoId: input.repoId,
          branch: effectiveBranch,
          query: variant,
          limit: effectiveTopK * 4
        })
        .catch(() => []);

      const vectorPromise = (async () => {
        try {
          const embedded = await embedWithRetry(variant);
          return await repo.searchVectorCandidates({
            knowledgeSpace,
            repoId: input.repoId,
            branch: effectiveBranch,
            vectorLiteral: embedded.vectorLiteral,
            embeddingModel: embedded.model,
            limit: effectiveTopK * 4
          });
        } catch {
          return [];
        }
      })();

      const [vectorCandidates, lexicalCandidates] = await Promise.all([vectorPromise, lexicalPromise]);
      return { vectorCandidates, lexicalCandidates };
      })
    )
  ]);
  const vectorBuckets: RetrievalHit[] = variantBuckets.flatMap((item) => item.vectorCandidates);
  const lexicalBuckets: RetrievalHit[] = variantBuckets.flatMap((item) => item.lexicalCandidates);

  const merged = mergeHybridCandidates(vectorBuckets, lexicalBuckets, cfg.vectorWeight, cfg.keywordWeight, queryVariants[0]);
  let hits = dedupeHitsByPath([...memoryResult.hits, ...merged]).slice(0, effectiveTopK);
  let fallbackUsed = false;

  let confidence = estimateConfidence(hits[0]);
  if (input.includeFallback && confidence < cfg.threshold) {
    const fallbackDocs = await repo
      .listCandidateDocumentsForFallback({
        knowledgeSpace,
        repoId: input.repoId,
        branch: effectiveBranch,
        query: input.query,
        limit: Math.max(2, Math.ceil(effectiveTopK / 2))
      })
      .catch(() => []);

    for (const doc of fallbackDocs) {
      const content = doc.content;
      if (!content) continue;
      fallbackUsed = true;
      hits.push({
        chunkId: `fallback:${doc.repoId}:${doc.path}:${doc.commitSha}`,
        documentId: `fallback:${doc.repoId}:${doc.path}`,
        repoId: doc.repoId,
        repo: doc.repo,
        branch: doc.branch,
        path: doc.path,
        sourceUrl: doc.sourceUrl,
        repoSourceUrl: doc.repoSourceUrl,
        commitSha: doc.commitSha,
        title: doc.title,
        headingPath: "FALLBACK",
        snippet: content.slice(0, 1600),
        score: 0.12,
        rankSignals: { fallback: 1 }
      });
    }

    hits = hits.sort((a, b) => b.score - a.score).slice(0, effectiveTopK);
    confidence = estimateConfidence(hits[0]);
  }

  hits = await enrichOpenApiHits(hits, answerLanguage).catch(() => hits);
  hits = await hydratePublicSourceUrls(hits).catch(() => hits);
  hits = rerankHitsForIntent(input.query, hits);
  const snippetTerms = tokenizeRetrievalQuery(queryVariants.join(" "));
  hits = hits.map((hit) => ({
    ...hit,
    snippet: buildQueryAnchoredSnippet(hit.snippet || hit.title, snippetTerms)
  }));
  // Guardrail: fallback-only retrieval must not be treated as grounded-high-confidence.
  if (hits.length > 0 && hits.every((item) => item.rankSignals?.fallback)) {
    confidence = Math.min(confidence, Math.max(0, cfg.threshold - 0.12));
  }

  await Promise.allSettled([
    repo.recordMetric({
      repoId: input.repoId,
      metricName: "kb_retrieval_latency_ms",
      metricValue: Date.now() - startedAt,
      tags: { profile: input.profile }
    }),
    repo.recordMetric({
      repoId: input.repoId,
      metricName: "kb_retrieval_fallback_rate",
      metricValue: fallbackUsed ? 1 : 0,
      tags: { profile: input.profile }
    }),
    repo.recordMetric({
      repoId: input.repoId,
      metricName: "kb_retrieval_confidence",
      metricValue: confidence,
      tags: { profile: input.profile }
    })
  ]);

  const groundedAnswer = await buildGroundedAnswerFromTopHit(answerLanguage, hits, confidence, input.query).catch(() =>
    buildLocalizedAnswer(answerLanguage, hits, confidence)
  );

  const response: RetrievalResponse = {
    query: input.query,
    profile: input.profile,
    answerLanguage,
    answer: groundedAnswer,
    resolvedQueries: queryVariants,
    retrievalStatus: hits.length > 0 ? "grounded" : "no_results",
    confidence,
    fallbackUsed,
    hits: hits.map((hit) => ({ ...hit, snippet: cleanSnippet(hit.snippet || hit.title) })),
    debug: {
      vectorCandidates: vectorBuckets.length,
      keywordCandidates: lexicalBuckets.length,
      mergedCandidates: merged.length,
      memoryCandidates: memoryResult.diagnostics.candidateCounts,
      rewrittenQueries: memoryResult.diagnostics.rewrittenQueries,
      extractedSignals: memoryResult.diagnostics.extractedSignals as unknown as Record<string, unknown>,
      topMemoryReasons: memoryResult.diagnostics.topMemoryReasons
    }
  };
  retrievalCache.set(cacheKey, {
    expiresAt: Date.now() + RETRIEVAL_CACHE_TTL_MS,
    value: response
  });
  if (retrievalCache.size > RETRIEVAL_CACHE_MAX) {
    const first = retrievalCache.keys().next().value;
    if (first) retrievalCache.delete(first);
  }
  return response;
}

export async function getSyncHealthSummary() {
  const jobs = await repo.listRecentSyncJobs(100);
  const totals = jobs.reduce(
    (acc, job) => {
      acc[job.status] = (acc[job.status] ?? 0) + 1;
      return acc;
    },
    {} as Record<string, number>
  );

  const metrics = await repo.aggregateMetricsLast24h();

  return {
    jobs: {
      total: jobs.length,
      queued: totals.queued ?? 0,
      running: totals.running ?? 0,
      succeeded: totals.succeeded ?? 0,
      failed: totals.failed ?? 0,
      deadLetter: totals.dead_letter ?? 0
    },
    metrics
  };
}

export async function getMetricsSummary() {
  return repo.aggregateMetricsLast24h();
}

export async function runReadOnlyComplianceCheck(): Promise<{ blockedWriteMethod: boolean }> {
  try {
    assertGithubReadOnlyMethod("POST");
    return { blockedWriteMethod: false };
  } catch {
    return { blockedWriteMethod: true };
  }
}

export async function triggerReindex(repoId: string, branch?: string) {
  return enqueueSyncJob({
    repoId,
    branch,
    mode: "reindex",
    source: "system",
    idempotencyKey: `reindex:${repoId}:${branch}:${Date.now()}`
  });
}

export async function bootstrapRepositoryFromEnvIfConfigured(): Promise<void> {
  if (!env.GITHUB_KB_BOOTSTRAP_REPO_URL) {
    return;
  }
  const includePaths = resolveBootstrapIncludePaths(env.GITHUB_KB_BOOTSTRAP_INCLUDE_PATHS);
  const excludePaths = resolveBootstrapExcludePaths(env.GITHUB_KB_BOOTSTRAP_EXCLUDE_PATHS);

  const { registration } = await registerRepository({
    repoUrl: env.GITHUB_KB_BOOTSTRAP_REPO_URL,
    publicBaseUrl: env.GITHUB_KB_BOOTSTRAP_PUBLIC_BASE_URL,
    defaultBranch: env.GITHUB_KB_BOOTSTRAP_BRANCH,
    includePaths,
    excludePaths,
    pollingIntervalSeconds: env.GITHUB_KB_BOOTSTRAP_POLLING_INTERVAL_SECONDS,
    actor: "system_bootstrap"
  });

  await enqueueSyncJob({
    repoId: registration.id,
    branch: registration.default_branch,
    mode: "full",
    source: "system",
    idempotencyKey: `bootstrap:full:${registration.id}:${registration.default_branch}`
  });
}
