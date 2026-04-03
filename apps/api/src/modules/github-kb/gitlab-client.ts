import { env } from "../../config/env.js";
import { fetchWithNodeCompat } from "../../utils/fetch-compat.js";
import type { CompareFile, GitHubReadValidation, GitHubTreeFile, RepoRegistration } from "./types.js";

interface GitLabRepoIdentity {
  host: string;
  projectPath: string;
}

function assertReadMethod(method: string): void {
  const normalized = method.toUpperCase();
  if (normalized !== "GET" && normalized !== "HEAD") {
    throw new Error(`GitLab write operation is not allowed: ${normalized}`);
  }
}

function isTransientGitLabError(error: unknown): boolean {
  const message = (error as Error)?.message?.toLowerCase?.() ?? "";
  return (
    message.includes("fetch failed") ||
    message.includes("timeout") ||
    message.includes("timed out") ||
    message.includes("econnreset") ||
    message.includes("enotfound") ||
    message.includes("socket hang up") ||
    message.includes("connection reset") ||
    message.includes("und_err_connect_timeout")
  );
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function getGitLabHeaders(extra?: Record<string, string>): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: "application/json",
    "User-Agent": "nexusflow-gitlab-kb-readonly",
    ...(extra ?? {})
  };
  if (env.GITLAB_TOKEN_READONLY) {
    headers["PRIVATE-TOKEN"] = env.GITLAB_TOKEN_READONLY;
  }
  return headers;
}

function parseGitLabRepoIdentity(repoUrl: string): GitLabRepoIdentity {
  const parsed = new URL(repoUrl);
  const host = parsed.hostname.toLowerCase();
  if (host !== "git.ones.pro") {
    throw new Error(`Unsupported GitLab repo host: ${parsed.hostname}`);
  }
  const projectPath = parsed.pathname.replace(/^\//, "").replace(/\.git$/i, "").replace(/\/+$/, "");
  if (!projectPath || projectPath.split("/").filter(Boolean).length < 2) {
    throw new Error(`Invalid GitLab repo url: ${repoUrl}`);
  }
  return {
    host,
    projectPath
  };
}

function buildGitLabApiPath(projectPath: string, suffix: string): string {
  const encodedProjectPath = encodeURIComponent(projectPath);
  return `/projects/${encodedProjectPath}${suffix}`;
}

async function gitlabRequest(path: string, method = "GET", extraHeaders?: Record<string, string>) {
  assertReadMethod(method);
  const base = env.GITLAB_API_BASE_URL.replace(/\/$/, "");

  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await fetchWithNodeCompat(`${base}${path}`, {
        method,
        headers: getGitLabHeaders(extraHeaders)
      });
    } catch (error) {
      if (!env.GITLAB_TOKEN_READONLY || !isTransientGitLabError(error) || attempt >= 2) {
        throw error;
      }
      await sleep((attempt + 1) * 1500);
    }
  }

  throw new Error(`GitLab request returned no response: ${path}`);
}

export function validateGitLabPatScopes(scopes: string[]): GitHubReadValidation {
  const normalized = Array.from(
    new Set(
      scopes
        .map((item) => item.trim())
        .filter(Boolean)
    )
  );
  const required = ["read_api", "read_repository"];
  const missing = required.filter((scope) => !normalized.includes(scope));
  const disallowed = normalized.filter((scope) => !required.includes(scope));

  if (missing.length || disallowed.length) {
    const reasons: string[] = [];
    if (missing.length) {
      reasons.push(`Missing required GitLab read scopes: ${missing.join(", ")}`);
    }
    if (disallowed.length) {
      reasons.push(`Disallowed write-capable or unsupported GitLab scopes detected: ${disallowed.join(", ")}`);
    }

    return {
      ok: false,
      scopes: normalized,
      message: reasons.join("; ")
    };
  }

  return {
    ok: true,
    scopes: normalized,
    message: "Read-only GitLab scopes validated"
  };
}

export function buildGitLabSourceUrl(repoUrl: string, filePath: string, commitSha: string): string {
  return `${repoUrl.replace(/\/$/, "")}/-/blob/${encodeURIComponent(commitSha)}/${filePath}`;
}

export async function validateReadOnlyAccess(registration: RepoRegistration): Promise<GitHubReadValidation> {
  const repo = parseGitLabRepoIdentity(registration.repo_url);
  const response = await gitlabRequest("/personal_access_tokens/self");
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`GitLab auth validation failed: ${response.status} ${body}`);
  }

  const payload = (await response.json()) as { scopes?: string[] };
  const validation = validateGitLabPatScopes(payload.scopes ?? []);
  if (!validation.ok) {
    return validation;
  }

  const projectResponse = await gitlabRequest(buildGitLabApiPath(repo.projectPath, ""));
  if (!projectResponse.ok) {
    const body = await projectResponse.text();
    throw new Error(`GitLab project read validation failed: ${projectResponse.status} ${body}`);
  }

  return validation;
}

