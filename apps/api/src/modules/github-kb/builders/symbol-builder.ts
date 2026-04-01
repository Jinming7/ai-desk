import { summarizeText, uniqueStrings } from "../knowledge-common.js";
import type { CodeSymbolDraft, RetrievalUnitDraft } from "../knowledge-model.js";

export function buildSymbolRetrievalUnits(symbols: CodeSymbolDraft[], citationByArtifactId: Map<string, string>): RetrievalUnitDraft[] {
  return symbols.flatMap((symbol) => {
    const citationId = citationByArtifactId.get(symbol.id);
    if (!citationId) return [];
    return [
      {
        memoryKind: "symbol_responsibility",
        title: symbol.qualifiedName,
        canonicalClaim: summarizeText(
          `${symbol.qualifiedName} is a ${symbol.symbolKind}${symbol.bodySummary ? ` responsible for ${symbol.bodySummary}` : ""}`,
          260
        ),
        summary: summarizeText([symbol.docComment ?? "", symbol.bodySummary ?? ""].filter(Boolean).join(" "), 340),
        productArea: "repository_code",
        docKind: "rules",
        actionType: null,
        deploymentModel: null,
        objectType: symbol.symbolKind,
        aliases: uniqueStrings([symbol.symbolName, symbol.qualifiedName]),
        signals: [
          { type: "symbol_name", value: symbol.symbolName, weight: 0.95 },
          { type: "symbol_name", value: symbol.qualifiedName, weight: 0.99 }
        ],
        citationIds: [citationId],
        metadata: {
          retrieval_unit_family: "symbol_responsibility_unit",
          language: symbol.language
        }
      }
    ];
  });
}
