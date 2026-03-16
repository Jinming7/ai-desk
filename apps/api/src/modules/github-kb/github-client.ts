import { env } from "../../config/env.js";
import type { CompareFile, GitHubReadValidation, GitHubTreeFile, RepoRegistration } from "./types.js";

interface RepoIdentity {
  owner: string;
  name: string;
  mock: boolean;
}

type MockSnapshot = Record<string, string>;

const mockRepoSnapshots: Record<string, Record<string, MockSnapshot>> = {
  "acme/ticket-kb": {
    mockc1: {
      "docs/auth.md": "# Auth Guide\n\nReset user token via console and verify callback URL.",
      "docs/runbook.md": "# Incident Runbook\n\nEscalate high severity incidents within 15 minutes."
    },
    mockc2: {
      "docs/auth.md": "# Auth Guide\n\nRotate token, verify callback URL, and clear local cache before retry.",
      "docs/runbook.md": "# Incident Runbook\n\nEscalate high severity incidents within 10 minutes.",
      "docs/api.md": "# API Access\n\n401 usually means token scope mismatch or expired secret.",
      "deploy-docs/troubleshooting/infra/k3s-alert-handler.md":
        "---\nid: alert-handler\nsidebar_label: Alert故障处理\n---\n\n# Alert故障处理\n\n本文介绍关于 k3s/k8s 常见告警主题处理及解决方案。\n\n## KubeVersionMismatch\n\n- 优先级: P4\n- 描述: There are $value different semantic versions of Kubernetes components running.\n- 解决方法: 立即处理，联系 ONES 进行处理。"
    },
    mockc3: {
      "docs/auth.md": "# Auth Guide\n\nRotate token, verify callback URL, clear cache, then re-login.",
      "docs/api.md": "# API Access\n\nCheck token scope, tenant binding, and rate limit headers.",
      "deploy-docs/troubleshooting/infra/k3s-alert-handler.md":
        "---\nid: alert-handler\nsidebar_label: Alert故障处理\n---\n\n# Alert故障处理\n\n本文介绍关于 k3s/k8s 常见告警主题处理及解决方案。\n\n## KubeVersionMismatch\n\n- 优先级: P4\n- 描述: There are $value different semantic versions of Kubernetes components running.\n- 解决方法: 立即处理，联系 ONES 进行处理。"
    }
  }
};

const mockRepoHeads: Record<string, Record<string, string>> = {
  "acme/ticket-kb": {
    main: "mockc3"
  }
};

function parseRepoIdentity(repoUrl: string): RepoIdentity {
  if (repoUrl.startsWith("mock://")) {
    const parts = repoUrl.replace("mock://", "").split("/").filter(Boolean);
    if (parts.length < 2) {
      throw new Error(`Invalid mock repo url: ${repoUrl}`);
    }
    return { owner: parts[0], name: parts[1], mock: true };
  }

  try {
    const url = new URL(repoUrl);
    if (!/github\.com$/i.test(url.hostname)) {
      throw new Error(`Unsupported repo host: ${url.hostname}`);
    }
    const parts = url.pathname.replace(/^\//, "").replace(/\.git$/i, "").split("/").filter(Boolean);
    if (parts.length < 2) {
      throw new Error(`Invalid github repo url: ${repoUrl}`);
    }
    return { owner: parts[0], name: parts[1], mock: false };
  } catch (error) {
    if (error instanceof TypeError) {
      throw new Error(`Invalid repo url: ${repoUrl}`);
    }
    throw error;
  }
}

function buildMockKey(identity: RepoIdentity): string {
  return `${identity.owner}/${identity.name}`;
}

function assertReadMethod(method: string) {
  const normalized = method.toUpperCase();
  if (normalized !== "GET" && normalized !== "HEAD") {
    throw new Error(`GitHub write operation is not allowed: ${normalized}`);
  }
}

function getGithubHeaders(extra?: Record<string, string>) {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "nexusflow-github-kb-readonly",
    ...(extra ?? {})
  };
  if (env.GITHUB_TOKEN_READONLY) {
    headers.Authorization = `Bearer ${env.GITHUB_TOKEN_READONLY}`;
  }
  return headers;
}

async function githubRequest(path: string, method = "GET", extraHeaders?: Record<string, string>) {
  assertReadMethod(method);
  const base = env.GITHUB_API_BASE_URL.replace(/\/$/, "");
  const response = await fetch(`${base}${path}`, {
    method,
    headers: getGithubHeaders(extraHeaders)
  });
  return response;
}

function mockGetSnapshot(repo: RepoIdentity, commitSha: string): MockSnapshot {
  const map = mockRepoSnapshots[buildMockKey(repo)];
  if (!map) {
    throw new Error(`Mock repository not found: ${buildMockKey(repo)}`);
  }
  const snapshot = map[commitSha];
  if (!snapshot) {
    throw new Error(`Mock commit not found: ${commitSha}`);
  }
  return snapshot;
}

