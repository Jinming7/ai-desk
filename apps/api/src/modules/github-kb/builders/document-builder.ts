import { collapseWhitespace, splitLines, summarizeText, uniqueStrings } from "../knowledge-common.js";
import type { RetrievalUnitDraft } from "../knowledge-model.js";
import type { ParsedSection } from "../types.js";

interface MarkdownTable {
  headers: string[];
  rows: string[][];
}

function hasConstraintLanguage(lower: string): boolean {
  return /限制|constraint|not supported|unsupported|must|required?|requirements?|minimum|resource|capacity|quota|support matrix|compatibility|system requirements?|environment requirements?|supported operating systems?/.test(
    lower
  );
}

function isDeploymentSizingText(lower: string): boolean {
  return /(deployment|node|per-node|self-hosted|private deployment|resource requirements?|sizing|capacity|users?|tier)/.test(lower) &&
    /(cpu|memory|ram|disk|storage)/.test(lower);
}

function isLinuxSupportMatrixText(lower: string): boolean {
  return /(linux|ubuntu|centos|red hat|debian|uos|麒麟|operating system|server os|distribution)/.test(lower) &&
    /(support|supported|compatibility|matrix|requirements?)/.test(lower);
}

function inferDocMemoryKind(
  section: ParsedSection,
  docKind: string,
  supplementalText = ""
): RetrievalUnitDraft["memoryKind"] {
  const lower = `${section.title} ${section.content} ${supplementalText}`.toLowerCase();
  if (/troubleshoot|故障|报错|排查/.test(lower) || docKind === "troubleshooting") return "troubleshooting_pattern";
  if (/permission|scope|oauth|授权|权限/.test(lower)) return "permission_rule";
  if (/步骤|step|how to|configure|setup|install|创建|配置/.test(lower)) return "procedure";
  if (hasConstraintLanguage(lower) || docKind === "rules" || (docKind === "deployment_runbook" && isDeploymentSizingText(lower))) {
    return "constraint";
  }
  return "behavior_rule";
}

function inferActionType(section: ParsedSection): string | null {
  const match = /\b(create|update|delete|get|list|search|configure|deploy|install|reset|authorize)\b/i.exec(section.content);
  return match?.[1]?.toLowerCase() ?? null;
}

function inferObjectType(section: ParsedSection, supplementalText = ""): string | null {
  const lower = `${section.headingPath} ${section.title} ${section.content} ${supplementalText}`.toLowerCase();
  if (isDeploymentSizingText(lower)) return "deployment_node_sizing";
  if (isLinuxSupportMatrixText(lower)) return "linux distributions";
  const match = /\b(issue|comment|project|wiki|space|page|token|callback|webhook|field|deployment)\b/i.exec(
    `${section.title} ${section.content} ${supplementalText}`
  );
  return match?.[1]?.toLowerCase() ?? null;
}

