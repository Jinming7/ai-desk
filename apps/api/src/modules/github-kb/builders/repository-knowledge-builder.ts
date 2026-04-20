import type { RepositoryKnowledgeBuildResult, SourceDocumentContext } from "../knowledge-model.js";
import { parseDocPage } from "../parsers/docs-parser.js";
import { parseOpenApiOperations } from "../parsers/openapi-parser.js";
import { parseCodeSymbols } from "../parsers/code-parser.js";
import { parseConfigSurfaces } from "../parsers/config-parser.js";
import { parseSchemaObjects } from "../parsers/schema-parser.js";
import { parseOpenApiResponseContractBehaviors, parseTestBehaviors } from "../parsers/test-parser.js";
import { classifySourceFamily } from "../parsers/source-classifier.js";
import { buildOpenApiCitations, buildOpenApiRetrievalUnits } from "./openapi-builder.js";
import { buildCodeSymbolCitations } from "../chunkers/code-span-builder.js";
import { buildConfigCitations } from "../chunkers/config-snippet-builder.js";
import { buildSchemaCitations } from "../chunkers/schema-snippet-builder.js";
import { buildTestCitations } from "../chunkers/test-snippet-builder.js";
import { buildConfigRetrievalUnits } from "./config-builder.js";
import { buildSymbolRetrievalUnits } from "./symbol-builder.js";
import { buildSchemaRetrievalUnits } from "./schema-builder.js";
import { buildTestRetrievalUnits } from "./test-behavior-builder.js";
import { generateMemoryEntriesFromRetrievalUnits } from "../memory/generate-memory-entries.js";

export function buildRepositoryKnowledgeArtifacts(context: SourceDocumentContext): RepositoryKnowledgeBuildResult {
  const classification = classifySourceFamily(context.path, context.content);
  const groundedContext = {
    ...context,
    metadata: {
      ...context.metadata,
      source_family: classification.sourceFamily
    }
  };
  const docPage = classification.sourceFamily === "doc_page" || classification.sourceFamily === "runbook_file" || classification.sourceFamily === "openapi_spec"
    ? parseDocPage(context.path, context.title, context.content)
    : null;
  const openApiOperations = classification.sourceFamily === "openapi_spec" ? parseOpenApiOperations(context) : [];
  const codeSymbols = classification.sourceFamily === "code_file" ? parseCodeSymbols(context) : [];
  const configSurfaces = classification.sourceFamily === "config_file" ? parseConfigSurfaces(context) : [];
  const schemaObjects =
    classification.sourceFamily === "schema_file" ||
    classification.sourceFamily === "openapi_spec" ||
    classification.sourceFamily === "config_file"
      ? parseSchemaObjects(groundedContext)
      : [];
  const testBehaviors =
    classification.sourceFamily === "test_file"
      ? parseTestBehaviors(context)
      : classification.sourceFamily === "openapi_spec"
      ? parseOpenApiResponseContractBehaviors(groundedContext, openApiOperations)
      : [];

  const citationUnits = [
    ...buildOpenApiCitations(groundedContext, openApiOperations),
    ...buildCodeSymbolCitations(groundedContext, codeSymbols),
    ...buildConfigCitations(groundedContext, configSurfaces),
    ...buildSchemaCitations(groundedContext, schemaObjects),
    ...buildTestCitations(groundedContext, testBehaviors)
  ];
  const citationByArtifactId = new Map<string, string>();
  for (const citation of citationUnits) {
    if (citation.sourceArtifactId) citationByArtifactId.set(citation.sourceArtifactId, citation.id);
  }

  const retrievalUnits = [
    ...buildOpenApiRetrievalUnits(openApiOperations, citationByArtifactId),
    ...buildConfigRetrievalUnits(configSurfaces, citationByArtifactId),
    ...buildSymbolRetrievalUnits(codeSymbols, citationByArtifactId),
    ...buildSchemaRetrievalUnits(schemaObjects, citationByArtifactId),
    ...buildTestRetrievalUnits(testBehaviors, citationByArtifactId)
  ];

  const memoryEntries = generateMemoryEntriesFromRetrievalUnits(
    groundedContext,
    retrievalUnits
  );

  return {
    classification,
    docPage,
    openApiOperations,
    codeSymbols,
    configSurfaces,
    schemaObjects,
    testBehaviors,
    citationUnits,
    retrievalUnits,
    memoryEntries
  };
}
