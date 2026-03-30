import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { retrieveKnowledge } from "./service.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const datasetSchema = z.array(
  z.object({
    query: z.string().min(1),
    expectedPaths: z.array(z.string().min(1)).default([])
  })
);

async function main() {
  const datasetArg = process.argv[2] ?? "./fixtures/retrieval-eval.json";
  const repoId = process.argv[3];
  const profile = (process.argv[4] as "search" | "agent" | undefined) ?? "search";
  const topK = Number(process.argv[5] ?? 5);

  if (!repoId) {
    throw new Error("Usage: npm run kb:eval -w apps/api -- <datasetPath> <repoId> [profile] [topK]");
  }

  const datasetPath = path.isAbsolute(datasetArg) ? datasetArg : path.resolve(__dirname, datasetArg);
  const raw = await readFile(datasetPath, "utf8");
  const dataset = datasetSchema.parse(JSON.parse(raw));

  let hitQueries = 0;
  let reciprocalRankSum = 0;

  for (const sample of dataset) {
    const result = await retrieveKnowledge({
      query: sample.query,
      profile,
      repoId,
      topK,
      includeFallback: false
    });

    let rr = 0;
    for (let i = 0; i < result.hits.length; i += 1) {
      if (sample.expectedPaths.includes(result.hits[i].path)) {
        rr = 1 / (i + 1);
        break;
      }
    }
    if (rr > 0) hitQueries += 1;
    reciprocalRankSum += rr;
  }

  const total = dataset.length || 1;
  const recallAtK = hitQueries / total;
  const mrr = reciprocalRankSum / total;

  console.log(
    JSON.stringify(
      {
        totalQueries: dataset.length,
        recallAtK,
        mrr,
        profile,
        topK
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
