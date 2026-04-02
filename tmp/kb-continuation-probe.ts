import { registerRepository, runRepositorySyncDirect } from "../apps/api/src/modules/github-kb/service.ts";
import { pool } from "../apps/api/src/db/client.ts";

const OWNER = "Jinming7";
const REPO = "ai-desk";
const EXECUTION_ID = "probe-run";
const INCLUDE_PATHS = [
  "docs/**/*.md",
  "docs/**/*.mdx",
  "apps/api/openapi.yaml",
  "apps/api/src/**/*.ts",
  "apps/api/src/db/migrations/**/*.sql",
  ".env.example",
  "scripts/**/*.ts",
  "scripts/**/*.mjs"
];

async function cleanupLocalState(): Promise<void> {
  await pool.query(
    "DELETE FROM kb_publications WHERE repo_id IN (SELECT id FROM kb_repo_registrations WHERE repo_owner = $1 AND repo_name = $2)",
    [OWNER, REPO]
  );
  await pool.query(
    "DELETE FROM kb_serving_versions WHERE repo_id IN (SELECT id FROM kb_repo_registrations WHERE repo_owner = $1 AND repo_name = $2)",
    [OWNER, REPO]
  );
  await pool.query(
    "DELETE FROM kb_build_validation_results WHERE build_id IN (SELECT id FROM kb_builds WHERE repo_id IN (SELECT id FROM kb_repo_registrations WHERE repo_owner = $1 AND repo_name = $2))",
    [OWNER, REPO]
  );
  await pool.query(
    "DELETE FROM kb_builds WHERE repo_id IN (SELECT id FROM kb_repo_registrations WHERE repo_owner = $1 AND repo_name = $2)",
    [OWNER, REPO]
  );
  await pool.query("DELETE FROM kb_repo_registrations WHERE repo_owner = $1 AND repo_name = $2", [OWNER, REPO]);
}

async function getRegistration() {
  const existing = await pool.query<{ id: string; default_branch: string }>(
    "SELECT id::text, default_branch FROM kb_repo_registrations WHERE repo_owner = $1 AND repo_name = $2 AND is_active = true ORDER BY created_at DESC LIMIT 1",
    [OWNER, REPO]
  );
  if (existing.rows[0]) return existing.rows[0];

  const registered = await registerRepository({
    repoUrl: `https://github.com/${OWNER}/${REPO}.git`,
    defaultBranch: "main",
    includePaths: INCLUDE_PATHS,
    excludePaths: ["node_modules/**", "dist/**", "build/**", ".github/**", ".claude/**"],
    pollingIntervalSeconds: 300,
    actor: "internal_operator"
  });
  const confirmation = await pool.query(
    "SELECT id::text, repo_owner, repo_name, default_branch, is_active::text FROM kb_repo_registrations ORDER BY created_at DESC"
  );
  console.log(
    JSON.stringify(
      {
        label: "post-register-confirmation",
        selectedRegistration: {
          id: registered.registration.id,
          repo_owner: registered.registration.repo_owner,
          repo_name: registered.registration.repo_name,
          default_branch: registered.registration.default_branch
        },
        registrations: confirmation.rows
      },
      null,
      2
    )
  );
  return {
    id: registered.registration.id,
    default_branch: registered.registration.default_branch
  };
}

async function printState(label: string, repoId: string) {
  const [registrations, builds, counts, publication, serving, validations] = await Promise.all([
    pool.query(
      "SELECT id::text, repo_owner, repo_name, default_branch, is_active::text FROM kb_repo_registrations WHERE repo_owner = $1 AND repo_name = $2 ORDER BY created_at DESC",
      [OWNER, REPO]
    ),
    pool.query(
      "SELECT id::text, build_version, status, validation_passed::text, error_message FROM kb_builds WHERE repo_id = $1 ORDER BY created_at DESC",
      [repoId]
    ),
    pool.query(
      `SELECT
         (SELECT COUNT(*)::text FROM kb_documents WHERE repo_id = $1) AS docs,
         (SELECT COUNT(*)::text FROM kb_chunks WHERE repo_id = $1) AS chunks,
         (SELECT COUNT(*)::text FROM kb_citation_units WHERE repo_id = $1) AS citations,
         (SELECT COUNT(*)::text FROM kb_memory_entries WHERE repo_id = $1) AS memories,
         (SELECT COUNT(*)::text FROM kb_code_symbols WHERE repo_id = $1) AS code_symbols,
         (SELECT COUNT(*)::text FROM kb_config_surfaces WHERE repo_id = $1) AS config_surfaces,
         (SELECT COUNT(*)::text FROM kb_schema_objects WHERE repo_id = $1) AS schema_objects,
         (SELECT COUNT(*)::text FROM kb_test_behaviors WHERE repo_id = $1) AS test_behaviors`,
      [repoId]
    ),
    pool.query(
      "SELECT knowledge_space, branch, published_build_version, published_head, published_from_env FROM kb_publications WHERE repo_id = $1 ORDER BY published_at DESC",
      [repoId]
    ),
    pool.query(
      "SELECT branch, active_build_version, active_head FROM kb_serving_versions WHERE repo_id = $1 ORDER BY updated_at DESC",
      [repoId]
    ),
    pool.query(
      "SELECT b.build_version, COUNT(*)::text AS validation_rows FROM kb_build_validation_results r INNER JOIN kb_builds b ON b.id = r.build_id WHERE b.repo_id = $1 GROUP BY b.build_version ORDER BY b.build_version",
      [repoId]
    )
  ]);

  console.log(
    JSON.stringify(
      {
        label,
        registrations: registrations.rows,
        builds: builds.rows,
        counts: counts.rows[0] ?? {},
        publications: publication.rows,
        serving: serving.rows,
        validations: validations.rows
      },
      null,
      2
    )
  );
}

async function main() {
  const fresh = process.argv.includes("--fresh");
  const maxBatchesArg = process.argv.find((arg) => arg.startsWith("--max-batches="));
  const cursorArg = process.argv.find((arg) => arg.startsWith("--cursor="));
  const maxBatches = Number(maxBatchesArg?.split("=")[1] ?? "20");

  if (fresh) {
    await cleanupLocalState();
  }

  const registration = await getRegistration();
  await printState("before-run", registration.id);

  let cursor = cursorArg?.slice("--cursor=".length) || undefined;
  for (let index = 0; index < maxBatches; index += 1) {
    try {
      const result = await runRepositorySyncDirect({
        repoId: registration.id,
        branch: registration.default_branch,
        mode: "full",
        source: "manual",
        cursor,
        executionId: EXECUTION_ID
      });
      console.log(JSON.stringify({ batch: index + 1, cursor: cursor ?? null, result }, null, 2));
      await printState(`after-batch-${index + 1}`, registration.id);
      if (result.finished) return;
      cursor = result.nextCursor ?? undefined;
      if (!cursor) {
        throw new Error("full sync returned unfinished result without nextCursor");
      }
    } catch (error) {
      console.error("PROBE_ERROR", error);
      await printState(`after-error-batch-${index + 1}`, registration.id);
      throw error;
    }
  }

  throw new Error(`probe stopped after ${maxBatches} batches without finishing`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end().catch(() => undefined);
  });
