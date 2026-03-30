import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { test } from "node:test";
import { env } from "../../config/env.js";
import type { RepoRegistration } from "./types.js";
import { buildQueryAnchoredSnippet, getLocalDocsMirrorState, resolveBootstrapIncludePaths, sliceSnapshotForBackfill } from "./service.js";

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

test("resolveBootstrapIncludePaths falls back to markdown and mdx coverage", () => {
  assert.deepEqual(resolveBootstrapIncludePaths(""), ["**/*.md", "**/*.mdx"]);
  assert.deepEqual(resolveBootstrapIncludePaths("docs/**/*.mdx"), ["docs/**/*.mdx"]);
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
