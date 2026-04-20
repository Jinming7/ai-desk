import { stableUuidFromParts } from "../knowledge-common.js";
import { summarizeText } from "../knowledge-common.js";
import type { CitationUnitDraft, SourceDocumentContext } from "../knowledge-model.js";

export function buildDocChunkCitations(
  context: SourceDocumentContext,
  chunks: Array<{ id: string; headingPath: string; content: string; metadata: Record<string, unknown> }>,
  sourceFamily: "doc_page" | "openapi_spec" | "runbook_file" = "doc_page"
): CitationUnitDraft[] {
  return chunks.map((chunk) => ({
    id: stableUuidFromParts([context.knowledgeSpace, context.repoId, context.branch, context.buildVersion, context.path, chunk.id]),
    sourceDocId: context.docId,
    citationFamily: "doc_chunk",
    sourceFamily,
    sourceArtifactType: "kb_chunks",
    sourceArtifactId: null,
    citationKey: chunk.id,
    path: context.path,
    title: String(chunk.metadata.sectionTitle ?? context.title),
    headingPath: chunk.headingPath,
    snippetText: summarizeText(chunk.content, 900),
    sourceLocation: {
      heading_path: chunk.headingPath,
      section_order: chunk.metadata.sectionOrder ?? null
    },
    authority: { authority: "documentation" },
    metadata: {
      chunk_id: chunk.id,
      chunk_metadata: chunk.metadata
    }
  }));
}
