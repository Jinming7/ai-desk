import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { access, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import zlib from "node:zlib";
import { env } from "../../config/env.js";
import { buildChunks } from "./chunker.js";
import { embedText, toVectorLiteral } from "./embedding.js";
import {
  assertGithubReadOnlyMethod,
  buildSourceUrl,
  compareCommits,
  getBranchHead,
  getFileContentAtCommit,
  getRepositoryDefaultBranch,
  getRepoFullName,
  listFilesAtCommit,
  validateReadOnlyAccess
} from "./github-client.js";
import { parseMarkdownSections } from "./markdown.js";
import { buildPublicSourceUrl } from "./public-url.js";
import * as repo from "./repository.js";
import type { KbSyncSource, RepoRegistration, RetrievalHit, RetrievalProfile, RetrievalResponse, SyncJob } from "./types.js";

const RETRIEVAL_CACHE_TTL_MS = 90_000;
const RETRIEVAL_CACHE_MAX = 300;
const retrievalCache = new Map<string, { expiresAt: number; value: RetrievalResponse }>();
const EMBEDDING_CIRCUIT_BREAKER_MS = 10 * 60 * 1000;
let embeddingDisabledUntil = 0;
let embeddingDisabledReason = "";
const LOCAL_DOCS_SUPPORTED_ROOTS = ["docs", "deploy-docs", "open-docs", "i18n", "blog"];
const LOCAL_DOCS_SKIP_DIRS = new Set([".git", ".github", ".claude", "node_modules", ".docusaurus", "build", "dist"]);

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

function sha256(input: string): string {
  return crypto.createHash("sha256").update(input).digest("hex");
}

function parseRepoOwnerName(repoUrl: string): { owner: string; name: string } {
  if (repoUrl.startsWith("mock://")) {
    const parts = repoUrl.replace("mock://", "").split("/").filter(Boolean);
    if (parts.length < 2) throw new Error(`Invalid mock repo url: ${repoUrl}`);
    return { owner: parts[0], name: parts[1] };
  }

  const url = new URL(repoUrl);
  const parts = url.pathname.replace(/^\//, "").replace(/\.git$/i, "").split("/").filter(Boolean);
  if (parts.length < 2) throw new Error(`Invalid GitHub repo url: ${repoUrl}`);
  return { owner: parts[0], name: parts[1] };
}

function isDocsComRepo(owner: string, name: string): boolean {
  return owner.toLowerCase() === "bangwork" && name.toLowerCase() === "docs-com";
}

function isDocsComRegistration(registration: RepoRegistration): boolean {
  return isDocsComRepo(registration.repo_owner, registration.repo_name);
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await access(targetPath);
    return true;
  } catch {
    return false;
  }
}

function readGitValue(rootDir: string, args: string[], fallback: string): string {
  try {
    return execFileSync("git", ["-C", rootDir, ...args], { encoding: "utf8" }).trim() || fallback;
  } catch {
    return fallback;
  }
}

async function getLocalDocsMirrorState(registration: RepoRegistration): Promise<{ rootDir: string; head: string; branch: string } | null> {
  if (!isDocsComRegistration(registration)) return null;
  const rootDir = env.LOCAL_DOCS_COM_PATH;
  if (!(await pathExists(rootDir))) return null;
  const head = readGitValue(rootDir, ["rev-parse", "HEAD"], "local");
  const branch = readGitValue(rootDir, ["rev-parse", "--abbrev-ref", "HEAD"], registration.default_branch || "master");
  return { rootDir, head, branch };
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
    if (!entry.isFile() || !/\.(md|mdx)$/i.test(entry.name)) continue;
    const relativePath = path.posix.join(relativeDir.split(path.sep).join(path.posix.sep), entry.name);
    if (isPathIncluded(relativePath, includePaths, excludePaths)) {
      output.push(relativePath);
    }
  }
  return output;
}

