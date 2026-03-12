import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import type { AddressInfo } from "node:net";
import { app } from "../app.js";
import { pool } from "../db/client.js";

let baseUrl = "";
let server: ReturnType<typeof app.listen>;

function assertSafeTestDatabase() {
  const url = process.env.DATABASE_URL ?? "";
  const isLocal = /localhost|127\.0\.0\.1/i.test(url) || /test|supabase/i.test(url);
  if (!isLocal) {
    throw new Error(`Refusing to run github-kb integration tests against database: ${url}`);
  }
}

async function resetKbDb() {
  await pool.query("DELETE FROM kb_chunks");
  await pool.query("DELETE FROM kb_documents");
  await pool.query("DELETE FROM kb_sync_jobs");
  await pool.query("DELETE FROM kb_sync_checkpoints");
  await pool.query("DELETE FROM kb_github_webhook_events");
  await pool.query("DELETE FROM kb_metrics_events");
  await pool.query("DELETE FROM kb_repo_registrations");
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
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
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
      includePaths: ["docs/**/*.md"],
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
      includePaths: ["docs/**/*.md"],
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
