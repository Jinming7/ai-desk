import assert from "node:assert/strict";
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { test } from "node:test";
import { env } from "../../config/env.js";
import type { KbBuild, RepoRegistration, SyncJob } from "./types.js";
import { buildDocsComSourceManifest } from "./source/manifest-builder.js";
import {
  buildEnqueuedSyncPayload,
  buildDocsComIncludePaths,
  buildPollingSyncRequestFromPublication,
  buildQueryAnchoredSnippet,
  githubKbServiceDeps,
  handleTerminalGenericSyncJobFailure,
  resolveSyncExecutionId,
  ensureMarkdownCoverage,
  getLocalDocsMirrorState,
  populateDocsComManifestEligibleChecksumsForSnapshot,
  resolveBootstrapIncludePaths,
  resolvePublicationAwareIncrementalBase,
  shouldAdvanceFullSyncCheckpoint,
  sliceSnapshotForBackfill
} from "./service.js";
import { summarizeServingCompatibilityMetadata } from "./release/service.js";

const localMirrorRegistration: RepoRegistration = {
  id: "docs-com-test",
  repo_owner: "BangWork",
  repo_name: "docs-com",
  repo_url: "https://github.com/BangWork/docs-com",
  public_base_url: "https://docs.ones.com",
  default_branch: "master",
  include_paths: ["**/*.md", "**/*.mdx"],
  exclude_paths: [],
  polling_interval_seconds: 60,
  auth_mode: "github_token_readonly",
  is_active: true,
  last_validated_at: null,
  last_validation_error: null,
  created_by: "test",
  created_at: new Date(0).toISOString(),
  updated_at: new Date(0).toISOString()
};

function sha256(input: string): string {
  return crypto.createHash("sha256").update(input).digest("hex");
}

test("resolveBootstrapIncludePaths falls back to markdown and mdx coverage", () => {
  assert.deepEqual(resolveBootstrapIncludePaths(""), ["**/*.md", "**/*.mdx"]);
  assert.deepEqual(resolveBootstrapIncludePaths("docs/**/*.mdx"), ["docs/**/*.mdx"]);
});

test("resolveBootstrapIncludePaths keeps docs-com open-docs and deploy-docs coverage for long env lists", () => {
  const includePaths = resolveBootstrapIncludePaths(
    [
      "AGENTS.md",
      "README.md",
      "CONTRIBUTING.md",
      "REGION_FILTER_GUIDE.md",
      "docs/*.md",
      "docs/*.mdx",
      "docs/**/*.md",
      "docs/**/*.mdx",
      "open-docs/*.md",
      "open-docs/*.mdx",
      "open-docs/**/*.md",
      "open-docs/**/*.mdx",
      "deploy-docs/*.md",
      "deploy-docs/*.mdx",
      "deploy-docs/**/*.md",
      "deploy-docs/**/*.mdx",
      "scripts/**/*.md",
      "src/**/README.md"
    ].join(",")
  );

  assert.equal(includePaths.includes("open-docs/**/*.md"), true);
  assert.equal(includePaths.includes("open-docs/**/*.mdx"), true);
  assert.equal(includePaths.includes("deploy-docs/**/*.md"), true);
  assert.equal(includePaths.includes("deploy-docs/**/*.mdx"), true);
  assert.equal(includePaths.length, 18);
});

test("ensureMarkdownCoverage does not truncate long docs-com include lists", () => {
  const includePaths = ensureMarkdownCoverage([
    "AGENTS.md",
    "README.md",
    "CONTRIBUTING.md",
    "REGION_FILTER_GUIDE.md",
    "docs/*.md",
    "docs/*.mdx",
    "docs/**/*.md",
    "docs/**/*.mdx",
    "open-docs/*.md",
    "open-docs/*.mdx",
    "open-docs/**/*.md",
    "open-docs/**/*.mdx",
    "deploy-docs/*.md",
    "deploy-docs/*.mdx",
    "deploy-docs/**/*.md",
    "deploy-docs/**/*.mdx",
    "scripts/**/*.md",
    "src/**/README.md"
  ]);

  assert.equal(includePaths.includes("open-docs/**/*.md"), true);
  assert.equal(includePaths.includes("open-docs/**/*.mdx"), true);
  assert.equal(includePaths.includes("deploy-docs/**/*.md"), true);
  assert.equal(includePaths.includes("deploy-docs/**/*.mdx"), true);
  assert.equal(includePaths.length, 18);
});

