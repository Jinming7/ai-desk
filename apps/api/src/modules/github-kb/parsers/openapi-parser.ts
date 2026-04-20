import zlib from "node:zlib";
import { collapseWhitespace, safeJsonParse, splitLines, uniqueStrings } from "../knowledge-common.js";
import { stableUuidFromParts, summarizeText } from "../knowledge-common.js";
import type { OpenApiOperationDraft, SourceDocumentContext } from "../knowledge-model.js";

function decodeBase64Url(input: string): Buffer {
  const normalized = input.replace(/-/g, "+").replace(/_/g, "/");
  const padding = normalized.length % 4 === 0 ? "" : "=".repeat(4 - (normalized.length % 4));
  return Buffer.from(normalized + padding, "base64");
}

function decodeEmbeddedOpenApiBlob(content: string): Record<string, unknown> | null {
  const matched = /^api:\s*(\S+)$/m.exec(content);
  if (!matched?.[1]) return null;
  const payload = decodeBase64Url(matched[1]);
  for (const fn of [zlib.inflateSync, zlib.inflateRawSync, zlib.gunzipSync]) {
    try {
      const parsed = safeJsonParse(fn(payload).toString("utf8"));
      if (parsed && typeof parsed === "object") return parsed as Record<string, unknown>;
    } catch {
      // try next strategy
    }
  }
  return null;
}

function getOperationId(method: string, routePath: string): string {
  const normalizedPath = routePath
    .replace(/[{}]/g, "")
    .split("/")
    .filter(Boolean)
    .join("_");
  return `${method.toLowerCase()}_${normalizedPath || "root"}`;
}

function parseSecurityScopes(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return uniqueStrings(
    raw.flatMap((item) => {
      if (!item || typeof item !== "object") return [];
      return Object.values(item as Record<string, unknown>).flatMap((value) =>
        Array.isArray(value) ? value.map((scope) => String(scope ?? "")) : []
      );
    }),
    12
  );
}

function buildOperationDraft(context: SourceDocumentContext, input: {
  method: string;
  routePath: string;
  operationId?: string | null;
  summary?: string | null;
  description?: string | null;
  tags?: string[];
  authScopes?: string[];
  requestSchema?: Record<string, unknown>;
  responseSchema?: Record<string, unknown>;
  errorShapes?: Record<string, unknown>;
  sourceLocation?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}): OpenApiOperationDraft {
  const method = input.method.toUpperCase();
  const routePath = input.routePath.trim();
  const operationId = input.operationId?.trim() || getOperationId(method, routePath);
  return {
    id: stableUuidFromParts([context.knowledgeSpace, context.repoId, context.branch, context.buildVersion, context.path, method, routePath]),
    sourceDocId: context.docId,
    path: context.path,
    method,
    routePath,
    operationId,
    summary: input.summary?.trim() || null,
    description: input.description?.trim() || null,
    requestSchema: input.requestSchema ?? {},
    responseSchema: input.responseSchema ?? {},
    authScopes: uniqueStrings(input.authScopes ?? [], 24),
    tags: uniqueStrings(input.tags ?? [], 12),
    errorShapes: input.errorShapes ?? {},
    sourceLocation: input.sourceLocation ?? {},
    metadata: input.metadata ?? {}
  };
}

function parseOperationsFromStructuredSpec(context: SourceDocumentContext, spec: Record<string, unknown>): OpenApiOperationDraft[] {
  const paths = spec.paths;
  if (!paths || typeof paths !== "object") return [];
  const operations: OpenApiOperationDraft[] = [];
  for (const [routePath, methodsValue] of Object.entries(paths as Record<string, unknown>)) {
    if (!methodsValue || typeof methodsValue !== "object") continue;
    for (const [method, operationValue] of Object.entries(methodsValue as Record<string, unknown>)) {
      if (!/^(get|post|put|patch|delete|head|options)$/i.test(method)) continue;
      const operation = (operationValue ?? {}) as Record<string, unknown>;
      operations.push(
        buildOperationDraft(context, {
          method,
          routePath,
          operationId: String(operation.operationId ?? "") || null,
          summary: String(operation.summary ?? "") || null,
          description: String(operation.description ?? "") || null,
          tags: Array.isArray(operation.tags) ? operation.tags.map((tag) => String(tag ?? "")) : [],
          authScopes: parseSecurityScopes(operation.security ?? spec.security),
          requestSchema: (operation.requestBody as Record<string, unknown> | undefined) ?? {},
          responseSchema: (operation.responses as Record<string, unknown> | undefined) ?? {},
          errorShapes: {
            responses: Object.keys((operation.responses as Record<string, unknown> | undefined) ?? {}).filter((code) => /^4|5/.test(code))
          },
          sourceLocation: { routePath, method: method.toUpperCase() },
          metadata: {
            parser: "structured_openapi",
            specVersion: String(spec.openapi ?? spec.swagger ?? "")
          }
        })
      );
    }
  }
  return operations;
}

