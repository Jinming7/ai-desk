import type { GitHubTreeFile, KbFullSyncShardKey, KbSourceAcquisitionMode, KbSourceFamily } from "../types.js";

export interface DocsComManifestEligibleItem {
  path: string;
  shardKey: KbFullSyncShardKey;
  sourceFamily: KbSourceFamily;
  blobSha: string;
  contentChecksum: string | null;
  sizeBytes: number;
  needsRebuild: boolean;
  reuseReason: string | null;
  sourceAcquisitionMode: KbSourceAcquisitionMode;
}

export interface DocsComManifestSkippedItem {
  path: string;
  shardKey: KbFullSyncShardKey | null;
  sourceFamily: KbSourceFamily | null;
  blobSha: string;
  contentChecksum: string | null;
  sizeBytes: number;
  sourceAcquisitionMode: KbSourceAcquisitionMode;
  skipReason: string;
}

export interface DocsComSourceManifest {
  eligibleItems: DocsComManifestEligibleItem[];
  skippedItems: DocsComManifestSkippedItem[];
}

function classifyShard(pathname: string): KbFullSyncShardKey | null {
  if (pathname.startsWith("deploy-docs/")) return "deploy-docs";
  if (pathname.startsWith("docs/")) return "docs";
  if (pathname.startsWith("open-docs/")) return "open-docs";
  return null;
}

function classifyFamilyHint(pathname: string): KbSourceFamily | null {
  const lower = pathname.toLowerCase();
  if (/\.(md|mdx)$/i.test(lower)) {
    if (lower.includes("/runbook") || lower.includes("/ops/") || lower.startsWith("deploy-docs/")) return "runbook_file";
    if (/\.api\.mdx$/i.test(lower) || lower.includes("/openapi/") || lower.includes("/swagger/")) return "openapi_spec";
    return "doc_page";
  }
  if (/\.(ya?ml|json)$/i.test(lower)) {
    if (lower.includes("openapi") || lower.includes("swagger")) return "openapi_spec";
    return "config_file";
  }
  if (/\.(sql|ddl)$/i.test(lower) || /migrations?\//.test(lower)) return "schema_file";
  if (/\.(env|properties|ini|toml)$/i.test(lower) || /(^|\/)\.env(\.|$)/.test(lower)) return "config_file";
  if (/\.(ts|tsx|js|jsx|mjs|cjs|go|py|java|rb|php|rs)$/i.test(lower)) {
    if (/(^|\/)(test|tests|__tests__|specs?|fixtures?)\//.test(lower) || /\.(test|spec)\.[^.]+$/i.test(lower)) return "test_file";
    return "code_file";
  }
  return null;
}

function globToRegex(glob: string): RegExp {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  const withDoubleStar = escaped.replace(/\*\*/g, "::DOUBLE_STAR::");
  const withSingleStar = withDoubleStar.replace(/\*/g, "[^/]*");
  const pattern = withSingleStar.replace(/::DOUBLE_STAR::/g, ".*");
  return new RegExp(`^${pattern}$`, "i");
}

function getInclusionDecision(pathname: string, includePaths: string[], excludePaths: string[]): {
  includedByPattern: boolean;
  excludedByPattern: boolean;
} {
  const includeRegex = includePaths.map(globToRegex);
  const excludeRegex = excludePaths.map(globToRegex);
  return {
    includedByPattern: includeRegex.some((regex) => regex.test(pathname)),
    excludedByPattern: excludeRegex.some((regex) => regex.test(pathname))
  };
}

function resolveSkipReason(input: {
  path: string;
  shardKey: KbFullSyncShardKey | null;
  sourceFamily: KbSourceFamily | null;
  includePaths: string[];
  excludePaths: string[];
}): string | null {
  if (!input.shardKey) return "outside_docs_com_scope";

  const inclusion = getInclusionDecision(input.path, input.includePaths, input.excludePaths);
  if (inclusion.excludedByPattern) return "excluded_by_pattern";
  if (!inclusion.includedByPattern) return "outside_include_scope";
  if (!input.sourceFamily) return "unsupported_extension";
  return null;
}

export function buildDocsComSourceManifest(input: {
  sourceMode: KbSourceAcquisitionMode;
  includePaths: string[];
  excludePaths: string[];
  files: GitHubTreeFile[];
}): DocsComSourceManifest {
  const eligibleItems: DocsComManifestEligibleItem[] = [];
  const skippedItems: DocsComManifestSkippedItem[] = [];

  for (const file of [...input.files].sort((left, right) => left.path.localeCompare(right.path, "en"))) {
    const shardKey = classifyShard(file.path);
    const sourceFamily = classifyFamilyHint(file.path);
    const skipReason = resolveSkipReason({
      path: file.path,
      shardKey,
      sourceFamily,
      includePaths: input.includePaths,
      excludePaths: input.excludePaths
    });

    if (skipReason || !shardKey || !sourceFamily) {
      skippedItems.push({
        path: file.path,
        shardKey,
        sourceFamily,
        blobSha: file.sha,
        // Skipped ledger is path/provenance oriented; do not force content reads just to backfill checksums.
        contentChecksum: null,
        sizeBytes: file.size,
        sourceAcquisitionMode: input.sourceMode,
        skipReason: skipReason ?? "unsupported_family"
      });
      continue;
    }

    eligibleItems.push({
      path: file.path,
      shardKey,
      sourceFamily,
      blobSha: file.sha,
      contentChecksum: file.contentChecksum ?? null,
      sizeBytes: file.size,
      needsRebuild: true,
      reuseReason: null,
      sourceAcquisitionMode: input.sourceMode
    });
  }

  return {
    eligibleItems,
    skippedItems
  };
}
