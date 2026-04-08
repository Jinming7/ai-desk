import assert from "node:assert/strict";
import { test } from "node:test";
import { pool } from "../../db/client.js";
import { replaceRelationsForMemoryIds } from "./memory-repository.js";

test("replaceRelationsForMemoryIds writes relations transactionally and filters missing memory rows at insert time", async () => {
  const queries: Array<{ sql: string; params?: unknown[] }> = [];
  const originalConnect = pool.connect.bind(pool);
  const fakeClient = {
    async query(sql: string, params?: unknown[]) {
      queries.push({ sql, params });
      return { rows: [] };
    },
    release() {}
  };

  (pool as typeof pool & { connect: typeof pool.connect }).connect = (async () => fakeClient as never) as typeof pool.connect;

  try {
    await replaceRelationsForMemoryIds(
      ["7ca4f868-e5d4-45c5-b12f-dc9e28340429", "ec64b043-5dd6-4c8a-9363-0509df2cd9d8"],
      [
        {
          id: "ef5e932d-bf19-43c7-bf6b-fdc1846f5b77",
          from_memory_id: "7ca4f868-e5d4-45c5-b12f-dc9e28340429",
          to_memory_id: "ec64b043-5dd6-4c8a-9363-0509df2cd9d8",
          relation_type: "extends",
          weight: 0.72,
          metadata_json: { similarity: 0.61 }
        }
      ]
    );
  } finally {
    (pool as typeof pool & { connect: typeof pool.connect }).connect = originalConnect as typeof pool.connect;
  }

  assert.match(queries[0]?.sql ?? "", /^BEGIN$/);
  assert.match(queries[1]?.sql ?? "", /DELETE FROM kb_memory_relations/);
  const insertQuery = queries.find((item) => /INSERT INTO kb_memory_relations/.test(item.sql));
  assert.ok(insertQuery);
  assert.match(insertQuery?.sql ?? "", /INNER JOIN kb_memory_entries AS from_entry/);
  assert.match(insertQuery?.sql ?? "", /INNER JOIN kb_memory_entries AS to_entry/);
  assert.match(queries.at(-1)?.sql ?? "", /^COMMIT$/);
});
