import { Client } from "pg";
import { config } from "dotenv";

config();

const client = new Client({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const REPO_ID = "923c123e-cc11-4d21-a33f-5947508ac002";
const INCLUDE_PATHS = [
  "docs/**.md",
  "docs/**.mdx",
  "open-docs/**.md",
  "open-docs/**.mdx",
  "deploy-docs/**.md",
  "deploy-docs/**.mdx"
];

async function main() {
  await client.connect();
  try {
    await client.query("BEGIN");

    const reg = await client.query(
      `UPDATE kb_repo_registrations
       SET include_paths = $2::text[],
           updated_at = NOW(),
           last_validation_error = NULL
       WHERE id = $1
       RETURNING id, include_paths, updated_at`,
      [REPO_ID, INCLUDE_PATHS]
    );

    const jobs = await client.query(
      `UPDATE kb_sync_jobs
       SET status = 'dead_letter',
           error_message = 'superseded by fresh canonical full restore',
           finished_at = NOW(),
           updated_at = NOW()
       WHERE repo_id = $1
         AND sync_mode = 'full'
         AND status IN ('queued', 'running')
       RETURNING id, status, error_message, updated_at`,
      [REPO_ID]
    );

    await client.query("COMMIT");
    console.log(JSON.stringify({ registration: reg.rows, deadLetteredJobs: jobs.rows }, null, 2));
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
