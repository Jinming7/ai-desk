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
  const queryArg = process.argv.find((item) => item.startsWith("--query="));
  loadEnvFile("/Users/jeremypeng/Downloads/Workspace/TicketManagement/.env");
  const { WsOpenClawAdapter } = await import("../apps/api/src/infrastructure/openclaw/ws-adapter.ts");
  const { runSupportSearchAgent } = await import("../apps/api/src/modules/ai/support-agent.ts");
  const adapter = new WsOpenClawAdapter();
  const query = queryArg ? queryArg.slice("--query=".length) : "ONES 私有化部署当前支持哪些 Linux 发行版和版本？";
  const startedAt = Date.now();
  try {
    const execution = await runSupportSearchAgent({
      query,
      language: "zh",
      currentRound: 0,
      conversationHistory: [],
      adapter,
      idempotencyKey: `single-timeout-probe:${Date.now()}`,
      runtime: {
        deliveryMode: "async_job",
        overallTimeoutMs: 300000,
        requestStartedAtMs: Date.now()
      }
    });
    const diagnostics = (execution.result.internal_diagnostics ?? {}) as Record<string, unknown>;
    const stageTrace = Array.isArray(diagnostics.stage_trace)
      ? diagnostics.stage_trace.map((item) => {
          const stage = item as Record<string, unknown>;
          const timing = (stage.timing as Record<string, unknown> | undefined) ?? {};
          return {
            stage: stage.stage ?? null,
            status: stage.status ?? timing.status ?? null,
            runtimeStage: stage.runtimeStage ?? null,
            durationMs: timing.duration_ms ?? null
          };
        })
      : [];

    console.log(
      JSON.stringify(
        {
          ok: true,
          elapsedMs: Date.now() - startedAt,
          retrievalStatus: execution.result.retrieval_status,
          answerMode: execution.result.support_answer?.mode ?? null,
          verificationVerdict: execution.result.verification?.verdict ?? null,
          route: (diagnostics.route as Record<string, unknown> | undefined) ?? null,
          stageTrace
        },
        null,
        2
      )
    );
  } catch (error) {
    console.log(
      JSON.stringify(
        {
          ok: false,
          elapsedMs: Date.now() - startedAt,
          error: error instanceof Error ? error.message : String(error)
        },
        null,
        2
      )
    );
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
