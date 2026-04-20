import { collapseWhitespace, safeJsonParse, splitLines, uniqueStrings } from "../knowledge-common.js";
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

function parseSqlSchemaObjects(context: SourceDocumentContext): SchemaObjectDraft[] {
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

function looksLikeSchemaNode(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return ["type", "properties", "items", "allOf", "oneOf", "anyOf", "description", "title"].some((key) => key in record);
}

function summarizeSchemaDefinition(name: string, node: Record<string, unknown>): string {
  const type = typeof node.type === "string" ? node.type : "object";
  const description = typeof node.description === "string" ? node.description : "";
  const properties =
    node.properties && typeof node.properties === "object" && !Array.isArray(node.properties)
      ? Object.keys(node.properties as Record<string, unknown>).slice(0, 6)
      : [];
  return summarizeText(
    collapseWhitespace(
      [
        `Schema ${name}`,
        `type ${type}`,
        description,
        properties.length ? `properties ${properties.join(", ")}` : ""
      ]
        .filter(Boolean)
        .join(". ")
    ),
    320
  );
}

function findLineNumber(lines: string[], patterns: string[]): number {
  const index = lines.findIndex((line) => patterns.some((pattern) => line.includes(pattern)));
  return index >= 0 ? index + 1 : 1;
}

function buildStructuredSchemaObjects(
  context: SourceDocumentContext,
  name: string,
  node: Record<string, unknown>,
  line: number
): SchemaObjectDraft[] {
  const objects: SchemaObjectDraft[] = [
    buildSchemaObject(context, {
      objectKind: "schema",
      objectName: name,
      summary: summarizeSchemaDefinition(name, node),
      line,
      metadata: { parser: "structured_schema", degraded_quality: false }
    })
  ];

  const properties =
    node.properties && typeof node.properties === "object" && !Array.isArray(node.properties)
      ? (node.properties as Record<string, unknown>)
      : {};
  for (const [propertyName, propertyNode] of Object.entries(properties)) {
    const propertyDescription =
      propertyNode && typeof propertyNode === "object" && !Array.isArray(propertyNode)
        ? typeof (propertyNode as Record<string, unknown>).description === "string"
          ? String((propertyNode as Record<string, unknown>).description)
          : typeof (propertyNode as Record<string, unknown>).type === "string"
          ? `type ${(propertyNode as Record<string, unknown>).type}`
          : ""
        : "";
    objects.push(
      buildSchemaObject(context, {
        objectKind: "property",
        schemaName: name,
        objectName: propertyName,
        summary: propertyDescription || `Property ${propertyName} of ${name}`,
        relatedTables: [name],
        line,
        metadata: { parser: "structured_schema_property", degraded_quality: false }
      })
    );
  }

  return objects;
}

function parseSchemaObjectsFromStructuredData(context: SourceDocumentContext): SchemaObjectDraft[] {
  const parsed = safeJsonParse(context.content);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return [];

  const record = parsed as Record<string, unknown>;
  const lines = splitLines(context.content);
  const schemas: SchemaObjectDraft[] = [];
  const componentSchemas =
    record.components &&
    typeof record.components === "object" &&
    !Array.isArray(record.components) &&
    (record.components as Record<string, unknown>).schemas &&
    typeof (record.components as Record<string, unknown>).schemas === "object" &&
    !Array.isArray((record.components as Record<string, unknown>).schemas)
      ? ((record.components as Record<string, unknown>).schemas as Record<string, unknown>)
      : null;

  if (componentSchemas) {
    for (const [name, node] of Object.entries(componentSchemas)) {
      if (!looksLikeSchemaNode(node)) continue;
      schemas.push(
        ...buildStructuredSchemaObjects(context, name, node, findLineNumber(lines, [`"${name}"`, `${name}:`]))
      );
    }
    return schemas;
  }

  for (const [name, node] of Object.entries(record)) {
    if (!looksLikeSchemaNode(node)) continue;
    schemas.push(
      ...buildStructuredSchemaObjects(context, name, node, findLineNumber(lines, [`"${name}"`, `${name}:`]))
    );
  }
  return schemas;
}

function looksLikeSchemaBearingStructuredFile(context: SourceDocumentContext): boolean {
  const lower = context.path.toLowerCase();
  if (!/\.(ya?ml|json)$/i.test(lower)) return false;
  if (/(^|\/)(openapi|swagger)\//.test(lower) || lower.includes("/schemas")) return true;
  return /\bproperties:\s*$|\btype:\s+\w+|"properties"\s*:|"type"\s*:/.test(context.content);
}

function parseYamlSchemaObjects(context: SourceDocumentContext): SchemaObjectDraft[] {
  if (!looksLikeSchemaBearingStructuredFile(context)) return [];

  const rawLines = splitLines(context.content);
  const baselineIndent = rawLines
    .filter((line) => line.trim())
    .reduce<number>((current, line) => {
      const indent = line.match(/^\s*/)?.[0].length ?? 0;
      return current === -1 ? indent : Math.min(current, indent);
    }, -1);
  const lines =
    baselineIndent > 0
      ? rawLines.map((line) => {
          const indent = line.match(/^\s*/)?.[0].length ?? 0;
          return indent >= baselineIndent ? line.slice(baselineIndent) : line.trimStart();
        })
      : rawLines;
  const objects: SchemaObjectDraft[] = [];
  let inComponents = false;
  let componentsIndent = -1;
  let inSchemas = false;
  let schemasIndent = -1;
  let currentSchema: {
    name: string;
    indent: number;
    line: number;
    description: string;
    explicitType: string | null;
    hasProperties: boolean;
  } | null = null;
  let propertiesIndent = -1;

  const flushSchema = () => {
    if (!currentSchema) return;
    if (currentSchema.explicitType || currentSchema.hasProperties) {
      objects.push(
        buildSchemaObject(context, {
          objectKind: "schema",
          objectName: currentSchema.name,
          summary: summarizeText(
            collapseWhitespace(
              [
                `Schema ${currentSchema.name}`,
                currentSchema.explicitType ? `type ${currentSchema.explicitType}` : "",
                currentSchema.description
              ]
                .filter(Boolean)
                .join(". ")
            ),
            320
          ),
          line: currentSchema.line,
          metadata: { parser: "yaml_schema_fallback", degraded_quality: true }
        })
      );
    }
    currentSchema = null;
    propertiesIndent = -1;
  };

  for (let index = 0; index < lines.length; index += 1) {
    const rawLine = lines[index];
    const trimmed = rawLine.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const indent = rawLine.match(/^\s*/)?.[0].length ?? 0;
    if (currentSchema && indent <= currentSchema.indent && /^[A-Za-z0-9_.-]+:\s*$/.test(trimmed)) {
      flushSchema();
    }
    if (inSchemas && indent <= schemasIndent && !/^schemas:\s*$/.test(trimmed)) inSchemas = false;
    if (inComponents && indent <= componentsIndent && !/^components:\s*$/.test(trimmed)) {
      inComponents = false;
      inSchemas = false;
    }
    if (propertiesIndent >= 0 && indent <= propertiesIndent) propertiesIndent = -1;

    if (/^components:\s*$/i.test(trimmed)) {
      inComponents = true;
      componentsIndent = indent;
      inSchemas = false;
      continue;
    }
    if (inComponents && /^schemas:\s*$/i.test(trimmed)) {
      inSchemas = true;
      schemasIndent = indent;
      continue;
    }
    if (currentSchema && indent > currentSchema.indent && /^properties:\s*$/i.test(trimmed)) {
      currentSchema.hasProperties = true;
      propertiesIndent = indent;
      continue;
    }

    const blockMatch = /^([A-Za-z0-9_.-]+):\s*$/.exec(trimmed);
    if (blockMatch?.[1]) {
      if (currentSchema && propertiesIndent >= 0 && indent > propertiesIndent) {
        objects.push(
          buildSchemaObject(context, {
            objectKind: "property",
            schemaName: currentSchema.name,
            objectName: blockMatch[1],
            summary: `Property ${blockMatch[1]} of ${currentSchema.name}`,
            relatedTables: [currentSchema.name],
            line: index + 1,
            metadata: { parser: "yaml_schema_property_fallback", degraded_quality: true }
          })
        );
        continue;
      }

      const isSchemaDefinition = (inSchemas && indent > schemasIndent) || (!inComponents && indent === 0);
      if (isSchemaDefinition) {
        flushSchema();
        currentSchema = {
          name: blockMatch[1],
          indent,
          line: index + 1,
          description: "",
          explicitType: null,
          hasProperties: false
        };
      }
      continue;
    }

    if (!currentSchema || indent <= currentSchema.indent) continue;
    if (propertiesIndent >= 0 && indent > propertiesIndent) continue;

    const scalarMatch = /^([A-Za-z0-9_$.-]+):\s*(.+?)\s*$/.exec(trimmed);
    if (!scalarMatch) continue;
    const key = scalarMatch[1];
    const value = scalarMatch[2].replace(/^["']|["']$/g, "");
    if (key === "description") currentSchema.description = value;
    if (key === "type") currentSchema.explicitType = value;
  }

  flushSchema();
  return objects;
}

export function parseSchemaObjects(context: SourceDocumentContext): SchemaObjectDraft[] {
  const lower = context.path.toLowerCase();
  const objects = /\.(sql|ddl)$/i.test(lower) || /migrations?\//.test(lower)
    ? parseSqlSchemaObjects(context)
    : [...parseSchemaObjectsFromStructuredData(context), ...parseYamlSchemaObjects(context)];

  return objects.filter((item, index, all) => all.findIndex((candidate) => candidate.id === item.id) === index);
}
