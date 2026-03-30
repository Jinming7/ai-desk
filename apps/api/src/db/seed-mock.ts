import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pool } from "./client.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function run() {
  const client = await pool.connect();
  try {
    const sql = await readFile(path.join(__dirname, "migrations", "009_seed_mock_support_tickets.sql"), "utf-8");
    await client.query("BEGIN");
    await client.query(sql);
    await client.query("COMMIT");
    console.log("Mock tickets seeded from 009_seed_mock_support_tickets.sql");
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
