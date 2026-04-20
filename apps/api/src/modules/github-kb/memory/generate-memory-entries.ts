import type { RetrievalUnitDraft, SourceDocumentContext } from "../knowledge-model.js";
import type { MemoryEntryDraft } from "../memory-types.js";
import { stableUuidFromParts, summarizeText } from "../knowledge-common.js";
import { generateAliases } from "./generate-aliases.js";
import { generateSignals } from "./generate-signals.js";

export function generateMemoryEntriesFromRetrievalUnits(
  context: SourceDocumentContext,
  retrievalUnits: RetrievalUnitDraft[]
): MemoryEntryDraft[] {
  return retrievalUnits
    .filter((unit) => unit.citationIds.length > 0)
    .map((unit, index) => ({
      id: stableUuidFromParts([
        context.knowledgeSpace,
        context.repoId,
        context.branch,
        context.buildVersion,
        context.path,
        unit.memoryKind,
        unit.title ?? unit.canonicalClaim,
        String(index)
      ]),
      repo_id: context.repoId,
      knowledge_space: context.knowledgeSpace,
      branch: context.branch,
      doc_id: context.docId,
      path: context.path,
      memory_kind: unit.memoryKind,
      title: unit.title,
      canonical_claim: summarizeText(unit.canonicalClaim, 280),
      summary: summarizeText(unit.summary, 360),
      product_area: unit.productArea,
      doc_kind: unit.docKind,
      action_type: unit.actionType,
      deployment_model: unit.deploymentModel,
      object_type: unit.objectType,
      is_static: true,
      build_version: context.buildVersion,
      metadata_json: {
        ...unit.metadata,
        source_family: context.metadata.source_family,
        grounded_citation_count: unit.citationIds.length
      },
      search_text: [unit.title ?? "", unit.canonicalClaim, unit.summary, ...unit.aliases, ...unit.signals.map((signal) => signal.value)].filter(Boolean).join(" "),
      aliases: generateAliases(unit.aliases),
      signals: generateSignals(unit.signals),
      sources: [],
      citations: unit.citationIds.map((citationId, citationIndex) => ({
        citation_id: citationId,
        source_score: Math.max(0.7, 1 - citationIndex * 0.1)
      }))
    }));
}
