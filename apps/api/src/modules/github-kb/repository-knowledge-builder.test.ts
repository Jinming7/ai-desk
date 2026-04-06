import assert from "node:assert/strict";
import { test } from "node:test";
import { buildRepositoryKnowledgeArtifacts } from "./builders/repository-knowledge-builder.js";
import { buildDocumentRetrievalUnits } from "./builders/document-builder.js";
import { buildDocChunkCitations } from "./chunkers/doc-citation-builder.js";
import { generateMemoryEntriesFromRetrievalUnits } from "./memory/generate-memory-entries.js";

const baseContext = {
  knowledgeSpace: "support-local" as const,
  repoId: "repo-1",
  branch: "main",
  buildVersion: "commit:run",
  commitSha: "commit",
  docId: "11111111-1111-5111-8111-111111111111",
  title: "Sample",
  metadata: {}
};

test("buildRepositoryKnowledgeArtifacts extracts openapi operations and grounded memory entries", () => {
  const result = buildRepositoryKnowledgeArtifacts({
    ...baseContext,
    path: "openapi/petstore.json",
    content: JSON.stringify({
      openapi: "3.0.0",
      paths: {
        "/project/issues/{issueID}": {
          put: {
            operationId: "updateIssue",
            summary: "Update an issue",
            description: "Update issue fields and status.",
            tags: ["issue"],
            security: [{ oauth: ["write:project:issue"] }],
            requestBody: { required: true },
            responses: { "200": { description: "ok" }, "403": { description: "forbidden" } }
          }
        }
      }
    })
  });

  assert.equal(result.classification.sourceFamily, "openapi_spec");
  assert.equal(result.openApiOperations.length, 1);
  assert.equal(result.citationUnits.some((item) => item.citationFamily === "openapi_operation_span"), true);
  assert.equal(result.memoryEntries.length >= 1, true);
  assert.equal(result.memoryEntries[0].citations?.length, 1);
});

test("buildRepositoryKnowledgeArtifacts extracts code symbols with code citations", () => {
  const result = buildRepositoryKnowledgeArtifacts({
    ...baseContext,
    path: "src/github/callback.ts",
    content: `
      export async function handleGithubCallback(code: string) {
        if (!code) throw new Error("page not found");
        return code.trim();
      }
    `
  });

  assert.equal(result.classification.sourceFamily, "code_file");
  assert.equal(result.codeSymbols.length >= 1, true);
  assert.equal(result.citationUnits.some((item) => item.citationFamily === "code_symbol_span"), true);
  assert.equal(result.memoryEntries.some((item) => item.memory_kind === "symbol_responsibility"), true);
});

test("buildRepositoryKnowledgeArtifacts only materializes high-signal top-level code symbols into memory", () => {
  const result = buildRepositoryKnowledgeArtifacts({
    ...baseContext,
    path: "src/github/callback.ts",
    content: `
      const INTERNAL_FLAG = "callback";

      class GithubCallbackService {
        handleGithubCallback(code: string) {
          return normalizeGithubCallback(code);
        }
      }

      export async function normalizeGithubCallback(code: string) {
        if (!code) throw new Error("page not found");
        return code.trim();
      }
    `
  });

  assert.equal(result.codeSymbols.some((item) => item.symbolKind === "constant"), true);
  assert.equal(result.codeSymbols.some((item) => item.symbolKind === "method"), true);
  assert.equal(result.codeSymbols.some((item) => item.symbolKind === "function"), true);

  const memoryTitles = result.memoryEntries.map((item) => item.title);
  assert.equal(memoryTitles.includes("INTERNAL_FLAG"), false);
  assert.equal(memoryTitles.includes("GithubCallbackService.handleGithubCallback"), false);
  assert.equal(memoryTitles.includes("GithubCallbackService"), true);
  assert.equal(memoryTitles.includes("normalizeGithubCallback"), true);
  assert.equal(result.memoryEntries.length, 2);
});