test("buildDocsComIncludePaths strips non-docs repo metadata patterns", () => {
  const includePaths = buildDocsComIncludePaths(
    [
      "AGENTS.md",
      "README.md",
      "CONTRIBUTING.md",
      "REGION_FILTER_GUIDE.md",
      "docs/*.md",
      "docs/*.mdx",
      "docs/**/*.md",
      "docs/**/*.mdx",
      "open-docs/*.md",
      "open-docs/*.mdx",
      "open-docs/**/*.md",
      "open-docs/**/*.mdx",
      "deploy-docs/*.md",
      "deploy-docs/*.mdx",
      "deploy-docs/**/*.md",
      "deploy-docs/**/*.mdx",
      "scripts/**/*.md",
      "src/**/README.md"
    ].join(",")
  );

  assert.equal(includePaths.includes("AGENTS.md"), false);
  assert.equal(includePaths.includes("README.md"), false);
  assert.equal(includePaths.includes("scripts/**/*.md"), false);
  assert.equal(includePaths.includes("docs/**/*.md"), true);
  assert.equal(includePaths.includes("open-docs/**/*.mdx"), true);
  assert.equal(includePaths.includes("deploy-docs/**/*.md"), true);
});

test("buildEnqueuedSyncPayload assigns distinct execution-scoped build versions for different logical full-sync runs on the same commit", () => {
  const first = buildEnqueuedSyncPayload({
    mode: "full",
    idempotencyKey: "poll:repo-1:main:none:shared-head",
    afterCommitSha: "shared-head",
    knowledgeSpace: "support-local",
    payload: {}
  });
  const second = buildEnqueuedSyncPayload({
    mode: "full",
    idempotencyKey: "manual:repo-1:main:none:shared-head",
    afterCommitSha: "shared-head",
    knowledgeSpace: "support-local",
    payload: {}
  });

  assert.notEqual(first.buildVersion, "shared-head");
  assert.notEqual(second.buildVersion, "shared-head");
  assert.notEqual(first.buildVersion, second.buildVersion);
  assert.notEqual(first.executionId, second.executionId);
});

test("resolveSyncExecutionId prefers the explicit execution id over build version fallback", () => {
  assert.equal(
    resolveSyncExecutionId({ executionId: "exec-123", buildVersion: "shared-head" }, "job-1"),
    "exec-123"
  );
});

test("buildEnqueuedSyncPayload preserves the explicit build version for full-sync continuations", () => {
  const payload = buildEnqueuedSyncPayload({
    mode: "full",
    idempotencyKey: "sync-continuation:full:repo-1:main:shared-head:cursor-2",
    afterCommitSha: "shared-head",
    knowledgeSpace: "support-local",
    payload: {
      executionId: "sync-exec:abc123",
      buildVersion: "shared-head:sync-exec:abc123"
    }
  });

  assert.equal(payload.executionId, "sync-exec:abc123");
  assert.equal(payload.buildVersion, "shared-head:sync-exec:abc123");
});

function buildSyncJob(overrides: Partial<SyncJob> = {}): SyncJob {
  return {
    id: "job-1",
    repo_id: "repo-1",
    branch: "main",
    sync_mode: "full",
    source: "manual",
    status: "running",
    idempotency_key: "sync:repo-1:main",
    before_commit_sha: null,
    after_commit_sha: "shared-head",
    payload_json: {
      knowledgeSpace: "support-local",
      buildVersion: "shared-head:exec-1",
      executionId: "exec-1"
    },
    attempts: 0,
    max_attempts: 5,
    next_run_at: new Date(0).toISOString(),
    started_at: new Date(0).toISOString(),
    finished_at: null,
    error_message: null,
    created_at: new Date(0).toISOString(),
    updated_at: new Date(0).toISOString(),
    ...overrides
  };
}

