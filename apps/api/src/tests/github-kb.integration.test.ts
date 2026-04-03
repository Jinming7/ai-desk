import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { after, before, beforeEach, test } from "node:test";
import type { AddressInfo } from "node:net";
import "./helpers/fetch-polyfill.js";
import { app } from "../app.js";
import { pool } from "../db/client.js";
import { env, isSafeTestDatabaseUrl } from "../config/env.js";
import { buildChunks } from "../modules/github-kb/chunker.js";
import { toVectorLiteral } from "../modules/github-kb/embedding.js";
import { parseMarkdownSections } from "../modules/github-kb/markdown.js";
import * as githubRepo from "../modules/github-kb/repository.js";
import * as serviceModule from "../modules/github-kb/service.js";
import { buildDocsComIncludePaths, githubKbServiceDeps, promoteValidatedBuild, runDueSyncJobs } from "../modules/github-kb/service.js";
import { formatLocalDbBlockedMessage, probeLocalDbReadiness, type LocalDbReadiness } from "./helpers/local-db-readiness.js";

let baseUrl = "";
let server: ReturnType<typeof app.listen>;
const originalLocalDocsPath = env.LOCAL_DOCS_COM_PATH;
const originalVercelEnv = process.env.VERCEL_ENV;
let localDbReadiness: LocalDbReadiness = { kind: "ready" };

function stripHighlightMarkup(value: string): string {
  return value.replace(/<[^>]+>/g, "");
}

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((innerResolve, innerReject) => {
    resolve = innerResolve;
    reject = innerReject;
  });
  return { promise, resolve, reject };
}

function assertSafeTestDatabase() {
  const url = process.env.DATABASE_URL ?? env.DATABASE_URL;
  if (!isSafeTestDatabaseUrl(url)) {
    throw new Error("Refusing to run github-kb integration tests against a non-local database");
  }
}

async function resetKbDb() {
  await pool.query("DELETE FROM kb_build_validation_results");
  await pool.query("DELETE FROM kb_ingest_leases");
  await pool.query("DELETE FROM kb_publications");
  await pool.query("DELETE FROM kb_builds");
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

async function createFixtureRoot(): Promise<string> {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "github-kb-integration-"));
  execFileSync("git", ["init"], { cwd: rootDir, stdio: "ignore" });
  execFileSync("git", ["-c", "user.name=Test User", "-c", "user.email=test@example.com", "commit", "--allow-empty", "-m", "init"], {
    cwd: rootDir,
    stdio: "ignore"
  });
  return rootDir;
}

async function writeFixture(rootDir: string, relativePath: string, content: string): Promise<void> {
  const filePath = path.join(rootDir, relativePath);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, content, "utf8");
}

before(async () => {
  localDbReadiness = await probeLocalDbReadiness({
    pool,
    databaseUrl: process.env.DATABASE_URL ?? env.DATABASE_URL,
    isSafeTestDatabaseUrl
  });
  if (localDbReadiness.kind === "blocked") {
    if (localDbReadiness.reason === "unsafe_database") {
      throw new Error(localDbReadiness.detail);
    }
    return;
  }
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
});

beforeEach(async (t) => {
  if (localDbReadiness.kind === "blocked") {
    if ("skip" in t && typeof t.skip === "function") {
      t.skip(formatLocalDbBlockedMessage("github-kb.integration", localDbReadiness));
    }
    return;
  }
  if (!baseUrl && server) {
    const address = server.address() as AddressInfo | null;
    if (address) {
      baseUrl = `http://127.0.0.1:${address.port}`;
    }
  }
  await resetKbDb();
  env.LOCAL_DOCS_COM_PATH = originalLocalDocsPath;
  process.env.VERCEL_ENV = originalVercelEnv;
});

after(async () => {
  if (server) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  env.LOCAL_DOCS_COM_PATH = originalLocalDocsPath;
  process.env.VERCEL_ENV = originalVercelEnv;
  await pool.end();
});

async function createIsolationRegistration() {
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

test("build artifact summary only counts selected citation embedding targets", async () => {
  const registration = await createIsolationRegistration();
  const buildVersion = "build-selected-citation-embeddings";
  const doc = await githubRepo.upsertDocument({
    repoId: registration.id,
    knowledgeSpace: "support-local",
    branch: "main",
    path: "docs/auth.md",
    buildVersion,
    title: "Auth",
    sourceUrl: "https://example.com/docs/auth",
    repoSourceUrl: "https://example.com/repo/docs/auth.md",
    publicSourceUrl: "https://example.com/docs/auth",
    commitSha: "mockc1",
    contentHash: "hash-auth",
    content: "# Auth\n",
    metadata: { sourceFamily: "doc_page" }
  });

  await githubRepo.upsertCitationUnit({
    id: "11111111-1111-5111-8111-111111111111",
    knowledgeSpace: "support-local",
    repoId: registration.id,
    branch: "main",
    buildVersion,
    sourceDocId: doc.id,
    citationFamily: "code_symbol_span",
    sourceFamily: "code_file",
    sourceArtifactType: "kb_code_symbols",
    sourceArtifactId: null,
    citationKey: "disabled-citation",
    path: "apps/api/src/app.ts",
    title: "App",
    headingPath: "App.start",
    snippetText: "function start() {}",
    sourceLocation: { lineStart: 1, lineEnd: 1 },
    authority: { authority: "repository_code" },
    metadata: { embeddingTarget: "disabled" },
    embedding: toVectorLiteral([1, 0]),
    embeddingModel: "model-2d",
    embeddingVersion: "v1"
  });

  await githubRepo.upsertCitationUnit({
    id: "22222222-2222-5222-8222-222222222222",
    knowledgeSpace: "support-local",
    repoId: registration.id,
    branch: "main",
    buildVersion,
    sourceDocId: doc.id,
    citationFamily: "openapi_operation_span",
    sourceFamily: "openapi_spec",
    sourceArtifactType: "kb_openapi_operations",
    sourceArtifactId: null,
    citationKey: "selected-citation",
    path: "apps/api/openapi.yaml",
    title: "OpenAPI",
    headingPath: "/tickets",
    snippetText: "get /tickets",
    sourceLocation: { lineStart: 1, lineEnd: 1 },
    authority: { authority: "repository_openapi" },
    metadata: { embeddingTarget: "selected" },
    embedding: null,
    embeddingModel: null,
    embeddingVersion: null
  });

  const summary = await githubRepo.getBuildArtifactSummary({
    knowledgeSpace: "support-local",
    repoId: registration.id,
    branch: "main",
    buildVersion
  });

  assert.deepEqual(summary.embeddingSummary.citationEmbeddings, {
    total: 1,
    ready: 0,
    missing: 1
  });
});

test("withBuildDocumentMutationLock serializes concurrent mutations for the same build document", async () => {
  const withBuildDocumentMutationLock = (serviceModule as Record<string, unknown>).withBuildDocumentMutationLock as
    | ((
        input: {
          knowledgeSpace: "support-local";
          repoId: string;
          branch: string;
          buildVersion: string;
          path: string;
        },
        work: () => Promise<string>
      ) => Promise<string>)
    | undefined;

  assert.equal(typeof withBuildDocumentMutationLock, "function");
  const lockMutation = withBuildDocumentMutationLock!;
  const order: string[] = [];
  const firstEntered = createDeferred<void>();
  const releaseFirst = createDeferred<void>();
  const secondEntered = createDeferred<void>();

  const first = lockMutation(
    {
      knowledgeSpace: "support-local",
      repoId: "repo-lock",
      branch: "main",
      buildVersion: "build-lock",
      path: "docs/auth.md"
    },
    async () => {
      order.push("first-enter");
      firstEntered.resolve();
      await releaseFirst.promise;
      order.push("first-exit");
      return "first";
    }
  );

  await firstEntered.promise;

  const second = lockMutation(
    {
      knowledgeSpace: "support-local",
      repoId: "repo-lock",
      branch: "main",
      buildVersion: "build-lock",
      path: "docs/auth.md"
    },
    async () => {
      order.push("second-enter");
      secondEntered.resolve();
      return "second";
    }
  );

  const secondBeforeRelease = await Promise.race([
    secondEntered.promise.then(() => "entered"),
    new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 50))
  ]);
  assert.equal(secondBeforeRelease, "timeout");

  releaseFirst.resolve();

  const results = await Promise.all([first, second]);
  assert.deepEqual(results, ["first", "second"]);
  assert.deepEqual(order, ["first-enter", "first-exit", "second-enter"]);
});

test("withGenericBuildBatchLock serializes concurrent generic full-sync batches for the same build version", async () => {
  const withGenericBuildBatchLock = (serviceModule as Record<string, unknown>).withGenericBuildBatchLock as
    | ((
        input: {
          knowledgeSpace: "support-local";
          repoId: string;
          branch: string;
          buildVersion: string;
        },
        work: () => Promise<string>
      ) => Promise<string>)
    | undefined;

  assert.equal(typeof withGenericBuildBatchLock, "function");
  const lockBatch = withGenericBuildBatchLock!;
  const order: string[] = [];
  const firstEntered = createDeferred<void>();
  const releaseFirst = createDeferred<void>();
  const secondEntered = createDeferred<void>();

  const first = lockBatch(
    {
      knowledgeSpace: "support-local",
      repoId: "repo-lock",
      branch: "main",
      buildVersion: "build-lock"
    },
    async () => {
      order.push("first-enter");
      firstEntered.resolve();
      await releaseFirst.promise;
      order.push("first-exit");
      return "first";
    }
  );

  await firstEntered.promise;

  const second = lockBatch(
    {
      knowledgeSpace: "support-local",
      repoId: "repo-lock",
      branch: "main",
      buildVersion: "build-lock"
    },
    async () => {
      order.push("second-enter");
      secondEntered.resolve();
      return "second";
    }
  );

  const secondBeforeRelease = await Promise.race([
    secondEntered.promise.then(() => "entered"),
    new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 50))
  ]);
  assert.equal(secondBeforeRelease, "timeout");

  releaseFirst.resolve();

  const results = await Promise.all([first, second]);
  assert.deepEqual(results, ["first", "second"]);
  assert.deepEqual(order, ["first-enter", "first-exit", "second-enter"]);
});

