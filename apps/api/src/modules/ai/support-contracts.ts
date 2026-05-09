import { existsSync, lstatSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { SupportDomain } from "./types.js";

export type RuntimeSupportDomain = Exclude<SupportDomain, "docs">;

export interface SupportContractRegistryDomainEntry {
  id: RuntimeSupportDomain;
  contract_path: string;
  owned_product_areas: string[];
  owned_source_families: string[];
  preferred_doc_kinds: string[];
  exact_signal_types: string[];
}

export interface SupportContractRegistry {
  version: string;
  contracts: {
    supervisor: string;
    evidence_judge: string;
    answer_composer: string;
    evidence_selector: string;
    support_writer: string;
  };
  domains: SupportContractRegistryDomainEntry[];
}

const textCache = new Map<string, string>();
let registryCache: SupportContractRegistry | null = null;
let repoRootCache: string | null = null;
const moduleDir = path.dirname(fileURLToPath(import.meta.url));

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

function findWorkspaceRoot(startDir: string): string | null {
  let current = path.resolve(startDir);
  while (true) {
    if (
      existsSync(path.join(current, "package.json")) &&
      existsSync(path.join(current, "apps", "api")) &&
      existsSync(path.join(current, "docs"))
    ) {
      return current;
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

function resolveSupportRepoRoot(): string {
  if (repoRootCache) {
    return repoRootCache;
  }

  const workspaceRoot = findWorkspaceRoot(process.cwd());
  if (workspaceRoot) {
    repoRootCache = workspaceRoot;
    return repoRootCache;
  }

  const gitEntry = findGitEntry(process.cwd());
  const repoRoot = gitEntry ? resolveRepoRootFromGitEntry(gitEntry) : null;
  repoRootCache = repoRoot ?? path.resolve(process.cwd());
  return repoRootCache;
}

function resolveSupportContractAbsolutePath(relativePath: string): string {
  const candidates = [
    path.resolve(resolveSupportRepoRoot(), relativePath),
    path.resolve(process.cwd(), "apps", "api", "dist", relativePath),
    path.resolve(moduleDir, "../..", relativePath),
    path.resolve(moduleDir, "../../..", relativePath)
  ];
  const resolved = candidates.find((candidate) => existsSync(candidate));
  return resolved ?? candidates[0];
}

export function canonicalizeSupportDomain(value: unknown): RuntimeSupportDomain | null {
  switch (String(value ?? "").trim().toLowerCase()) {
    case "openapi":
      return "openapi";
    case "deployment":
      return "deployment";
    case "integrations":
      return "integrations";
    case "product":
      return "product";
    case "troubleshooting":
      return "troubleshooting";
    default:
      return null;
  }
}

export function loadSupportContractText(relativePath: string): string {
  const absolutePath = resolveSupportContractAbsolutePath(relativePath);
  const cached = textCache.get(absolutePath);
  if (cached) {
    return cached;
  }

  const text = readFileSync(absolutePath, "utf8");
  textCache.set(absolutePath, text);
  return text;
}

export function loadSupportContractRegistry(): SupportContractRegistry {
  if (registryCache) {
    return registryCache;
  }

  registryCache = JSON.parse(loadSupportContractText("docs/agents/support-runtime/registry.json")) as SupportContractRegistry;
  return registryCache;
}

export function resolveDomainContractPath(domain: SupportDomain | string): string {
  return resolveSupportDomainRegistryEntry(domain).contract_path;
}

export function resolveSupportDomainRegistryEntry(domain: SupportDomain | string): SupportContractRegistryDomainEntry {
  const canonicalDomain = canonicalizeSupportDomain(domain);
  if (!canonicalDomain) {
    throw new Error(`Invalid support runtime domain: ${String(domain ?? "")}`);
  }
  const registry = loadSupportContractRegistry();
  const entry = registry.domains.find((item) => item.id === canonicalDomain);
  if (!entry) {
    throw new Error(`Missing support contract domain entry for ${canonicalDomain}`);
  }
  return entry;
}

export function resolveDomainContract(domain: SupportDomain | string): string {
  return loadSupportContractText(resolveDomainContractPath(domain));
}

export function resolveSupervisorContract(): string {
  return loadSupportContractText(loadSupportContractRegistry().contracts.supervisor);
}

export function resolveEvidenceJudgeContract(): string {
  return loadSupportContractText(loadSupportContractRegistry().contracts.evidence_judge);
}

export function resolveAnswerComposerContract(): string {
  return loadSupportContractText(loadSupportContractRegistry().contracts.answer_composer);
}

export function resolveEvidenceSelectorContract(): string {
  return loadSupportContractText(loadSupportContractRegistry().contracts.evidence_selector);
}

export function resolveSupportWriterContract(): string {
  return loadSupportContractText(loadSupportContractRegistry().contracts.support_writer);
}

export function resetSupportContractCachesForTest(): void {
  textCache.clear();
  registryCache = null;
  repoRootCache = null;
}
