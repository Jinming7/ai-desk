import { collapseWhitespace, summarizeText, uniqueStrings } from "../knowledge-common.js";
import type { ParsedSection } from "../types.js";
import type { RetrievalUnitDraft } from "../knowledge-model.js";

function inferDocMemoryKind(section: ParsedSection, docKind: string): RetrievalUnitDraft["memoryKind"] {
  const lower = `${section.title} ${section.content}`.toLowerCase();
  if (/troubleshoot|故障|报错|排查/.test(lower) || docKind === "troubleshooting") return "troubleshooting_pattern";
  if (/permission|scope|oauth|授权|权限/.test(lower)) return "permission_rule";
  if (/步骤|step|how to|configure|setup|install|创建|配置/.test(lower)) return "procedure";
  if (/限制|constraint|not supported|unsupported|must/.test(lower) || docKind === "rules") return "constraint";
  return "behavior_rule";
}

function inferActionType(section: ParsedSection): string | null {
  const match = /\b(create|update|delete|get|list|search|configure|deploy|install|reset|authorize)\b/i.exec(section.content);
  return match?.[1]?.toLowerCase() ?? null;
}

function inferObjectType(section: ParsedSection): string | null {
  const match = /\b(issue|comment|project|wiki|space|page|token|callback|webhook|field|deployment)\b/i.exec(
    `${section.title} ${section.content}`
  );
  return match?.[1]?.toLowerCase() ?? null;
}

export function buildDocumentRetrievalUnits(input: {
  sections: ParsedSection[];
  docKind: string;
  productArea: string;
  deploymentModel: string;
  citationByHeading: Map<string, string>;
  title: string;
}): RetrievalUnitDraft[] {
  return input.sections.flatMap((section) => {
    const citationId = input.citationByHeading.get(section.headingPath);
    if (!citationId || !collapseWhitespace(section.content)) return [];
    const memoryKind = inferDocMemoryKind(section, input.docKind);
    return [
      {
        memoryKind,
        title: section.title || input.title,
        canonicalClaim: summarizeText(`${section.title}: ${collapseWhitespace(section.content)}`, 240),
        summary: summarizeText(collapseWhitespace(section.content), 340),
        productArea: input.productArea,
        docKind: input.docKind,
        actionType: inferActionType(section),
        deploymentModel: input.deploymentModel,
        objectType: inferObjectType(section),
        aliases: uniqueStrings([section.title, input.title, ...section.headingPath.split(">")]),
        signals: uniqueStrings(
          [
            ...[...section.content.matchAll(/\b(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b/gi)].map((match) => String(match[1] ?? "").toUpperCase()),
            ...[...section.content.matchAll(/\/[A-Za-z0-9_./{}:-]+/g)].map((match) => match[0] ?? ""),
            ...[...section.content.matchAll(/\b(?:read|write):[A-Za-z0-9:_-]+\b/g)].map((match) => match[0] ?? "")
          ],
          10
        ).map((value) => ({ type: value.startsWith("/") ? "api_path" : /^[A-Z]+$/.test(value) ? "http_method" : "scope", value, weight: 0.84 })),
        citationIds: [citationId],
        metadata: {
          retrieval_unit_family:
            memoryKind === "troubleshooting_pattern"
              ? "troubleshooting_pattern_unit"
              : memoryKind === "procedure"
              ? "procedure_unit"
              : memoryKind === "permission_rule"
              ? "permission_rule_unit"
              : memoryKind === "constraint"
              ? "schema_constraint_unit"
              : "behavior_rule_unit",
          heading_path: section.headingPath
        }
      }
    ];
  });
}
