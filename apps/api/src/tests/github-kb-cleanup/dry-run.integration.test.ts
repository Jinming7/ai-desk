import assert from "node:assert/strict";
import { after, test } from "node:test";
import type { AddressInfo } from "node:net";
import "../helpers/fetch-polyfill.js";
import { app } from "../../app.js";
import { env, isSafeTestDatabaseUrl } from "../../config/env.js";
import { pool } from "../../db/client.js";
import * as githubRepo from "../../modules/github-kb/repository.js";
import { formatLocalDbBlockedMessage, probeLocalDbReadiness } from "../helpers/local-db-readiness.js";

function assertSafeTestDatabase() {
  const url = process.env.DATABASE_URL ?? env.DATABASE_URL;
  if (!isSafeTestDatabaseUrl(url)) {
    throw new Error("Refusing to run cleanup integration tests against a non-local database");
  }
}

async function resetKbDb() {
  await pool.query("DELETE FROM kb_build_validation_results");
  await pool.query("DELETE FROM kb_ingest_leases");
  await pool.query("DELETE FROM kb_publications");
  await pool.query("DELETE FROM kb_builds");
  await pool.query("DELETE FROM kb_memory_citations");
  await pool.query("DELETE FROM kb_citation_units");
  await pool.query("DELETE FROM kb_openapi_operations");
  await pool.query("DELETE FROM kb_code_symbols");
  await pool.query("DELETE FROM kb_config_surfaces");
  await pool.query("DELETE FROM kb_schema_objects");
  await pool.query("DELETE FROM kb_test_behaviors");
  await pool.query("DELETE FROM kb_memory_profiles");
  await pool.query("DELETE FROM kb_memory_relations");
  await pool.query("DELETE FROM kb_memory_aliases");
  await pool.query("DELETE FROM kb_memory_signals");
  await pool.query("DELETE FROM kb_memory_sources");
  await pool.query("DELETE FROM kb_memory_entries");
  await pool.query("DELETE FROM kb_chunks");
  await pool.query("DELETE FROM kb_documents");
  await pool.query("DELETE FROM kb_serving_versions");
  await pool.query("DELETE FROM kb_sync_manifest_items");
  await pool.query("DELETE FROM kb_sync_run_shards");
  await pool.query("DELETE FROM kb_sync_runs");
  await pool.query("DELETE FROM kb_sync_jobs");
  await pool.query("DELETE FROM kb_sync_checkpoints");
  await pool.query("DELETE FROM kb_github_webhook_events");
  await pool.query("DELETE FROM kb_metrics_events");
  await pool.query("DELETE FROM kb_repo_registrations");
}

async function createRegistration() {
  return githubRepo.upsertRepoRegistration({
    repoOwner: "acme",
    repoName: "ticket-kb",
    repoUrl: "mock://acme/ticket-kb",
    defaultBranch: "main",
    includePaths: ["docs/*.md", "docs/**/*.md"],
    excludePaths: [],
    pollingIntervalSeconds: 60,
    createdBy: "test"
  });
}

async function createBuild(input: {
  repoId: string;
  knowledgeSpace?: "support-prod" | "support-preview" | "support-local" | "support-shadow" | "support-eval";
  buildVersion: string;
  targetHead: string;
  status: "failed" | "validated" | "published" | "superseded";
}) {
  const build = await githubRepo.ensureBuild({
    knowledgeSpace: input.knowledgeSpace ?? "support-local",
    repoId: input.repoId,
    branch: "main",
    buildVersion: input.buildVersion,
    targetHead: input.targetHead,
    buildKind: "full",
    requestedBy: "test",
    requestedFromEnv: "local",
    sourceSnapshotTotal: 1
  });
  const updated = await githubRepo.updateBuildStatus({
    buildId: build.id,
    status: input.status,
    validationPassed: input.status !== "failed",
    validationSummary: { checks: [] },
    finished: true
  });
  assert.ok(updated);
  return updated;
}

