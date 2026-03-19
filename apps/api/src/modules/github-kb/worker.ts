import { env } from "../../config/env.js";
import {
  bootstrapRepositoryFromEnvIfConfigured,
  pollAndEnqueueIncremental,
  runDueSyncJobs,
  validateStartupConfig
} from "./service.js";

async function tick() {
  await runDueSyncJobs(env.GITHUB_KB_WORKER_BATCH_SIZE);
  await pollAndEnqueueIncremental(env.GITHUB_KB_POLL_BATCH_SIZE);
}

async function main() {
  if (!env.GITHUB_KB_ENABLED) {
    console.log("github-kb worker disabled by config");
    return;
  }

  await bootstrapRepositoryFromEnvIfConfigured();
  const health = await validateStartupConfig();
  console.log(`github-kb startup validation: healthy=${health.healthy}, repos=${health.checkedRepos}`);

  await tick();
  setInterval(() => {
    void tick().catch((error) => {
      console.error("github-kb worker tick failed", error);
    });
  }, env.GITHUB_KB_WORKER_INTERVAL_SECONDS * 1000);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
