import { splitLines, summarizeText } from "../knowledge-common.js";
import { stableUuidFromParts } from "../knowledge-common.js";
import type { CitationUnitDraft, SourceDocumentContext, TestBehaviorDraft } from "../knowledge-model.js";

function extractBlock(content: string, lineStart: number, lineEnd: number): string {
  return splitLines(content).slice(Math.max(0, lineStart - 1), Math.max(lineStart, lineEnd)).join("\n");
}

export function buildTestCitations(context: SourceDocumentContext, behaviors: TestBehaviorDraft[]): CitationUnitDraft[] {
  return behaviors.map((behavior) => {
    const lineStart = Number(behavior.sourceLocation.lineStart ?? 1);
    const lineEnd = Number(behavior.sourceLocation.lineEnd ?? lineStart);
    const sourceFamily =
      typeof context.metadata.source_family === "string" ? (context.metadata.source_family as CitationUnitDraft["sourceFamily"]) : "test_file";
    return {
      id: stableUuidFromParts([context.knowledgeSpace, context.repoId, context.branch, context.buildVersion, context.path, behavior.id]),
      sourceDocId: context.docId,
      citationFamily: "test_snippet",
      sourceFamily,
      sourceArtifactType: "kb_test_behaviors",
      sourceArtifactId: behavior.id,
      citationKey: behavior.id,
      path: context.path,
      title: behavior.title,
      headingPath: behavior.behaviorKey,
      snippetText: summarizeText(extractBlock(context.content, lineStart, lineEnd) || behavior.summary, 700),
      sourceLocation: behavior.sourceLocation,
      authority: {
        authority: sourceFamily === "openapi_spec" ? "repository_openapi_response_contract" : "repository_test",
        behavior_key: behavior.behaviorKey
      },
      metadata: { signals: behavior.signals }
    };
  });
}
