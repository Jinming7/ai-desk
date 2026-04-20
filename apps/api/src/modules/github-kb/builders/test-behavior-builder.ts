import { summarizeText, uniqueStrings } from "../knowledge-common.js";
import type { RetrievalUnitDraft, TestBehaviorDraft } from "../knowledge-model.js";

export function buildTestRetrievalUnits(behaviors: TestBehaviorDraft[], citationByArtifactId: Map<string, string>): RetrievalUnitDraft[] {
  return behaviors.flatMap((behavior) => {
    const citationId = citationByArtifactId.get(behavior.id);
    if (!citationId) return [];
    const metadata = behavior.metadata as Record<string, unknown>;
    const signals = Array.isArray((behavior.signals as Record<string, unknown>).signals)
      ? ((behavior.signals as Record<string, unknown>).signals as unknown[]).map((item) => String(item ?? ""))
      : [];
    return [
      {
        memoryKind: "behavior_rule",
        title: behavior.title,
        canonicalClaim: summarizeText(behavior.summary, 240),
        summary: summarizeText(behavior.summary, 320),
        productArea: typeof metadata.productArea === "string" ? metadata.productArea : "testing",
        docKind: typeof metadata.docKind === "string" ? metadata.docKind : "rules",
        actionType: null,
        deploymentModel: null,
        objectType: typeof metadata.objectType === "string" ? metadata.objectType : "test_behavior",
        aliases: uniqueStrings([behavior.title, behavior.behaviorKey]),
        signals: signals.map((signal) => ({ type: "signal", value: signal, weight: 0.82 })),
        citationIds: [citationId],
        metadata: {
          retrieval_unit_family: "behavior_rule_unit",
          assertions: behavior.assertions
        }
      }
    ];
  });
}
