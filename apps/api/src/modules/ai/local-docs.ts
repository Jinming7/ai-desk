import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { access, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { env } from "../../config/env.js";
import { isServerlessRuntime } from "../../config/runtime-env.js";
import { buildChunks } from "../github-kb/chunker.js";
import { parseMarkdownSections } from "../github-kb/markdown.js";
import { buildPublicSourceUrl } from "../github-kb/public-url.js";
import type { RepoRegistration, RetrievalHit } from "../github-kb/types.js";

type LocalDocsHit = Pick<
  RetrievalHit,
  | "documentId"
  | "repoId"
  | "repo"
  | "branch"
  | "path"
  | "sourceUrl"
  | "repoSourceUrl"
  | "commitSha"
  | "title"
  | "headingPath"
  | "snippet"
  | "score"
  | "supportMetadata"
>;

type LocalDocsIndexEntry = LocalDocsHit & {
  displayContent: string;
  searchableTitle: string;
  searchableHeading: string;
  searchablePath: string;
  searchableContent: string;
};

type ScoredLocalDocsEntry = LocalDocsIndexEntry & {
  score: number;
  snippet: string;
};

const LOCAL_DOCS_REPO = "BangWork/docs-com";
const LOCAL_DOCS_REPO_ID = "local-docs-com";
const LOCAL_DOCS_PUBLIC_BASE_URL = "https://docs.ones.com";
const SUPPORTED_ROOTS = ["docs", "deploy-docs", "open-docs", "i18n", "blog"];
const SKIP_DIRS = new Set([".git", "build", "node_modules", ".docusaurus"]);
const CACHE_TTL_MS = env.LOCAL_DOCS_CACHE_TTL_SECONDS * 1000;
const GENERIC_ANCHOR_TOKENS = new Set([
  "how",
  "what",
  "when",
  "where",
  "which",
  "why",
  "can",
  "could",
  "would",
  "should",
  "is",
  "are",
  "was",
  "were",
  "the",
  "for",
  "with",
  "via",
  "and",
  "then",
  "that",
  "this",
  "procedure",
  "procedures",
  "step",
  "steps",
  "guide",
  "guidance",
  "support",
  "troubleshooting",
  "diagnose",
  "diagnosis",
  "behavior",
  "rule",
  "rules",
  "limitation",
  "limitations",
  "issue",
  "issues",
  "problem",
  "problems",
  "error",
  "errors",
  "failed",
  "failure",
  "page",
  "found",
  "页面",
  "步骤",
  "排查",
  "问题",
  "错误",
  "失败",
  "原因",
  "为什么",
  "如何",
  "怎么",
  "通过",
  "哪个",
  "一个"
]);

let cache:
  | {
      rootDir: string;
      expiresAt: number;
      headSha: string;
      branch: string;
      entries: LocalDocsIndexEntry[];
    }
  | null = null;
let inFlightBuild:
  | {
      rootDir: string;
      promise: Promise<{
        entries: LocalDocsIndexEntry[];
        headSha: string;
        branch: string;
      }>;
    }
  | null = null;

function hash(input: string): string {
  return crypto.createHash("sha256").update(input).digest("hex");
}

function normalizeSpaces(input: string): string {
  return input.replace(/\s+/g, " ").trim();
}

function stripFrontmatter(content: string): string {
  return content.replace(/^---\s*\n[\s\S]*?\n---\s*(?:\n|$)/, "");
}

function stripMarkup(content: string): string {
  return normalizeSpaces(
    stripFrontmatter(content)
      .replace(/api:\s*eJ[0-9A-Za-z+/_=-]{16,}/g, " ")
      .replace(/^import\s+.+$/gm, " ")
      .replace(/```[\s\S]*?```/g, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/\{[^}]{0,160}\}/g, (matched) => (/["':]/.test(matched) ? matched : " "))
      .replace(/`{1,3}/g, "")
      .replace(/\[(.*?)\]\((.*?)\)/g, "$1")
      .replace(/^\s*[-*+]\s+/gm, " ")
      .replace(/[*_#>|]/g, " ")
  );
}

function parseFrontmatterValue(content: string, key: string): string | null {
  const matched = content.match(/^---\s*\n([\s\S]*?)\n---\s*(?:\n|$)/);
  if (!matched?.[1]) return null;
  const row = matched[1]
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.startsWith(`${key}:`));
  if (!row) return null;
  return row
    .slice(key.length + 1)
    .trim()
    .replace(/^['"]|['"]$/g, "");
}

function pickTitle(filePath: string, content: string, headingPath: string): string {
  const frontmatterTitle = parseFrontmatterValue(content, "title");
  if (frontmatterTitle) return frontmatterTitle;
  const firstHeading = stripFrontmatter(content).match(/^#\s+(.+)$/m)?.[1]?.trim();
  if (firstHeading) return firstHeading;
  if (headingPath && headingPath !== "ROOT") {
    const lastHeading = headingPath.split(">").map((item) => item.trim()).filter(Boolean).pop();
    if (lastHeading) return lastHeading;
  }
  return filePath.split("/").pop()?.replace(/\.api\.mdx$/i, "").replace(/\.(md|mdx)$/i, "") ?? filePath;
}

function buildRepoSourceUrl(commitSha: string, filePath: string): string {
  return `https://github.com/${LOCAL_DOCS_REPO}/blob/${commitSha}/${filePath}`;
}

function buildSyntheticRegistration(branch: string): RepoRegistration {
  return {
    id: LOCAL_DOCS_REPO_ID,
    repo_owner: "BangWork",
    repo_name: "docs-com",
    repo_url: `https://github.com/${LOCAL_DOCS_REPO}`,
    public_base_url: LOCAL_DOCS_PUBLIC_BASE_URL,
    default_branch: branch,
    include_paths: ["**/*.md", "**/*.mdx"],
    exclude_paths: [],
    polling_interval_seconds: 300,
    auth_mode: "local_clone",
    is_active: true,
    last_validated_at: null,
    last_validation_error: null,
    created_by: "system",
    created_at: new Date(0).toISOString(),
    updated_at: new Date(0).toISOString()
  };
}

function uniqueStrings(input: Array<string | undefined | null>, limit = 8): string[] {
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

function tokenize(text: string): string[] {
  const normalized = text.toLowerCase();
  const ascii = [...normalized.matchAll(/[a-z0-9][a-z0-9:_./-]{1,}/g)].map((match) => match[0]);
  const cjkRuns = [...text.matchAll(/[\u4e00-\u9fff]{2,}/g)].map((match) => match[0]);
  const cjkTokens: string[] = [];
  for (const run of cjkRuns) {
    if (run.length <= 4) {
      cjkTokens.push(run);
      continue;
    }
    for (let index = 0; index < run.length - 1 && cjkTokens.length < 24; index += 1) {
      cjkTokens.push(run.slice(index, index + 2));
    }
  }
  return uniqueStrings([...ascii, ...cjkTokens], 24);
}

function buildAnchorTokens(query: string): string[] {
  return tokenize(normalizeSpaces(query)).filter((token) => {
    if (!token) return false;
    if (GENERIC_ANCHOR_TOKENS.has(token)) return false;
    if (/^[a-z]+$/.test(token) && token.length < 3) return false;
    return true;
  });
}

function buildQueryVariants(query: string): string[] {
  const normalized = normalizeSpaces(query);
  const variants = new Set<string>([normalized, normalized.toLowerCase()]);
  const replacements: Array<[RegExp, string]> = [
    [/open\s*api/gi, "openapi"],
    [/开放平台/gi, "openapi open platform"],
    [/接口/gi, "api endpoint"],
    [/项目标识|项目id|project id/gi, "项目 标识 project id uuid"],
    [/标识|标识符/gi, "identifier id uuid 标识"],
    [/项目列表/gi, "项目列表 project list projects"],
    [/项目/gi, "项目 project"],
    [/负责人/gi, "负责人 owner assignee member user"],
    [/成员/gi, "成员 member user owner assignee"],
    [/选项值|选项/gi, "选项 option options field options"],
    [/属性/gi, "属性 field property"],
    [/缺陷/gi, "缺陷 defect bug issue 工作项"],
    [/工作项/gi, "工作项 issue work item"],
    [/状态列表|状态枚举/gi, "status list statuses enum issueStatuses"],
    [/状态/gi, "状态 status state workflow_status issue status"],
    [/详情|详细信息/gi, "详情 details detail get by id current value"],
    [/字段/gi, "字段 field response schema property"],
    [/列表/gi, "列表 list collection enum"],
    [/获取|查询/gi, "get query retrieve fetch"],
    [/评论/gi, "comment issue comment"],
    [/权限/gi, "permission scope access"],
    [/scope/gi, "scope permission"],
    [/访问权限/gi, "access scope permission"],
    [/令牌|token/gi, "token credential access token"],
    [/重置|重设|reset/gi, "reset rotate revoke reissue"],
    [/授权/gi, "authorization oauth"],
    [/回调/gi, "callback redirect uri"],
    [/page not found|404/gi, "page not found 404"],
    [/集成/gi, "integration"],
    [/报错|错误|异常|失败/gi, "error failed troubleshooting"],
    [/排查/gi, "troubleshooting diagnose"],
    [/工单/gi, "ticket issue"]
  ];
  let expanded = normalized.toLowerCase();
  for (const [pattern, replacement] of replacements) {
    expanded = expanded.replace(pattern, ` ${replacement} `);
  }
  expanded = normalizeSpaces(expanded);
  if (expanded) variants.add(expanded);
  return [...variants].filter(Boolean).slice(0, 6);
}

function computeLanguageBoost(entry: LocalDocsIndexEntry, answerLanguage: "zh" | "en"): number {
  if (answerLanguage === "zh" && /(^|\/)i18n\/zh-Hans\//i.test(entry.path)) return 1.2;
  if (answerLanguage === "en" && /(^|\/)i18n\/en\//i.test(entry.path)) return 1.2;
  if (answerLanguage === "en" && !/(^|\/)i18n\/zh-Hans\//i.test(entry.path)) return 0.4;
  return 0;
}

function getSupportMetadataList(entry: LocalDocsIndexEntry, key: string): string[] {
  const metadata = entry.supportMetadata as Record<string, unknown> | undefined;
  if (!metadata) return [];
  const value = metadata[key];
  return Array.isArray(value) ? value.map((item) => String(item).toLowerCase()).filter(Boolean) : [];
}

function scoreEntry(entry: LocalDocsIndexEntry, phrases: string[], tokens: string[], answerLanguage: "zh" | "en"): number {
  let score = computeLanguageBoost(entry, answerLanguage);
  const joinedTokens = tokens.join(" ");
  const permissions = getSupportMetadataList(entry, "permissions");
  const prerequisites = getSupportMetadataList(entry, "prerequisites");
  const needsScopeEvidence = /scope|permission|oauth|authorization|access token/.test(joinedTokens);
  const needsCommentEvidence = /comment|issue-comment/.test(joinedTokens);
  const needsIntegrationEvidence = /github|gitlab|integration|callback|redirect|webhook|oauth/.test(joinedTokens);
  const needsTokenLifecycleEvidence = /token|credential|revoke|reset|refresh/.test(joinedTokens);
  const needsIssueEntity = /issue|defect|bug|工作项|缺陷/.test(joinedTokens);
  const needsStatusEntity = /status|state|workflow_status|状态/.test(joinedTokens);
  const needsProjectEntity = /project|projects|项目/.test(joinedTokens);
  const needsMemberEntity = /负责人|成员|member|user|owner|assignee/.test(joinedTokens);
  const needsDetailOperation = /detail|details|get by id|current value|详细信息|详情|当前/.test(joinedTokens);
  const needsListOperation = /statuses|list|enum|collection|列表|枚举/.test(joinedTokens);
  const normalizedPhrases = phrases.map((phrase) => phrase.toLowerCase()).filter((phrase) => phrase.length >= 2);
  for (const phrase of normalizedPhrases) {
    if (entry.searchableTitle.includes(phrase)) score += 7;
    if (entry.searchableHeading.includes(phrase)) score += 5;
    if (entry.searchablePath.includes(phrase)) score += 4;
    if (entry.searchableContent.includes(phrase)) score += phrase.length >= 10 ? 4 : 2;
  }

  for (const token of tokens) {
    if (token.length < 2) continue;
    if (entry.searchableTitle.includes(token)) score += 2.2;
    if (entry.searchableHeading.includes(token)) score += 1.8;
    if (entry.searchablePath.includes(token)) score += 1.6;
    if (entry.searchableContent.includes(token)) score += /:/.test(token) ? 2.2 : 0.9;
  }

  if (/openapi|scope|oauth|token|comment/.test(tokens.join(" ")) && /open-docs\/docs\/openapi\//i.test(entry.path)) {
    score += 1.4;
  }
  if (/callback|redirect|integration|github|oauth/.test(tokens.join(" ")) && /integrations|deploy-docs/i.test(entry.path)) {
    score += 1.2;
  }
  if (needsProjectEntity) {
    if (entry.searchableTitle.includes("项目") || entry.searchableTitle.includes("project")) score += 6;
    if (entry.searchablePath.includes("project")) score += 5;
    if (entry.searchableContent.includes("项目id") || entry.searchableContent.includes("\"id\"")) score += 4;
  }
  if (needsMemberEntity) {
    if (entry.searchableContent.includes("成员") || entry.searchableContent.includes("member")) score += 4;
    if (entry.searchableContent.includes("avatar") || entry.searchableContent.includes("assignee")) score += 3;
  }
  if (needsScopeEvidence) {
    if (permissions.length > 0) score += 7;
    if (entry.searchableTitle.includes("scope") || entry.searchableHeading.includes("authentication")) score += 6;
    if (entry.searchableContent.includes("scopes:") || entry.searchableContent.includes("scope list")) score += 5;
    if (entry.searchableHeading.includes("history")) score -= 3;
  }
  if (needsCommentEvidence && permissions.some((permission) => permission.includes("issue-comment"))) {
    score += 8;
  }
  if (
    needsCommentEvidence &&
    permissions.length > 0 &&
    !permissions.some((permission) => permission.includes("issue-comment")) &&
    !/issue comment/.test(entry.searchableTitle)
  ) {
    score -= 6;
  }
  if (/token|credential|revoke|reset/.test(joinedTokens) && prerequisites.some((item) => item.includes("scope:"))) {
    score += 2;
  }
  if (needsIssueEntity && needsStatusEntity && /open-docs\/docs\/openapi\/api\//i.test(entry.path)) {
    if (/03-get-a-issue-details|\/project\/issues\/\{issueid\}/i.test(entry.searchablePath + " " + entry.searchableContent)) {
      score += needsDetailOperation || !needsListOperation ? 18 : 6;
    }
    if (/get-a-list-of-issue-status|\/project\/issuestatuses/i.test(entry.searchablePath + " " + entry.searchableContent)) {
      score += needsListOperation ? 18 : 8;
    }
    if (entry.searchableTitle.includes("获取工作项详细信息") || entry.searchableHeading.includes("获取工作项详细信息")) {
      score += needsDetailOperation || !needsListOperation ? 10 : 3;
    }
    if (entry.searchableTitle.includes("获取工作项状态列表") || entry.searchableHeading.includes("获取工作项状态列表")) {
      score += needsListOperation ? 10 : 4;
    }
  }
  if (needsIntegrationEvidence) {
    const signals = ["github", "gitlab", "integration", "oauth", "callback", "redirect", "webhook"];
    const matchedSignals = signals.filter(
      (signal) =>
        entry.searchableTitle.includes(signal) ||
        entry.searchableHeading.includes(signal) ||
        entry.searchablePath.includes(signal) ||
        entry.searchableContent.includes(signal)
    ).length;
    score += matchedSignals * 2.4;
    if (/code-integration|github|gitlab|integrations/.test(entry.searchablePath)) score += 4;
    if (matchedSignals === 0 && /\bpage\b/.test(entry.searchableTitle)) score -= 6;
    if (/^page$/.test(entry.searchableTitle) && !/github|gitlab|integration|callback|redirect/.test(entry.searchablePath)) {
      score -= 8;
    }
  }
  if (needsTokenLifecycleEvidence) {
    if (/credential|revoke access token|revoke a token|refresh token/.test(entry.searchableTitle)) score += 5;
    if (/credential-types|revoke-access-token/.test(entry.searchablePath)) score += 5;
    if (entry.searchableContent.includes("issued tokens generally do not change automatically")) score += 6;
    if (entry.searchableContent.includes("re-run the authorization flow") || entry.searchableContent.includes("issue a new token")) {
      score += 5;
    }
  }

  return Number(score.toFixed(3));
}

function buildSnippet(content: string, terms: string[]): string {
  const cleaned = stripMarkup(content);
  if (!cleaned) return "";
  const lower = cleaned.toLowerCase();
  const rankedTerms = [...terms]
    .filter((term) => term.length >= 2)
    .sort((a, b) => scoreSnippetTerm(b) - scoreSnippetTerm(a));
  const match = rankedTerms.find((term) => lower.includes(term.toLowerCase()));
  if (!match) return cleaned.slice(0, 320);
  const index = lower.indexOf(match.toLowerCase());
  const start = Math.max(0, index - 140);
  const end = Math.min(cleaned.length, index + 220);
  return cleaned.slice(start, end).trim();
}

function scoreSnippetTerm(term: string): number {
  const normalized = term.toLowerCase();
  let score = Math.min(normalized.length, 24);
  if (/[/{}`:]/.test(normalized)) score += 18;
  if (/status|state|scope|permission|field|schema|response|param|path|issueid|workflow/.test(normalized)) score += 40;
  if (/状态|字段|权限|参数|路径|返回|工作流|接口/.test(term)) score += 40;
  if (/detail|details|current|get by id|详细信息|详情|当前/.test(normalized + term)) score += 12;
  return score;
}

function countAnchorMatches(entry: LocalDocsIndexEntry, anchorTokens: string[]): number {
  if (!anchorTokens.length) return 0;
  return anchorTokens.filter(
    (token) =>
      entry.searchableTitle.includes(token) ||
      entry.searchableHeading.includes(token) ||
      entry.searchablePath.includes(token) ||
      entry.searchableContent.includes(token)
  ).length;
}

function inferEvidenceKind(filePath: string, title: string, content: string): string {
  const normalizedPath = filePath.toLowerCase();
  const normalizedTitle = title.toLowerCase();
  if (normalizedPath.includes("/openapi/")) return "api_operation";
  if (normalizedPath.includes("/troubleshooting/") || /troubleshooting|troubleshoot|排查|故障/.test(normalizedTitle)) {
    return "troubleshooting";
  }
  if (normalizedPath.includes("/integrations/") || /oauth|callback|redirect|github|gitlab|teams|slack/.test(content.toLowerCase())) {
    return "integration_guidance";
  }
  return "procedure";
}

function inferSupportMetadata(filePath: string, title: string, content: string): Record<string, unknown> {
  const normalizedContent = content.toLowerCase();
  return {
    evidence_kind: inferEvidenceKind(filePath, title, content),
    product_area: /openapi|oauth|scope|token|credential/.test(normalizedContent)
      ? "openapi"
      : /github|gitlab|teams|slack|webhook|integration/.test(normalizedContent)
      ? "integrations"
      : /deploy|kubernetes|cluster|pod|ingress/.test(normalizedContent)
      ? "deployment"
      : "general",
    deployment_model:
      /private deployment|on-prem|私有部署|本地部署|deploy-docs/i.test(filePath) || /private deployment|on-prem|私有部署|本地部署/i.test(content)
        ? "private_deployment"
        : /public cloud|公有云|saas/i.test(content)
        ? "public_cloud"
        : "shared",
    permissions: uniqueStrings([...content.matchAll(/\b(?:read|write):[A-Za-z0-9:_-]+\b/g)].map((match) => match[0]), 10),
    prerequisites: uniqueStrings(
      [...content.matchAll(/(?:Prerequisites?|前提|需要|必须)[：:\s-]*([^\n.。]+)/gi)].map((match) => match[1]),
      6
    ),
    limitations: uniqueStrings(
      [...content.matchAll(/(?:Limitations?|限制|注意事项|Note)[：:\s-]*([^\n.。]+)/gi)].map((match) => match[1]),
      6
    )
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

async function collectMarkdownFiles(rootDir: string, relativeDir = ""): Promise<string[]> {
  const dirPath = path.join(rootDir, relativeDir);
  const entries = await readdir(dirPath, { withFileTypes: true });
  const output: string[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".") && entry.name !== ".well-known") continue;
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      output.push(...(await collectMarkdownFiles(rootDir, path.join(relativeDir, entry.name))));
      continue;
    }
    if (entry.isFile() && /\.(md|mdx)$/i.test(entry.name)) {
      output.push(path.posix.join(relativeDir.split(path.sep).join(path.posix.sep), entry.name));
    }
  }
  return output;
}

function readGitValue(rootDir: string, args: string[], fallback: string): string {
  try {
    return execFileSync("git", ["-C", rootDir, ...args], { encoding: "utf8" }).trim() || fallback;
  } catch {
    return fallback;
  }
}

async function buildIndex(rootDir: string): Promise<{ entries: LocalDocsIndexEntry[]; headSha: string; branch: string }> {
  const availableRoots = await Promise.all(
    SUPPORTED_ROOTS.map(async (subdir) => ((await pathExists(path.join(rootDir, subdir))) ? subdir : null))
  );
  const roots = availableRoots.filter((item): item is string => Boolean(item));
  if (!roots.length) {
    return { entries: [], headSha: "local", branch: "master" };
  }

  const headSha = readGitValue(rootDir, ["rev-parse", "HEAD"], "local");
  const branch = readGitValue(rootDir, ["rev-parse", "--abbrev-ref", "HEAD"], "master");
  const registration = buildSyntheticRegistration(branch);
  const fileGroups = await Promise.all(roots.map((subdir) => collectMarkdownFiles(rootDir, subdir)));
  const files = fileGroups.flat();

  const docs = await Promise.all(
    files.map(async (relativePath) => {
      const absolutePath = path.join(rootDir, relativePath);
      const rawContent = await readFile(absolutePath, "utf8").catch(() => "");
      if (!rawContent.trim()) return [];
      const sections = parseMarkdownSections(rawContent);
      const chunks = buildChunks(relativePath, sections, {
        targetTokens: env.GITHUB_KB_CHUNK_TARGET_TOKENS,
        overlapTokens: Math.min(env.GITHUB_KB_CHUNK_OVERLAP_TOKENS, 40)
      });
      const title = pickTitle(relativePath, rawContent, "");
      const repoSourceUrl = buildRepoSourceUrl(headSha, relativePath);
      const sourceUrl = buildPublicSourceUrl(registration, relativePath, rawContent) ?? repoSourceUrl;
      const documentId = hash(`${relativePath}:${headSha}`).slice(0, 24);

      return chunks.map<LocalDocsIndexEntry>((chunk) => {
        const chunkTitle = pickTitle(relativePath, rawContent, chunk.headingPath || title);
        const displayContent = stripMarkup(chunk.content);
        return {
          documentId,
          repoId: LOCAL_DOCS_REPO_ID,
          repo: LOCAL_DOCS_REPO,
          branch,
          path: relativePath,
          sourceUrl,
          repoSourceUrl,
          commitSha: headSha,
          title: chunkTitle || title,
          headingPath: chunk.headingPath,
          snippet: "",
          score: 0,
          supportMetadata: inferSupportMetadata(relativePath, chunkTitle || title, chunk.content),
          displayContent,
          searchableTitle: (chunkTitle || title).toLowerCase(),
          searchableHeading: chunk.headingPath.toLowerCase(),
          searchablePath: relativePath.toLowerCase(),
          searchableContent: displayContent.toLowerCase()
        };
      });
    })
  );

  return {
    headSha,
    branch,
    entries: docs.flat()
  };
}

async function ensureIndex(rootDir: string): Promise<LocalDocsIndexEntry[]> {
  const now = Date.now();
  if (cache && cache.rootDir === rootDir && cache.expiresAt > now) {
    return cache.entries;
  }

  if (inFlightBuild && inFlightBuild.rootDir === rootDir) {
    const built = await inFlightBuild.promise;
    return built.entries;
  }

  if (!(await pathExists(rootDir))) {
    cache = {
      rootDir,
      expiresAt: now + CACHE_TTL_MS,
      headSha: "missing",
      branch: "master",
      entries: []
    };
    return [];
  }

  const promise = buildIndex(rootDir)
    .then((built) => {
      cache = {
        rootDir,
        expiresAt: Date.now() + CACHE_TTL_MS,
        headSha: built.headSha,
        branch: built.branch,
        entries: built.entries
      };
      return built;
    })
    .finally(() => {
      if (inFlightBuild?.rootDir === rootDir) {
        inFlightBuild = null;
      }
    });

  inFlightBuild = { rootDir, promise };
  const built = await promise;
  return built.entries;
}

export async function preloadLocalDocsIndex(options?: { rootDir?: string }): Promise<{
  entries: number;
  headSha: string;
  branch: string;
}> {
  if (isServerlessRuntime()) {
    return { entries: 0, headSha: "serverless-disabled", branch: "master" };
  }
  const rootDir = options?.rootDir ?? env.LOCAL_DOCS_COM_PATH;
  const entries = await ensureIndex(rootDir);
  return {
    entries: entries.length,
    headSha: cache?.rootDir === rootDir ? cache.headSha : "unknown",
    branch: cache?.rootDir === rootDir ? cache.branch : "master"
  };
}

export async function searchLocalDocs(
  query: string,
  answerLanguage: "zh" | "en",
  topK = 5,
  options?: { rootDir?: string }
): Promise<LocalDocsHit[]> {
  if (isServerlessRuntime()) {
    return [];
  }
  const rootDir = options?.rootDir ?? env.LOCAL_DOCS_COM_PATH;
  const entries = await ensureIndex(rootDir);
  if (!entries.length) return [];

  const phrases = buildQueryVariants(query);
  const tokens = uniqueStrings(phrases.flatMap((phrase) => tokenize(phrase)), 24);
  const anchorTokens = uniqueStrings(buildAnchorTokens(query), 12);

  const scored = entries
    .map((entry) => {
      const anchorMatches = countAnchorMatches(entry, anchorTokens);
      if (anchorTokens.length > 0 && anchorMatches === 0) return null;
      const score = scoreEntry(entry, phrases, tokens, answerLanguage);
      if (score <= 0) return null;
      return {
        ...entry,
        score: score + anchorMatches * 1.5,
        snippet: buildSnippet(entry.displayContent, [...phrases, ...tokens])
      };
    })
    .filter((entry): entry is ScoredLocalDocsEntry => entry !== null && Boolean(entry.snippet));

  const deduped = new Map<string, ScoredLocalDocsEntry>();
  for (const item of scored.sort((a, b) => b.score - a.score)) {
    const key = `${item.path}::${item.headingPath}`;
    if (!deduped.has(key)) {
      deduped.set(key, item);
    }
    if (deduped.size >= topK * 2) break;
  }

  const maxScore = Math.max(...[...deduped.values()].map((item) => item.score), 1);
  return [...deduped.values()]
    .slice(0, topK)
    .map((item) => ({
      ...item,
      score: Number(Math.min(0.99, item.score / maxScore).toFixed(2))
    }));
}
