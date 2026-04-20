import type { CompareFile, GitHubReadValidation, GitHubTreeFile, RepoRegistration } from "./types.js";
import * as githubClient from "./github-client.js";
import * as gitlabClient from "./gitlab-client.js";

export type RepoProviderKind = "mock" | "github" | "gitlab";

const DOCS_COM_GITLAB_REPO_URL = "https://git.ones.pro/docs/docs-com";
const DOCS_COM_GITLAB_PROJECT_PATH = "docs/docs-com";
const DOCS_COM_DEFAULT_BRANCH = "master";
const DOCS_COM_PUBLIC_BASE_URL = "https://docs.ones.com";

export function resolveRepoProviderKind(repoUrl: string): RepoProviderKind {
  const normalized = String(repoUrl ?? "").trim();
  if (normalized.startsWith("mock://")) {
    return "mock";
  }

  const url = new URL(normalized);
  const hostname = url.hostname.toLowerCase();
  if (hostname === "github.com" || hostname.endsWith(".github.com")) {
    return "github";
  }
  if (hostname === "git.ones.pro") {
    return "gitlab";
  }
  throw new Error(`Unsupported repo host: ${url.hostname}`);
}

export function getDocsComCanonicalSource() {
  return {
    providerKind: "gitlab" as const,
    repoUrl: DOCS_COM_GITLAB_REPO_URL,
    projectPath: DOCS_COM_GITLAB_PROJECT_PATH,
    defaultBranch: DOCS_COM_DEFAULT_BRANCH,
    publicBaseUrl: DOCS_COM_PUBLIC_BASE_URL
  };
}

export const validateGitLabPatScopes = gitlabClient.validateGitLabPatScopes;
export const buildGitLabSourceUrl = gitlabClient.buildGitLabSourceUrl;

export function assertGithubReadOnlyMethod(method: string): void {
  githubClient.assertGithubReadOnlyMethod(method);
}

export function buildSourceUrl(registration: RepoRegistration, path: string, commitSha: string): string {
  switch (resolveRepoProviderKind(registration.repo_url)) {
    case "gitlab":
      return gitlabClient.buildSourceUrl(registration, path, commitSha);
    default:
      return githubClient.buildSourceUrl(registration, path, commitSha);
  }
}

export function getRepoFullName(registration: RepoRegistration): string {
  switch (resolveRepoProviderKind(registration.repo_url)) {
    case "gitlab":
      return gitlabClient.getRepoFullName(registration);
    default:
      return githubClient.getRepoFullName(registration);
  }
}

export function validateReadOnlyAccess(registration: RepoRegistration): Promise<GitHubReadValidation> {
  switch (resolveRepoProviderKind(registration.repo_url)) {
    case "gitlab":
      return gitlabClient.validateReadOnlyAccess(registration);
    default:
      return githubClient.validateReadOnlyAccess(registration);
  }
}

export function getBranchHead(registration: RepoRegistration, branch?: string): Promise<string> {
  switch (resolveRepoProviderKind(registration.repo_url)) {
    case "gitlab":
      return gitlabClient.getBranchHead(registration, branch);
    default:
      return githubClient.getBranchHead(registration, branch);
  }
}

export function getRepositoryDefaultBranch(registration: RepoRegistration): Promise<string> {
  switch (resolveRepoProviderKind(registration.repo_url)) {
    case "gitlab":
      return gitlabClient.getRepositoryDefaultBranch(registration);
    default:
      return githubClient.getRepositoryDefaultBranch(registration);
  }
}

export function listFilesAtCommit(registration: RepoRegistration, commitSha: string): Promise<GitHubTreeFile[]> {
  switch (resolveRepoProviderKind(registration.repo_url)) {
    case "gitlab":
      return gitlabClient.listFilesAtCommit(registration, commitSha);
    default:
      return githubClient.listFilesAtCommit(registration, commitSha);
  }
}

export function getFileContentBufferAtCommit(registration: RepoRegistration, filePath: string, commitSha: string): Promise<Buffer> {
  switch (resolveRepoProviderKind(registration.repo_url)) {
    case "gitlab":
      return gitlabClient.getFileContentBufferAtCommit(registration, filePath, commitSha);
    default:
      return githubClient.getFileContentBufferAtCommit(registration, filePath, commitSha);
  }
}

export function getFileContentAtCommit(registration: RepoRegistration, filePath: string, commitSha: string): Promise<string> {
  switch (resolveRepoProviderKind(registration.repo_url)) {
    case "gitlab":
      return gitlabClient.getFileContentAtCommit(registration, filePath, commitSha);
    default:
      return githubClient.getFileContentAtCommit(registration, filePath, commitSha);
  }
}

export function compareCommits(
  registration: RepoRegistration,
  beforeCommitSha: string,
  afterCommitSha: string
): Promise<CompareFile[]> {
  switch (resolveRepoProviderKind(registration.repo_url)) {
    case "gitlab":
      return gitlabClient.compareCommits(registration, beforeCommitSha, afterCommitSha);
    default:
      return githubClient.compareCommits(registration, beforeCommitSha, afterCommitSha);
  }
}
