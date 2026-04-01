import crypto from "node:crypto";
import fs from "node:fs/promises";
import { execFileSync } from "node:child_process";
import path from "node:path";

const ROOT = "/tmp/docs-com";
const REPO_ID = "c90bbce1-4059-4293-ab72-261df5f447cb";
const TARGETS = [
  "AGENTS.md",
  "CONTRIBUTING.md",
  "README.md",
  "REGION_FILTER_GUIDE.md",
  "docs/billing-and-invoices.mdx",
  "docs/readme.mdx",
  "scripts/batch-tasks/DESIGNS.md",
  "src/components/jsonSchemaViewer/README.md"
];

function sha256(input) {
  return crypto.createHash("sha256").update(input).digest("hex");
}

function pickTitle(filePath, content) {
  const heading = /^(#{1,6})\s+(.+)$/m.exec(content);
  return heading?.[2]?.trim() || path.posix.basename(filePath);
}

async function loadEnv() {
  const envText = await fs.readFile(new URL("../.env", import.meta.url), "utf8");
  for (const line of envText.split(/\n+/)) {
    if (!line || line.trim().startsWith("#")) continue;
    const index = line.indexOf("=");
    if (index < 0) continue;
    process.env[line.slice(0, index).trim()] = line.slice(index + 1).trim();
  }
}

async function main() {
  await loadEnv();
  const repo = await import("../apps/api/dist/modules/github-kb/repository.js");
  const { buildChunks } = await import("../apps/api/dist/modules/github-kb/chunker.js");
  const { parseMarkdownSections } = await import("../apps/api/dist/modules/github-kb/markdown.js");
  const { buildSourceUrl } = await import("../apps/api/dist/modules/github-kb/github-client.js");
  const { buildPublicSourceUrl } = await import("../apps/api/dist/modules/github-kb/public-url.js");
  const { env } = await import("../apps/api/dist/config/env.js");

  const registration = await repo.getRepoRegistrationById(REPO_ID);
  if (!registration) throw new Error(`registration not found: ${REPO_ID}`);

  const commitSha = execFileSync("git", ["-C", ROOT, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const branch = registration.default_branch;
  const imported = [];

  for (const relativePath of TARGETS) {
    const absolutePath = path.join(ROOT, relativePath);
    const content = await fs.readFile(absolutePath, "utf8");
    const title = pickTitle(relativePath, content);
    const repoSourceUrl = buildSourceUrl(registration, relativePath, commitSha);
    const publicSourceUrl = buildPublicSourceUrl(registration, relativePath, content);
    const doc = await repo.upsertDocument({
      repoId: registration.id,
      branch,
      path: relativePath,
      title,
      sourceUrl: publicSourceUrl ?? repoSourceUrl,
      repoSourceUrl,
      publicSourceUrl,
      commitSha,
      contentHash: sha256(content),
      content,
      metadata: {
        parser: "manual-import",
        contentTransform: "none",
        publicSourceUrlResolved: Boolean(publicSourceUrl),
        includePaths: registration.include_paths,
        excludePaths: registration.exclude_paths
      }
    });

    await repo.deactivateChunksByDocument(doc.id);

    const sections = parseMarkdownSections(content);
    const chunks = buildChunks(doc.doc_key, sections, {
      targetTokens: env.GITHUB_KB_CHUNK_TARGET_TOKENS,
      overlapTokens: env.GITHUB_KB_CHUNK_OVERLAP_TOKENS
    });

    for (const chunk of chunks) {
      await repo.upsertChunk({
        id: chunk.id,
        docId: doc.id,
        repoId: registration.id,
        branch,
        path: relativePath,
        commitSha,
        headingPath: chunk.headingPath,
        ordinal: chunk.ordinal,
        content: chunk.content,
        contentHash: chunk.contentHash,
        tokenCount: chunk.tokenCount,
        metadata: {
          sectionOrder: chunk.metadata.sectionOrder,
          sectionTitle: chunk.metadata.sectionTitle,
          embeddingState: "missing"
        },
        embedding: null,
        embeddingModel: null,
        embeddingVersion: null
      });
    }

    imported.push({ path: relativePath, chunks: chunks.length, publicSourceUrl });
  }

  console.log(JSON.stringify({ imported }, null, 2));
}

await main();
