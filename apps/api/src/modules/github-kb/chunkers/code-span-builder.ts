import { splitLines, summarizeText } from "../knowledge-common.js";
import { stableUuidFromParts } from "../knowledge-common.js";
import type { CitationUnitDraft, CodeSymbolDraft, SourceDocumentContext } from "../knowledge-model.js";

function sliceLines(content: string, startLine: number, endLine: number): string {
  const lines = splitLines(content);
  return lines.slice(Math.max(0, startLine - 1), Math.max(startLine, endLine)).join("\n").trim();
}

function buildCitation(
  context: SourceDocumentContext,
  symbol: CodeSymbolDraft,
  kind: string,
  snippet: string,
  lineStart: number,
  lineEnd: number
): CitationUnitDraft {
  return {
    id: stableUuidFromParts([context.knowledgeSpace, context.repoId, context.branch, context.buildVersion, context.path, symbol.id, kind]),
    sourceDocId: context.docId,
    citationFamily: "code_symbol_span",
    sourceFamily: "code_file",
    sourceArtifactType: "kb_code_symbols",
    sourceArtifactId: symbol.id,
    citationKey: `${symbol.id}:${kind}`,
    path: context.path,
    title: `${symbol.symbolName} (${kind})`,
    headingPath: symbol.qualifiedName,
    snippetText: summarizeText(snippet, 900),
    sourceLocation: { lineStart, lineEnd, span_kind: kind },
    authority: { authority: "repository_code", symbol_kind: symbol.symbolKind },
    metadata: { symbol_kind: symbol.symbolKind, qualified_name: symbol.qualifiedName }
  };
}

export function buildCodeSymbolCitations(context: SourceDocumentContext, symbols: CodeSymbolDraft[]): CitationUnitDraft[] {
  const citations: CitationUnitDraft[] = [];
  for (const symbol of symbols) {
    const fullSpan = sliceLines(context.content, symbol.startLine, symbol.endLine);
    citations.push(buildCitation(context, symbol, "whole_symbol", fullSpan, symbol.startLine, symbol.endLine));
    citations.push(buildCitation(context, symbol, "signature", symbol.signatureText, symbol.startLine, symbol.startLine));
    if (symbol.docComment) {
      citations.push(buildCitation(context, symbol, "doc_comment", symbol.docComment, symbol.startLine, symbol.startLine));
    }
    if (symbol.endLine - symbol.startLine >= 12) {
      const logicSpan = sliceLines(context.content, symbol.startLine, Math.min(symbol.endLine, symbol.startLine + 11));
      citations.push(buildCitation(context, symbol, "logic_span", logicSpan, symbol.startLine, Math.min(symbol.endLine, symbol.startLine + 11)));
    }
  }
  return citations;
}
