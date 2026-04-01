import { collapseWhitespace, splitLines, uniqueStrings } from "../knowledge-common.js";
import { stableUuidFromParts, summarizeText } from "../knowledge-common.js";
import type { SchemaObjectDraft, SourceDocumentContext } from "../knowledge-model.js";

function normalizeSchemaName(input: string): string | null {
  const trimmed = input.trim().replace(/^["']|["']$/g, "");
  if (!trimmed) return null;
  if (trimmed.includes(".")) return trimmed.split(".")[0] ?? null;
  return null;
}

function normalizeObjectName(input: string): string {
  return input.trim().replace(/^["']|["']$/g, "");
}

function buildSchemaObject(context: SourceDocumentContext, input: {
  objectKind: string;
  objectName: string;
  schemaName?: string | null;
  summary: string;
  relatedTables?: string[];
  line: number;
  metadata?: Record<string, unknown>;
}): SchemaObjectDraft {
  const objectName = normalizeObjectName(input.objectName);
  const schemaName = input.schemaName ?? normalizeSchemaName(input.objectName);
  const normalizedName = collapseWhitespace(`${schemaName ?? ""}.${objectName}`.replace(/^\./, "")).toLowerCase();
  return {
    id: stableUuidFromParts([context.knowledgeSpace, context.repoId, context.branch, context.buildVersion, context.path, input.objectKind, normalizedName]),
    sourceDocId: context.docId,
    path: context.path,
    objectKind: input.objectKind,
    schemaName,
    objectName,
    normalizedName,
    definitionSummary: summarizeText(input.summary, 320),
    relatedTables: { tables: uniqueStrings(input.relatedTables ?? [], 12) },
    sourceLocation: { lineStart: input.line, lineEnd: input.line },
    metadata: input.metadata ?? {}
  };
}

export function parseSchemaObjects(context: SourceDocumentContext): SchemaObjectDraft[] {
  const lines = splitLines(context.content);
  const objects: SchemaObjectDraft[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (!line) continue;

    const createTable = /^create\s+table\s+(?:if\s+not\s+exists\s+)?("?[\w.]+"?)/i.exec(line);
    if (createTable?.[1]) {
      objects.push(
        buildSchemaObject(context, {
          objectKind: "table",
          objectName: createTable[1],
          summary: line,
          line: index + 1,
          metadata: { parser: "sql_fallback", degraded_quality: true }
        })
      );
      continue;
    }

    const alterTable = /^alter\s+table\s+(?:if\s+exists\s+)?("?[\w.]+"?)\s+add\s+constraint\s+("?[\w.]+"?)/i.exec(line);
    if (alterTable?.[2]) {
      objects.push(
        buildSchemaObject(context, {
          objectKind: "constraint",
          objectName: alterTable[2],
          summary: line,
          relatedTables: [alterTable[1]],
          line: index + 1,
          metadata: { parser: "sql_fallback", degraded_quality: true }
        })
      );
      continue;
    }

    const createIndex = /^create\s+(?:unique\s+)?index\s+(?:if\s+not\s+exists\s+)?("?[\w.]+"?)\s+on\s+("?[\w.]+"?)/i.exec(line);
    if (createIndex?.[1]) {
      objects.push(
        buildSchemaObject(context, {
          objectKind: "index",
          objectName: createIndex[1],
          summary: line,
          relatedTables: [createIndex[2]],
          line: index + 1,
          metadata: { parser: "sql_fallback", degraded_quality: true }
        })
      );
      continue;
    }

    const column = /^("?[\w]+"?)\s+[A-Za-z0-9_()[\], ]+(?:not\s+null|null|default|references|primary\s+key|unique)/i.exec(line);
    if (column?.[1]) {
      const tableMatch = [...objects].reverse().find((item) => item.objectKind === "table");
      objects.push(
        buildSchemaObject(context, {
          objectKind: "column",
          objectName: column[1],
          summary: line,
          relatedTables: tableMatch ? [tableMatch.objectName] : [],
          line: index + 1,
          metadata: { parser: "sql_column_fallback", degraded_quality: true }
        })
      );
    }
  }

  return objects.filter((item, index, all) => all.findIndex((candidate) => candidate.id === item.id) === index);
}
