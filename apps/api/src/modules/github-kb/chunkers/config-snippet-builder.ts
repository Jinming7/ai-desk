import { splitLines, summarizeText } from "../knowledge-common.js";
import { stableUuidFromParts } from "../knowledge-common.js";
import type { CitationUnitDraft, ConfigSurfaceDraft, SourceDocumentContext } from "../knowledge-model.js";

function extractLine(content: string, lineNumber: number): string {
  return splitLines(content)[Math.max(0, lineNumber - 1)] ?? "";
}

export function buildConfigCitations(context: SourceDocumentContext, surfaces: ConfigSurfaceDraft[]): CitationUnitDraft[] {
  return surfaces.map((surface) => {
    const lineStart = Number(surface.sourceLocation.lineStart ?? 1);
    const snippet = extractLine(context.content, lineStart) || `${surface.configKey}=${surface.defaultValue ?? ""}`;
    return {
      id: stableUuidFromParts([context.knowledgeSpace, context.repoId, context.branch, context.buildVersion, context.path, surface.id]),
      sourceDocId: context.docId,
      citationFamily: "config_snippet",
      sourceFamily: "config_file",
      sourceArtifactType: "kb_config_surfaces",
      sourceArtifactId: surface.id,
      citationKey: surface.id,
      path: context.path,
      title: surface.configKey,
      headingPath: surface.configKey,
      snippetText: summarizeText(snippet, 400),
      sourceLocation: surface.sourceLocation,
      authority: { authority: "repository_config", config_kind: surface.configKind },
      metadata: { normalized_key: surface.normalizedKey }
    };
  });
}
