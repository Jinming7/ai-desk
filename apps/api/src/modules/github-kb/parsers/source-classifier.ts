import type { SourceFamilyClassification } from "../knowledge-model.js";

function hasMarkdownFrontmatter(content: string): boolean {
  return /^---\s*\n[\s\S]*?\n---\s*(?:\n|$)/.test(content);
}

function looksLikeOpenApi(content: string): boolean {
  return (
    /^\s*openapi:\s*["']?\d/i.test(content) ||
    /^\s*swagger:\s*["']?2/i.test(content) ||
    /"openapi"\s*:\s*"/i.test(content) ||
    /"swagger"\s*:\s*"/i.test(content) ||
    /\npaths:\s*\n/.test(content) ||
    /"paths"\s*:\s*\{/.test(content)
  );
}

export function classifySourceFamily(path: string, content: string): SourceFamilyClassification {
  const lower = path.toLowerCase();

  if (/\.(md|mdx)$/i.test(lower)) {
    if (lower.includes("/runbook") || lower.includes("/ops/") || /deploy-docs\//.test(lower)) {
      return { sourceFamily: "runbook_file", quality: "canonical", reason: "markdown runbook path" };
    }
    if (looksLikeOpenApi(content) || /\.api\.mdx$/i.test(lower)) {
      return { sourceFamily: "openapi_spec", quality: "canonical", reason: "openapi markdown source" };
    }
    return { sourceFamily: "doc_page", quality: "canonical", reason: hasMarkdownFrontmatter(content) ? "markdown document with frontmatter" : "markdown document" };
  }

  if (/\.(ya?ml|json)$/i.test(lower) && looksLikeOpenApi(content)) {
    return { sourceFamily: "openapi_spec", quality: "canonical", reason: "openapi structured file" };
  }

  if (/\.(sql|ddl)$/i.test(lower) || /migrations?\//.test(lower)) {
    return { sourceFamily: "schema_file", quality: "degraded", reason: "sql parser subset" };
  }

  if (/\.(ts|tsx|js|jsx|mjs|cjs|go|py|java|rb|php|rs)$/i.test(lower)) {
    if (/(^|\/)(test|tests|__tests__|specs?|fixtures?)\//.test(lower) || /\.(test|spec)\.[^.]+$/i.test(lower)) {
      return { sourceFamily: "test_file", quality: "canonical", reason: "test code path" };
    }
    return { sourceFamily: "code_file", quality: "degraded", reason: "language-aware fallback parser" };
  }

  if (/\.(env|properties|ini|ya?ml|json|toml)$/i.test(lower) || /(^|\/)\.env(\.|$)/.test(lower)) {
    return { sourceFamily: "config_file", quality: "degraded", reason: "config parser subset" };
  }

  return { sourceFamily: "doc_page", quality: "degraded", reason: "fallback document treatment" };
}
