import { summarizeText, uniqueStrings } from "../knowledge-common.js";
import type { RetrievalUnitDraft, SchemaObjectDraft } from "../knowledge-model.js";

export function buildSchemaRetrievalUnits(objects: SchemaObjectDraft[], citationByArtifactId: Map<string, string>): RetrievalUnitDraft[] {
  return objects.flatMap((object) => {
    const citationId = citationByArtifactId.get(object.id);
    if (!citationId) return [];
    return [
      {
        memoryKind: "schema_constraint",
        title: object.objectName,
        canonicalClaim: summarizeText(`${object.objectKind} ${object.objectName}: ${object.definitionSummary}`, 240),
        summary: summarizeText(object.definitionSummary, 300),
        productArea: "schema",
        docKind: "rules",
        actionType: null,
        deploymentModel: null,
        objectType: object.objectKind,
        aliases: uniqueStrings([object.objectName, object.normalizedName]),
        signals: [
          { type: "table_name", value: object.objectName, weight: 0.9 },
          { type: "column_name", value: object.objectName, weight: object.objectKind === "column" ? 0.98 : 0.7 }
        ],
        citationIds: [citationId],
        metadata: {
          retrieval_unit_family: "schema_constraint_unit",
          related_tables: object.relatedTables
        }
      }
    ];
  });
}
