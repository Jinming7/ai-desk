import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pool } from "./client.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function run() {
  const client = await pool.connect();
  try {
    const dir = path.join(__dirname, "migrations");
    const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();

    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        id SERIAL PRIMARY KEY,
        filename TEXT UNIQUE NOT NULL,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    for (const filename of files) {
      const exists = await client.query("SELECT 1 FROM schema_migrations WHERE filename = $1", [filename]);
      if (exists.rowCount) {
        continue;
      }
      const sql = await readFile(path.join(dir, filename), "utf-8");
      await client.query("BEGIN");
      await client.query(sql);
      await client.query("INSERT INTO schema_migrations(filename) VALUES($1)", [filename]);
      await client.query("COMMIT");
      console.log(`Applied migration: ${filename}`);
    }
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