export async function getBranchHead(registration: RepoRegistration, branch?: string): Promise<string> {
  const repo = parseGitLabRepoIdentity(registration.repo_url);
  const targetBranch = branch ?? registration.default_branch;
  const response = await gitlabRequest(
    buildGitLabApiPath(repo.projectPath, `/repository/branches/${encodeURIComponent(targetBranch)}`)
  );
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Failed to get GitLab branch head: ${response.status} ${body}`);
  }

  const payload = (await response.json()) as { commit?: { id?: string } };
  const sha = payload.commit?.id;
  if (!sha) {
    throw new Error(`GitLab branch ${targetBranch} returned no commit SHA`);
  }
  return sha;
}

export async function getRepositoryDefaultBranch(registration: RepoRegistration): Promise<string> {
  const repo = parseGitLabRepoIdentity(registration.repo_url);
  const response = await gitlabRequest(buildGitLabApiPath(repo.projectPath, ""));
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Failed to get GitLab project metadata: ${response.status} ${body}`);
  }

  const payload = (await response.json()) as { default_branch?: string };
  if (!payload.default_branch) {
    throw new Error(`GitLab project returned no default branch: ${registration.repo_url}`);
  }
  return payload.default_branch;
}

export async function listFilesAtCommit(registration: RepoRegistration, commitSha: string): Promise<GitHubTreeFile[]> {
  const repo = parseGitLabRepoIdentity(registration.repo_url);
  const files: GitHubTreeFile[] = [];
  let page = 1;

  while (true) {
    const response = await gitlabRequest(
      `${buildGitLabApiPath(repo.projectPath, "/repository/tree")}?ref=${encodeURIComponent(commitSha)}&recursive=true&per_page=100&page=${page}`
    );
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Failed to list GitLab tree: ${response.status} ${body}`);
    }

    const payload = (await response.json()) as Array<{ id?: string; path?: string; type?: string; size?: number }>;
    for (const item of payload) {
      if (item.type !== "blob" || !item.path || !item.id) continue;
      files.push({
        path: item.path,
        sha: item.id,
        size: Number(item.size ?? 0),
        type: "blob"
      });
    }

    const nextPage = response.headers.get("x-next-page");
    if (!nextPage) {
      break;
    }
    page = Number(nextPage);
    if (!Number.isFinite(page) || page <= 0) {
      break;
    }
  }

  return files;
}

export async function getFileContentBufferAtCommit(
  registration: RepoRegistration,
  filePath: string,
  commitSha: string
): Promise<Buffer> {
  const repo = parseGitLabRepoIdentity(registration.repo_url);
  const encodedPath = encodeURIComponent(filePath);
  const response = await gitlabRequest(
    `${buildGitLabApiPath(repo.projectPath, `/repository/files/${encodedPath}/raw`)}?ref=${encodeURIComponent(commitSha)}`,
    "GET",
    { Accept: "*/*" }
  );
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Failed to fetch GitLab file content: ${response.status} ${body}`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  return buffer;
}

export async function getFileContentAtCommit(
  registration: RepoRegistration,
  filePath: string,
  commitSha: string
): Promise<string> {
  const buffer = await getFileContentBufferAtCommit(registration, filePath, commitSha);
  return buffer.toString("utf8");
}

function mapGitLabCompareStatus(file: {
  old_path?: string;
  new_path?: string;
  new_file?: boolean;
  deleted_file?: boolean;
  renamed_file?: boolean;
}): CompareFile {
  if (file.deleted_file) {
    return {
      filename: String(file.old_path ?? file.new_path ?? ""),
      status: "removed"
    };
  }
  if (file.new_file) {
    return {
      filename: String(file.new_path ?? file.old_path ?? ""),
      status: "added"
    };
  }
  if (file.renamed_file) {
    return {
      filename: String(file.new_path ?? file.old_path ?? ""),
      status: "renamed",
      previous_filename: String(file.old_path ?? "")
    };
  }
  return {
    filename: String(file.new_path ?? file.old_path ?? ""),
    status: "modified"
  };
}

export async function compareCommits(
  registration: RepoRegistration,
  beforeCommitSha: string,
  afterCommitSha: string
): Promise<CompareFile[]> {
  const repo = parseGitLabRepoIdentity(registration.repo_url);
  const response = await gitlabRequest(
    `${buildGitLabApiPath(repo.projectPath, "/repository/compare")}?from=${encodeURIComponent(beforeCommitSha)}&to=${encodeURIComponent(afterCommitSha)}`
  );
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Failed to compare GitLab commits: ${response.status} ${body}`);
  }

  const payload = (await response.json()) as {
    diffs?: Array<{
      old_path?: string;
      new_path?: string;
      new_file?: boolean;
      deleted_file?: boolean;
      renamed_file?: boolean;
    }>;
  };

  return (payload.diffs ?? []).map((file) => mapGitLabCompareStatus(file));
}

export function buildSourceUrl(registration: RepoRegistration, filePath: string, commitSha: string): string {
  parseGitLabRepoIdentity(registration.repo_url);
  return buildGitLabSourceUrl(registration.repo_url, filePath, commitSha);
}

export function getRepoFullName(registration: RepoRegistration): string {
  return parseGitLabRepoIdentity(registration.repo_url).projectPath;
}

export function assertGitLabReadOnlyMethod(method: string): void {
  assertReadMethod(method);
}
