import assert from "node:assert/strict";
import { test } from "node:test";
import { pool } from "../../db/client.js";
import { searchKeywordCandidates } from "./repository.js";

test("searchKeywordCandidates builds valid lexical score SQL for mixed CJK queries", async () => {
  const originalQuery = pool.query.bind(pool);
  let capturedSql = "";
  let capturedParams: unknown[] = [];
  (pool as typeof pool & { query: typeof pool.query }).query = (async (sql: string, params?: unknown[]) => {
    capturedSql = sql;
    capturedParams = params ?? [];
    return { rows: [] } as unknown as Awaited<ReturnType<typeof pool.query>>;
  }) as typeof pool.query;

  try {
    const hits = await searchKeywordCandidates({
      knowledgeSpace: "support-local",
      query: "Ubuntu Linux Red Hat 发行版 系统要求",
      limit: 20
    });

    assert.deepEqual(hits, []);
    assert.match(capturedSql, /\(\s*0\s*\+\s*\(CASE WHEN doc\.title ILIKE \$2/);
    assert.doesNotMatch(capturedSql, /\(\s*0\s*\(CASE WHEN doc\.title ILIKE \$2/);
    assert.equal(capturedParams[0], "support-local");
    assert.equal(capturedParams[1], "%ubuntu%");
    assert.equal(capturedParams.at(-1), 20);
  } finally {
    (pool as typeof pool & { query: typeof pool.query }).query = originalQuery as typeof pool.query;
  }
});
