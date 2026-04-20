import fs from "node:fs";
import { spawnSync } from "node:child_process";

const envFile = process.argv[2];

if (!envFile) {
  console.error("Usage: node scripts/deploy-preview-with-source-env.mjs <env-file>");
  process.exit(1);
}

const allowKey = (key) =>
  key.startsWith("OPENCLAW_") ||
  key.startsWith("FEATURE_SUPPORT_AGENT_") ||
  key.startsWith("AI_SUPPORT_") ||
  key.startsWith("GITHUB_KB_") ||
  key === "GITHUB_TOKEN_READONLY" ||
  key === "INTERNAL_OPS_TOKEN" ||
  key === "DATABASE_URL" ||
  key === "PG_POOL_MAX";

const args = ["deploy", "--target", "preview", "--yes", "--force"];
for (const line of fs.readFileSync(envFile, "utf8").split(/\r?\n/)) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) continue;
  const separatorIndex = line.indexOf("=");
  if (separatorIndex <= 0) continue;

  const key = line.slice(0, separatorIndex).trim();
  if (!allowKey(key)) continue;

  let value = line.slice(separatorIndex + 1).trim();
  if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
    value = value.slice(1, -1);
  }
  args.push("-e", `${key}=${value}`);
}

const result = spawnSync("vercel", args, {
  stdio: "inherit",
  env: process.env
});

process.exit(result.status ?? 1);