async function seedFailedArtifacts(repoId: string, buildVersion: string) {
  const docOne = await githubRepo.upsertDocument({
    repoId,
    knowledgeSpace: "support-local",
    branch: "main",
    path: "docs/failed-one.md",
    buildVersion,
    title: "Failed One",
    sourceUrl: "https://docs.example.com/failed-one",
    repoSourceUrl: "https://github.com/acme/ticket-kb/blob/main/docs/failed-one.md",
    publicSourceUrl: "https://docs.example.com/failed-one",
    commitSha: buildVersion,
    contentHash: "hash-doc-one",
    content: "failure doc one",
    metadata: { sourceFamily: "doc_page", sourceFamilyQuality: "canonical" }
  });
  const docTwo = await githubRepo.upsertDocument({
    repoId,
    knowledgeSpace: "support-local",
    branch: "main",
    path: "docs/failed-two.md",
    buildVersion,
    title: "Failed Two",
    sourceUrl: "https://docs.example.com/failed-two",
    repoSourceUrl: "https://github.com/acme/ticket-kb/blob/main/docs/failed-two.md",
    publicSourceUrl: "https://docs.example.com/failed-two",
    commitSha: buildVersion,
    contentHash: "hash-doc-two",
    content: "failure doc two",
    metadata: { sourceFamily: "doc_page", sourceFamilyQuality: "canonical" }
  });

  await githubRepo.upsertChunk({
    id: "failed-chunk-1",
    docId: docOne.id,
    repoId,
    knowledgeSpace: "support-local",
    branch: "main",
    path: docOne.path,
    buildVersion,
    commitSha: buildVersion,
    headingPath: "ROOT",
    ordinal: 0,
    content: "chunk one",
    contentHash: "hash-chunk-one",
    tokenCount: 2,
    metadata: {},
    embedding: null,
    embeddingModel: null,
    embeddingVersion: null
  });
  await githubRepo.upsertChunk({
    id: "failed-chunk-2",
    docId: docOne.id,
    repoId,
    knowledgeSpace: "support-local",
    branch: "main",
    path: docOne.path,
    buildVersion,
    commitSha: buildVersion,
    headingPath: "ROOT/Part 2",
    ordinal: 1,
    content: "chunk two",
    contentHash: "hash-chunk-two",
    tokenCount: 2,
    metadata: {},
    embedding: null,
    embeddingModel: null,
    embeddingVersion: null
  });
  await githubRepo.upsertChunk({
    id: "failed-chunk-3",
    docId: docTwo.id,
    repoId,
    knowledgeSpace: "support-local",
    branch: "main",
    path: docTwo.path,
    buildVersion,
    commitSha: buildVersion,
    headingPath: "ROOT",
    ordinal: 0,
    content: "chunk three",
    contentHash: "hash-chunk-three",
    tokenCount: 2,
    metadata: {},
    embedding: null,
    embeddingModel: null,
    embeddingVersion: null
  });
}

