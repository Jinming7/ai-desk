import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { after, before, beforeEach, test } from "node:test";
import type { AddressInfo } from "node:net";
import { app } from "../app.js";
import { pool } from "../db/client.js";
import { env, isSafeTestDatabaseUrl } from "../config/env.js";
import * as githubClient from "../modules/github-kb/github-client.js";
import * as githubRepo from "../modules/github-kb/repository.js";
import { runDueSyncJobs } from "../modules/github-kb/service.js";

let baseUrl = "";
let server: ReturnType<typeof app.listen>;
const originalLocalDocsPath = env.LOCAL_DOCS_COM_PATH;

function assertSafeTestDatabase() {
  const url = process.env.DATABASE_URL ?? env.DATABASE_URL;
  if (!isSafeTestDatabaseUrl(url)) {
    throw new Error("Refusing to run github-kb integration tests against a non-local database");
  }
}

async function resetKbDb() {
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
  assertSafeTestDatabase();
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
});

beforeEach(async () => {
  await resetKbDb();
  env.LOCAL_DOCS_COM_PATH = originalLocalDocsPath;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  env.LOCAL_DOCS_COM_PATH = originalLocalDocsPath;
  await pool.end();
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
      idempotencyKey: "test-full-sync"
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
        idempotencyKey: "test-remote-full-batch"
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
      repoUrl: "https://github.com/BangWork/docs-com",
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
      targetHead: "mock-docs-head",
      requestedBy: "test",
      runReason: "transient-db-timeout",
      sourceSnapshotTotal: 1,
      manifestItems: [
        {
          path: "docs/example/transient-timeout.mdx",
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
      afterCommitSha: "mock-docs-head",
      payload: {
        runId: run.id,
        shardKey: "docs",
        targetHead: "mock-docs-head",
        buildVersion: `mock-docs-head:${run.id}`,
        sourceMode: "remote"
      }
    });

    t.mock.method(githubClient, "validateReadOnlyAccess", async () => ({
      ok: true,
      scopes: ["mock:readonly"],
      message: "mocked"
    }));
    t.mock.method(githubClient, "getFileContentAtCommit", async () => "# Example\n\nTransient db timeout should retry.");

    t.mock.method(githubRepo, "updateManifestItemBuildStatus", async () => {
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
      idempotencyKey: "test-public-docs-url"
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
      idempotencyKey: "test-deploy-docs-id-route"
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
      idempotencyKey: "full-c2"
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

    const register = await fetch(`${baseUrl}/api/v1/internal/kb/repos/register`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-portal-surface": "internal"
      },
      body: JSON.stringify({
        repoUrl: "https://github.com/BangWork/docs-com",
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
        runLimit: 4
      })
    });
    assert.equal(ensure.status, 202);
    const ensurePayload = (await ensure.json()) as {
      result: {
        registrationChanged: boolean;
        runResult: { processed: number; succeeded: number };
        afterStatus: {
          registration: { includePaths: string[] };
          corpus: Array<{ prefix: string; total: number; active: number }>;
        };
      };
    };

    assert.equal(ensurePayload.result.registrationChanged, true);
    assert.equal(ensurePayload.result.runResult.processed >= 1, true);
    assert.equal(ensurePayload.result.runResult.succeeded >= 1, true);
    assert.deepEqual(ensurePayload.result.afterStatus.registration.includePaths, ["**/*.md", "**/*.mdx"]);
    const openDocs = ensurePayload.result.afterStatus.corpus.find((item) => item.prefix === "open-docs/");
    assert.equal(openDocs?.total, 1);
    assert.equal(openDocs?.active, 1);

    const status = await fetch(`${baseUrl}/api/v1/internal/kb/docs-com/status?limit=5`, {
      headers: { "x-portal-surface": "internal" }
    });
    assert.equal(status.status, 200);
    const statusPayload = (await status.json()) as {
      result: {
        exists: boolean;
        status: {
          registration: { branch: string; includePaths: string[] };
          corpus: Array<{ prefix: string; total: number; active: number }>;
        };
      };
    };

    assert.equal(statusPayload.result.exists, true);
    assert.equal(statusPayload.result.status.registration.branch, "master");
    assert.deepEqual(statusPayload.result.status.registration.includePaths, ["**/*.md", "**/*.mdx"]);
    const docsCorpus = statusPayload.result.status.corpus.find((item) => item.prefix === "docs/");
    assert.equal(docsCorpus?.total, 1);
  } finally {
    env.LOCAL_DOCS_COM_PATH = originalLocalDocsPath;
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("docs-com sync builds memory graph and grounds callback troubleshooting retrieval", async () => {
  const rootDir = await createFixtureRoot();
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

    const register = await fetch(`${baseUrl}/api/v1/internal/kb/repos/register`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-portal-surface": "internal"
      },
      body: JSON.stringify({
        repoUrl: "https://github.com/BangWork/docs-com",
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
        idempotencyKey: "docs-com-memory-graph"
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