function buildRecord(overrides: Partial<KbBuild> = {}): KbBuild {
  return {
    id: "build-1",
    knowledge_space: "support-local",
    repo_id: "repo-1",
    branch: "main",
    build_version: "shared-head:exec-1",
    target_head: "shared-head",
    build_kind: "full",
    requested_by: "manual",
    requested_from_env: "local",
    status: "building",
    source_snapshot_total: 1,
    documents_built: 0,
    chunks_built: 0,
    memory_entries_built: 0,
    embeddings_built: 0,
    validation_passed: false,
    validation_summary_json: {},
    error_message: null,
    started_at: new Date(0).toISOString(),
    finished_at: null,
    created_at: new Date(0).toISOString(),
    updated_at: new Date(0).toISOString(),
    ...overrides
  };
}

test("handleTerminalGenericSyncJobFailure marks dead-lettered generic builds failed and releases the lease", async (t) => {
  const job = buildSyncJob();
  const build = buildRecord();
  const calls: {
    getBuildByVersion?: Record<string, unknown>;
    updateBuildStatus?: Record<string, unknown>;
    releaseIngestLease?: { leaseKey: string; ownerId: string | undefined };
  } = {};

  t.mock.method(githubKbServiceDeps, "getBuildByVersion", async (input: Parameters<typeof githubKbServiceDeps.getBuildByVersion>[0]) => {
    calls.getBuildByVersion = input;
    return build;
  });
  t.mock.method(githubKbServiceDeps, "updateBuildStatus", async (input: Parameters<typeof githubKbServiceDeps.updateBuildStatus>[0]) => {
    calls.updateBuildStatus = input as Record<string, unknown>;
    return { ...build, status: "failed", error_message: "forced failure", finished_at: new Date().toISOString() };
  });
  t.mock.method(githubKbServiceDeps, "releaseIngestLease", async (leaseKey: string, ownerId?: string) => {
    calls.releaseIngestLease = { leaseKey, ownerId };
  });

  await handleTerminalGenericSyncJobFailure({
    job,
    status: "dead_letter",
    errorMessage: "forced failure"
  });

  assert.deepEqual(calls.getBuildByVersion, {
    knowledgeSpace: "support-local",
    repoId: "repo-1",
    branch: "main",
    buildVersion: "shared-head:exec-1"
  });
  assert.deepEqual(calls.updateBuildStatus, {
    buildId: "build-1",
    status: "failed",
    errorMessage: "forced failure",
    finished: true
  });
  assert.deepEqual(calls.releaseIngestLease, {
    leaseKey: "build:support-local:repo-1:main",
    ownerId: "exec-1"
  });
});

test("handleTerminalGenericSyncJobFailure leaves retriable generic failures resumable", async (t) => {
  const getBuildByVersion = t.mock.method(githubKbServiceDeps, "getBuildByVersion", async () => buildRecord());
  const updateBuildStatus = t.mock.method(githubKbServiceDeps, "updateBuildStatus", async () => buildRecord({ status: "failed" }));
  const releaseIngestLease = t.mock.method(githubKbServiceDeps, "releaseIngestLease", async () => undefined);

  await handleTerminalGenericSyncJobFailure({
    job: buildSyncJob(),
    status: "failed",
    errorMessage: "transient failure"
  });

  assert.equal(getBuildByVersion.mock.callCount(), 0);
  assert.equal(updateBuildStatus.mock.callCount(), 0);
  assert.equal(releaseIngestLease.mock.callCount(), 0);
});