async function createBuildScopedDocAndChunk(input: {
  repoId: string;
  knowledgeSpace: "support-prod" | "support-preview" | "support-local";
  branch: string;
  buildVersion: string;
  commitSha: string;
  path: string;
  title: string;
  content: string;
}) {
  const doc = await githubRepo.upsertDocument({
    repoId: input.repoId,
    knowledgeSpace: input.knowledgeSpace,
    branch: input.branch,
    path: input.path,
    buildVersion: input.buildVersion,
    title: input.title,
    sourceUrl: `https://example.com/${input.path}`,
    repoSourceUrl: `https://github.com/acme/ticket-kb/blob/${input.commitSha}/${input.path}`,
    publicSourceUrl: null,
    commitSha: input.commitSha,
    contentHash: `${input.buildVersion}:${input.knowledgeSpace}:hash`,
    content: input.content,
    metadata: {}
  });

  const sections = parseMarkdownSections(input.content);
  const chunks = buildChunks(doc.doc_key, sections, {
    targetTokens: 500,
    overlapTokens: 0
  });

  for (const chunk of chunks) {
    await githubRepo.upsertChunk({
      id: chunk.id,
      docId: doc.id,
      repoId: input.repoId,
      knowledgeSpace: input.knowledgeSpace,
      branch: input.branch,
      path: input.path,
      buildVersion: input.buildVersion,
      commitSha: input.commitSha,
      headingPath: chunk.headingPath,
      ordinal: chunk.ordinal,
      content: chunk.content,
      contentHash: chunk.contentHash,
      tokenCount: chunk.tokenCount,
      metadata: chunk.metadata,
      embedding: null,
      embeddingModel: null,
      embeddingVersion: null
    });
  }

  return { doc, chunks };
}

test("kb_chunks.embedding uses variable vector dimensions so custom providers can rebuild safely", async () => {
  const result = await pool.query<{ type: string }>(
    `SELECT format_type(a.atttypid, a.atttypmod) AS type
       FROM pg_attribute a
       INNER JOIN pg_class c ON c.oid = a.attrelid
       INNER JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public'
        AND c.relname = 'kb_chunks'
        AND a.attname = 'embedding'
        AND a.attnum > 0
        AND NOT a.attisdropped`
  );

  assert.equal(result.rows[0]?.type, "vector");
});

test("vector candidate search ignores chunks from other embedding models in the same published build", async () => {
  const registration = await createIsolationRegistration();
  const knowledgeSpace = "support-local";
  const buildVersion = "build-vector-model-safety";
  const commitSha = "abc1234";
  const doc = await githubRepo.upsertDocument({
    repoId: registration.id,
    knowledgeSpace,
    branch: "main",
    path: "docs/vector-model-safety.md",
    buildVersion,
    title: "Vector Model Safety",
    sourceUrl: "https://example.com/docs/vector-model-safety",
    repoSourceUrl: "https://github.com/acme/ticket-kb/blob/abc1234/docs/vector-model-safety.md",
    publicSourceUrl: null,
    commitSha,
    contentHash: "vector-model-safety",
    content: "# Vector model safety\n\nPublished builds may contain different embedding models over time.",
    metadata: {}
  });

  await githubRepo.upsertChunk({
    id: "chunk-2d",
    docId: doc.id,
    repoId: registration.id,
    knowledgeSpace,
    branch: "main",
    path: "docs/vector-model-safety.md",
    buildVersion,
    commitSha,
    headingPath: "ROOT",
    ordinal: 1,
    content: "Dense recall should use the same embedding model as the query.",
    contentHash: "chunk-2d",
    tokenCount: 12,
    metadata: {},
    embedding: toVectorLiteral([1, 0]),
    embeddingModel: "model-2d",
    embeddingVersion: "v1"
  });

  await githubRepo.upsertChunk({
    id: "chunk-3d",
    docId: doc.id,
    repoId: registration.id,
    knowledgeSpace,
    branch: "main",
    path: "docs/vector-model-safety.md",
    buildVersion,
    commitSha,
    headingPath: "Other",
    ordinal: 2,
    content: "This chunk belongs to a different embedding model and dimension.",
    contentHash: "chunk-3d",
    tokenCount: 11,
    metadata: {},
    embedding: toVectorLiteral([0, 1, 0]),
    embeddingModel: "model-3d",
    embeddingVersion: "v1"
  });

  await githubRepo.upsertPublication({
    knowledgeSpace,
    repoId: registration.id,
    branch: "main",
    publishedBuildVersion: buildVersion,
    publishedHead: commitSha,
    publishedBy: "test",
    publishedFromEnv: "local"
  });

  const hits = await githubRepo.searchVectorCandidates({
    knowledgeSpace,
    repoId: registration.id,
    branch: "main",
    vectorLiteral: toVectorLiteral([1, 0]),
    embeddingModel: "model-2d",
    limit: 5
  });

  assert.deepEqual(
    hits.map((hit) => hit.chunkId),
    ["chunk-2d"]
  );
});

test("full sync builds index and retrieval returns source citation", async () => {
  const register = await fetch(`${baseUrl}/api/v1/internal/kb/repos/register`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-portal-surface": "internal"
    },
    body: JSON.stringify({
      repoUrl: "mock://acme/ticket-kb",
      defaultBranch: "main",
      includePaths: ["docs/*.md", "docs/**/*.md"],
      excludePaths: [],
      pollingIntervalSeconds: 60,
      actor: "test"
    })
  });
  assert.equal(register.status, 201);
  const regPayload = (await register.json()) as { registration: { id: string; default_branch: string } };

  const enqueue = await fetch(`${baseUrl}/api/v1/internal/kb/sync/full`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-portal-surface": "internal"
    },
    body: JSON.stringify({
      repoId: regPayload.registration.id,
      branch: regPayload.registration.default_branch,
      afterCommitSha: "mockc2",
      idempotencyKey: "test-full-sync",
      payload: {
        publicationMode: "publish_inline"
      }
    })
  });
  assert.equal(enqueue.status, 202);

  const run = await fetch(`${baseUrl}/api/v1/internal/kb/sync/run`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-portal-surface": "internal"
    },
    body: JSON.stringify({ limit: 20 })
  });
  assert.equal(run.status, 200);

  const retrieval = await fetch(`${baseUrl}/api/v1/kb/retrieval/query`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      query: "token scope mismatch",
      profile: "search",
      repoId: regPayload.registration.id,
      includeFallback: false
    })
  });
  assert.equal(retrieval.status, 200);

  const body = (await retrieval.json()) as {
    result: {
      hits: Array<{ repo: string; path: string; sourceUrl: string; commitSha: string }>;
    };
  };

  assert.equal(body.result.hits.length > 0, true);
  assert.equal(typeof body.result.hits[0].repo, "string");
  assert.equal(body.result.hits[0].path.startsWith("docs/"), true);
  assert.equal(body.result.hits[0].sourceUrl.includes("github.com"), true);
  assert.equal(typeof body.result.hits[0].commitSha, "string");
});

test("build API creates a validated build without implicit publication", async () => {
  const register = await fetch(`${baseUrl}/api/v1/internal/kb/repos/register`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-portal-surface": "internal"
    },
    body: JSON.stringify({
      repoUrl: "mock://acme/ticket-kb",
      defaultBranch: "main",
      includePaths: ["docs/*.md", "docs/**/*.md"],
      excludePaths: [],
      pollingIntervalSeconds: 60,
      actor: "test"
    })
  });
  assert.equal(register.status, 201);
  const regPayload = (await register.json()) as { registration: { id: string; default_branch: string } };

  const buildStart = await fetch(`${baseUrl}/api/v1/internal/kb/builds/full`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-portal-surface": "internal"
    },
    body: JSON.stringify({
      repoId: regPayload.registration.id,
      branch: regPayload.registration.default_branch,
      actor: "test"
    })
  });
  assert.equal(buildStart.status, 202);

  const run = await fetch(`${baseUrl}/api/v1/internal/kb/sync/run`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-portal-surface": "internal"
    },
    body: JSON.stringify({ limit: 20 })
  });
  assert.equal(run.status, 200);

  const builds = await pool.query<{ id: string; status: string }>(
    `SELECT id, status
     FROM kb_builds
     WHERE repo_id = $1
     ORDER BY created_at DESC
     LIMIT 1`,
    [regPayload.registration.id]
  );
  assert.equal(builds.rowCount, 1);
  assert.equal(builds.rows[0].status, "validated");

  const publications = await fetch(
    `${baseUrl}/api/v1/internal/kb/publications/status?repoId=${encodeURIComponent(regPayload.registration.id)}`,
    {
      headers: { "x-portal-surface": "internal" }
    }
  );
  assert.equal(publications.status, 200);
  const publicationBody = (await publications.json()) as { result: Array<{ repo_id: string }> };
  assert.equal(publicationBody.result.length, 0);
});

