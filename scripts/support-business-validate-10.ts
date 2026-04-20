import crypto from "node:crypto";
import fs from "node:fs";

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

type ValidationQuestion = {
  id: string;
  language: "zh" | "en";
  query: string;
};

const questions: ValidationQuestion[] = [
  {
    id: "q01_private_reset_without_mail",
    language: "zh",
    query: "私有化部署里管理员忘记密码且邮件不可用时，应该如何重置管理员密码？"
  },
  {
    id: "q02_private_supported_os",
    language: "zh",
    query: "ONES 私有化部署当前支持哪些 Linux 发行版和版本？"
  },
  {
    id: "q03_private_cluster_sizing_500",
    language: "zh",
    query: "私有化部署 K3s 集群版 500 人以内时，每台工作节点的 CPU、内存和磁盘要求是什么？"
  },
  {
    id: "q04_gitlab_callback_404",
    language: "zh",
    query: "GitLab 集成授权后回调页面出现 page not found，优先排查哪些配置？"
  },
  {
    id: "q05_github_webhook_not_triggered",
    language: "zh",
    query: "GitHub 集成后 webhook 没有触发同步，应该先检查哪些项？"
  },
  {
    id: "q06_openapi_issue_detail_endpoint",
    language: "en",
    query: "What is the OpenAPI endpoint and HTTP method to fetch issue details?"
  },
  {
    id: "q07_openapi_comment_scope_variant",
    language: "en",
    query: "For creating an issue comment through OpenAPI, what OAuth scope is required?"
  },
  {
    id: "q08_onesql_sort_and_aggregate",
    language: "en",
    query: "Can ONESQL queries use ORDER BY together with GROUP BY?"
  },
  {
    id: "q09_private_callback_domain_mismatch",
    language: "zh",
    query: "私有化部署场景下，第三方 OAuth 回调域名不一致通常会导致什么问题，怎么定位？"
  },
  {
    id: "q10_export_reporting_capability",
    language: "zh",
    query: "ONES 是否支持导出报表或统计数据？如果支持，通常在哪里操作？"
  }
];

async function main(): Promise<void> {
  const envFile = parseArg("--env-file");
  const output = parseArg("--output") ?? "tmp/support-business-validation-10.json";
  const overallTimeoutMs = Number.parseInt(parseArg("--overall-timeout-ms") ?? "240000", 10);
  const perQuestionTimeoutMs = Number.parseInt(parseArg("--per-question-timeout-ms") ?? "180000", 10);

  if (!envFile) {
    throw new Error("Missing --env-file=<path>");
  }
  loadEnvFile(envFile);

  const [{ WsOpenClawAdapter }, { runSupportSearchAgent }] = await Promise.all([
    import("../apps/api/src/infrastructure/openclaw/ws-adapter.ts"),
    import("../apps/api/src/modules/ai/support-agent.ts")
  ]);

  const adapter = new WsOpenClawAdapter();
  const report: {
    generatedAt: string;
    envFile: string;
    count: number;
    overallTimeoutMs: number;
    items: Array<Record<string, unknown>>;
  } = {
    generatedAt: new Date().toISOString(),
    envFile,
    count: questions.length,
    overallTimeoutMs,
    perQuestionTimeoutMs,
    items: []
  };

  for (const item of questions) {
    const startedAt = Date.now();
    const idempotencyKey = `business-validate-10:${item.id}:${crypto.randomUUID()}`;
    try {
      const execution = await Promise.race([
        runSupportSearchAgent({
          query: item.query,
          language: item.language,
          currentRound: 0,
          conversationHistory: [],
          adapter,
          idempotencyKey,
          runtime: {
            deliveryMode: "async_job",
            overallTimeoutMs,
            requestStartedAtMs: Date.now()
          }
        }),
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error(`per-question timeout after ${perQuestionTimeoutMs}ms`)),
            perQuestionTimeoutMs
          )
        )
      ]);

      const result = execution.result;
      const diagnostics = result.internal_diagnostics ?? {};
      const stageTrace = Array.isArray(diagnostics.stage_trace)
        ? diagnostics.stage_trace.map((stage) => ({
            stage: stage.stage,
            status: stage.timing?.status,
            duration_ms: stage.timing?.duration_ms ?? 0,
            runtime_stage: stage.runtimeStage ?? null
          }))
        : [];

      report.items.push({
        id: item.id,
        query: item.query,
        language: item.language,
        elapsedMs: Date.now() - startedAt,
        answer: result.support_answer?.direct_answer ?? result.answer,
        answerMode: result.support_answer?.mode ?? null,
        renderVariant: result.support_answer?.render_variant ?? null,
        retrievalStatus: result.retrieval_status,
        verificationVerdict: result.verification?.verdict ?? null,
        unresolvedReasonCode: result.unresolved_reason_code,
        route: {
          question_type: diagnostics.route?.question_type ?? null,
          specialist_agent: diagnostics.route?.specialist_agent ?? null,
          primary_domain: diagnostics.route?.primary_domain ?? null
        },
        logic: {
          specialists_used: diagnostics.specialists_used ?? [],
          domains_used: diagnostics.domains_used ?? [],
          retrieval_queries_used: diagnostics.retrieval_queries_used ?? [],
          stage_trace: stageTrace,
          orchestration_trace: diagnostics.orchestration_trace ?? []
        },
        citations: (result.citations ?? []).slice(0, 5).map((citation) => ({
          id: citation.id,
          title: citation.title,
          source_url: citation.source_url
        }))
      });
    } catch (error) {
      report.items.push({
        id: item.id,
        query: item.query,
        language: item.language,
        elapsedMs: Date.now() - startedAt,
        error: error instanceof Error ? { message: error.message, stack: error.stack } : String(error)
      });
    }
  }

  fs.mkdirSync("tmp", { recursive: true });
  fs.writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