export async function validateReadOnlyAccess(registration: RepoRegistration): Promise<GitHubReadValidation> {
  const repo = parseRepoIdentity(registration.repo_url);
  if (repo.mock) {
    return { ok: true, scopes: ["mock:readonly"], message: "mock repository validation passed" };
  }

  const response = await githubRequest("/rate_limit", "GET");
  if (!response.ok) {
    return {
      ok: false,
      scopes: [],
      message: `GitHub auth validation failed: ${response.status}`
    };
  }

  const raw = response.headers.get("x-oauth-scopes") ?? "";
  const scopes = raw
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);

  if (!scopes.length) {
    return {
      ok: true,
      scopes: [],
      message: "No scope header returned by GitHub; assuming GitHub App/fine-grained token"
    };
  }

  const disallowed = scopes.filter(
    (scope) =>
      /^repo$/i.test(scope) ||
      /:write$/i.test(scope) ||
      /admin/i.test(scope) ||
      /workflow/i.test(scope) ||
      /delete/i.test(scope)
  );

  if (disallowed.length) {
    if (env.GITHUB_KB_ALLOW_BROAD_SCOPES) {
      return {
        ok: true,
        scopes,
        message: `Broad token scopes detected (${disallowed.join(", ")}), allowed by GITHUB_KB_ALLOW_BROAD_SCOPES override`
      };
    }
    return {
      ok: false,
      scopes,
      message: `Disallowed write-capable scopes detected: ${disallowed.join(", ")}`
    };
  }

  return {
    ok: true,
    scopes,
    message: "Read-only GitHub scopes validated"
  };
}

export async function getBranchHead(registration: RepoRegistration, branch?: string): Promise<string> {
  const repo = parseRepoIdentity(registration.repo_url);
  const targetBranch = branch ?? registration.default_branch;

  if (repo.mock) {
    const heads = mockRepoHeads[buildMockKey(repo)] ?? {};
    const head = heads[targetBranch];
    if (!head) {
      throw new Error(`Mock branch not found: ${targetBranch}`);
    }
    return head;
  }

  const response = await githubRequest(`/repos/${repo.owner}/${repo.name}/branches/${encodeURIComponent(targetBranch)}`);
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Failed to get branch head: ${response.status} ${body}`);
  }
  const payload = (await response.json()) as { commit?: { sha?: string } };
  const sha = payload.commit?.sha;
  if (!sha) {
    throw new Error(`Branch ${targetBranch} returned no commit SHA`);
  }
  return sha;
}

export async function getRepositoryDefaultBranch(registration: RepoRegistration): Promise<string> {
  const repo = parseRepoIdentity(registration.repo_url);
  if (repo.mock) {
    const heads = mockRepoHeads[buildMockKey(repo)] ?? {};
    const [firstBranch] = Object.keys(heads);
    if (!firstBranch) {
      throw new Error(`Mock repository has no branches: ${buildMockKey(repo)}`);
    }
    return firstBranch;
  }

  const response = await githubRequest(`/repos/${repo.owner}/${repo.name}`);
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Failed to get repository metadata: ${response.status} ${body}`);
  }
  const payload = (await response.json()) as { default_branch?: string };
  if (!payload.default_branch) {
    throw new Error("Repository metadata returned no default_branch");
  }
  return payload.default_branch;
}