test("build API keeps one execution-scoped build across generic full-sync continuations", async () => {
  const originalBatchSize = env.GITHUB_KB_REMOTE_SYNC_BATCH_SIZE;
  env.GITHUB_KB_REMOTE_SYNC_BATCH_SIZE = 1;

  try {
    const register = await fetch(`${baseUrl}/api/v1/internal/kb/repos/register`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-portal-surface": "internal"
      },
      body: JSON.stringify({
        repoUrl: "mock://acme/ticket-kb",
        defaultBranch: "main",
        includePaths: ["docs/*.md", "docs/**/*.md", "deploy-docs/*.md", "deploy-docs/**/*.md"],
        excludePaths: [],
        pollingIntervalSeconds: 60,
        actor: "test"
      })
    });
    assert.equal(register.status, 201);
    const regPayload = (await register.json()) as { registration: { id: string; default_branch: string } };

    const buildStart = await fetch(`${baseUrl}/api/v1/internal/kb/builds/full`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-portal-surface": "internal"
      },
      body: JSON.stringify({
        repoId: regPayload.registration.id,
        branch: regPayload.registration.default_branch,
        actor: "test"
      })
    });
    assert.equal(buildStart.status, 202);

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const run = await fetch(`${baseUrl}/api/v1/internal/kb/sync/run`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-portal-surface": "internal"
        },
        body: JSON.stringify({ limit: 20 })
      });
      assert.equal(run.status, 200);
    }

    const builds = await pool.query<{ build_version: string; status: string }>(
      `SELECT build_version, status
         FROM kb_builds
        WHERE repo_id = $1
        ORDER BY created_at ASC`,
      [regPayload.registration.id]
    );

    assert.equal(builds.rowCount, 1);
    assert.match(builds.rows[0]?.build_version ?? "", /^mockc3:sync-exec:/);
    assert.equal(builds.rows[0]?.status, "validated");

    const dangling = await pool.query<{ total: string }>(
      `SELECT COUNT(*)::text AS total
         FROM kb_builds
        WHERE repo_id = $1
          AND status = 'building'`,
      [regPayload.registration.id]
    );
    assert.equal(dangling.rows[0]?.total, "0");
  } finally {
    env.GITHUB_KB_REMOTE_SYNC_BATCH_SIZE = originalBatchSize;
  }
});

test("build API allows explicit internal operator override into support-shadow", async () => {
  const register = await fetch(`${baseUrl}/api/v1/internal/kb/repos/register`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-portal-surface": "internal"
    },
    body: JSON.stringify({
      repoUrl: "mock://acme/ticket-kb",
      defaultBranch: "main",
      includePaths: ["docs/*.md", "docs/**/*.md"],
      excludePaths: [],
      pollingIntervalSeconds: 60,
      actor: "test"
    })
  });
  assert.equal(register.status, 201);
  const regPayload = (await register.json()) as { registration: { id: string; default_branch: string } };

  const buildStart = await fetch(`${baseUrl}/api/v1/internal/kb/builds/full`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-portal-surface": "internal"
    },
    body: JSON.stringify({
      repoId: regPayload.registration.id,
      branch: regPayload.registration.default_branch,
      actor: "internal_operator",
      knowledgeSpace: "support-shadow",
      operatorOverride: true
    })
  });
  assert.equal(buildStart.status, 202);

  const run = await fetch(`${baseUrl}/api/v1/internal/kb/sync/run`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-portal-surface": "internal"
    },
    body: JSON.stringify({ limit: 20 })
  });
  assert.equal(run.status, 200);

  const builds = await pool.query<{ knowledge_space: string; requested_from_env: string; status: string }>(
    `SELECT knowledge_space, requested_from_env, status
     FROM kb_builds
     WHERE repo_id = $1
     ORDER BY created_at DESC
     LIMIT 1`,
    [regPayload.registration.id]
  );
  assert.equal(builds.rowCount, 1);
  assert.equal(builds.rows[0].knowledge_space, "support-shadow");
  assert.equal(builds.rows[0].requested_from_env, "operator");
  assert.equal(builds.rows[0].status, "validated");
});

