import fs from "node:fs";

function loadEnvFile(path: string): void {
  for (const line of fs.readFileSync(path, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator <= 0) continue;
    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

async function main(): Promise<void> {
  loadEnvFile("/Users/jeremypeng/Downloads/Workspace/TicketManagement/.env");
  const { retrieveKnowledge } = await import("../apps/api/src/modules/github-kb/service.js");
  const queries = [
    "Does ONESQL support ORDER BY and GROUP BY?",
    "ONES 是否支持导出报表或统计数据？"
  ];
  const reports: Array<Record<string, unknown>> = [];

  for (const query of queries) {
    const result = await retrieveKnowledge({
      query,
      topK: 8,
      language: "zh",
      answerLanguage: "zh"
    } as never);
    reports.push({
      query,
      retrievalStatus: result.retrievalStatus,
      hitCount: result.hits.length,
      topHits: result.hits.slice(0, 5).map((hit) => ({
        title: hit.title,
        path: hit.path,
        score: hit.score,
        sourceUrl: hit.sourceUrl
      }))
    });
  }

  console.log(JSON.stringify({ generatedAt: new Date().toISOString(), reports }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