test("buildQueryAnchoredSnippet exposes later callback evidence instead of chunk prefix", () => {
  const raw = `
Intro paragraph about repository linking and account authorization.

Some generic setup explanation appears first and does not answer the troubleshooting case.

If the authorization completes but ONES does not return, or the callback page shows page not found,
check whether Redirect URI, webhook callback address, and baseURL point to the same environment.
`;

  const snippet = buildQueryAnchoredSnippet(raw, ["github", "callback", "page not found", "redirect uri", "baseurl"]);

  assert.match(snippet, /page not found/i);
  assert.match(snippet, /Redirect URI/i);
  assert.doesNotMatch(snippet, /^Intro paragraph/i);
});

test("getLocalDocsMirrorState ignores an existing path when the local mirror flag is disabled", async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "github-kb-service-"));
  const originalPath = env.LOCAL_DOCS_COM_PATH;
  const originalEnabled = env.GITHUB_KB_ENABLE_LOCAL_DOCS_MIRROR;

  try {
    env.LOCAL_DOCS_COM_PATH = rootDir;
    env.GITHUB_KB_ENABLE_LOCAL_DOCS_MIRROR = false;
    const localMirror = await getLocalDocsMirrorState(localMirrorRegistration);
    assert.equal(localMirror, null);
  } finally {
    env.LOCAL_DOCS_COM_PATH = originalPath;
    env.GITHUB_KB_ENABLE_LOCAL_DOCS_MIRROR = originalEnabled;
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("getLocalDocsMirrorState rejects non-git directories instead of falling back to literal local", async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "github-kb-service-"));
  const originalPath = env.LOCAL_DOCS_COM_PATH;
  const originalEnabled = env.GITHUB_KB_ENABLE_LOCAL_DOCS_MIRROR;

  try {
    env.LOCAL_DOCS_COM_PATH = rootDir;
    env.GITHUB_KB_ENABLE_LOCAL_DOCS_MIRROR = true;
    const localMirror = await getLocalDocsMirrorState(localMirrorRegistration);
    assert.equal(localMirror, null);
  } finally {
    env.LOCAL_DOCS_COM_PATH = originalPath;
    env.GITHUB_KB_ENABLE_LOCAL_DOCS_MIRROR = originalEnabled;
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("sliceSnapshotForBackfill continues across uppercase paths using the same ordering as snapshot sort", () => {
  const paths = [
    "deploy-docs/scaling/database/GoldenDB-external.cn.md",
    "deploy-docs/scaling/database/index.mdx",
    "deploy-docs/scaling/database/install_with_TDSQL.cn.md",
    "deploy-docs/scaling/database/mysql-external.md",
    "deploy-docs/scaling/database/mysql-to-dameng.cn.md",
    "deploy-docs/scaling/database/mysql-to-gaussdb.cn.md",
    "deploy-docs/scaling/database/OceanBase-external.cn.md",
    "deploy-docs/scaling/database/TaurusDB-external.cn.md",
    "deploy-docs/scaling/index.mdx"
  ];

  const window = sliceSnapshotForBackfill(paths, "deploy-docs/scaling/database/mysql-to-gaussdb.cn.md", 2);

  assert.deepEqual(window.files, [
    "deploy-docs/scaling/database/OceanBase-external.cn.md",
    "deploy-docs/scaling/database/TaurusDB-external.cn.md"
  ]);
  assert.equal(window.nextCursor, "deploy-docs/scaling/database/TaurusDB-external.cn.md");
  assert.equal(window.finished, false);
});

test("buildDocsComSourceManifest records included files and machine-readable skip reasons", () => {
  const manifest = buildDocsComSourceManifest({
    sourceMode: "remote",
    includePaths: ["docs/**"],
    excludePaths: ["docs/excluded/**"],
    files: [
      {
        path: "docs/guide/setup.mdx",
        sha: "sha-doc",
        contentChecksum: "checksum-doc",
        size: 12,
        type: "blob"
      },
      {
        path: "docs/assets/logo.png",
        sha: "sha-png",
        contentChecksum: "checksum-png",
        size: 8,
        type: "blob"
      },
      {
        path: "docs/example/openapi.yaml",
        sha: "sha-openapi",
        contentChecksum: "checksum-openapi",
        size: 24,
        type: "blob"
      },
      {
        path: "docs/excluded/secret.mdx",
        sha: "sha-excluded",
        contentChecksum: "checksum-excluded",
        size: 16,
        type: "blob"
      },
      {
        path: "README.md",
        sha: "sha-readme",
        contentChecksum: "checksum-readme",
        size: 32,
        type: "blob"
      }
    ]
  });

  assert.equal(manifest.eligibleItems.length, 2);
  assert.equal(manifest.skippedItems.length, 3);
  assert.deepEqual(
    manifest.eligibleItems.map((item) => [item.path, item.sourceFamily]),
    [
      ["docs/example/openapi.yaml", "openapi_spec"],
      ["docs/guide/setup.mdx", "doc_page"]
    ]
  );
  assert.deepEqual(
    manifest.skippedItems.map((item) => [item.path, item.skipReason, item.shardKey, item.contentChecksum]),
    [
      ["docs/assets/logo.png", "unsupported_extension", "docs", null],
      ["docs/excluded/secret.mdx", "excluded_by_pattern", "docs", null],
      ["README.md", "outside_docs_com_scope", null, null]
    ]
  );
  assert.equal(manifest.skippedItems[0].sourceAcquisitionMode, "remote");
});

test("buildDocsComSourceManifest keeps content checksum stable across acquisition modes", () => {
  const remoteManifest = buildDocsComSourceManifest({
    sourceMode: "remote",
    includePaths: ["docs/**/*.md"],
    excludePaths: [],
    files: [
      {
        path: "docs/api/auth.md",
        sha: "blob-remote",
        contentChecksum: "sha256-same-content",
        size: 42,
        type: "blob"
      }
    ]
  });

  const localManifest = buildDocsComSourceManifest({
    sourceMode: "local_mirror",
    includePaths: ["docs/**/*.md"],
    excludePaths: [],
    files: [
      {
        path: "docs/api/auth.md",
        sha: "blob-local",
        contentChecksum: "sha256-same-content",
        size: 42,
        type: "blob"
      }
    ]
  });

  assert.equal(remoteManifest.eligibleItems[0]?.blobSha, "blob-remote");
  assert.equal(localManifest.eligibleItems[0]?.blobSha, "blob-local");
  assert.equal(remoteManifest.eligibleItems[0]?.contentChecksum, "sha256-same-content");
  assert.equal(localManifest.eligibleItems[0]?.contentChecksum, "sha256-same-content");
});

test("remote manifest checksum hydration fetches only eligible files and respects bounded concurrency", async () => {
  const manifest = buildDocsComSourceManifest({
    sourceMode: "remote",
    includePaths: ["docs/**"],
    excludePaths: ["docs/excluded/**"],
    files: [
      {
        path: "docs/guide/setup.mdx",
        sha: "blob-doc",
        size: 12,
        type: "blob"
      },
      {
        path: "docs/reference/openapi.yaml",
        sha: "blob-openapi",
        size: 24,
        type: "blob"
      },
      {
        path: "docs/assets/logo.png",
        sha: "blob-png",
        size: 8,
        type: "blob"
      },
      {
        path: "docs/excluded/secret.mdx",
        sha: "blob-excluded",
        size: 16,
        type: "blob"
      },
      {
        path: "README.md",
        sha: "blob-readme",
        size: 32,
        type: "blob"
      }
    ]
  });

  const fetchedPaths: string[] = [];
  let inFlight = 0;
  let maxInFlight = 0;

  const hydrated = await populateDocsComManifestEligibleChecksumsForSnapshot({
    registration: localMirrorRegistration,
    targetHead: "mock-head",
    sourceMode: "remote",
    manifest,
    remoteConcurrency: 1,
    fetchContentBuffer: async (filePath) => {
      fetchedPaths.push(filePath);
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 10));
      inFlight -= 1;
      return Buffer.from(`content:${filePath}`, "utf8");
    }
  });

  assert.deepEqual(fetchedPaths, ["docs/guide/setup.mdx", "docs/reference/openapi.yaml"]);
  assert.equal(maxInFlight, 1);
  assert.equal(hydrated.skippedItems.every((item) => item.contentChecksum === null), true);
  assert.equal(
    hydrated.eligibleItems.every((item) => typeof item.contentChecksum === "string" && item.contentChecksum.length > 0),
    true
  );
});