async function collectLocalMirrorSnapshot(
  registration: RepoRegistration,
  localMirror: { rootDir: string; head: string; branch: string }
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

function sliceSnapshotForBackfill(paths: string[], cursor?: string, limit?: number): {
  files: string[];
  total: number;
  remaining: number;
  nextCursor: string | null;
  finished: boolean;
} {
  const normalizedLimit = Number.isFinite(limit) && (limit ?? 0) > 0 ? Math.max(1, Math.floor(limit as number)) : paths.length;
  const startIndex = cursor ? paths.findIndex((item) => item > cursor) : 0;
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
  branch: string;
  commitSha: string;
  rootDir: string;
  paths: string[];
}): Promise<number> {
  let indexed = 0;
  for (const relativePath of input.paths) {
    const absolutePath = path.join(input.rootDir, relativePath);
    const content = await readFile(absolutePath, "utf8").catch(() => "");
    if (!content.trim()) continue;
    await indexDocumentContent({
      registration: input.registration,
      branch: input.branch,
      commitSha: input.commitSha,
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
    if (parsed.owner.toLowerCase() === "bangwork" && parsed.name.toLowerCase() === "docs-com") {
      return "https://docs.ones.com";
    }
  } catch {
    return explicit;
  }
  return explicit;
}

function globToRegex(glob: string): RegExp {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  const withDoubleStar = escaped.replace(/\*\*/g, "::DOUBLE_STAR::");
  const withSingleStar = withDoubleStar.replace(/\*/g, "[^/]*");
  const pattern = withSingleStar.replace(/::DOUBLE_STAR::/g, ".*");
  return new RegExp(`^${pattern}$`, "i");
}

function isPathIncluded(path: string, includePaths: string[], excludePaths: string[]): boolean {
  const includeRegex = includePaths.map(globToRegex);
  const excludeRegex = excludePaths.map(globToRegex);
  const included = includeRegex.some((regex) => regex.test(path));
  const excluded = excludeRegex.some((regex) => regex.test(path));
  return included && !excluded;
}

function pickTitle(path: string, content: string): string {
  const heading = /^(#{1,6})\s+(.+)$/m.exec(content);
  if (heading?.[2]) return heading[2].trim();
  return path.split("/").pop() ?? path;
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
  if (isDocsComRepo(input.repoOwner, input.repoName) && (await pathExists(env.LOCAL_DOCS_COM_PATH))) {
    const localBranch = readGitValue(env.LOCAL_DOCS_COM_PATH, ["rev-parse", "--abbrev-ref", "HEAD"], input.defaultBranch || "master");
    return input.defaultBranch?.trim() || localBranch;
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
  if (normalizedPath.includes("/openapi/")) return "openapi";
  if (normalizedPath.includes("/integrations/") || /oauth|sso|webhook|github|gitlab|slack|teams/.test(normalizedContent)) return "integrations";
  if (normalizedPath.includes("/wiki/") || /wiki|page group|space/.test(normalizedContent)) return "wiki";
  if (normalizedPath.includes("/deploy-docs/") || /kubernetes|pod|pvc|volume|cluster/.test(normalizedContent)) return "deployment";
  if (/issue|project|sprint|field|comment|attachment/.test(normalizedContent)) return "project_management";
  return "general";
}

function inferDeploymentModel(path: string, content: string): string {
  const normalizedPath = path.toLowerCase();
  const normalizedContent = content.toLowerCase();
  if (normalizedPath.includes("/deploy-docs/") || /private deployment|私有部署|本地部署|on-prem/i.test(content)) return "private_deployment";
  if (/public cloud|公有云|saas/i.test(content)) return "public_cloud";
  return "shared";
}

function inferEvidenceKind(path: string, title: string, content: string): string {
  const normalizedPath = path.toLowerCase();
  const normalizedTitle = title.toLowerCase();
  const normalizedContent = content.toLowerCase();
  if (normalizedPath.includes("/openapi/")) return "api_operation";
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
  if (!/open-docs\/docs\/openapi\/api\/.+\.api\.mdx$/i.test(path)) {
    return rawContent;
  }
  const apiDoc = decodeOpenApiBlob(rawContent);
  if (!apiDoc) return rawContent;
  const apiText = toSearchableApiText(apiDoc);
  return `${rawContent}\n\n${apiText}`;
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
  return /\b(api|openapi|endpoint|rest|request|response|method|path)\b/i.test(query);
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

function cleanSnippet(raw: string): string {
  return raw
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
    .trim()
    .slice(0, 600);
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
  const compactTokenVariant = tokenizeRetrievalQuery(normalized).join(" ").trim();
  return uniqueStrings(
    [
      normalized,
      lowered !== normalized ? lowered : "",
      compactTokenVariant && compactTokenVariant !== lowered ? compactTokenVariant : ""
    ],
    3
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

async function embedChunkBestEffort(
  text: string
): Promise<{ vectorLiteral: string; model: string; version: string } | null> {
  try {
    return await embedWithRetry(text);
  } catch {
    return null;
  }
}

function isPermanentEmbeddingError(error: unknown): boolean {
  const message = (error as Error)?.message?.toLowerCase?.() ?? "";
  return (
    message.includes("insufficient_quota") ||
    message.includes("quota") ||
    message.includes("invalid_api_key") ||
    message.includes("incorrect api key") ||
    message.includes("401")
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

export async function retrieveKnowledgeWithRetry(input: {
  query: string;
  answerLanguage?: "zh" | "en";
  profile: RetrievalProfile;
  repoId?: string;
  branch?: string;
  topK?: number;
  includeFallback: boolean;
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

async function indexDocument(registration: RepoRegistration, branch: string, commitSha: string, path: string): Promise<void> {
  const content = await getFileContentAtCommit(registration, path, commitSha);
  await indexDocumentContent({
    registration,
    branch,
    commitSha,
    path,
    content
  });
}

async function indexDocumentContent(input: {
  registration: RepoRegistration;
  branch: string;
  commitSha: string;
  path: string;
  content: string;
}): Promise<void> {
  const { registration, branch, commitSha, path, content } = input;
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
  const docSupportEvidence = extractSupportEvidenceMetadata({
    path,
    title,
    content: normalizedContent,
    apiDoc
  });
  const doc = await repo.upsertDocument({
    repoId: registration.id,
    branch,
    path,
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
      supportEvidence: docSupportEvidence
    }
  });

  await repo.deactivateChunksByDocument(doc.id);

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
    const embedded = await embedChunkBestEffort(chunk.content);
    await repo.upsertChunk({
      id: chunk.id,
      docId: doc.id,
      repoId: registration.id,
      branch,
      path,
      commitSha,
      headingPath: chunk.headingPath,
      ordinal: chunk.ordinal,
      content: chunk.content,
      contentHash: chunk.contentHash,
      tokenCount: chunk.tokenCount,
      metadata: {
        ...chunk.metadata,
        supportEvidence: chunkSupportEvidence,
        embeddingState: embedded ? "ready" : "missing"
      },
      embedding: embedded?.vectorLiteral ?? null,
      embeddingModel: embedded?.model ?? null,
      embeddingVersion: embedded?.version ?? null
    });
  }
}

async function runLocalMirrorFullSync(
  job: SyncJob,
  registration: RepoRegistration,
  localMirror: { rootDir: string; head: string; branch: string }
): Promise<LocalMirrorBatchResult> {
  const branch = job.branch || localMirror.branch || registration.default_branch;
  return runLocalMirrorSyncBatch({
    registration,
    branch,
    localMirror,
    cursor: getLocalMirrorCursor(job),
    limit: env.GITHUB_KB_LOCAL_MIRROR_BATCH_SIZE
  });
}

async function runLocalMirrorSyncBatch(input: {
  registration: RepoRegistration;
  branch: string;
  localMirror: { rootDir: string; head: string; branch: string };
  cursor?: string;
  limit: number;
}): Promise<LocalMirrorBatchResult> {
  const markdownFiles = await collectLocalMirrorSnapshot(input.registration, input.localMirror);
  const window = sliceSnapshotForBackfill(markdownFiles, input.cursor, input.limit);
  const indexed = await indexLocalMirrorPaths({
    registration: input.registration,
    branch: input.branch,
    commitSha: input.localMirror.head,
    rootDir: input.localMirror.rootDir,
    paths: window.files
  });

  let deactivated = 0;
  if (window.finished) {
    deactivated = await repo.deactivateDocumentsMissingFromSnapshot(input.registration.id, input.branch, markdownFiles);
    await repo.upsertCheckpoint({
      repoId: input.registration.id,
      branch: input.branch,
      lastSyncedCommitSha: input.localMirror.head,
      fullSync: true
    });
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

function buildSyntheticSyncJob(input: {
  repoId: string;
  branch: string;
  mode: "full" | "incremental" | "reindex";
  source: KbSyncSource;
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
    payload_json: {},
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
  const localMirror = await getLocalDocsMirrorState(registration);
  if (localMirror) {
    return runLocalMirrorFullSync(job, registration, localMirror);
  }
  const resolved = await resolveRegistrationBranch(registration, job.branch, "sync_worker");
  const branch = resolved.branch;
  const effectiveRegistration = resolved.registration;
  const head = job.after_commit_sha ?? (await getBranchHead(effectiveRegistration, branch));
  const files = await listFilesAtCommit(effectiveRegistration, head);
  const markdownFiles = files
    .filter((file) => /\.(md|mdx)$/i.test(file.path))
    .filter((file) => isPathIncluded(file.path, effectiveRegistration.include_paths, effectiveRegistration.exclude_paths));

  for (const file of markdownFiles) {
    await indexDocument(effectiveRegistration, branch, head, file.path);
  }

  const deactivated = await repo.deactivateDocumentsMissingFromSnapshot(
    effectiveRegistration.id,
    branch,
    markdownFiles.map((file) => file.path)
  );

  await repo.upsertCheckpoint({
    repoId: effectiveRegistration.id,
    branch,
    lastSyncedCommitSha: head,
    fullSync: true
  });

  return { indexed: markdownFiles.length, deactivated, head, finished: true, nextCursor: null };
}

async function runIncrementalSync(job: SyncJob, registration: RepoRegistration): Promise<SyncExecutionResult> {
  const localMirror = await getLocalDocsMirrorState(registration);
  if (localMirror) {
    const branch = job.branch || localMirror.branch || registration.default_branch;
    const checkpoint = await repo.getCheckpoint(registration.id, branch);
    if (checkpoint?.last_synced_commit_sha && checkpoint.last_synced_commit_sha === localMirror.head) {
      return { indexed: 0, removed: 0, head: localMirror.head, finished: true, nextCursor: null };
    }
    const full = await runLocalMirrorFullSync({ ...job, branch }, registration, localMirror);
    return { indexed: full.indexed, removed: full.deactivated, head: full.head, finished: full.finished, nextCursor: full.nextCursor };
  }
  const resolved = await resolveRegistrationBranch(registration, job.branch, "sync_worker");
  const branch = resolved.branch;
  const effectiveRegistration = resolved.registration;
  const checkpoint = await repo.getCheckpoint(effectiveRegistration.id, branch);
  const before = job.before_commit_sha ?? checkpoint?.last_synced_commit_sha ?? null;
  const after = job.after_commit_sha ?? (await getBranchHead(effectiveRegistration, branch));

  if (!before) {
    const full = await runFullSync({ ...job, branch }, effectiveRegistration);
    return { indexed: full.indexed, removed: full.deactivated, head: full.head, finished: full.finished, nextCursor: full.nextCursor };
  }

  if (before === after) {
    return { indexed: 0, removed: 0, head: after, finished: true, nextCursor: null };
  }

  const changed = await compareCommits(effectiveRegistration, before, after);
  const toIndex = new Set<string>();
  let removed = 0;

  for (const file of changed) {
    if (!/\.(md|mdx)$/i.test(file.filename)) continue;
    if (file.status === "removed") {
      await repo.deactivateDocumentByPath(effectiveRegistration.id, branch, file.filename);
      removed += 1;
      continue;
    }
    if (file.status === "renamed" && file.previous_filename) {
      await repo.deactivateDocumentByPath(effectiveRegistration.id, branch, file.previous_filename);
    }
    if (isPathIncluded(file.filename, registration.include_paths, registration.exclude_paths)) {
      toIndex.add(file.filename);
    }
  }

  for (const path of toIndex) {
    await indexDocument(effectiveRegistration, branch, after, path);
  }

  await repo.upsertCheckpoint({
    repoId: effectiveRegistration.id,
    branch,
    lastSyncedCommitSha: after,
    fullSync: false
  });

  return { indexed: toIndex.size, removed, head: after, finished: true, nextCursor: null };
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
  cursor?: string;
}): Promise<SyncExecutionResult> {
  const registration = await repo.getRepoRegistrationById(input.repoId);
  if (!registration || !registration.is_active) {
    throw new Error(`Repository registration not found or inactive: ${input.repoId}`);
  }

  const branch = input.branch?.trim() || registration.default_branch;
  const syntheticJob: SyncJob = {
    ...buildSyntheticSyncJob({
      repoId: registration.id,
      branch,
      mode: input.mode,
      source: input.source ?? "manual"
    }),
    payload_json: input.cursor ? { cursor: input.cursor } : {}
  };

  if (input.mode === "full") {
    return runFullSync(syntheticJob, registration);
  }
  if (input.mode === "incremental") {
    return runIncrementalSync(syntheticJob, registration);
  }
  return runReindex(syntheticJob, registration);
}

async function enqueueLocalMirrorContinuation(job: SyncJob, registration: RepoRegistration, result: SyncExecutionResult): Promise<void> {
  if (result.finished || !result.nextCursor) return;
  await enqueueSyncJob({
    repoId: registration.id,
    branch: job.branch,
    mode: job.sync_mode,
    source: job.source,
    beforeCommitSha: job.before_commit_sha ?? undefined,
    afterCommitSha: result.head,
    payload: {
      ...job.payload_json,
      cursor: result.nextCursor
    },
    idempotencyKey: `local-mirror:${job.sync_mode}:${registration.id}:${job.branch}:${result.head}:${result.nextCursor}`
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
    if (localMirror) {
      await repo.setRepoValidation(registration.id, null);
      continue;
    }
    const validation = await validateReadOnlyAccess(registration).catch((error) => ({
      ok: false,
      scopes: [],
      message: (error as Error).message
    }));
    await repo.setRepoValidation(registration.id, validation.ok ? null : validation.message);
    if (!validation.ok) {
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
  const publicBaseUrl = pickDefaultPublicBaseUrl(input.repoUrl, input.publicBaseUrl);
  const resolvedBranch = await resolveBranchForRegistrationInput({
    repoUrl: input.repoUrl,
    repoOwner: parsed.owner,
    repoName: parsed.name,
    publicBaseUrl,
    defaultBranch: input.defaultBranch,
    includePaths: input.includePaths,
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
    includePaths: input.includePaths,
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

export async function enqueueSyncJob(input: {
  repoId: string;
  branch?: string;
  mode: "full" | "incremental" | "reindex";
  source: KbSyncSource;
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

  return repo.enqueueSyncJob({
    repoId: resolved.registration.id,
    branch: resolved.branch,
    syncMode: input.mode,
    source: input.source,
    idempotencyKey,
    beforeCommitSha: input.beforeCommitSha,
    afterCommitSha: input.afterCommitSha,
    payload: input.payload
  });
}

export async function runDueSyncJobs(limit: number): Promise<{ processed: number; succeeded: number; failed: number; deadLetter: number }> {
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
        const result = await runFullSync(job, registration);
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

      if (localMirror) {
        await enqueueLocalMirrorContinuation(job, registration, executionResult);
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
      const status = await repo.markSyncJobFailed(job, (error as Error).message);
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
      const branch = localMirror.branch || registration.default_branch;
      const checkpoint = await repo.getCheckpoint(registration.id, branch);
      if (checkpoint?.last_synced_commit_sha === localMirror.head) {
        continue;
      }
      await enqueueSyncJob({
        repoId: registration.id,
        branch,
        mode: checkpoint?.last_synced_commit_sha ? "incremental" : "full",
        source: "polling",
        beforeCommitSha: checkpoint?.last_synced_commit_sha ?? undefined,
        afterCommitSha: localMirror.head,
        idempotencyKey: `poll:local:${registration.id}:${branch}:${checkpoint?.last_synced_commit_sha ?? "none"}:${localMirror.head}`
      });
      enqueued += 1;
      continue;
    }
    const resolved = await resolveRegistrationBranch(registration, registration.default_branch, "polling");
    const branch = resolved.branch;
    const effectiveRegistration = resolved.registration;
    const latest = await getBranchHead(effectiveRegistration, branch);
    const checkpoint = await repo.getCheckpoint(effectiveRegistration.id, branch);
    const previous = checkpoint?.last_synced_commit_sha;
    if (previous && previous === latest) {
      continue;
    }

    await enqueueSyncJob({
      repoId: effectiveRegistration.id,
      branch,
      mode: previous ? "incremental" : "full",
      source: "polling",
      beforeCommitSha: previous ?? undefined,
      afterCommitSha: latest,
      idempotencyKey: `poll:${effectiveRegistration.id}:${branch}:${previous ?? "none"}:${latest}`
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
    : (await repo.listActiveRepoRegistrations()).find((item) => isDocsComRegistration(item)) ?? null;
  if (!registration || !registration.is_active) {
    throw new Error(`Repository registration not found or inactive: ${repoId ?? "docs-com"}`);
  }

  const localMirror = await getLocalDocsMirrorState(registration);
  if (!localMirror) {
    throw new Error("Local docs-com mirror is not available");
  }

  const branch = registration.default_branch;
  const batch = await runLocalMirrorSyncBatch({
    registration,
    branch,
    localMirror,
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
  const integrationIntent = /\b(integrate|integration|teams|slack|webhook|zapier|oauth)\b/i.test(normalizedQuery);
  const merged = [...byChunk.values()].map((hit) => {
    let boosted = hit.score;
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
      if (/\/openapi\/api\/.+\.api\.mdx$/i.test(hit.path)) boosted += 0.08;
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

async function buildGroundedAnswerFromTopHit(language: "zh" | "en", hits: RetrievalHit[], confidence: number): Promise<string> {
  if (!hits.length) {
    return buildLocalizedAnswer(language, hits, confidence);
  }

  const top = hits[0];
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
}): Promise<RetrievalResponse> {
  const topK = input.topK ?? getProfileConfig(input.profile).topK;
  const cacheKey = buildRetrievalCacheKey({
    query: input.query,
    profile: input.profile,
    repoId: input.repoId,
    branch: input.branch,
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
  const queryVariants = buildQueryVariants(input.query);

  const variantBuckets = await Promise.all(
    queryVariants.map(async (variant) => {
      const lexicalPromise = repo
        .searchKeywordCandidates({
          repoId: input.repoId,
          branch: input.branch,
          query: variant,
          limit: effectiveTopK * 4
        })
        .catch(() => []);

      const vectorPromise = (async () => {
        try {
          const embedded = await embedWithRetry(variant);
          return await repo.searchVectorCandidates({
            repoId: input.repoId,
            branch: input.branch,
            vectorLiteral: embedded.vectorLiteral,
            limit: effectiveTopK * 4
          });
        } catch {
          return [];
        }
      })();

      const [vectorCandidates, lexicalCandidates] = await Promise.all([vectorPromise, lexicalPromise]);
      return { vectorCandidates, lexicalCandidates };
    })
  );
  const vectorBuckets: RetrievalHit[] = variantBuckets.flatMap((item) => item.vectorCandidates);
  const lexicalBuckets: RetrievalHit[] = variantBuckets.flatMap((item) => item.lexicalCandidates);

  const merged = mergeHybridCandidates(vectorBuckets, lexicalBuckets, cfg.vectorWeight, cfg.keywordWeight, queryVariants[0]);
  let hits = dedupeHitsByPath(merged).slice(0, effectiveTopK);
  let fallbackUsed = false;

  let confidence = estimateConfidence(hits[0]);
  if (input.includeFallback && confidence < cfg.threshold) {
    const fallbackDocs = await repo
      .listCandidateDocumentsForFallback({
        repoId: input.repoId,
        branch: input.branch,
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

  const groundedAnswer = await buildGroundedAnswerFromTopHit(answerLanguage, hits, confidence).catch(() =>
    buildLocalizedAnswer(answerLanguage, hits, confidence)
  );

  const response: RetrievalResponse = {
    query: input.query,
    profile: input.profile,
    answerLanguage,
    answer: groundedAnswer,
    resolvedQueries: queryVariants,
    confidence,
    fallbackUsed,
    hits: hits.map((hit) => ({ ...hit, snippet: cleanSnippet(hit.snippet || hit.title) })),
    debug: {
      vectorCandidates: vectorBuckets.length,
      keywordCandidates: lexicalBuckets.length,
      mergedCandidates: merged.length
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
  const includePaths = env.GITHUB_KB_BOOTSTRAP_INCLUDE_PATHS.split(",").map((item) => item.trim()).filter(Boolean);
  const excludePaths = env.GITHUB_KB_BOOTSTRAP_EXCLUDE_PATHS.split(",").map((item) => item.trim()).filter(Boolean);

  const { registration } = await registerRepository({
    repoUrl: env.GITHUB_KB_BOOTSTRAP_REPO_URL,
    publicBaseUrl: env.GITHUB_KB_BOOTSTRAP_PUBLIC_BASE_URL,
    defaultBranch: env.GITHUB_KB_BOOTSTRAP_BRANCH,
    includePaths: includePaths.length ? includePaths : ["**/*.md"],
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
