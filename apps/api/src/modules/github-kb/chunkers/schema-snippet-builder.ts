import { splitLines, summarizeText } from "../knowledge-common.js";
import { stableUuidFromParts } from "../knowledge-common.js";
import type { CitationUnitDraft, SchemaObjectDraft, SourceDocumentContext } from "../knowledge-model.js";

function extractLine(content: string, lineNumber: number): string {
  return splitLines(content)[Math.max(0, lineNumber - 1)] ?? "";
}

export function buildSchemaCitations(context: SourceDocumentContext, objects: SchemaObjectDraft[]): CitationUnitDraft[] {
  return objects.map((object) => {
    const lineStart = Number(object.sourceLocation.lineStart ?? 1);
    return {
      id: stableUuidFromParts([context.knowledgeSpace, context.repoId, context.branch, context.buildVersion, context.path, object.id]),
      sourceDocId: context.docId,
      citationFamily: "sql_snippet",
      sourceFamily: "schema_file",
      sourceArtifactType: "kb_schema_objects",
      sourceArtifactId: object.id,
      citationKey: object.id,
      path: context.path,
      title: object.objectName,
      headingPath: object.objectKind,
      snippetText: summarizeText(extractLine(context.content, lineStart) || object.definitionSummary, 420),
      sourceLocation: object.sourceLocation,
      authority: { authority: "repository_schema", object_kind: object.objectKind },
      metadata: { normalized_name: object.normalizedName }
    };
  });
}
