import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import { loadDotenvFiles, resolveDotenvCandidatePaths } from "./dotenv-loader.js";

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  delete process.env.TEST_WORKTREE_ENV_VALUE;
  delete process.env.TEST_FALLBACK_ENV_VALUE;
  delete process.env.TEST_EMPTY_IN_ENV_TEST;
  delete process.env.OPENCLAW_ALLOW_SELF_SIGNED;
});

test("resolveDotenvCandidatePaths includes main repo env for git worktrees", () => {
  const repoRoot = makeTempDir("dotenv-main-repo-");
  mkdirSync(path.join(repoRoot, ".git", "worktrees", "wt-1"), { recursive: true });

  const worktreeRoot = makeTempDir("dotenv-worktree-");
  writeFileSync(
    path.join(worktreeRoot, ".git"),
    `gitdir: ${path.join(repoRoot, ".git", "worktrees", "wt-1")}\n`,
    "utf8"
  );

  const cwd = path.join(worktreeRoot, "apps", "api");
  mkdirSync(cwd, { recursive: true });

  assert.deepEqual(resolveDotenvCandidatePaths(cwd, ".env"), [
    path.join(cwd, ".env"),
    path.join(repoRoot, ".env")
  ]);
});

test("loadDotenvFiles falls back to the main repo env from a git worktree cwd", () => {
  const repoRoot = makeTempDir("dotenv-main-repo-");
  mkdirSync(path.join(repoRoot, ".git", "worktrees", "wt-2"), { recursive: true });
  writeFileSync(path.join(repoRoot, ".env"), "TEST_WORKTREE_ENV_VALUE=from-main-repo\n", "utf8");

  const worktreeRoot = makeTempDir("dotenv-worktree-");
  writeFileSync(
    path.join(worktreeRoot, ".git"),
    `gitdir: ${path.join(repoRoot, ".git", "worktrees", "wt-2")}\n`,
    "utf8"
  );

  const cwd = path.join(worktreeRoot, "apps", "api");
  mkdirSync(cwd, { recursive: true });

  delete process.env.TEST_WORKTREE_ENV_VALUE;
  loadDotenvFiles({ cwd, envFile: ".env" });

  assert.equal(process.env.TEST_WORKTREE_ENV_VALUE, "from-main-repo");
});

test("loadDotenvFiles keeps current cwd env ahead of the main repo fallback", () => {
  const repoRoot = makeTempDir("dotenv-main-repo-");
  mkdirSync(path.join(repoRoot, ".git", "worktrees", "wt-3"), { recursive: true });
  writeFileSync(path.join(repoRoot, ".env"), "TEST_WORKTREE_ENV_VALUE=from-main-repo\n", "utf8");

  const worktreeRoot = makeTempDir("dotenv-worktree-");
  writeFileSync(
    path.join(worktreeRoot, ".git"),
    `gitdir: ${path.join(repoRoot, ".git", "worktrees", "wt-3")}\n`,
    "utf8"
  );
  writeFileSync(path.join(worktreeRoot, ".env"), "TEST_WORKTREE_ENV_VALUE=from-worktree\n", "utf8");

  const cwd = worktreeRoot;

  delete process.env.TEST_WORKTREE_ENV_VALUE;
  loadDotenvFiles({ cwd, envFile: ".env" });

  assert.equal(process.env.TEST_WORKTREE_ENV_VALUE, "from-worktree");
});

test("resolveDotenvCandidatePaths deduplicates repo-root paths", () => {
  const repoRoot = makeTempDir("dotenv-main-repo-");
  mkdirSync(path.join(repoRoot, ".git"), { recursive: true });

  assert.deepEqual(resolveDotenvCandidatePaths(repoRoot, ".env"), [path.join(repoRoot, ".env")]);
});

test("resolveDotenvCandidatePaths ignores malformed gitdir files", () => {
  const worktreeRoot = makeTempDir("dotenv-worktree-");
  writeFileSync(path.join(worktreeRoot, ".git"), "not-a-valid-gitdir\n", "utf8");

  assert.deepEqual(resolveDotenvCandidatePaths(worktreeRoot, ".env"), [path.join(worktreeRoot, ".env")]);
});

test("loadDotenvFiles works when a worktree env is symlinked back to the main repo env", () => {
  const repoRoot = makeTempDir("dotenv-main-repo-");
  mkdirSync(path.join(repoRoot, ".git", "worktrees", "wt-4"), { recursive: true });
  writeFileSync(path.join(repoRoot, ".env"), "TEST_WORKTREE_ENV_VALUE=from-main-repo\n", "utf8");

  const worktreeRoot = makeTempDir("dotenv-worktree-");
  writeFileSync(
    path.join(worktreeRoot, ".git"),
    `gitdir: ${path.join(repoRoot, ".git", "worktrees", "wt-4")}\n`,
    "utf8"
  );
  symlinkSync(path.join(repoRoot, ".env"), path.join(worktreeRoot, ".env"));

  delete process.env.TEST_WORKTREE_ENV_VALUE;
  loadDotenvFiles({ cwd: worktreeRoot, envFile: ".env" });

  assert.equal(process.env.TEST_WORKTREE_ENV_VALUE, "from-main-repo");
});