test("build API rejects operator override from automation-only callers", async () => {
  const previousOpsToken = env.INTERNAL_OPS_TOKEN;
  env.INTERNAL_OPS_TOKEN = "test-internal-ops-token";

  try {
    const registration = await createIsolationRegistration();
    const buildStart = await fetch(`${baseUrl}/api/v1/internal/kb/builds/full`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${env.INTERNAL_OPS_TOKEN}`
      },
      body: JSON.stringify({
        repoId: registration.id,
        branch: "main",
        actor: "internal_operator",
        knowledgeSpace: "support-shadow",
        operatorOverride: true
      })
    });

    assert.equal(buildStart.status, 403);
    const body = (await buildStart.json()) as { error: string };
    assert.match(body.error, /internal portal access required/i);
  } finally {
    env.INTERNAL_OPS_TOKEN = previousOpsToken;
  }
});

test("legacy /sync/full defaults to validated build without implicit publication", async () => {
  const register = await fetch(`${baseUrl}/api/v1/internal/kb/repos/register`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-portal-surface": "internal"
    },
    body: JSON.stringify({
      repoUrl: "mock://acme/ticket-kb",
      defaultBranch: "main",
      includePaths: ["docs/*.md", "docs/**/*.md"],
      excludePaths: [],
      pollingIntervalSeconds: 60,
      actor: "test"
    })
  });
  assert.equal(register.status, 201);
  const regPayload = (await register.json()) as { registration: { id: string; default_branch: string } };

  const enqueue = await fetch(`${baseUrl}/api/v1/internal/kb/sync/full`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-portal-surface": "internal"
    },
    body: JSON.stringify({
      repoId: regPayload.registration.id,
      branch: regPayload.registration.default_branch,
      afterCommitSha: "mockc2",
      idempotencyKey: "test-legacy-sync-no-inline-publish"
    })
  });
  assert.equal(enqueue.status, 202);

  const run = await fetch(`${baseUrl}/api/v1/internal/kb/sync/run`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-portal-surface": "internal"
    },
    body: JSON.stringify({ limit: 20 })
  });
  assert.equal(run.status, 200);

  const builds = await pool.query<{ status: string }>(
    `SELECT status
       FROM kb_builds
      WHERE repo_id = $1
      ORDER BY created_at DESC
      LIMIT 1`,
    [regPayload.registration.id]
  );
  assert.equal(builds.rowCount, 1);
  assert.equal(builds.rows[0].status, "validated");

  const publications = await pool.query<{ total: string }>(
    `SELECT COUNT(*)::text AS total
       FROM kb_publications
      WHERE repo_id = $1`,
    [regPayload.registration.id]
  );
  assert.equal(publications.rows[0]?.total, "0");
});

test("knowledge_space document isolation keeps same path/build rows separate across spaces", async () => {
  const registration = await createIsolationRegistration();
  const shared = {
    repoId: registration.id,
    branch: "main",
    buildVersion: "shared-build",
    commitSha: "mockc2",
    path: "docs/isolation.md",
    title: "Isolation",
    content: "# Isolation\n\nProd and preview must not collide."
  };

  const prod = await githubRepo.upsertDocument({
    ...shared,
    knowledgeSpace: "support-prod",
    sourceUrl: "https://example.com/prod",
    repoSourceUrl: "https://github.com/acme/ticket-kb/blob/mockc2/docs/isolation.md",
    publicSourceUrl: null,
    contentHash: "prod-hash",
    metadata: { space: "prod" }
  });
  const preview = await githubRepo.upsertDocument({
    ...shared,
    knowledgeSpace: "support-preview",
    sourceUrl: "https://example.com/preview",
    repoSourceUrl: "https://github.com/acme/ticket-kb/blob/mockc2/docs/isolation.md",
    publicSourceUrl: null,
    contentHash: "preview-hash",
    metadata: { space: "preview" }
  });

  assert.notEqual(prod.id, preview.id);
  assert.notEqual(prod.doc_key, preview.doc_key);
  assert.match(prod.doc_key, /^support-prod:/);
  assert.match(preview.doc_key, /^support-preview:/);

  const rows = await pool.query<{ knowledge_space: string; content_hash: string }>(
    `SELECT knowledge_space, content_hash
     FROM kb_documents
     WHERE repo_id = $1
       AND branch = $2
       AND path = $3
       AND build_version = $4
     ORDER BY knowledge_space ASC`,
    [registration.id, "main", "docs/isolation.md", "shared-build"]
  );

  assert.equal(rows.rowCount, 2);
  assert.deepEqual(
    rows.rows.map((row) => [row.knowledge_space, row.content_hash]),
    [
      ["support-preview", "preview-hash"],
      ["support-prod", "prod-hash"]
    ]
  );
});

test("knowledge_space chunk isolation keeps same logical chunk separate across spaces", async () => {
  const registration = await createIsolationRegistration();
  const content = "# Callback\n\nVerify redirect URI and callback URL.";
  const prod = await createBuildScopedDocAndChunk({
    repoId: registration.id,
    knowledgeSpace: "support-prod",
    branch: "main",
    buildVersion: "shared-build",
    commitSha: "mockc2",
    path: "docs/callback.md",
    title: "Callback",
    content
  });
  const preview = await createBuildScopedDocAndChunk({
    repoId: registration.id,
    knowledgeSpace: "support-preview",
    branch: "main",
    buildVersion: "shared-build",
    commitSha: "mockc2",
    path: "docs/callback.md",
    title: "Callback",
    content
  });

  assert.equal(prod.chunks.length > 0, true);
  assert.equal(preview.chunks.length > 0, true);
  assert.notEqual(prod.chunks[0].id, preview.chunks[0].id);

  const rows = await pool.query<{ knowledge_space: string; chunk_id: string }>(
    `SELECT knowledge_space, id AS chunk_id
     FROM kb_chunks
     WHERE repo_id = $1
       AND branch = $2
       AND path = $3
       AND build_version = $4
     ORDER BY knowledge_space ASC`,
    [registration.id, "main", "docs/callback.md", "shared-build"]
  );

  assert.equal(rows.rowCount, prod.chunks.length + preview.chunks.length);
  assert.equal(new Set(rows.rows.map((row) => row.chunk_id)).size, rows.rowCount);
});

test("publication isolation across spaces keeps prod read path independent from preview", async () => {
  const registration = await createIsolationRegistration();

  await githubRepo.ensureBuild({
    knowledgeSpace: "support-prod",
    repoId: registration.id,
    branch: "main",
    buildVersion: "prod-build",
    targetHead: "mockc2",
    buildKind: "full",
    requestedBy: "test",
    requestedFromEnv: "prod"
  });
  await githubRepo.ensureBuild({
    knowledgeSpace: "support-preview",
    repoId: registration.id,
    branch: "main",
    buildVersion: "preview-build",
    targetHead: "mockc2",
    buildKind: "full",
    requestedBy: "test",
    requestedFromEnv: "preview"
  });
  await githubRepo.ensureBuild({
    knowledgeSpace: "support-local",
    repoId: registration.id,
    branch: "main",
    buildVersion: "local-build",
    targetHead: "mockc2",
    buildKind: "full",
    requestedBy: "test",
    requestedFromEnv: "local"
  });

  await createBuildScopedDocAndChunk({
    repoId: registration.id,
    knowledgeSpace: "support-prod",
    branch: "main",
    buildVersion: "prod-build",
    commitSha: "mockc2",
    path: "docs/publication.md",
    title: "Publication",
    content: "# Publication\n\nToken scope mismatch is a prod-only phrase."
  });
  await createBuildScopedDocAndChunk({
    repoId: registration.id,
    knowledgeSpace: "support-preview",
    branch: "main",
    buildVersion: "preview-build",
    commitSha: "mockc2",
    path: "docs/publication.md",
    title: "Publication",
    content: "# Publication\n\nPreview staging callback mismatch is a preview-only phrase."
  });
  await createBuildScopedDocAndChunk({
    repoId: registration.id,
    knowledgeSpace: "support-local",
    branch: "main",
    buildVersion: "local-build",
    commitSha: "mockc2",
    path: "docs/publication.md",
    title: "Publication",
    content: "# Publication\n\nLocal workstation callback mismatch is a local-only phrase."
  });

  await githubRepo.upsertPublication({
    knowledgeSpace: "support-prod",
    repoId: registration.id,
    branch: "main",
    publishedBuildVersion: "prod-build",
    publishedHead: "mockc2",
    publishedBy: "test",
    publishedFromEnv: "prod"
  });
  await githubRepo.upsertPublication({
    knowledgeSpace: "support-preview",
    repoId: registration.id,
    branch: "main",
    publishedBuildVersion: "preview-build",
    publishedHead: "mockc2",
    publishedBy: "test",
    publishedFromEnv: "preview"
  });
  await githubRepo.upsertPublication({
    knowledgeSpace: "support-local",
    repoId: registration.id,
    branch: "main",
    publishedBuildVersion: "local-build",
    publishedHead: "mockc2",
    publishedBy: "test",
    publishedFromEnv: "local"
  });

  const prodHits = await githubRepo.searchKeywordCandidates({
    knowledgeSpace: "support-prod",
    repoId: registration.id,
    branch: "main",
    query: "prod-only phrase token scope mismatch",
    limit: 5
  });
  const previewHits = await githubRepo.searchKeywordCandidates({
    knowledgeSpace: "support-preview",
    repoId: registration.id,
    branch: "main",
    query: "preview-only phrase callback mismatch",
    limit: 5
  });
  const localHits = await githubRepo.searchKeywordCandidates({
    knowledgeSpace: "support-local",
    repoId: registration.id,
    branch: "main",
    query: "local-only phrase callback mismatch",
    limit: 5
  });

  assert.equal(prodHits.length > 0, true);
  assert.equal(previewHits.length > 0, true);
  assert.equal(localHits.length > 0, true);
  assert.match(stripHighlightMarkup(prodHits[0].snippet), /prod-only phrase/i);
  assert.match(stripHighlightMarkup(previewHits[0].snippet), /preview-only phrase/i);
  assert.match(stripHighlightMarkup(localHits[0].snippet), /local-only phrase/i);
});

test("deactivation isolation only mutates rows inside the requested knowledge space", async () => {
  const registration = await createIsolationRegistration();
  await githubRepo.upsertDocument({
    repoId: registration.id,
    knowledgeSpace: "support-prod",
    branch: "main",
    path: "docs/deactivate.md",
    buildVersion: "shared-build",
    title: "Deactivate",
    sourceUrl: "https://example.com/prod",
    repoSourceUrl: "https://github.com/acme/ticket-kb/blob/mockc2/docs/deactivate.md",
    publicSourceUrl: null,
    commitSha: "mockc2",
    contentHash: "prod-doc",
    content: "# Deactivate\n\nProd row stays active.",
    metadata: {}
  });
  await githubRepo.upsertDocument({
    repoId: registration.id,
    knowledgeSpace: "support-preview",
    branch: "main",
    path: "docs/deactivate.md",
    buildVersion: "shared-build",
    title: "Deactivate",
    sourceUrl: "https://example.com/preview",
    repoSourceUrl: "https://github.com/acme/ticket-kb/blob/mockc2/docs/deactivate.md",
    publicSourceUrl: null,
    commitSha: "mockc2",
    contentHash: "preview-doc",
    content: "# Deactivate\n\nPreview row should deactivate.",
    metadata: {}
  });

  await githubRepo.deactivateDocumentsMissingFromSnapshot(registration.id, "main", "support-preview", []);

  const rows = await pool.query<{ knowledge_space: string; is_active: boolean }>(
    `SELECT knowledge_space, is_active
     FROM kb_documents
     WHERE repo_id = $1
       AND branch = 'main'
       AND path = 'docs/deactivate.md'
     ORDER BY knowledge_space ASC`,
    [registration.id]
  );

  assert.deepEqual(
    rows.rows.map((row) => [row.knowledge_space, row.is_active]),
    [
      ["support-preview", false],
      ["support-prod", true]
    ]
  );
});

test("local promotion guard rejects non-local knowledge space promotion", async () => {
  const registration = await createIsolationRegistration();
  await githubRepo.ensureBuild({
    knowledgeSpace: "support-prod",
    repoId: registration.id,
    branch: "main",
    buildVersion: "prod-build",
    targetHead: "mockc2",
    buildKind: "full",
    requestedBy: "test",
    requestedFromEnv: "prod"
  });
  await createBuildScopedDocAndChunk({
    repoId: registration.id,
    knowledgeSpace: "support-prod",
    branch: "main",
    buildVersion: "prod-build",
    commitSha: "mockc2",
    path: "docs/guard.md",
    title: "Guard",
    content: "# Guard\n\nProd build exists."
  });

  process.env.VERCEL_ENV = "";
  const prodBuild = await githubRepo.getBuildByVersion({
    knowledgeSpace: "support-prod",
    repoId: registration.id,
    branch: "main",
    buildVersion: "prod-build"
  });
  assert.ok(prodBuild);
  await assert.rejects(
    async () =>
      promoteValidatedBuild({
        buildId: prodBuild.id,
        actor: "test"
      }),
    /cannot promote build .* support-prod/i
  );

  await githubRepo.ensureBuild({
    knowledgeSpace: "support-local",
    repoId: registration.id,
    branch: "main",
    buildVersion: "local-build",
    targetHead: "mockc2",
    buildKind: "full",
    requestedBy: "test",
    requestedFromEnv: "local"
  });
  await createBuildScopedDocAndChunk({
    repoId: registration.id,
    knowledgeSpace: "support-local",
    branch: "main",
    buildVersion: "local-build",
    commitSha: "mockc2",
    path: "docs/guard-local.md",
    title: "Guard Local",
    content: "# Guard Local\n\nLocal build is allowed."
  });

  const localBuild = await githubRepo.getBuildByVersion({
    knowledgeSpace: "support-local",
    repoId: registration.id,
    branch: "main",
    buildVersion: "local-build"
  });
  assert.ok(localBuild);
  const promoted = await promoteValidatedBuild({
    buildId: localBuild!.id,
    actor: "test"
  });
  assert.equal(promoted.publication?.knowledge_space, "support-local");
});

test("remote full sync continues in batches until all docs are indexed", async () => {
  const originalBatchSize = env.GITHUB_KB_REMOTE_SYNC_BATCH_SIZE;
  env.GITHUB_KB_REMOTE_SYNC_BATCH_SIZE = 2;

  try {
    const register = await fetch(`${baseUrl}/api/v1/internal/kb/repos/register`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-portal-surface": "internal"
      },
      body: JSON.stringify({
        repoUrl: "mock://acme/ticket-kb",
        defaultBranch: "main",
        includePaths: ["docs/*.md", "docs/**/*.md", "deploy-docs/*.md", "deploy-docs/**/*.md"],
        excludePaths: [],
        pollingIntervalSeconds: 60,
        actor: "test"
      })
    });
    assert.equal(register.status, 201);
    const regPayload = (await register.json()) as { registration: { id: string; default_branch: string } };

    const enqueue = await fetch(`${baseUrl}/api/v1/internal/kb/sync/full`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-portal-surface": "internal"
      },
      body: JSON.stringify({
        repoId: regPayload.registration.id,
        branch: regPayload.registration.default_branch,
        afterCommitSha: "mockc2",
        idempotencyKey: "test-remote-full-batch",
        payload: {
          publicationMode: "publish_inline"
        }
      })
    });
    assert.equal(enqueue.status, 202);

    const run1 = await fetch(`${baseUrl}/api/v1/internal/kb/sync/run`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-portal-surface": "internal"
      },
      body: JSON.stringify({ limit: 1 })
    });
    assert.equal(run1.status, 200);
    const run1Body = (await run1.json()) as { result: { processed: number; succeeded: number } };
    assert.equal(run1Body.result.processed, 1);
    assert.equal(run1Body.result.succeeded, 1);

    const jobsAfterRun1 = await fetch(`${baseUrl}/api/v1/internal/kb/sync/jobs?limit=10`, {
      headers: { "x-portal-surface": "internal" }
    });
    assert.equal(jobsAfterRun1.status, 200);
    const jobsAfterRun1Body = (await jobsAfterRun1.json()) as { jobs: Array<{ status: string }> };
    assert.equal(jobsAfterRun1Body.jobs.some((job) => job.status === "queued"), true);

    const run2 = await fetch(`${baseUrl}/api/v1/internal/kb/sync/run`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-portal-surface": "internal"
      },
      body: JSON.stringify({ limit: 1 })
    });
    assert.equal(run2.status, 200);

    const retrieval = await fetch(`${baseUrl}/api/v1/kb/retrieval/query`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        query: "KubeVersionMismatch",
        profile: "search",
        repoId: regPayload.registration.id,
        includeFallback: false
      })
    });
    assert.equal(retrieval.status, 200);
    const body = (await retrieval.json()) as {
      result: {
        hits: Array<{ path: string }>;
      };
    };
    assert.equal(body.result.hits.some((hit) => hit.path === "deploy-docs/troubleshooting/infra/k3s-alert-handler.md"), true);
  } finally {
    env.GITHUB_KB_REMOTE_SYNC_BATCH_SIZE = originalBatchSize;
  }
});

test("docs-com full shard retries transient DB timeout without failing the full run", async (t) => {
  const originalMirrorEnabled = env.GITHUB_KB_ENABLE_LOCAL_DOCS_MIRROR;
  env.GITHUB_KB_ENABLE_LOCAL_DOCS_MIRROR = false;

  try {
    const registration = await githubRepo.upsertRepoRegistration({
      repoOwner: "BangWork",
      repoName: "docs-com",
      repoUrl: "mock://BangWork/docs-com",
      publicBaseUrl: "https://docs.ones.com",
      defaultBranch: "master",
      includePaths: ["docs/**/*.md", "docs/**/*.mdx", "open-docs/**/*.md", "open-docs/**/*.mdx", "deploy-docs/**/*.md", "deploy-docs/**/*.mdx"],
      excludePaths: [],
      pollingIntervalSeconds: 60,
      createdBy: "test"
    });

    const { run } = await githubRepo.createFullSyncRun({
      repoId: registration.id,
      branch: "master",
      targetHead: "mockc2",
      requestedBy: "test",
      runReason: "transient-db-timeout",
      sourceSnapshotTotal: 1,
      manifestItems: [
        {
          path: "docs/api.md",
          shardKey: "docs",
          blobSha: "blob-1",
          sizeBytes: 32,
          needsRebuild: true,
          reuseReason: null
        }
      ]
    });

    await githubRepo.advanceSyncRunShard({
      runId: run.id,
      shardKey: "deploy-docs",
      completedDelta: 0,
      reusableDelta: 0,
      rebuiltDelta: 0,
      failedDelta: 0,
      nextCursor: null,
      status: "succeeded"
    });
    await githubRepo.advanceSyncRunShard({
      runId: run.id,
      shardKey: "open-docs",
      completedDelta: 0,
      reusableDelta: 0,
      rebuiltDelta: 0,
      failedDelta: 0,
      nextCursor: null,
      status: "succeeded"
    });

    await githubRepo.enqueueSyncJob({
      repoId: registration.id,
      branch: "master",
      syncMode: "full",
      source: "system",
      idempotencyKey: `test-transient-db-timeout:${run.id}`,
      afterCommitSha: "mockc2",
      payload: {
        runId: run.id,
        shardKey: "docs",
        targetHead: "mockc2",
        buildVersion: `mockc2:${run.id}`,
        sourceMode: "remote"
      }
    });

    t.mock.method(githubKbServiceDeps, "updateManifestItemBuildStatus", async () => {
      throw new Error("timeout exceeded when trying to connect");
    });

    const result = await runDueSyncJobs(1);
    assert.equal(result.processed, 1);
    assert.equal(result.failed, 1);

    const runRow = await githubRepo.getSyncRun(run.id);
    assert.equal(runRow?.status, "running");
    assert.equal(runRow?.error_message, null);

    const shards = await githubRepo.listSyncRunShards(run.id);
    const docsShard = shards.find((shard) => shard.shard_key === "docs");
    assert.equal(docsShard?.status, "queued");
    assert.equal(docsShard?.failed_docs, 0);

    const manifestSummary = await githubRepo.getSyncRunManifestSummary(run.id);
    assert.equal(manifestSummary.failed, 0);
    assert.equal(manifestSummary.pending, 1);

    const jobs = await githubRepo.listRecentSyncJobs(10);
    const retryJob = jobs.find((job) => job.idempotency_key === `test-transient-db-timeout:${run.id}`);
    assert.equal(retryJob?.status, "queued");
    assert.equal(retryJob?.attempts, 1);
    assert.match(retryJob?.error_message ?? "", /timeout exceeded when trying to connect/i);
  } finally {
    env.GITHUB_KB_ENABLE_LOCAL_DOCS_MIRROR = originalMirrorEnabled;
  }
});

test("generic remote direct build retries transient document indexing timeout within the same run", async (t) => {
  const registration = await createIsolationRegistration();
  const originalBatchSize = env.GITHUB_KB_REMOTE_SYNC_BATCH_SIZE;
  env.GITHUB_KB_REMOTE_SYNC_BATCH_SIZE = 20;

  const serviceDeps = githubKbServiceDeps as typeof githubKbServiceDeps & {
    indexDocument?: (input: {
      registration: Awaited<ReturnType<typeof createIsolationRegistration>>;
      knowledgeSpace: "support-local";
      branch: string;
      commitSha: string;
      path: string;
      buildVersion?: string;
      publicationMode?: "build_only" | "publish_inline";
      embeddingMode?: "disabled" | "best_effort" | "required";
    }) => Promise<void>;
  };

  assert.equal(typeof serviceDeps.indexDocument, "function");
  const originalIndexDocument = serviceDeps.indexDocument!;
  let attempts = 0;

  t.mock.method(serviceDeps, "indexDocument", async (input: Parameters<typeof originalIndexDocument>[0]) => {
    attempts += 1;
    if (attempts === 1) {
      throw new Error("timeout exceeded when trying to connect");
    }
    return originalIndexDocument(input);
  });

  try {
    const executionId = "generic-timeout-retry";
    const result = await serviceModule.runRepositorySyncDirect({
      repoId: registration.id,
      branch: "main",
      mode: "full",
      source: "manual",
      executionId
    });

    assert.equal(result.finished, true);
    assert.equal(attempts > 1, true);

    const build = await githubRepo.getBuildByVersion({
      knowledgeSpace: "support-local",
      repoId: registration.id,
      branch: "main",
      buildVersion: `${result.head}:${executionId}`
    });
    assert.equal(build?.status, "validated");
  } finally {
    env.GITHUB_KB_REMOTE_SYNC_BATCH_SIZE = originalBatchSize;
  }
});

test("claimDueSyncJobs only claims one queued job per full-run shard", async () => {
  const registration = await githubRepo.upsertRepoRegistration({
    repoOwner: "BangWork",
    repoName: "docs-com",
    repoUrl: "https://github.com/BangWork/docs-com",
    publicBaseUrl: "https://docs.ones.com",
    defaultBranch: "master",
    includePaths: ["docs/**/*.mdx", "open-docs/**/*.mdx", "deploy-docs/**/*.mdx"],
    excludePaths: [],
    pollingIntervalSeconds: 60,
    createdBy: "test"
  });

  const { run } = await githubRepo.createFullSyncRun({
    repoId: registration.id,
    branch: "master",
    targetHead: "mock-head-dedup",
    requestedBy: "test",
    runReason: "dedupe-claim",
    sourceSnapshotTotal: 3,
    manifestItems: [
      {
        path: "docs/example/a.mdx",
        shardKey: "docs",
        blobSha: "blob-a",
        sizeBytes: 10,
        needsRebuild: true,
        reuseReason: null
      },
      {
        path: "docs/example/b.mdx",
        shardKey: "docs",
        blobSha: "blob-b",
        sizeBytes: 10,
        needsRebuild: true,
        reuseReason: null
      },
      {
        path: "open-docs/example/c.mdx",
        shardKey: "open-docs",
        blobSha: "blob-c",
        sizeBytes: 10,
        needsRebuild: true,
        reuseReason: null
      }
    ]
  });

  await githubRepo.enqueueSyncJob({
    repoId: registration.id,
    branch: "master",
    syncMode: "full",
    source: "system",
    idempotencyKey: `claim-dedup:${run.id}:docs:cursor-a`,
    afterCommitSha: "mock-head-dedup",
    payload: {
      runId: run.id,
      shardKey: "docs",
      targetHead: "mock-head-dedup",
      buildVersion: `mock-head-dedup:${run.id}`,
      sourceMode: "remote",
      cursor: "docs/example/a.mdx"
    }
  });
  await githubRepo.enqueueSyncJob({
    repoId: registration.id,
    branch: "master",
    syncMode: "full",
    source: "system",
    idempotencyKey: `claim-dedup:${run.id}:docs:cursor-b`,
    afterCommitSha: "mock-head-dedup",
    payload: {
      runId: run.id,
      shardKey: "docs",
      targetHead: "mock-head-dedup",
      buildVersion: `mock-head-dedup:${run.id}`,
      sourceMode: "remote",
      cursor: "docs/example/b.mdx"
    }
  });
  await githubRepo.enqueueSyncJob({
    repoId: registration.id,
    branch: "master",
    syncMode: "full",
    source: "system",
    idempotencyKey: `claim-dedup:${run.id}:open-docs:cursor-c`,
    afterCommitSha: "mock-head-dedup",
    payload: {
      runId: run.id,
      shardKey: "open-docs",
      targetHead: "mock-head-dedup",
      buildVersion: `mock-head-dedup:${run.id}`,
      sourceMode: "remote",
      cursor: "open-docs/example/c.mdx"
    }
  });

  const claimed = await githubRepo.claimDueSyncJobs(10);
  assert.equal(claimed.length, 2);

  const claimedShardKeys = claimed
    .map((job) => String(job.payload_json?.shardKey ?? ""))
    .sort((left, right) => left.localeCompare(right, "en"));
  assert.deepEqual(claimedShardKeys, ["docs", "open-docs"]);

  const jobs = await githubRepo.listRecentSyncJobs(10);
  const docsRunning = jobs.filter((job) => job.status === "running" && job.payload_json?.shardKey === "docs");
  const docsQueued = jobs.filter((job) => job.status === "queued" && job.payload_json?.shardKey === "docs");
  assert.equal(docsRunning.length, 1);
  assert.equal(docsQueued.length, 1);
});

test("createFullSyncRun persists skipped manifest ledger including null shard items", async () => {
  const registration = await githubRepo.upsertRepoRegistration({
    repoOwner: "BangWork",
    repoName: "docs-com",
    repoUrl: "https://github.com/BangWork/docs-com",
    publicBaseUrl: "https://docs.ones.com",
    defaultBranch: "master",
    includePaths: ["docs/**/*.mdx", "open-docs/**/*.mdx", "deploy-docs/**/*.mdx"],
    excludePaths: ["docs/excluded/**"],
    pollingIntervalSeconds: 60,
    createdBy: "test"
  });

  const { run } = await githubRepo.createFullSyncRun({
    repoId: registration.id,
    branch: "master",
    targetHead: "mock-ledger-head",
    requestedBy: "test",
    runReason: "manifest-ledger",
    sourceSnapshotTotal: 3,
    manifestItems: [
      {
        path: "docs/guides/setup.mdx",
        shardKey: "docs",
        sourceFamily: "doc_page",
        contentChecksum: "checksum-doc",
        sourceAcquisitionMode: "remote",
        blobSha: "blob-doc",
        sizeBytes: 12,
        needsRebuild: true,
        reuseReason: null,
        buildStatus: "pending"
      },
      {
        path: "docs/excluded/logo.png",
        shardKey: "docs",
        sourceFamily: null,
        contentChecksum: "checksum-logo",
        sourceAcquisitionMode: "remote",
        blobSha: "blob-logo",
        sizeBytes: 8,
        needsRebuild: false,
        reuseReason: null,
        skipReason: "excluded_by_pattern",
        buildStatus: "skipped"
      },
      {
        path: "README.md",
        shardKey: null,
        sourceFamily: null,
        contentChecksum: "checksum-readme",
        sourceAcquisitionMode: "remote",
        blobSha: "blob-readme",
        sizeBytes: 20,
        needsRebuild: false,
        reuseReason: null,
        skipReason: "outside_docs_com_scope",
        buildStatus: "skipped"
      }
    ]
  });

  const manifest = await githubRepo.listSyncRunManifest(run.id, 10);
  assert.equal(manifest.length, 3);
  assert.deepEqual(
    manifest
      .map((item) => [item.path, item.shard_key, item.build_status, item.skip_reason] as const)
      .sort((left, right) => left[0].localeCompare(right[0])),
    [
      ["docs/excluded/logo.png", "docs", "skipped", "excluded_by_pattern"],
      ["docs/guides/setup.mdx", "docs", "pending", null],
      ["README.md", null, "skipped", "outside_docs_com_scope"]
    ]
  );

  const summary = await githubRepo.getSyncRunManifestSummary(run.id);
  assert.equal(summary.pending, 1);
  assert.equal(summary.skipped, 2);
});

test("sync cron lane drains one queued job via automation bearer token", async () => {
  const previousCronSecret = env.CRON_SECRET;
  env.CRON_SECRET = "test-cron-secret";

  try {
    const register = await fetch(`${baseUrl}/api/v1/internal/kb/repos/register`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-portal-surface": "internal"
      },
      body: JSON.stringify({
        repoUrl: "mock://acme/ticket-kb",
        defaultBranch: "main",
        includePaths: ["docs/*.md", "docs/**/*.md"],
        excludePaths: [],
        pollingIntervalSeconds: 60,
        actor: "test"
      })
    });
    assert.equal(register.status, 201);
    const regPayload = (await register.json()) as { registration: { id: string; default_branch: string } };

    const enqueue = await fetch(`${baseUrl}/api/v1/internal/kb/sync/full`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-portal-surface": "internal"
      },
      body: JSON.stringify({
        repoId: regPayload.registration.id,
        branch: regPayload.registration.default_branch,
        afterCommitSha: "mockc2",
        idempotencyKey: "test-cron-lane-full-sync"
      })
    });
    assert.equal(enqueue.status, 202);

    const run = await fetch(`${baseUrl}/api/v1/internal/kb/sync/cron/lane-a`, {
      headers: {
        Authorization: `Bearer ${env.CRON_SECRET}`
      }
    });
    assert.equal(run.status, 200);
    const body = (await run.json()) as { lane: string; result: { processed: number; succeeded: number } };
    assert.equal(body.lane, "lane-a");
    assert.equal(body.result.processed, 1);
    assert.equal(body.result.succeeded, 1);
  } finally {
    env.CRON_SECRET = previousCronSecret;
  }
});

test("retrieval prefers public docs url when repo registration configures docs base", async () => {
  const register = await fetch(`${baseUrl}/api/v1/internal/kb/repos/register`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-portal-surface": "internal"
    },
    body: JSON.stringify({
      repoUrl: "mock://acme/ticket-kb",
      publicBaseUrl: "https://docs.ones.com",
      defaultBranch: "main",
      includePaths: ["docs/*.md", "docs/**/*.md"],
      excludePaths: [],
      pollingIntervalSeconds: 60,
      actor: "test"
    })
  });
  assert.equal(register.status, 201);
  const regPayload = (await register.json()) as { registration: { id: string; default_branch: string } };

  await fetch(`${baseUrl}/api/v1/internal/kb/sync/full`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-portal-surface": "internal"
    },
    body: JSON.stringify({
      repoId: regPayload.registration.id,
      branch: regPayload.registration.default_branch,
      afterCommitSha: "mockc2",
      idempotencyKey: "test-public-docs-url",
      payload: {
        publicationMode: "publish_inline"
      }
    })
  });

  await fetch(`${baseUrl}/api/v1/internal/kb/sync/run`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-portal-surface": "internal"
    },
    body: JSON.stringify({ limit: 20 })
  });

  const retrieval = await fetch(`${baseUrl}/api/v1/kb/retrieval/query`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      query: "token scope mismatch",
      profile: "search",
      repoId: regPayload.registration.id,
      includeFallback: false
    })
  });
  assert.equal(retrieval.status, 200);

  const body = (await retrieval.json()) as {
    result: {
      hits: Array<{ sourceUrl: string; repoSourceUrl: string; path: string }>;
    };
  };

  assert.equal(body.result.hits.length > 0, true);
  assert.equal(body.result.hits[0].path.startsWith("docs/"), true);
  assert.equal(body.result.hits[0].sourceUrl.startsWith("https://docs.ones.com/"), true);
  assert.equal(body.result.hits[0].repoSourceUrl.includes("github.com"), true);
});

test("deploy docs public url honors frontmatter id instead of file name", async () => {
  const register = await fetch(`${baseUrl}/api/v1/internal/kb/repos/register`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-portal-surface": "internal"
    },
    body: JSON.stringify({
      repoUrl: "mock://acme/ticket-kb",
      publicBaseUrl: "https://docs.ones.com",
      defaultBranch: "main",
      includePaths: ["deploy-docs/*.md", "deploy-docs/**/*.md"],
      excludePaths: [],
      pollingIntervalSeconds: 60,
      actor: "test"
    })
  });
  assert.equal(register.status, 201);
  const regPayload = (await register.json()) as { registration: { id: string; default_branch: string } };

  await fetch(`${baseUrl}/api/v1/internal/kb/sync/full`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-portal-surface": "internal"
    },
    body: JSON.stringify({
      repoId: regPayload.registration.id,
      branch: regPayload.registration.default_branch,
      afterCommitSha: "mockc2",
      idempotencyKey: "test-deploy-docs-id-route",
      payload: {
        publicationMode: "publish_inline"
      }
    })
  });

  await fetch(`${baseUrl}/api/v1/internal/kb/sync/run`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-portal-surface": "internal"
    },
    body: JSON.stringify({ limit: 20 })
  });

  const retrieval = await fetch(`${baseUrl}/api/v1/kb/retrieval/query`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      query: "KubeVersionMismatch",
      profile: "search",
      repoId: regPayload.registration.id,
      includeFallback: false
    })
  });
  assert.equal(retrieval.status, 200);

  const body = (await retrieval.json()) as {
    result: {
      hits: Array<{ sourceUrl: string; path: string }>;
    };
  };

  assert.equal(body.result.hits.length > 0, true);
  assert.equal(body.result.hits[0].path, "deploy-docs/troubleshooting/infra/k3s-alert-handler.md");
  assert.equal(body.result.hits[0].sourceUrl, "https://docs.ones.com/zh-Hans/deploy/troubleshooting/infra/alert-handler");
});

test("incremental sync is idempotent and propagates deletion", async () => {
  const register = await fetch(`${baseUrl}/api/v1/internal/kb/repos/register`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-portal-surface": "internal"
    },
    body: JSON.stringify({
      repoUrl: "mock://acme/ticket-kb",
      defaultBranch: "main",
      includePaths: ["docs/*.md", "docs/**/*.md"],
      pollingIntervalSeconds: 60,
      actor: "test"
    })
  });
  const regPayload = (await register.json()) as { registration: { id: string; default_branch: string } };

  await fetch(`${baseUrl}/api/v1/internal/kb/sync/full`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-portal-surface": "internal"
    },
    body: JSON.stringify({
      repoId: regPayload.registration.id,
      branch: regPayload.registration.default_branch,
      afterCommitSha: "mockc2",
      idempotencyKey: "full-c2",
      payload: {
        publicationMode: "publish_inline"
      }
    })
  });
  await fetch(`${baseUrl}/api/v1/internal/kb/sync/run`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-portal-surface": "internal"
    },
    body: JSON.stringify({ limit: 20 })
  });

  const inc1 = await fetch(`${baseUrl}/api/v1/internal/kb/sync/incremental`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-portal-surface": "internal"
    },
    body: JSON.stringify({
      repoId: regPayload.registration.id,
      branch: regPayload.registration.default_branch,
      beforeCommitSha: "mockc2",
      afterCommitSha: "mockc3",
      idempotencyKey: "inc-c2-c3"
    })
  });
  assert.equal(inc1.status, 202);
  const incBody1 = (await inc1.json()) as { job: { id: string } };

  const inc2 = await fetch(`${baseUrl}/api/v1/internal/kb/sync/incremental`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-portal-surface": "internal"
    },
    body: JSON.stringify({
      repoId: regPayload.registration.id,
      branch: regPayload.registration.default_branch,
      beforeCommitSha: "mockc2",
      afterCommitSha: "mockc3",
      idempotencyKey: "inc-c2-c3"
    })
  });
  assert.equal(inc2.status, 202);
  const incBody2 = (await inc2.json()) as { job: { id: string } };
  assert.equal(incBody1.job.id, incBody2.job.id);

  await fetch(`${baseUrl}/api/v1/internal/kb/sync/run`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-portal-surface": "internal"
    },
    body: JSON.stringify({ limit: 20 })
  });

  const removed = await pool.query<{ is_active: boolean }>(
    `SELECT is_active FROM kb_documents WHERE repo_id = $1 AND branch = $2 AND path = 'docs/runbook.md' LIMIT 1`,
    [regPayload.registration.id, regPayload.registration.default_branch]
  );
  assert.equal(removed.rowCount, 1);
  assert.equal(removed.rows[0].is_active, false);
});

test("docs-com ensure auto-fixes registration to include mdx and runs sync immediately", async () => {
  const rootDir = await createFixtureRoot();
  const originalMirrorEnabled = env.GITHUB_KB_ENABLE_LOCAL_DOCS_MIRROR;
  env.GITHUB_KB_ENABLE_LOCAL_DOCS_MIRROR = true;
  env.LOCAL_DOCS_COM_PATH = rootDir;

  try {
    await writeFixture(
      rootDir,
      "open-docs/docs/openapi/api/execute-onesql.api.mdx",
      `---
title: "Execute ONESQL query"
---

# Execute ONESQL query

ONESQL supports ORDER BY and GROUP BY clauses in POST /onesql/query.
`
    );
    await writeFixture(
      rootDir,
      "docs/ones-devops/code-integration/github-and-public-gitlab.mdx",
      `---
title: "GitHub 和公共 GitLab"
---

# GitHub 和公共 GitLab

如果授权完成后无法返回 ONES，或者回调页面显示 page not found，请检查 Redirect URI、Webhook 回调地址，以及 baseURL 配置是否一致。
`
    );
    await writeFixture(
      rootDir,
      "deploy-docs/troubleshooting/infra/callback-runbook.mdx",
      `---
title: "Callback Runbook"
---

# Callback Runbook

When callback redirects fail, verify Redirect URI and baseURL deployment wiring before retrying.
`
    );

    const register = await fetch(`${baseUrl}/api/v1/internal/kb/repos/register`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-portal-surface": "internal"
      },
      body: JSON.stringify({
        repoUrl: "mock://BangWork/docs-com",
        publicBaseUrl: "https://docs.ones.com",
        defaultBranch: "master",
        includePaths: ["**/*.md"],
        excludePaths: [],
        pollingIntervalSeconds: 60,
        actor: "test"
      })
    });
    assert.equal(register.status, 201);

    const ensure = await fetch(`${baseUrl}/api/v1/internal/kb/docs-com/ensure`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-portal-surface": "internal"
      },
      body: JSON.stringify({
        mode: "full",
        actor: "test",
        runLimit: 4,
        publicationMode: "publish_inline"
      })
    });
    assert.equal(ensure.status, 202);
    const ensurePayload = (await ensure.json()) as {
      result: {
        registrationChanged: boolean;
        runResult: { processed: number; succeeded: number };
        afterStatus: {
          registration: { repo: string; repoUrl: string; includePaths: string[] };
          sourceSnapshot: { mode: string };
          corpus: Array<{ prefix: string; total: number; active: number }>;
        };
      };
    };

    assert.equal(ensurePayload.result.registrationChanged, true);
    assert.equal(ensurePayload.result.runResult.processed >= 1, true);
    assert.equal(ensurePayload.result.runResult.succeeded >= 1, true);
    assert.equal(ensurePayload.result.afterStatus.registration.repo, "docs/docs-com");
    assert.equal(ensurePayload.result.afterStatus.registration.repoUrl, "https://git.ones.pro/docs/docs-com");
    assert.equal(ensurePayload.result.afterStatus.sourceSnapshot.mode, "local_mirror");
    assert.deepEqual(ensurePayload.result.afterStatus.registration.includePaths, buildDocsComIncludePaths(env.GITHUB_KB_BOOTSTRAP_INCLUDE_PATHS));
    const openDocs = ensurePayload.result.afterStatus.corpus.find((item) => item.prefix === "open-docs/");
    assert.equal(openDocs?.total, 1);
    assert.equal(openDocs?.active, 1);

    const docsComRegistrations = await pool.query<{ repo_owner: string; repo_url: string; is_active: boolean }>(
      `SELECT repo_owner, repo_url, is_active
         FROM kb_repo_registrations
        WHERE repo_name = 'docs-com'
        ORDER BY updated_at DESC`
    );
    const activeDocsComRegistrations = docsComRegistrations.rows.filter((row) => row.is_active);
    assert.equal(activeDocsComRegistrations.length, 1);
    assert.equal(activeDocsComRegistrations[0]?.repo_owner, "docs");
    assert.equal(activeDocsComRegistrations[0]?.repo_url, "https://git.ones.pro/docs/docs-com");

    const legacyRegistration = await pool.query<{ is_active: boolean }>(
      `SELECT is_active
         FROM kb_repo_registrations
        WHERE repo_url = 'mock://BangWork/docs-com'
        ORDER BY updated_at DESC
        LIMIT 1`
    );
    assert.equal(legacyRegistration.rowCount, 1);
    assert.equal(legacyRegistration.rows[0]?.is_active, false);

    const status = await fetch(`${baseUrl}/api/v1/internal/kb/docs-com/status?limit=5`, {
      headers: { "x-portal-surface": "internal" }
    });
    assert.equal(status.status, 200);
    const statusPayload = (await status.json()) as {
      result: {
        exists: boolean;
        status: {
          registration: { branch: string; includePaths: string[] };
          sourceSnapshot: { mode: string };
          corpus: Array<{ prefix: string; total: number; active: number }>;
        };
      };
    };

    assert.equal(statusPayload.result.exists, true);
    assert.equal(statusPayload.result.status.registration.branch, "master");
    assert.equal(statusPayload.result.status.sourceSnapshot.mode, "local_mirror");
    assert.deepEqual(statusPayload.result.status.registration.includePaths, buildDocsComIncludePaths(env.GITHUB_KB_BOOTSTRAP_INCLUDE_PATHS));
    const docsCorpus = statusPayload.result.status.corpus.find((item) => item.prefix === "docs/");
    assert.equal(docsCorpus?.total, 1);
  } finally {
    env.GITHUB_KB_ENABLE_LOCAL_DOCS_MIRROR = originalMirrorEnabled;
    env.LOCAL_DOCS_COM_PATH = originalLocalDocsPath;
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("docs-com ensure full defaults to build_only without implicit publication", async () => {
  const rootDir = await createFixtureRoot();
  const originalMirrorEnabled = env.GITHUB_KB_ENABLE_LOCAL_DOCS_MIRROR;
  env.GITHUB_KB_ENABLE_LOCAL_DOCS_MIRROR = true;
  env.LOCAL_DOCS_COM_PATH = rootDir;

  try {
    await writeFixture(
      rootDir,
      "docs/auth/callback.mdx",
      `---
title: "Callback Troubleshooting"
---

# Callback Troubleshooting

Check Redirect URI, callback address, and baseURL consistency.
`
    );
    await writeFixture(
      rootDir,
      "open-docs/docs/openapi/api/execute-onesql.api.mdx",
      `---
title: "Execute ONESQL query"
---

# Execute ONESQL query

ONESQL supports ORDER BY and GROUP BY clauses in POST /onesql/query.
`
    );
    await writeFixture(
      rootDir,
      "deploy-docs/troubleshooting/infra/callback-runbook.mdx",
      `---
title: "Callback Runbook"
---

# Callback Runbook

When callback redirects fail, verify Redirect URI and baseURL deployment wiring before retrying.
`
    );

    const register = await fetch(`${baseUrl}/api/v1/internal/kb/repos/register`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-portal-surface": "internal"
      },
      body: JSON.stringify({
        repoUrl: "mock://BangWork/docs-com",
        publicBaseUrl: "https://docs.ones.com",
        defaultBranch: "master",
        includePaths: ["**/*.md", "**/*.mdx"],
        excludePaths: [],
        pollingIntervalSeconds: 60,
        actor: "test"
      })
    });
    assert.equal(register.status, 201);
    await register.json();

    const ensure = await fetch(`${baseUrl}/api/v1/internal/kb/docs-com/ensure`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-portal-surface": "internal"
      },
      body: JSON.stringify({
        mode: "full",
        actor: "test",
        runLimit: 4
      })
    });
    assert.equal(ensure.status, 202);

    const activeDocsComRegistration = await pool.query<{ id: string }>(
      `SELECT id
         FROM kb_repo_registrations
        WHERE repo_owner = 'docs'
          AND repo_name = 'docs-com'
          AND is_active = true
        ORDER BY updated_at DESC
        LIMIT 1`
    );
    assert.equal(activeDocsComRegistration.rowCount, 1);

    const builds = await pool.query<{ status: string }>(
      `SELECT status
         FROM kb_builds
        WHERE repo_id = $1
        ORDER BY created_at DESC
        LIMIT 1`,
      [activeDocsComRegistration.rows[0].id]
    );
    assert.equal(builds.rowCount, 1);
    assert.equal(builds.rows[0].status, "validated");

    const publications = await pool.query<{ total: string }>(
      `SELECT COUNT(*)::text AS total
         FROM kb_publications
        WHERE repo_id = $1`,
      [activeDocsComRegistration.rows[0].id]
    );
    assert.equal(publications.rows[0]?.total, "0");
  } finally {
    env.GITHUB_KB_ENABLE_LOCAL_DOCS_MIRROR = originalMirrorEnabled;
    env.LOCAL_DOCS_COM_PATH = originalLocalDocsPath;
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("docs-com sync builds memory graph and grounds callback troubleshooting retrieval", async () => {
  const rootDir = await createFixtureRoot();
  const originalMirrorEnabled = env.GITHUB_KB_ENABLE_LOCAL_DOCS_MIRROR;
  env.GITHUB_KB_ENABLE_LOCAL_DOCS_MIRROR = true;
  env.LOCAL_DOCS_COM_PATH = rootDir;

  try {
    await writeFixture(
      rootDir,
      "open-docs/docs/openapi/api/execute-onesql.api.mdx",
      `---
title: "Execute ONESQL query"
---

# Execute ONESQL query

ONESQL supports ORDER BY and GROUP BY clauses in POST /onesql/query.
`
    );
    await writeFixture(
      rootDir,
      "docs/ones-devops/code-integration/github-and-public-gitlab.mdx",
      `---
title: "GitHub 和公共 GitLab"
---

# GitHub 和公共 GitLab

如果授权完成后无法返回 ONES，或者回调页面显示 page not found，请检查 Redirect URI、Webhook 回调地址，以及 baseURL 配置是否一致。
`
    );
    await writeFixture(
      rootDir,
      "deploy-docs/troubleshooting/infra/callback-runbook.mdx",
      `---
title: "Callback Runbook"
---

# Callback Runbook

When callback redirects fail, verify Redirect URI and baseURL deployment wiring before retrying.
`
    );

    const register = await fetch(`${baseUrl}/api/v1/internal/kb/repos/register`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-portal-surface": "internal"
      },
      body: JSON.stringify({
        repoUrl: "mock://BangWork/docs-com",
        publicBaseUrl: "https://docs.ones.com",
        defaultBranch: "master",
        includePaths: ["**/*.md", "**/*.mdx"],
        excludePaths: [],
        pollingIntervalSeconds: 60,
        actor: "test"
      })
    });
    assert.equal(register.status, 201);
    const regPayload = (await register.json()) as { registration: { id: string; default_branch: string } };

    const enqueue = await fetch(`${baseUrl}/api/v1/internal/kb/sync/full`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-portal-surface": "internal"
      },
      body: JSON.stringify({
        repoId: regPayload.registration.id,
        branch: regPayload.registration.default_branch,
        afterCommitSha: "local-memory-graph",
        idempotencyKey: "docs-com-memory-graph",
        payload: {
          publicationMode: "publish_inline"
        }
      })
    });
    assert.equal(enqueue.status, 202);

    const run = await fetch(`${baseUrl}/api/v1/internal/kb/sync/run`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-portal-surface": "internal"
      },
      body: JSON.stringify({ limit: 10 })
    });
    assert.equal(run.status, 200);

    const counts = await pool.query<{
      entry_count: string;
      alias_count: string;
      signal_count: string;
      source_count: string;
    }>(
      `SELECT
         (SELECT COUNT(*)::text FROM kb_memory_entries) AS entry_count,
         (SELECT COUNT(*)::text FROM kb_memory_aliases) AS alias_count,
         (SELECT COUNT(*)::text FROM kb_memory_signals) AS signal_count,
         (SELECT COUNT(*)::text FROM kb_memory_sources) AS source_count`
    );
    assert.equal(Number(counts.rows[0].entry_count) >= 2, true);
    assert.equal(Number(counts.rows[0].alias_count) >= 1, true);
    assert.equal(Number(counts.rows[0].signal_count) >= 1, true);
    assert.equal(Number(counts.rows[0].source_count) >= 2, true);

    const callbackRetrieval = await fetch(`${baseUrl}/api/v1/kb/retrieval/query`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        query: "GitHub 集成授权后回调页面显示 page not found，怎么排查？",
        profile: "agent",
        repoId: regPayload.registration.id,
        includeFallback: false
      })
    });
    assert.equal(callbackRetrieval.status, 200);
    const callbackBody = (await callbackRetrieval.json()) as {
      result: {
        hits: Array<{ path: string; headingPath: string; sourceUrl: string }>;
      };
    };
    assert.equal(callbackBody.result.hits.length > 0, true);
    assert.equal(callbackBody.result.hits[0].path, "docs/ones-devops/code-integration/github-and-public-gitlab.mdx");
    assert.equal(callbackBody.result.hits[0].sourceUrl.startsWith("https://docs.ones.com/"), true);

    const onesqlRetrieval = await fetch(`${baseUrl}/api/v1/kb/retrieval/query`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        query: "Does ONESQL support ORDER BY and GROUP BY?",
        profile: "search",
        repoId: regPayload.registration.id,
        includeFallback: false
      })
    });
    assert.equal(onesqlRetrieval.status, 200);
    const onesqlBody = (await onesqlRetrieval.json()) as {
      result: {
        hits: Array<{ path: string }>;
      };
    };
    assert.equal(onesqlBody.result.hits[0]?.path, "open-docs/docs/openapi/api/execute-onesql.api.mdx");
  } finally {
    env.GITHUB_KB_ENABLE_LOCAL_DOCS_MIRROR = originalMirrorEnabled;
    env.LOCAL_DOCS_COM_PATH = originalLocalDocsPath;
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("read-only compliance endpoint reports blocked write method", async () => {
  const response = await fetch(`${baseUrl}/api/v1/internal/kb/compliance/read-only`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-portal-surface": "internal"
    },
    body: JSON.stringify({})
  });

  assert.equal(response.status, 200);
  const payload = (await response.json()) as { compliance: { blockedWriteMethod: boolean } };
  assert.equal(payload.compliance.blockedWriteMethod, true);
});