function dedupeSignals(
  signals: Array<{ type: string; value: string; weight?: number }>,
  limit = 24
): Array<{ type: string; value: string; weight?: number }> {
  const seen = new Set<string>();
  const values: Array<{ type: string; value: string; weight?: number }> = [];

  for (const signal of signals) {
    const value = collapseWhitespace(signal.value);
    if (!value) continue;
    const key = `${signal.type}::${value.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    values.push({ ...signal, value });
    if (values.length >= limit) break;
  }

  return values;
}

function buildSectionSignals(
  section: ParsedSection,
  extraSignals: Array<{ type: string; value: string; weight?: number }> = []
): Array<{ type: string; value: string; weight?: number }> {
  return dedupeSignals(
    [
      ...extraSignals,
      ...uniqueStrings(
        [
          ...[...section.content.matchAll(/\b(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b/gi)].map((match) => String(match[1] ?? "").toUpperCase()),
          ...[...section.content.matchAll(/\/[A-Za-z0-9_./{}:-]+/g)].map((match) => match[0] ?? ""),
          ...[...section.content.matchAll(/\b(?:read|write):[A-Za-z0-9:_-]+\b/g)].map((match) => match[0] ?? "")
        ],
        10
      ).map((value) => ({
        type: value.startsWith("/") ? "api_path" : /^[A-Z]+$/.test(value) ? "http_method" : "scope",
        value,
        weight: 0.84
      }))
    ],
    18
  );
}

function splitTableCells(line: string): string[] {
  let normalized = line.trim();
  if (normalized.startsWith("|")) normalized = normalized.slice(1);
  if (normalized.endsWith("|")) normalized = normalized.slice(0, -1);
  return normalized.split("|").map((cell) => collapseWhitespace(cell));
}

function isMarkdownTableLine(line: string): boolean {
  const normalized = line.trim();
  return normalized.startsWith("|") && normalized.includes("|");
}

function isMarkdownDividerRow(cells: string[]): boolean {
  return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell.replace(/\s+/g, "")));
}

function parseMarkdownTables(content: string): MarkdownTable[] {
  const lines = splitLines(content);
  const tables: MarkdownTable[] = [];

  for (let index = 0; index < lines.length - 1; index += 1) {
    const headerLine = lines[index] ?? "";
    const dividerLine = lines[index + 1] ?? "";
    if (!isMarkdownTableLine(headerLine) || !isMarkdownTableLine(dividerLine)) continue;

    const headers = splitTableCells(headerLine);
    const dividerCells = splitTableCells(dividerLine);
    if (headers.length < 2 || headers.length !== dividerCells.length || !isMarkdownDividerRow(dividerCells)) continue;

    const rows: string[][] = [];
    let cursor = index + 2;
    while (cursor < lines.length && isMarkdownTableLine(lines[cursor] ?? "")) {
      const cells = splitTableCells(lines[cursor] ?? "");
      if (cells.length < headers.length) break;
      rows.push(cells.slice(0, headers.length));
      cursor += 1;
    }

    if (rows.length > 0) {
      tables.push({ headers, rows });
      index = cursor - 1;
    }
  }

  return tables;
}

function inferTableSubjectIndex(headers: string[]): number {
  const index = headers.findIndex((header) =>
    /\b(user|tier|plan|edition|environment|distribution|operating system|os|role|node type|scenario)\b/i.test(header)
  );
  return index >= 0 ? index : 0;
}

function formatHeaderValue(header: string, value: string): string {
  return `${collapseWhitespace(header)} ${collapseWhitespace(value)}`;
}

function buildTableRowSignals(
  headers: string[],
  row: string[],
  objectType: string | null
): Array<{ type: string; value: string; weight?: number }> {
  const subjectIndex = inferTableSubjectIndex(headers);
  const objectSignals = objectType ? [{ type: "object", value: objectType.replace(/_/g, " "), weight: 0.92 }] : [];
  const headerSignals = headers.map((header) => ({
    type: /cpu|memory|ram|disk|storage/i.test(header) ? "resource_dimension" : "table_column",
    value: header,
    weight: 0.82
  }));
  const valueSignals = row.map((value, index) => ({
    type:
      index === subjectIndex
        ? "table_subject"
        : /cpu|memory|ram|disk|storage/i.test(headers[index] ?? "")
        ? "resource_requirement"
        : "table_value",
    value,
    weight: 0.88
  }));

  return dedupeSignals([...objectSignals, ...headerSignals, ...valueSignals], 18);
}

function buildConstraintTableRowUnits(input: {
  section: ParsedSection;
  title: string;
  docKind: string;
  productArea: string;
  deploymentModel: string;
  citationId: string;
}): RetrievalUnitDraft[] {
  return parseMarkdownTables(input.section.content).flatMap((table) => {
    const supplementalText = table.headers.join(" ");
    const memoryKind = inferDocMemoryKind(input.section, input.docKind, supplementalText);
    const objectType = inferObjectType(input.section, supplementalText);
    if (memoryKind !== "constraint" && objectType !== "deployment_node_sizing" && objectType !== "linux distributions") {
      return [];
    }

    const subjectIndex = inferTableSubjectIndex(table.headers);
    return table.rows.flatMap((row) => {
      const subject = collapseWhitespace(row[subjectIndex] ?? row[0] ?? "");
      const facts = table.headers
        .map((header, index) => ({ header, value: collapseWhitespace(row[index] ?? "") }))
        .filter((pair) => pair.value.length > 0);
      if (!subject || facts.length === 0) return [];

      const canonicalPairs = facts.filter((_, index) => index !== subjectIndex);
      const canonicalClaim = summarizeText(
        canonicalPairs.length > 0
          ? `${input.section.title || input.title} for ${subject}: ${canonicalPairs.map((pair) => formatHeaderValue(pair.header, pair.value)).join("; ")}.`
          : `${input.section.title || input.title}: ${facts.map((pair) => formatHeaderValue(pair.header, pair.value)).join("; ")}.`,
        240
      );

      return [
        {
          memoryKind: "constraint",
          title: collapseWhitespace(`${input.section.title || input.title}: ${subject}`),
          canonicalClaim,
          summary: summarizeText(
            `${input.section.headingPath}: ${facts.map((pair) => formatHeaderValue(pair.header, pair.value)).join("; ")}`,
            340
          ),
          productArea: input.productArea,
          docKind: input.docKind,
          actionType: inferActionType(input.section),
          deploymentModel: input.deploymentModel,
          objectType,
          aliases: uniqueStrings(
            [
              input.section.title,
              input.title,
              ...input.section.headingPath.split(">"),
              subject,
              `${subject} ${input.section.title}`,
              ...table.headers
            ],
            18
          ),
          signals: buildTableRowSignals(table.headers, row, objectType),
          citationIds: [input.citationId],
          metadata: {
            retrieval_unit_family: "constraint_table_row_unit",
            heading_path: input.section.headingPath,
            table_subject: subject
          }
        }
      ];
    });
  });
}

function buildSectionRetrievalUnit(input: {
  section: ParsedSection;
  title: string;
  docKind: string;
  productArea: string;
  deploymentModel: string;
  citationId: string;
}): RetrievalUnitDraft {
  const memoryKind = inferDocMemoryKind(input.section, input.docKind);
  return {
    memoryKind,
    title: input.section.title || input.title,
    canonicalClaim: summarizeText(`${input.section.title}: ${collapseWhitespace(input.section.content)}`, 240),
    summary: summarizeText(collapseWhitespace(input.section.content), 340),
    productArea: input.productArea,
    docKind: input.docKind,
    actionType: inferActionType(input.section),
    deploymentModel: input.deploymentModel,
    objectType: inferObjectType(input.section),
    aliases: uniqueStrings([input.section.title, input.title, ...input.section.headingPath.split(">")]),
    signals: buildSectionSignals(input.section),
    citationIds: [input.citationId],
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
      heading_path: input.section.headingPath
    }
  };
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

    return [
      buildSectionRetrievalUnit({
        section,
        title: input.title,
        docKind: input.docKind,
        productArea: input.productArea,
        deploymentModel: input.deploymentModel,
        citationId
      }),
      ...buildConstraintTableRowUnits({
        section,
        title: input.title,
        docKind: input.docKind,
        productArea: input.productArea,
        deploymentModel: input.deploymentModel,
        citationId
      })
    ];
  });
}