test("remote eligible checksum matches local mirror checksum for the same content", async () => {
  const content = "# Setup\n\nUse the same content across acquisition modes.";
  const localManifest = buildDocsComSourceManifest({
    sourceMode: "local_mirror",
    includePaths: ["docs/**"],
    excludePaths: [],
    files: [
      {
        path: "docs/guide/setup.mdx",
        sha: "blob-local",
        contentChecksum: sha256(content),
        size: Buffer.byteLength(content, "utf8"),
        type: "blob"
      }
    ]
  });

  const remoteManifest = buildDocsComSourceManifest({
    sourceMode: "remote",
    includePaths: ["docs/**"],
    excludePaths: [],
    files: [
      {
        path: "docs/guide/setup.mdx",
        sha: "blob-remote",
        size: Buffer.byteLength(content, "utf8"),
        type: "blob"
      }
    ]
  });

  const hydrated = await populateDocsComManifestEligibleChecksumsForSnapshot({
    registration: localMirrorRegistration,
    targetHead: "mock-head",
    sourceMode: "remote",
    manifest: remoteManifest,
    fetchContentBuffer: async () => Buffer.from(content, "utf8")
  });

  assert.equal(hydrated.eligibleItems[0]?.contentChecksum, localManifest.eligibleItems[0]?.contentChecksum);
});

