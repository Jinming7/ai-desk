import { config as loadDotenv } from "dotenv";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import path from "node:path";

function uniquePaths(paths: Array<string | null | undefined>): string[] {
  const seen = new Set<string>();
  const values: string[] = [];
  for (const candidate of paths) {
    const value = String(candidate ?? "").trim();
    if (!value) continue;
    const normalized = path.resolve(value);
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    values.push(normalized);
  }
  return values;
}

function findGitEntry(startDir: string): string | null {
  let current = path.resolve(startDir);
  while (true) {
    const candidate = path.join(current, ".git");
    if (existsSync(candidate)) {
      return candidate;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}

function resolveRepoRootFromGitEntry(gitEntryPath: string): string | null {
  try {
    const stat = lstatSync(gitEntryPath);
    if (stat.isDirectory()) {
      return path.dirname(gitEntryPath);
    }
    if (!stat.isFile()) {
      return null;
    }
    const match = readFileSync(gitEntryPath, "utf8").match(/^\s*gitdir:\s*(.+?)\s*$/i);
    if (!match) {
      return null;
    }
    let gitDir = path.resolve(path.dirname(gitEntryPath), match[1]);
    while (path.basename(gitDir) !== ".git") {
      const parent = path.dirname(gitDir);
      if (parent === gitDir) {
        return null;
      }
      gitDir = parent;
    }
    return path.dirname(gitDir);
  } catch {
    return null;
  }
}

export function resolveDotenvCandidatePaths(cwd: string, envFile: string): string[] {
  const gitEntry = findGitEntry(cwd);
  const repoRoot = gitEntry ? resolveRepoRootFromGitEntry(gitEntry) : null;
  return uniquePaths([path.join(cwd, envFile), repoRoot ? path.join(repoRoot, envFile) : null]);
}

export function loadDotenvFiles(input?: { cwd?: string; envFile?: string }) {
  const cwd = input?.cwd ?? process.cwd();
  const envFile = input?.envFile ?? (process.env.NODE_ENV === "test" ? ".env.test" : ".env");
  for (const envPath of resolveDotenvCandidatePaths(cwd, envFile)) {
    loadDotenv({ path: envPath, override: false });
  }
}
