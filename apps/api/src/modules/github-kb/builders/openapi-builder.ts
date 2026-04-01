import { summarizeText, uniqueStrings } from "../knowledge-common.js";
import { stableUuidFromParts } from "../knowledge-common.js";
import type { CitationUnitDraft, OpenApiOperationDraft, RetrievalUnitDraft, SourceDocumentContext } from "../knowledge-model.js";

export function buildOpenApiCitations(context: SourceDocumentContext, operations: OpenApiOperationDraft[]): CitationUnitDraft[] {
  return operations.map((operation) => {
    const snippet = [
      `${operation.method} ${operation.routePath}`.trim(),
      operation.summary ?? "",
      operation.description ?? "",
      operation.authScopes.length ? `Scopes: ${operation.authScopes.join(", ")}` : ""
    ]
      .filter(Boolean)
      .join(". ");
    return {
      id: stableUuidFromParts([context.knowledgeSpace, context.repoId, context.branch, context.buildVersion, context.path, operation.id, "citation"]),
      sourceDocId: context.docId,
      citationFamily: "openapi_operation_span",
      sourceFamily: "openapi_spec",
      sourceArtifactType: "kb_openapi_operations",
      sourceArtifactId: operation.id,
      citationKey: operation.id,
      path: context.path,
      title: `${operation.method} ${operation.routePath}`,
      headingPath: operation.operationId ?? operation.routePath,
      snippetText: summarizeText(snippet, 600),
      sourceLocation: operation.sourceLocation,
      authority: { authority: "openapi", method: operation.method, route_path: operation.routePath },
      metadata: {
        operation_id: operation.operationId,
        tags: operation.tags
      }
    };
  });
}

export function buildOpenApiRetrievalUnits(operations: OpenApiOperationDraft[], citationByArtifactId: Map<string, string>): RetrievalUnitDraft[] {
  return operations.flatMap((operation) => {
    const citationId = citationByArtifactId.get(operation.id);
    if (!citationId) return [];
    const baseAliases = uniqueStrings([
      operation.operationId ?? "",
      `${operation.method} ${operation.routePath}`,
      operation.routePath,
      ...operation.tags
    ]);
    const apiUnit: RetrievalUnitDraft = {
      memoryKind: "api_operation",
      title: `${operation.method} ${operation.routePath}`,
      canonicalClaim: summarizeText(
        `${operation.method} ${operation.routePath}${operation.summary ? `: ${operation.summary}` : ""}${operation.description ? ` ${operation.description}` : ""}`,
        240
      ),
      summary: summarizeText(
        [
          operation.summary ?? "",
          operation.description ?? "",
          operation.authScopes.length ? `Required scopes: ${operation.authScopes.join(", ")}` : ""
        ]
          .filter(Boolean)
          .join(" "),
        360
      ),
      productArea: "openapi",
      docKind: "openapi/api",
      actionType: operation.method.toLowerCase(),
      deploymentModel: null,
      objectType: operation.routePath.split("/").filter(Boolean).slice(-1)[0] ?? "api",
      aliases: baseAliases,
      signals: [
        { type: "http_method", value: operation.method, weight: 0.96 },
        { type: "api_path", value: operation.routePath, weight: 0.99 },
        ...operation.authScopes.map((scope) => ({ type: "scope", value: scope, weight: 0.98 }))
      ],
      citationIds: [citationId],
      metadata: {
        retrieval_unit_family: "api_operation_unit",
        tags: operation.tags
      }
    };
    const permissionUnit: RetrievalUnitDraft | null = operation.authScopes.length
      ? {
          memoryKind: "permission_rule",
          title: `${operation.method} ${operation.routePath} permissions`,
          canonicalClaim: `${operation.method} ${operation.routePath} requires ${operation.authScopes.join(", ")}`,
          summary: summarizeText(`Required scopes: ${operation.authScopes.join(", ")}`, 240),
          productArea: "openapi",
          docKind: "openapi/api",
          actionType: "authorize",
          deploymentModel: null,
          objectType: "scope",
          aliases: uniqueStrings([...baseAliases, ...operation.authScopes]),
          signals: operation.authScopes.map((scope) => ({ type: "scope", value: scope, weight: 0.99 })),
          citationIds: [citationId],
          metadata: {
            retrieval_unit_family: "permission_rule_unit",
            operation_id: operation.operationId
          }
        }
      : null;
    return permissionUnit ? [apiUnit, permissionUnit] : [apiUnit];
  });
}
