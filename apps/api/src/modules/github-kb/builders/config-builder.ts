import { summarizeText, uniqueStrings } from "../knowledge-common.js";
import type { ConfigSurfaceDraft, RetrievalUnitDraft } from "../knowledge-model.js";

export function buildConfigRetrievalUnits(surfaces: ConfigSurfaceDraft[], citationByArtifactId: Map<string, string>): RetrievalUnitDraft[] {
  return surfaces.flatMap((surface) => {
    const citationId = citationByArtifactId.get(surface.id);
    if (!citationId) return [];
    return [
      {
        memoryKind: "config_surface",
        title: surface.configKey,
        canonicalClaim: summarizeText(`${surface.configKey}${surface.defaultValue ? ` defaults to ${surface.defaultValue}` : ""}`, 220),
        summary: summarizeText(
          [surface.description ?? "", surface.defaultValue ? `Default value: ${surface.defaultValue}` : ""].filter(Boolean).join(" "),
          280
        ),
        productArea: "configuration",
        docKind: "product_guide",
        actionType: "configure",
        deploymentModel: null,
        objectType: "config_key",
        aliases: uniqueStrings([surface.configKey, surface.normalizedKey]),
        signals: [
          { type: "config_key", value: surface.configKey, weight: 0.98 },
          { type: "env_var", value: surface.configKey, weight: surface.configKind === "env_var" ? 0.99 : 0.7 }
        ],
        citationIds: [citationId],
        metadata: {
          retrieval_unit_family: "config_surface_unit",
          config_kind: surface.configKind
        }
      }
    ];
  });
}