test("resolveDotenvCandidatePaths handles relative gitdir targets", () => {
  const repoRoot = makeTempDir("dotenv-main-repo-");
  mkdirSync(path.join(repoRoot, ".git", "worktrees", "wt-5"), { recursive: true });

  const worktreeRoot = makeTempDir("dotenv-worktree-");
  const relativeGitDir = path.relative(worktreeRoot, path.join(repoRoot, ".git", "worktrees", "wt-5"));
  writeFileSync(path.join(worktreeRoot, ".git"), `gitdir: ${relativeGitDir}\n`, "utf8");

  assert.deepEqual(resolveDotenvCandidatePaths(worktreeRoot, ".env"), [
    path.join(worktreeRoot, ".env"),
    path.join(repoRoot, ".env")
  ]);
});

test("resolveDotenvCandidatePaths includes .env fallback when loading .env.test", () => {
  const repoRoot = makeTempDir("dotenv-main-repo-");
  mkdirSync(path.join(repoRoot, ".git", "worktrees", "wt-6"), { recursive: true });

  const worktreeRoot = makeTempDir("dotenv-worktree-");
  writeFileSync(
    path.join(worktreeRoot, ".git"),
    `gitdir: ${path.join(repoRoot, ".git", "worktrees", "wt-6")}\n`,
    "utf8"
  );

  assert.deepEqual(resolveDotenvCandidatePaths(worktreeRoot, ".env.test"), [
    path.join(worktreeRoot, ".env.test"),
    path.join(repoRoot, ".env.test"),
    path.join(worktreeRoot, ".env"),
    path.join(repoRoot, ".env")
  ]);
});

test("loadDotenvFiles backfills missing .env.test keys from .env", () => {
  const repoRoot = makeTempDir("dotenv-main-repo-");
  mkdirSync(path.join(repoRoot, ".git", "worktrees", "wt-7"), { recursive: true });
  writeFileSync(path.join(repoRoot, ".env.test"), "TEST_WORKTREE_ENV_VALUE=from-env-test\n", "utf8");
  writeFileSync(
    path.join(repoRoot, ".env"),
    "TEST_FALLBACK_ENV_VALUE=from-env\nTEST_EMPTY_IN_ENV_TEST=from-env-fallback\n",
    "utf8"
  );

  const worktreeRoot = makeTempDir("dotenv-worktree-");
  writeFileSync(
    path.join(worktreeRoot, ".git"),
    `gitdir: ${path.join(repoRoot, ".git", "worktrees", "wt-7")}\n`,
    "utf8"
  );

  delete process.env.TEST_WORKTREE_ENV_VALUE;
  delete process.env.TEST_FALLBACK_ENV_VALUE;
  delete process.env.TEST_EMPTY_IN_ENV_TEST;
  writeFileSync(path.join(worktreeRoot, ".env.test"), "TEST_EMPTY_IN_ENV_TEST=\n", "utf8");
  loadDotenvFiles({ cwd: worktreeRoot, envFile: ".env.test" });

  assert.equal(process.env.TEST_WORKTREE_ENV_VALUE, "from-env-test");
  assert.equal(process.env.TEST_FALLBACK_ENV_VALUE, "from-env");
  assert.equal(process.env.TEST_EMPTY_IN_ENV_TEST, "from-env-fallback");
});

test("loadDotenvFiles promotes OPENCLAW_ALLOW_SELF_SIGNED from .env when .env.test disables it", () => {
  const repoRoot = makeTempDir("dotenv-main-repo-");
  mkdirSync(path.join(repoRoot, ".git", "worktrees", "wt-8"), { recursive: true });
  writeFileSync(path.join(repoRoot, ".env.test"), "OPENCLAW_ALLOW_SELF_SIGNED=false\n", "utf8");
  writeFileSync(path.join(repoRoot, ".env"), "OPENCLAW_ALLOW_SELF_SIGNED=true\n", "utf8");

  const worktreeRoot = makeTempDir("dotenv-worktree-");
  writeFileSync(
    path.join(worktreeRoot, ".git"),
    `gitdir: ${path.join(repoRoot, ".git", "worktrees", "wt-8")}\n`,
    "utf8"
  );

  delete process.env.OPENCLAW_ALLOW_SELF_SIGNED;
  loadDotenvFiles({ cwd: worktreeRoot, envFile: ".env.test" });

  assert.equal(process.env.OPENCLAW_ALLOW_SELF_SIGNED, "true");
});

process.on("exit", () => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});