test("buildRepositoryKnowledgeArtifacts extracts config surfaces and schema objects", () => {
  const configResult = buildRepositoryKnowledgeArtifacts({
    ...baseContext,
    path: ".env.example",
    content: "OPENCLAW_BASE_URL=https://example.com\nOPENCLAW_TOKEN=secret"
  });
  assert.equal(configResult.configSurfaces.length, 2);
  assert.equal(configResult.memoryEntries[0]?.memory_kind, "config_surface");

  const schemaResult = buildRepositoryKnowledgeArtifacts({
    ...baseContext,
    path: "db/migrations/001_init.sql",
    content: `
      CREATE TABLE tickets (id UUID PRIMARY KEY, title TEXT NOT NULL);
      CREATE UNIQUE INDEX tickets_title_idx ON tickets(title);
      ALTER TABLE tickets ADD CONSTRAINT tickets_title_unique UNIQUE(title);
    `
  });
  assert.equal(schemaResult.schemaObjects.length >= 2, true);
  assert.equal(schemaResult.memoryEntries.some((item) => item.memory_kind === "schema_constraint"), true);

  const schemaLikeConfigResult = buildRepositoryKnowledgeArtifacts({
    ...baseContext,
    path: "open-docs/docs/openapi/source/common/no-200-response-schemas.yaml",
    content: `
      BadResponse401:
        description: Access token is invalid
        type: object
        properties:
          errorCode:
            type: string
          errorMsg:
            type: string
    `
  });
  assert.equal(schemaLikeConfigResult.classification.sourceFamily, "config_file");
  assert.equal(schemaLikeConfigResult.schemaObjects.some((item) => item.objectKind === "schema"), true);
  assert.equal(schemaLikeConfigResult.schemaObjects.some((item) => item.objectKind === "property"), true);
  assert.equal(schemaLikeConfigResult.memoryEntries.some((item) => item.memory_kind === "schema_constraint"), true);
});

test("buildRepositoryKnowledgeArtifacts extracts test behaviors", () => {
  const result = buildRepositoryKnowledgeArtifacts({
    ...baseContext,
    path: "src/modules/github-kb/service.test.ts",
    content: `
      test("github callback returns page not found when code is missing", async () => {
        assert.equal(await run(""), "page not found");
      });
    `
  });
  assert.equal(result.classification.sourceFamily, "test_file");
  assert.equal(result.testBehaviors.length, 1);
  assert.equal(result.memoryEntries.some((item) => item.memory_kind === "behavior_rule"), true);
});

test("document retrieval units always keep grounded citation mappings", () => {
  const sections = [
    {
      headingPath: "Setup > Configure callback",
      title: "Configure callback",
      content: "Configure the callback URL and redirect URI before authorizing the app.",
      order: 1
    }
  ];
  const citations = buildDocChunkCitations(
    {
      ...baseContext,
      path: "docs/oauth/setup.md",
      content: "Configure the callback URL and redirect URI before authorizing the app."
    },
    [
      {
        id: "chunk-1",
        headingPath: "Setup > Configure callback",
        content: "Configure the callback URL and redirect URI before authorizing the app.",
        metadata: { sectionTitle: "Configure callback", sectionOrder: 1 }
      }
    ]
  );
  const retrievalUnits = buildDocumentRetrievalUnits({
    sections,
    docKind: "product_guide",
    productArea: "openapi",
    deploymentModel: "shared",
    citationByHeading: new Map([[citations[0].headingPath ?? "ROOT", citations[0].id]]),
    title: "OAuth setup"
  });
  const memoryEntries = generateMemoryEntriesFromRetrievalUnits(
    {
      ...baseContext,
      path: "docs/oauth/setup.md",
      content: "Configure the callback URL and redirect URI before authorizing the app.",
      metadata: { source_family: "doc_page" }
    },
    retrievalUnits
  );

  assert.equal(retrievalUnits.length, 1);
  assert.equal(memoryEntries.length, 1);
  assert.deepEqual(memoryEntries[0].citations?.map((item) => item.citation_id), [citations[0].id]);
});
