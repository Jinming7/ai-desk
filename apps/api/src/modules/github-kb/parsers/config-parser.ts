import { collapseWhitespace, splitLines, uniqueStrings } from "../knowledge-common.js";
import { stableUuidFromParts, summarizeText } from "../knowledge-common.js";
import type { ConfigSurfaceDraft, SourceDocumentContext } from "../knowledge-model.js";

function normalizeKey(input: string): string {
  return input.trim().replace(/\s+/g, ".").replace(/\.+/g, ".").replace(/^\.|\.$/g, "").toLowerCase();
}

function detectConfigKind(path: string): string {
  const lower = path.toLowerCase();
  if (/(^|\/)\.env(\.|$)/.test(lower)) return "env_var";
  if (lower.endsWith(".json")) return "json_path";
  if (lower.endsWith(".yaml") || lower.endsWith(".yml")) return "yaml_path";
  if (lower.endsWith(".toml")) return "toml_path";
  return "config_key";
}

function buildSurface(context: SourceDocumentContext, input: {
  configKey: string;
  defaultValue?: string | null;
  description?: string | null;
  line: number;
  relatedComponents?: string[];
  metadata?: Record<string, unknown>;
}): ConfigSurfaceDraft {
  const normalizedKey = normalizeKey(input.configKey);
  return {
    id: stableUuidFromParts([context.knowledgeSpace, context.repoId, context.branch, context.buildVersion, context.path, normalizedKey]),
    sourceDocId: context.docId,
    path: context.path,
    configKind: detectConfigKind(context.path),
    configKey: input.configKey.trim(),
    normalizedKey,
    defaultValue: input.defaultValue?.trim() || null,
    description: input.description?.trim() || null,
    requiredFor: {},
    relatedComponents: { components: uniqueStrings(input.relatedComponents ?? [], 8) },
    sourceLocation: { lineStart: input.line, lineEnd: input.line },
    metadata: input.metadata ?? {}
  };
}

function parseEnvLike(context: SourceDocumentContext): ConfigSurfaceDraft[] {
  return splitLines(context.content)
    .map((line, index) => ({ line, index }))
    .filter(({ line }) => !line.trim().startsWith("#") && /^[A-Za-z_][A-Za-z0-9_]*\s*=/.test(line))
    .map(({ line, index }) => {
      const [, key, rawValue] = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line.trim()) ?? [];
      return buildSurface(context, {
        configKey: key,
        defaultValue: rawValue?.replace(/^["']|["']$/g, "") ?? "",
        description: null,
        line: index + 1,
        metadata: { parser: "dotenv" }
      });
    });
}

function flattenJson(value: unknown, prefix = "", line = 1): Array<{ key: string; value: unknown; line: number }> {
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => flattenJson(item, prefix ? `${prefix}[${index}]` : `[${index}]`, line));
  }
  if (value && typeof value === "object") {
    return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) =>
      flattenJson(child, prefix ? `${prefix}.${key}` : key, line)
    );
  }
  return prefix ? [{ key: prefix, value, line }] : [];
}

function parseJsonConfig(context: SourceDocumentContext): ConfigSurfaceDraft[] {
  try {
    const parsed = JSON.parse(context.content) as unknown;
    return flattenJson(parsed).map((item) =>
      buildSurface(context, {
        configKey: item.key,
        defaultValue: typeof item.value === "string" || typeof item.value === "number" || typeof item.value === "boolean" ? String(item.value) : null,
        description: null,
        line: item.line,
        metadata: { parser: "json" }
      })
    );
  } catch {
    return [];
  }
}

function parseYamlLike(context: SourceDocumentContext): ConfigSurfaceDraft[] {
  const lines = splitLines(context.content);
  const stack: Array<{ indent: number; key: string }> = [];
  const surfaces: ConfigSurfaceDraft[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const rawLine = lines[index];
    if (!rawLine.trim() || rawLine.trim().startsWith("#")) continue;
    const indent = rawLine.match(/^\s*/)?.[0].length ?? 0;
    const match = /^([^:#]+):\s*(.*)$/.exec(rawLine.trim());
    if (!match) continue;
    while (stack.length && stack.at(-1) && indent <= stack.at(-1)!.indent) stack.pop();
    const key = match[1].trim();
    const value = match[2].trim();
    stack.push({ indent, key });
    if (!value || value === "|" || value === ">") continue;
    surfaces.push(
      buildSurface(context, {
        configKey: stack.map((item) => item.key).join("."),
        defaultValue: value.replace(/^["']|["']$/g, ""),
        description: null,
        line: index + 1,
        metadata: { parser: "yaml_fallback", degraded_quality: true }
      })
    );
  }
  return surfaces;
}

function parseTomlLike(context: SourceDocumentContext): ConfigSurfaceDraft[] {
  const lines = splitLines(context.content);
  let section = "";
  const surfaces: ConfigSurfaceDraft[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (!line || line.startsWith("#")) continue;
    const sectionMatch = /^\[([^\]]+)\]$/.exec(line);
    if (sectionMatch) {
      section = sectionMatch[1].trim();
      continue;
    }
    const kvMatch = /^([A-Za-z0-9_.-]+)\s*=\s*(.+)$/.exec(line);
    if (!kvMatch) continue;
    const key = section ? `${section}.${kvMatch[1]}` : kvMatch[1];
    surfaces.push(
      buildSurface(context, {
        configKey: key,
        defaultValue: kvMatch[2].replace(/^["']|["']$/g, ""),
        description: null,
        line: index + 1,
        metadata: { parser: "toml_fallback", degraded_quality: true }
      })
    );
  }
  return surfaces;
}

export function parseConfigSurfaces(context: SourceDocumentContext): ConfigSurfaceDraft[] {
  const lower = context.path.toLowerCase();
  const surfaces = /(^|\/)\.env(\.|$)/.test(lower)
    ? parseEnvLike(context)
    : lower.endsWith(".json")
    ? parseJsonConfig(context)
    : lower.endsWith(".toml")
    ? parseTomlLike(context)
    : parseYamlLike(context);

  return surfaces
    .map((surface) => ({
      ...surface,
      description: surface.description ?? summarizeText(collapseWhitespace(context.title), 120)
    }))
    .filter((surface, index, all) => all.findIndex((item) => item.id === surface.id) === index);
}
