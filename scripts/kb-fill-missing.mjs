import fs from "node:fs/promises";
import path from "node:path";
import { Client } from "pg";

const ROOT = "/tmp/docs-com";
const TARGET_DIRS = ["docs", "open-docs", "deploy-docs"];
const EXTRA_FILES = ["AGENTS.md", "README.md", "CONTRIBUTING.md", "REGION_FILTER_GUIDE.md"];
const EXTRA_GLOB_DIRS = ["scripts", "src"];
const REPO_ID = "c90bbce1-4059-4293-ab72-261df5f447cb";

async function loadEnv() {
  const envText = await fs.readFile(new URL("../.env", import.meta.url), "utf8");
  for (const line of envText.split(/\n+/)) {
    if (!line || line.trim().startsWith("#")) continue;
    const index = line.indexOf("=");
    if (index < 0) continue;
    const key = line.slice(0, index).trim();
    const value = line.slice(index + 1).trim();
    if (!(key in process.env)) process.env[key] = value;
  }
}

async function walkMarkdown(rel = "", output = []) {
  const dir = path.join(ROOT, rel);
  let entries = [];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return output;
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const child = rel ? path.posix.join(rel, entry.name) : entry.name;
    if (entry.isDirectory()) {
      await walkMarkdown(child, output);
      continue;
    }
    if (entry.isFile() && (entry.name.endsWith(".md") || entry.name.endsWith(".mdx"))) {
      output.push(child);
    }
  }
  return output;
}

async function listFilesystemPaths() {
  const files = [];
  for (const dir of TARGET_DIRS) {
    await walkMarkdown(dir, files);
  }
  for (const file of EXTRA_FILES) {
    try {
      await fs.access(path.join(ROOT, file));
      files.push(file);
    } catch {
      // ignore
    }
  }
  const scriptDocs = [];
  await walkMarkdown("scripts", scriptDocs);
  files.push(...scriptDocs);
  const srcDocs = [];
  await walkMarkdown("src", srcDocs);
  files.push(...srcDocs.filter((item) => path.posix.basename(item).toLowerCase() === "readme.md"));
  return [...new Set(files)].sort();
}

async function listDbPaths(client) {
  const result = await client.query(
    `select path from kb_documents where repo_id = '${REPO_ID}' and is_active = true order by path`
  );
  return result.rows.map((row) => row.path);
}

async function main() {
  await loadEnv();
  const svc = await import("../apps/api/dist/modules/github-kb/service.js");
  await svc.bootstrapRepositoryFromEnvIfConfigured();

  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
  });
  await client.connect();

  const filesystemPaths = await listFilesystemPaths();
  let dbPaths = await listDbPaths(client);
  let missing = filesystemPaths.filter((item) => !new Set(dbPaths).has(item));

  console.log(JSON.stringify({ step: "initial", filesystem: filesystemPaths.length, db: dbPaths.length, missing }, null, 2));

  let pass = 0;
  while (missing.length > 0 && pass < 8) {
    pass += 1;
    const result = await svc.runRepositorySyncDirect({
      repoId: REPO_ID,
      branch: "master",
      mode: "full"
    });
    dbPaths = await listDbPaths(client);
    missing = filesystemPaths.filter((item) => !new Set(dbPaths).has(item));
    console.log(
      JSON.stringify(
        {
          step: "pass",
          pass,
          indexed: result.indexed,
          finished: result.finished,
          nextCursor: result.nextCursor,
          db: dbPaths.length,
          missing
        },
        null,
        2
      )
    );
  }

  await client.end();
}

await main();
