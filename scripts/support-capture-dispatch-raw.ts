import crypto from "node:crypto";
import fs from "node:fs";
import { resolveSupervisorContract } from "../apps/api/src/modules/ai/support-contracts.js";

function parseArg(flag: string): string | null {
  const prefix = `${flag}=`;
  const match = process.argv.find((item) => item.startsWith(prefix));
  return match ? match.slice(prefix.length) : null;
}

function loadEnvFile(envFile: string): void {
  for (const line of fs.readFileSync(envFile, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const separatorIndex = line.indexOf("=");
    if (separatorIndex <= 0) continue;
    const key = line.slice(0, separatorIndex).trim();
    let value = line.slice(separatorIndex + 1).trim();
    if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

const questions = [
  "私有化部署里管理员忘记密码且邮件不可用时，应该如何重置管理员密码？",
  "ONES 私有化部署当前支持哪些 Linux 发行版和版本？",
  "GitLab 集成授权后回调页面出现 page not found，优先排查哪些配置？",
  "What is the OpenAPI endpoint and HTTP method to fetch issue details?",
  "For creating an issue comment through OpenAPI, what OAuth scope is required?"
];

async function main(): Promise<void> {
  const envFile = parseArg("--env-file");
  if (!envFile) throw new Error("Missing --env-file=<path>");
  loadEnvFile(envFile);

  const { WsOpenClawAdapter } = await import("../apps/api/src/infrastructure/openclaw/ws-adapter.ts");
  const adapter = new WsOpenClawAdapter() as any;
  const promptPrefix = resolveSupervisorContract().trim();
  const results: Array<Record<string, unknown>> = [];

  for (const query of questions) {
    const prompt = [
      promptPrefix,
      "",
      "Return ONLY valid JSON with keys:",
      "primary_domain(openapi|deployment|integrations|product|troubleshooting),",
      "route({question_type,user_goal,answer_contract,specialist_agent,routing_confidence,specialist_budget,primary_domain}),",
      "case_frame({goal,symptom,object,action_type,deployment_model,product_area,constraints(string[]),missing_critical_info(string[]),retrieval_queries(string[]),query_plan({concept_queries:string[],object_queries:string[],behavior_queries:string[]}),required_doc_kinds(string[]),primary_domain}),",
      "retrieval_queries(string[])",
      "context_type: search",
      "language: zh",
      `user_query: ${query}`
    ].join("\n");

    try {
      const parsed = await adapter.runJsonPrompt(
        prompt,
        `capture-dispatch-raw:${crypto.randomUUID()}`,
        {
          deliveryMode: "interactive",
          overallTimeoutMs: 120000,
          requestStartedAtMs: Date.now(),
          timeoutMs: 24000
        },
        undefined,
        "planner"
      );
      const route = (parsed as Record<string, unknown>)?.route as Record<string, unknown> | undefined;
      results.push({
        query,
        ok: true,
        primary_domain: (parsed as Record<string, unknown>)?.primary_domain ?? null,
        route,
        route_question_type: route?.question_type ?? null,
        route_specialist_agent: route?.specialist_agent ?? null
      });
    } catch (error) {
      results.push({
        query,
        ok: false,
        error: error instanceof Error ? { message: error.message, stack: error.stack } : String(error)
      });
    }
  }

  console.log(JSON.stringify({ generatedAt: new Date().toISOString(), results }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