export async function listFilesAtCommit(registration: RepoRegistration, commitSha: string): Promise<GitHubTreeFile[]> {
  const repo = parseRepoIdentity(registration.repo_url);
  if (repo.mock) {
    const snapshot = mockGetSnapshot(repo, commitSha);
    return Object.keys(snapshot).map((path) => ({
      path,
      sha: `sha-${commitSha}-${path}`,
      size: snapshot[path].length,
      type: "blob"
    }));
  }

  const response = await githubRequest(`/repos/${repo.owner}/${repo.name}/git/trees/${encodeURIComponent(commitSha)}?recursive=1`);
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Failed to list tree: ${response.status} ${body}`);
  }

  const payload = (await response.json()) as {
    tree?: Array<{ path: string; sha: string; size?: number; type: string }>;
    truncated?: boolean;
  };

  const treeFiles = (payload.tree ?? [])
    .filter((item) => item.type === "blob")
    .map((item) => ({
      path: item.path,
      sha: item.sha,
      size: item.size ?? 0,
      type: "blob" as const
    }));

  if (!payload.truncated) {
    return treeFiles;
  }

  // Fallback for large repositories: GitHub tree API may truncate results.
  const walkedFiles: GitHubTreeFile[] = [];
  const queue: string[] = [""];
  while (queue.length) {
    const current = queue.shift() ?? "";
    const encodedPath = current
      ? current
          .split("/")
          .filter(Boolean)
          .map((part) => encodeURIComponent(part))
          .join("/")
      : "";
    const endpoint = encodedPath
      ? `/repos/${repo.owner}/${repo.name}/contents/${encodedPath}?ref=${encodeURIComponent(commitSha)}`
      : `/repos/${repo.owner}/${repo.name}/contents?ref=${encodeURIComponent(commitSha)}`;
    const page = await githubRequest(endpoint, "GET");
    if (!page.ok) {
      const body = await page.text();
      throw new Error(`Failed to list contents: ${page.status} ${body}`);
    }
    const payload = (await page.json()) as
      | { type?: string; path?: string; sha?: string; size?: number }
      | Array<{ type?: string; path?: string; sha?: string; size?: number }>;
    const entries = Array.isArray(payload) ? payload : [payload];
    for (const entry of entries) {
      const type = String(entry.type ?? "");
      const path = String(entry.path ?? "");
      if (!path) continue;
      if (type === "dir") {
        queue.push(path);
        continue;
      }
      if (type === "file") {
        walkedFiles.push({
          path,
          sha: String(entry.sha ?? ""),
          size: Number(entry.size ?? 0),
          type: "blob" as const
        });
      }
    }
  }
  return walkedFiles;
}

export async function getFileContentAtCommit(
  registration: RepoRegistration,
  filePath: string,
  commitSha: string
): Promise<string> {
  const repo = parseRepoIdentity(registration.repo_url);
  if (repo.mock) {
    const snapshot = mockGetSnapshot(repo, commitSha);
    const content = snapshot[filePath];
    if (typeof content !== "string") {
      throw new Error(`Mock file not found: ${filePath} at ${commitSha}`);
    }
    return content;
  }

  const encodedPath = filePath.split("/").map(encodeURIComponent).join("/");
  const response = await githubRequest(`/repos/${repo.owner}/${repo.name}/contents/${encodedPath}?ref=${encodeURIComponent(commitSha)}`);
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Failed to fetch file content: ${response.status} ${body}`);
  }

  const payload = (await response.json()) as { content?: string; encoding?: string };
  if (!payload.content) {
    throw new Error(`File payload missing content: ${filePath}`);
  }
  if (payload.encoding === "base64") {
    return Buffer.from(payload.content, "base64").toString("utf8");
  }
  return payload.content;
}

export async function compareCommits(
  registration: RepoRegistration,
  beforeCommitSha: string,
  afterCommitSha: string
): Promise<CompareFile[]> {
  const repo = parseRepoIdentity(registration.repo_url);
  if (repo.mock) {
    const beforeSnapshot = mockGetSnapshot(repo, beforeCommitSha);
    const afterSnapshot = mockGetSnapshot(repo, afterCommitSha);

    const allPaths = new Set([...Object.keys(beforeSnapshot), ...Object.keys(afterSnapshot)]);
    const changed: CompareFile[] = [];

    for (const path of allPaths) {
      const before = beforeSnapshot[path];
      const after = afterSnapshot[path];
      if (before === undefined && after !== undefined) {
        changed.push({ filename: path, status: "added" });
        continue;
      }
      if (before !== undefined && after === undefined) {
        changed.push({ filename: path, status: "removed" });
        continue;
      }
      if (before !== after) {
        changed.push({ filename: path, status: "modified" });
      }
    }
    return changed;
  }

  const response = await githubRequest(
    `/repos/${repo.owner}/${repo.name}/compare/${encodeURIComponent(beforeCommitSha)}...${encodeURIComponent(afterCommitSha)}`
  );
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Failed to compare commits: ${response.status} ${body}`);
  }

  const payload = (await response.json()) as {
    files?: Array<{ filename: string; status: "added" | "modified" | "removed" | "renamed"; previous_filename?: string; sha?: string }>;
  };

  return (payload.files ?? []).map((file) => ({
    filename: file.filename,
    status: file.status,
    previous_filename: file.previous_filename,
    sha: file.sha
  }));
}

export function buildSourceUrl(registration: RepoRegistration, path: string, commitSha: string): string {
  const repo = parseRepoIdentity(registration.repo_url);
  if (repo.mock) {
    return `https://github.com/${repo.owner}/${repo.name}/blob/${commitSha}/${path}`;
  }
  return `https://github.com/${repo.owner}/${repo.name}/blob/${commitSha}/${path}`;
}

export function getRepoFullName(registration: RepoRegistration): string {
  const repo = parseRepoIdentity(registration.repo_url);
  return `${repo.owner}/${repo.name}`;
}

export function assertGithubReadOnlyMethod(method: string): void {
  assertReadMethod(method);
}
