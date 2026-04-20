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

const envFile = parseArg("--env-file");
const query = parseArg("--query") ?? "GitHub 集成授权后回调页面显示 page not found，怎么排查？";
const timeoutMs = Number.parseInt(parseArg("--timeout-ms") ?? "18000", 10);
const overallTimeoutMs = Number.parseInt(parseArg("--overall-timeout-ms") ?? "22000", 10);

if (!envFile) {
  throw new Error("Missing --env-file=<path>");
}

loadEnvFile(envFile);

async function main(): Promise<void> {
  const [{ WsOpenClawAdapter }, { resolveStageSpecificAgent }] = await Promise.all([
    import("../apps/api/src/infrastructure/openclaw/ws-adapter.ts"),
    import("../apps/api/src/modules/ai/agent-router.ts")
  ]);

  const adapter = new WsOpenClawAdapter();
  const stageAgent = resolveStageSpecificAgent("planner");
  const runtime = {
    deliveryMode: "interactive" as const,
    stage: "planner" as const,
    overallTimeoutMs,
    requestStartedAtMs: Date.now(),
    timeoutMs,
    agentId: stageAgent.agentId,
    model: stageAgent.model,
    sessionKey: `agent:${stageAgent.agentId}:probe:${crypto.randomUUID()}`
  };

  const startedAt = Date.now();

  try {
    const result = await adapter.planSupportDispatch(
      {
        contextType: "search",
        language: "zh",
        query,
        conversationHistory: []
      },
      `probe:${crypto.randomUUID()}`,
      runtime
    );

    console.log(
      JSON.stringify(
        {
          ok: true,
          elapsedMs: Date.now() - startedAt,
          timeoutMs,
          overallTimeoutMs,
          result
        },
        null,
        2
      )
    );
  } catch (error) {
    console.error(
      JSON.stringify(
        {
          ok: false,
          elapsedMs: Date.now() - startedAt,
          timeoutMs,
          overallTimeoutMs,
          error:
            error instanceof Error
              ? {
                  message: error.message,
                  stack: error.stack
                }
              : String(error)
        },
        null,
        2
      )
    );
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
