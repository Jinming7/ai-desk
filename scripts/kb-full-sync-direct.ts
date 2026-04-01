import { ensureDocsComKnowledgeBase, getDocsComStatus, runRepositorySyncDirect } from "../apps/api/src/modules/github-kb/service.ts";

async function main() {
  const batchSize = Number(process.env.GITHUB_KB_REMOTE_SYNC_BATCH_SIZE ?? 100);
  process.env.GITHUB_KB_REMOTE_SYNC_BATCH_SIZE = String(batchSize);
  const maxBatchRetries = Number(process.env.KB_BATCH_RETRIES ?? 5);
  const skipEnsure = process.env.KB_SKIP_ENSURE === "1";
  const repoIdFromEnv = process.env.KB_REPO_ID?.trim();
  const branchFromEnv = process.env.KB_BRANCH?.trim();

  if (!skipEnsure) {
    await ensureDocsComKnowledgeBase({ actor: "codex_full_sync", mode: "full", runLimit: 0 });
  }

  const snapshot = await getDocsComStatus({ recentJobLimit: 5 });
  const repoId = repoIdFromEnv || snapshot.status?.registration.id;
  const branch = branchFromEnv || (snapshot.status?.registration.branch ?? "master");
  if (!repoId) {
    throw new Error("docs-com registration missing");
  }

  let cursor: string | undefined;
  let iteration = 0;

  while (true) {
    iteration += 1;
    let result;
    let lastError: Error | null = null;
    for (let attempt = 1; attempt <= maxBatchRetries; attempt += 1) {
      try {
        result = await runRepositorySyncDirect({
          repoId,
          branch,
          mode: "full",
          source: "manual",
          cursor
        });
        lastError = null;
        break;
      } catch (error) {
        lastError = error as Error;
        console.error(
          JSON.stringify(
            {
              iteration,
              attempt,
              cursor: cursor ?? null,
              error: lastError.message
            },
            null,
            2
          )
        );
        if (attempt >= maxBatchRetries) {
          throw lastError;
        }
        await new Promise((resolve) => setTimeout(resolve, attempt * 2000));
      }
    }
    if (!result) {
      throw lastError ?? new Error("full sync batch produced no result");
    }
    console.log(
      JSON.stringify(
        {
          iteration,
          indexed: result.indexed,
          head: result.head,
          finished: result.finished,
          nextCursor: result.nextCursor
        },
        null,
        2
      )
    );
    if (result.finished || !result.nextCursor) break;
    cursor = result.nextCursor;
  }

  const done = await getDocsComStatus({ recentJobLimit: 10 });
  console.log(JSON.stringify(done, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