function parseInlineYamlList(value: string): string[] {
  const trimmed = value.trim();
  if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) return [];
  return uniqueStrings(
    trimmed
      .slice(1, -1)
      .split(",")
      .map((item) => item.replace(/^["']|["']$/g, "").trim())
      .filter(Boolean),
    24
  );
}

function parseOperationsFromYamlFallback(context: SourceDocumentContext, content: string): OpenApiOperationDraft[] {
  const lines = splitLines(content);
  const operations: OpenApiOperationDraft[] = [];
  let inPaths = false;
  let currentPath = "";
  let currentMethod = "";
  let operation: {
    summary?: string;
    description?: string;
    operationId?: string;
    tags: string[];
    authScopes: string[];
    line: number;
  } | null = null;

  const flushOperation = () => {
    if (!currentPath || !currentMethod || !operation) return;
    operations.push(
      buildOperationDraft(context, {
        method: currentMethod,
        routePath: currentPath,
        operationId: operation.operationId ?? null,
        summary: operation.summary ?? null,
        description: operation.description ?? null,
        tags: operation.tags,
        authScopes: operation.authScopes,
        sourceLocation: { lineStart: operation.line, routePath: currentPath, method: currentMethod.toUpperCase() },
        metadata: { parser: "yaml_fallback", degraded_quality: true }
      })
    );
    operation = null;
  };

  for (let index = 0; index < lines.length; index += 1) {
    const rawLine = lines[index];
    const trimmed = rawLine.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    if (/^paths:\s*$/i.test(trimmed)) {
      inPaths = true;
      continue;
    }
    if (!inPaths) continue;

    const indent = rawLine.match(/^\s*/)?.[0].length ?? 0;
    const pathMatch = /^([/][^:]+):\s*$/.exec(trimmed);
    if (indent <= 2 && pathMatch) {
      flushOperation();
      currentPath = pathMatch[1];
      currentMethod = "";
      continue;
    }

    const methodMatch = /^(get|post|put|patch|delete|head|options):\s*$/i.exec(trimmed);
    if (indent <= 4 && methodMatch) {
      flushOperation();
      currentMethod = methodMatch[1].toUpperCase();
      operation = { tags: [], authScopes: [], line: index + 1 };
      continue;
    }

    if (!operation) continue;
    const scalarMatch = /^([A-Za-z0-9_]+):\s*(.+?)\s*$/.exec(trimmed);
    if (scalarMatch) {
      const key = scalarMatch[1];
      const value = scalarMatch[2].replace(/^["']|["']$/g, "");
      if (key === "summary") operation.summary = value;
      if (key === "description") operation.description = value;
      if (key === "operationId") operation.operationId = value;
      if (key === "tags") operation.tags = parseInlineYamlList(value);
      continue;
    }

    const securityMatch = /^-\s*[A-Za-z0-9_-]+\s*:\s*\[(.*)\]\s*$/.exec(trimmed);
    if (securityMatch) {
      operation.authScopes = uniqueStrings(securityMatch[1].split(",").map((item) => item.trim().replace(/^["']|["']$/g, "")), 24);
    }
  }

  flushOperation();
  return operations;
}

function parseMethodEndpointComponent(content: string): { method: string; routePath: string } | null {
  const matched =
    /<MethodEndpoint[\s\S]*?method=\{["'`](get|post|put|patch|delete|head|options)["'`]\}[\s\S]*?path=\{["'`]([^"'`]+)["'`]\}/i.exec(content) ||
    /<MethodEndpoint[\s\S]*?path=\{["'`]([^"'`]+)["'`]\}[\s\S]*?method=\{["'`](get|post|put|patch|delete|head|options)["'`]\}/i.exec(content);
  if (!matched) return null;
  if (matched.length >= 3 && /^(get|post|put|patch|delete|head|options)$/i.test(matched[1] ?? "")) {
    return { method: matched[1], routePath: matched[2] };
  }
  if (matched.length >= 3) {
    return { method: matched[2], routePath: matched[1] };
  }
  return null;
}

export function parseOpenApiOperations(context: SourceDocumentContext): OpenApiOperationDraft[] {
  const structured =
    decodeEmbeddedOpenApiBlob(context.content) ||
    (safeJsonParse(context.content) as Record<string, unknown> | null);

  if (structured && (structured.openapi || structured.swagger)) {
    return parseOperationsFromStructuredSpec(context, structured);
  }

  const yamlFallback = parseOperationsFromYamlFallback(context, context.content);
  if (yamlFallback.length) return yamlFallback;

  const methodEndpoint = parseMethodEndpointComponent(context.content);
  if (methodEndpoint) {
    return [
      buildOperationDraft(context, {
        method: methodEndpoint.method,
        routePath: methodEndpoint.routePath,
        summary: summarizeText(context.title, 120),
        description: summarizeText(collapseWhitespace(context.content), 320),
        sourceLocation: { routePath: methodEndpoint.routePath, method: methodEndpoint.method.toUpperCase() },
        metadata: { parser: "mdx_method_endpoint", degraded_quality: true }
      })
    ];
  }

  const method = /(^|\n)\s*(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+([/A-Za-z0-9_{}:.-]+)/i.exec(context.content);
  if (!method) return [];

  return [
    buildOperationDraft(context, {
      method: method[2],
      routePath: method[3],
      summary: summarizeText(context.title, 120),
      description: summarizeText(collapseWhitespace(context.content), 320),
      sourceLocation: { lineStart: context.content.slice(0, method.index).split("\n").length, routePath: method[3], method: method[2].toUpperCase() },
      metadata: { parser: "markdown_openapi_fallback", degraded_quality: true }
    })
  ];
}