async function withDbHarness<T>(
  t: { skip: (reason?: string) => void },
  fn: (context: { baseUrl: string }) => Promise<T>
): Promise<T | undefined> {
  const readiness = await probeLocalDbReadiness({
    pool,
    databaseUrl: process.env.DATABASE_URL ?? env.DATABASE_URL,
    isSafeTestDatabaseUrl
  });
  if (readiness.kind === "blocked") {
    if (readiness.reason === "unsafe_database") {
      throw new Error(readiness.detail);
    }
    t.skip(formatLocalDbBlockedMessage("github-kb-cleanup/dry-run.integration", readiness));
    return undefined;
  }

  await resetKbDb();
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const { port } = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    return await fn({ baseUrl });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

after(async () => {
  await pool.end();
});

test("cleanup dry-run endpoint reports protected builds and candidate row counts", async (t) => {
  await withDbHarness(t, async ({ baseUrl }) => {
    const registration = await createRegistration();
    const rollbackBuild = await createBuild({
      repoId: registration.id,
      buildVersion: "build-rollback",
      targetHead: "sha-rollback",
      status: "superseded"
    });
    const currentBuild = await createBuild({
      repoId: registration.id,
      buildVersion: "build-current",
      targetHead: "sha-current",
      status: "published"
    });
    const failedBuild = await createBuild({
      repoId: registration.id,
      buildVersion: "build-failed",
      targetHead: "sha-failed",
      status: "failed"
    });
    await seedFailedArtifacts(registration.id, failedBuild.build_version);

    await githubRepo.upsertPublication({
      knowledgeSpace: "support-local",
      repoId: registration.id,
      branch: "main",
      publishedBuildVersion: currentBuild.build_version,
      publishedHead: currentBuild.target_head,
      publishedBy: "test",
      publishedFromEnv: "local"
    });
    await githubRepo.upsertServingVersion({
      repoId: registration.id,
      branch: "main",
      activeBuildVersion: currentBuild.build_version,
      activeHead: currentBuild.target_head
    });

    const response = await fetch(
      `${baseUrl}/api/v1/internal/kb/cleanup/dry-run?repoId=${encodeURIComponent(registration.id)}&branch=main&knowledgeSpace=support-local`,
      {
        headers: {
          "x-portal-surface": "internal"
        }
      }
    );

    assert.equal(response.status, 200);
    const body = (await response.json()) as {
      result: {
        aggregate: {
          directCandidates: { totalBuilds: number; rowsByTable: { kb_documents: number; kb_chunks: number } };
        };
        protectedBuilds: Array<{ buildId: string }>;
        scopes: Array<{
          publication: { publishedBuildVersion: string } | null;
          rollback: { publicationTarget: { buildVersion: string } | null };
        }>;
      };
    };

    assert.equal(body.result.aggregate.directCandidates.totalBuilds, 1);
    assert.equal(body.result.aggregate.directCandidates.rowsByTable.kb_documents, 2);
    assert.equal(body.result.aggregate.directCandidates.rowsByTable.kb_chunks, 3);
    assert.equal(body.result.scopes[0]?.publication?.publishedBuildVersion, currentBuild.build_version);
    assert.equal(body.result.scopes[0]?.rollback.publicationTarget?.buildVersion, rollbackBuild.build_version);
    assert.equal(body.result.protectedBuilds.some((item) => item.buildId === currentBuild.id), true);
    assert.equal(body.result.protectedBuilds.some((item) => item.buildId === rollbackBuild.id), true);
  });
});

test("cleanup dry-run keeps publication-scoped rollback truth when legacy serving metadata is ambiguous across knowledge spaces", async (t) => {
  await withDbHarness(t, async ({ baseUrl }) => {
    const registration = await createRegistration();
    const localRollback = await createBuild({
      repoId: registration.id,
      knowledgeSpace: "support-local",
      buildVersion: "build-local-prev",
      targetHead: "sha-local-prev",
      status: "superseded"
    });
    const localCurrent = await createBuild({
      repoId: registration.id,
      knowledgeSpace: "support-local",
      buildVersion: "build-local-current",
      targetHead: "sha-local-current",
      status: "published"
    });
    const previewRollback = await createBuild({
      repoId: registration.id,
      knowledgeSpace: "support-preview",
      buildVersion: "build-preview-prev",
      targetHead: "sha-preview-prev",
      status: "superseded"
    });
    const previewCurrent = await createBuild({
      repoId: registration.id,
      knowledgeSpace: "support-preview",
      buildVersion: "build-preview-current",
      targetHead: "sha-preview-current",
      status: "published"
    });

    await githubRepo.upsertPublication({
      knowledgeSpace: "support-local",
      repoId: registration.id,
      branch: "main",
      publishedBuildVersion: localCurrent.build_version,
      publishedHead: localCurrent.target_head,
      publishedBy: "test",
      publishedFromEnv: "local"
    });
    await githubRepo.upsertPublication({
      knowledgeSpace: "support-preview",
      repoId: registration.id,
      branch: "main",
      publishedBuildVersion: previewCurrent.build_version,
      publishedHead: previewCurrent.target_head,
      publishedBy: "test",
      publishedFromEnv: "preview"
    });
    await githubRepo.upsertServingVersion({
      repoId: registration.id,
      branch: "main",
      activeBuildVersion: localCurrent.build_version,
      activeHead: localCurrent.target_head
    });

    const response = await fetch(
      `${baseUrl}/api/v1/internal/kb/cleanup/dry-run?repoId=${encodeURIComponent(registration.id)}&branch=main`,
      {
        headers: {
          "x-portal-surface": "internal"
        }
      }
    );

    assert.equal(response.status, 200);
    const body = (await response.json()) as {
      result: {
        blockers: string[];
        scopes: Array<{
          knowledgeSpace: string;
          publication: { publishedBuildVersion: string } | null;
          serving: {
            source: string;
            comparisonToPublication: string;
            consistentWithPublication: boolean | null;
          } | null;
          rollback: { publicationTarget: { buildVersion: string } | null };
        }>;
      };
    };
    const localScope = body.result.scopes.find((scope) => scope.knowledgeSpace === "support-local");
    const previewScope = body.result.scopes.find((scope) => scope.knowledgeSpace === "support-preview");

    assert.ok(localScope);
    assert.ok(previewScope);
    assert.equal(localScope?.publication?.publishedBuildVersion, localCurrent.build_version);
    assert.equal(localScope?.rollback.publicationTarget?.buildVersion, localRollback.build_version);
    assert.equal(localScope?.serving?.source, "compatibility_metadata");
    assert.equal(localScope?.serving?.comparisonToPublication, "ambiguous_across_knowledge_spaces");
    assert.equal(localScope?.serving?.consistentWithPublication, null);
    assert.equal(previewScope?.publication?.publishedBuildVersion, previewCurrent.build_version);
    assert.equal(previewScope?.rollback.publicationTarget?.buildVersion, previewRollback.build_version);
    assert.equal(previewScope?.serving?.source, "compatibility_metadata");
    assert.equal(previewScope?.serving?.comparisonToPublication, "ambiguous_across_knowledge_spaces");
    assert.equal(previewScope?.serving?.consistentWithPublication, null);
    assert.equal(
      body.result.blockers.some((item) => item.includes("serving version mismatch for support-local/")),
      false
    );
    assert.equal(
      body.result.blockers.some((item) => item.includes("serving version mismatch for support-preview/")),
      false
    );
  });
});
