import type { KbCitationFamily, KbCodeSymbolKind, KbKnowledgeSpace, KbSourceFamily } from "./types.js";
import type { KbMemoryKind, MemoryEntryDraft } from "./memory-types.js";
import type { ParsedSection } from "./types.js";

export interface SourceDocumentContext {
  knowledgeSpace: KbKnowledgeSpace;
  repoId: string;
  branch: string;
  buildVersion: string;
  commitSha: string;
  docId: string;
  path: string;
  title: string;
  content: string;
  metadata: Record<string, unknown>;
}

export interface SourceFamilyClassification {
  sourceFamily: KbSourceFamily;
  quality: "canonical" | "degraded";
  reason: string;
}

export interface ParsedDocKnowledge {
  sections: ParsedSection[];
  docKind: string;
  productArea: string;
  deploymentModel: string;
  aliases: string[];
}

export interface OpenApiOperationDraft {
  id: string;
  sourceDocId: string;
  path: string;
  method: string;
  routePath: string;
  operationId: string | null;
  summary: string | null;
  description: string | null;
  requestSchema: Record<string, unknown>;
  responseSchema: Record<string, unknown>;
  authScopes: string[];
  tags: string[];
  errorShapes: Record<string, unknown>;
  sourceLocation: Record<string, unknown>;
  metadata: Record<string, unknown>;
}

export interface CodeSymbolDraft {
  id: string;
  sourceDocId: string;
  path: string;
  language: string;
  symbolKind: KbCodeSymbolKind;
  symbolName: string;
  qualifiedName: string;
  parentSymbol: string | null;
  startLine: number;
  endLine: number;
  signatureText: string;
  docComment: string | null;
  bodySummary: string | null;
  dependencyRefs: Record<string, unknown>;
  metadata: Record<string, unknown>;
}

export interface ConfigSurfaceDraft {
  id: string;
  sourceDocId: string;
  path: string;
  configKind: string;
  configKey: string;
  normalizedKey: string;
  defaultValue: string | null;
  description: string | null;
  requiredFor: Record<string, unknown>;
  relatedComponents: Record<string, unknown>;
  sourceLocation: Record<string, unknown>;
  metadata: Record<string, unknown>;
}

export interface SchemaObjectDraft {
  id: string;
  sourceDocId: string;
  path: string;
  objectKind: string;
  schemaName: string | null;
  objectName: string;
  normalizedName: string;
  definitionSummary: string;
  relatedTables: Record<string, unknown>;
  sourceLocation: Record<string, unknown>;
  metadata: Record<string, unknown>;
}

export interface TestBehaviorDraft {
  id: string;
  sourceDocId: string;
  path: string;
  behaviorKey: string;
  title: string;
  summary: string;
  assertions: Record<string, unknown>;
  signals: Record<string, unknown>;
  sourceLocation: Record<string, unknown>;
  metadata: Record<string, unknown>;
}

export interface CitationUnitDraft {
  id: string;
  sourceDocId: string;
  citationFamily: KbCitationFamily;
  sourceFamily: KbSourceFamily;
  sourceArtifactType: string;
  sourceArtifactId: string | null;
  citationKey: string;
  path: string;
  title: string;
  headingPath: string | null;
  snippetText: string;
  sourceLocation: Record<string, unknown>;
  authority: Record<string, unknown>;
  metadata: Record<string, unknown>;
  embeddingText?: string | null;
}

export interface RetrievalUnitDraft {
  memoryKind: KbMemoryKind;
  title: string | null;
  canonicalClaim: string;
  summary: string;
  productArea: string;
  docKind: string;
  actionType: string | null;
  deploymentModel: string | null;
  objectType: string | null;
  aliases: string[];
  signals: Array<{ type: string; value: string; weight?: number }>;
  citationIds: string[];
  metadata: Record<string, unknown>;
}

export interface RepositoryKnowledgeBuildResult {
  classification: SourceFamilyClassification;
  docPage: ParsedDocKnowledge | null;
  openApiOperations: OpenApiOperationDraft[];
  codeSymbols: CodeSymbolDraft[];
  configSurfaces: ConfigSurfaceDraft[];
  schemaObjects: SchemaObjectDraft[];
  testBehaviors: TestBehaviorDraft[];
  citationUnits: CitationUnitDraft[];
  retrievalUnits: RetrievalUnitDraft[];
  memoryEntries: MemoryEntryDraft[];
}