test("summarizeServingCompatibilityMetadata marks legacy serving rows as ambiguous when multiple knowledge spaces publish the same repo scope", () => {
  const serving = summarizeServingCompatibilityMetadata({
    serving: {
      repo_id: "repo-1",
      branch: "main",
      active_build_version: "build-local-current",
      active_head: "sha-local-current",
      activated_at: new Date(0).toISOString(),
      updated_at: new Date(0).toISOString()
    },
    publication: {
      knowledge_space: "support-preview",
      repo_id: "repo-1",
      branch: "main",
      published_build_version: "build-preview-current",
      published_head: "sha-preview-current",
      published_by: "test",
      published_from_env: "preview",
      published_at: new Date(0).toISOString(),
      updated_at: new Date(0).toISOString()
    },
    publicationScopeCount: 2
  });

  assert.deepEqual(serving, {
    source: "compatibility_metadata",
    scope: "repo_branch",
    activeBuildVersion: "build-local-current",
    activeHead: "sha-local-current",
    activatedAt: new Date(0).toISOString(),
    comparisonToPublication: "ambiguous_across_knowledge_spaces",
    consistentWithPublication: null
  });
});

test("resolvePublicationAwareIncrementalBase ignores newer unpublished checkpoint heads", () => {
  const baseline = resolvePublicationAwareIncrementalBase({
    publication: {
      published_build_version: "build-v1",
      published_head: "sha-v1"
    },
    checkpoint: {
      last_synced_commit_sha: "sha-v2-unpublished",
      last_full_synced_commit_sha: "sha-v2-unpublished"
    }
  });

  assert.deepEqual(baseline, {
    kind: "published",
    commitSha: "sha-v1",
    buildVersion: "build-v1"
  });
});

test("buildPollingSyncRequestFromPublication falls back to full sync when no publication exists", () => {
  assert.deepEqual(
    buildPollingSyncRequestFromPublication({
      latestHead: "sha-v3",
      publication: null,
      checkpoint: {
        last_synced_commit_sha: "sha-v2-unpublished",
        last_full_synced_commit_sha: "sha-v2-unpublished"
      }
    }),
    {
      mode: "full"
    }
  );
});

test("shouldAdvanceFullSyncCheckpoint only advances baseline state for publish_inline full builds", () => {
  assert.equal(shouldAdvanceFullSyncCheckpoint("build_only"), false);
  assert.equal(shouldAdvanceFullSyncCheckpoint("publish_inline"), true);
});
