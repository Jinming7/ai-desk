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

process.on("exit", () => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});
