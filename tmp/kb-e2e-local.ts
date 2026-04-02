import { registerRepository, runRepositorySyncDirect, promoteValidatedBuild } from "../apps/api/src/modules/github-kb/service.ts";
import * as repo from "../apps/api/src/modules/github-kb/repository.ts";
import { pool } from "../apps/api/src/db/client.ts";

async function main() {
  await pool.query(
    "DELETE FROM kb_publications WHERE repo_id IN (SELECT id FROM kb_repo_registrations WHERE repo_owner = $1 AND repo_name = $2)",
    ["Jinming7", "ai-desk"]
  );
  await pool.query(
    "DELETE FROM kb_serving_versions WHERE repo_id IN (SELECT id FROM kb_repo_registrations WHERE repo_owner = $1 AND repo_name = $2)",
    ["Jinming7", "ai-desk"]
  );
  await pool.query(
    "DELETE FROM kb_build_validation_results WHERE build_id IN (SELECT id FROM kb_builds WHERE repo_id IN (SELECT id FROM kb_repo_registrations WHERE repo_owner = $1 AND repo_name = $2))",
    ["Jinming7", "ai-desk"]
  );
  await pool.query(
    "DELETE FROM kb_builds WHERE repo_id IN (SELECT id FROM kb_repo_registrations WHERE repo_owner = $1 AND repo_name = $2)",
    ["Jinming7", "ai-desk"]
  );
  await pool.query("DELETE FROM kb_repo_registrations WHERE repo_owner = $1 AND repo_name = $2", ["Jinming7", "ai-desk"]);

  const includePaths = [
    "docs/**/*.md",
    "docs/**/*.mdx",
    "apps/api/openapi.yaml",
    "apps/api/src/**/*.ts",
    "apps/api/src/db/migrations/**/*.sql",
    ".env.example",
    "scripts/**/*.ts",
    "scripts/**/*.mjs"
  ];

  const registrationResult = await registerRepository({
    repoUrl: "https://github.com/Jinming7/ai-desk.git",
    defaultBranch: "main",
    includePaths,
    excludePaths: ["node_modules/**", "dist/**", "build/**", ".github/**", ".claude/**"],
    pollingIntervalSeconds: 300,
    actor: "internal_operator"
  });

  let cursor: string | undefined;
  let lastResult: Awaited<ReturnType<typeof runRepositorySyncDirect>> | null = null;
  for (let i = 0; i < 50; i += 1) {
    lastResult = await runRepositorySyncDirect({
      repoId: registrationResult.registration.id,
      branch: registrationResult.registration.default_branch,
      mode: "full",
      source: "manual",
      cursor,
      executionId: "local-e2e-ai-desk"
    });
    if (lastResult.finished) break;
    cursor = lastResult.nextCursor ?? undefined;
  }
  if (!lastResult?.finished) {
    throw new Error(`full sync did not finish after repeated batches; nextCursor=${String(lastResult?.nextCursor ?? "")}`);
  }

  const build = await repo.getBuildByVersion({
    knowledgeSpace: "support-local",
    repoId: registrationResult.registration.id,
    branch: registrationResult.registration.default_branch,
    buildVersion: lastResult.head
  });
  if (!build) throw new Error(`validated build missing for ${lastResult.head}`);

  const promoted = await promoteValidatedBuild({ buildId: build.id, actor: "internal_operator" });
  const artifactSummary = await repo.getBuildArtifactSummary({
    knowledgeSpace: build.knowledge_space,
    repoId: build.repo_id,
    branch: build.branch,
    buildVersion: build.build_version
  });
  const validationRows = await pool.query(
    "SELECT validation_kind, passed::text, severity FROM kb_build_validation_results WHERE build_id = $1 ORDER BY validation_kind",
    [build.id]
  );
  const publication = await repo.getPublication({ knowledgeSpace: build.knowledge_space, repoId: build.repo_id, branch: build.branch });
  const serving = await repo.getServingVersion({ repoId: build.repo_id, branch: build.branch });

  console.log(
    JSON.stringify(
      {
        registration: {
          id: registrationResult.registration.id,
          repo: `${registrationResult.registration.repo_owner}/${registrationResult.registration.repo_name}`,
          branch: registrationResult.registration.default_branch
        },
        syncResult: lastResult,
        build: {
          id: promoted.build.id,
          status: promoted.build.status,
          buildVersion: promoted.build.build_version,
          validationPassed: promoted.build.validation_passed
        },
        publication,
        serving,
        validationCount: validationRows.rowCount,
        artifactSummary
      },
      null,
      2
    )
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
