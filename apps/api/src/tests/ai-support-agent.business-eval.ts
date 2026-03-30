import http from "node:http";
import { app } from "../app.js";
import * as aiRepo from "../modules/ai/repository.js";

type SearchResult = {
  result: {
    session_id: string;
    answer: string;
    answer_language: "zh" | "en";
    support_answer?: {
      mode: "grounded" | "partial" | "clarification" | "handoff";
      direct_answer: string;
      why: string[];
      what_to_do_now: string[];
      still_need_to_confirm: string[];
    };
    verification?: {
      verdict: "verified" | "partial" | "unsupported";
    };
    citations: Array<{ id: string; title: string; source_url: string }>;
    retrieval_status: "grounded" | "no_results" | "kb_unavailable";
    unresolved_reason_code: string | null;
    clarification_round: number;
    follow_up_question: string | null;
    show_create_ticket_now: boolean;
  };
};

const scenarios = [
  {
    id: "zh_api_token_reset",
    language: "zh" as const,
    query: "怎么重置 API token 访问权限？",
    expectDocsEvidence: true,
    expectedBehavior: "至少给出 docs-backed 回答，或者在确实缺信息时只问一个高价值问题。"
  },
  {
    id: "zh_github_callback_404",
    language: "zh" as const,
    query: "GitHub 集成授权后回调页面显示 page not found，怎么排查？",
    expectDocsEvidence: true,
    expectedBehavior: "应优先给出回调地址、部署方式、代理/域名配置相关的可执行排查步骤。"
  },
  {
    id: "en_openapi_comment_scope",
    language: "en" as const,
    query: "What scope is required to create an issue comment via OpenAPI?",
    expectDocsEvidence: true,
    expectedBehavior: "如果找得到精确 scope，应返回精确 scope；找不到也应说明证据缺口，不要伪造。"
  },
  {
    id: "en_onesql_order_by",
    language: "en" as const,
    query: "Does ONESQL support ORDER BY and GROUP BY?",
    expectDocsEvidence: true,
    expectedBehavior: "应先直接回答 ONESQL 是否支持这些子句，并且引用必须是 ONESQL 相关文档，而不是无关配置页。"
  }
];

function extractFocusTerms(input: string): string[] {
  const ascii = [...input.toLowerCase().matchAll(/[a-z0-9:_./-]{3,}/g)].map((match) => match[0]);
  const cjk = [...input.matchAll(/[\u4e00-\u9fff]{2,}/g)].map((match) => match[0]);
  return [...new Set([...ascii, ...cjk])].slice(0, 12);
}

function summarizeEvaluation(input: {
  language: "zh" | "en";
  durationMs: number;
  scenario: (typeof scenarios)[number];
  payload: SearchResult["result"];
}) {
  const notes: string[] = [];
  const answerText = input.payload.support_answer?.direct_answer ?? input.payload.answer;
  if (input.payload.answer_language !== input.language) {
    notes.push("语言与用户提问不一致");
  }
  if (input.scenario.expectDocsEvidence && input.payload.citations.length === 0) {
    notes.push("没有返回任何 docs 证据");
  }
  if (input.payload.support_answer?.mode === "handoff" && !input.payload.follow_up_question) {
    notes.push("直接 handoff，没有给出 targeted clarification");
  }
  const focusTerms = extractFocusTerms(input.scenario.query);
  const irrelevantCitation = input.payload.citations.find((citation) => {
    const haystack = `${citation.title} ${citation.source_url}`.toLowerCase();
    return focusTerms.length > 0 && !focusTerms.some((term) => haystack.includes(term));
  });
  if (irrelevantCitation) {
    notes.push(`存在弱相关 citation: ${irrelevantCitation.title}`);
  }
  if (/verification|evidence gap|unsupported claims|why this is still needed/i.test(answerText)) {
    notes.push("泄露了内部框架语言");
  }
  if (/onesql/i.test(input.scenario.query) && !/onesql|order by|group by/i.test(answerText)) {
    notes.push("没有直接回答 ONESQL / ORDER BY / GROUP BY 问题");
  }
  if (/scope|oauth|comment/i.test(input.scenario.query) && !/scope|oauth|comment|issue comment/i.test(answerText)) {
    notes.push("没有直接回答 scope / OAuth 问题");
  }
  if (
    input.language === "en" &&
    input.payload.support_answer?.mode !== "grounded" &&
    !/\b(sorry|recommend|please|currently|could|would)\b/i.test(answerText)
  ) {
    notes.push("support tone is not polite enough");
  }
  if (input.payload.clarification_round > 0 && input.payload.support_answer?.mode !== "clarification") {
    notes.push("clarification_round 与最终 mode 不一致");
  }
  if (input.durationMs > 30_000) {
    notes.push(`耗时过长 (${input.durationMs}ms)`);
  }

  const verdict =
    notes.length === 0
      ? "pass"
      : notes.some((note) =>
          /没有返回任何 docs 证据|耗时过长|存在弱相关 citation|没有直接回答|泄露了内部框架语言/.test(note)
        )
      ? "fail"
      : "warn";
  return { verdict, notes };
}

async function startServer() {
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to resolve eval server address");
  }
  return { server, port: address.port };
}

async function requestJson<T>(port: number, path: string, body: unknown): Promise<T> {
  return await new Promise<T>((resolve, reject) => {
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path,
        method: "POST",
        headers: { "Content-Type": "application/json" }
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          if ((res.statusCode ?? 500) >= 400) {
            reject(new Error(`HTTP ${res.statusCode}: ${text}`));
            return;
          }
          resolve(JSON.parse(text) as T);
        });
      }
    );
    req.on("error", reject);
    req.write(JSON.stringify(body));
    req.end();
  });
}

async function main() {
  const { server, port } = await startServer();
  try {
    const scenarioFilter = new Set(
      process.argv
        .filter((arg) => arg.startsWith("--scenario="))
        .flatMap((arg) => arg.slice("--scenario=".length).split(","))
        .map((item) => item.trim())
        .filter(Boolean)
    );
    const selectedScenarios = scenarioFilter.size > 0 ? scenarios.filter((item) => scenarioFilter.has(item.id)) : scenarios;
    const reports = [];
    for (const scenario of selectedScenarios) {
      const startedAt = Date.now();
      const response = await requestJson<SearchResult>(port, "/api/v1/ai/search", {
        query: scenario.query,
        answerLanguage: scenario.language
      });
      const durationMs = Date.now() - startedAt;
      const dialogState = await aiRepo.getDialogState(response.result.session_id);
      const stageTimings = ((dialogState?.retrieval_outcome?.diagnostics ?? {}) as Record<string, unknown>).stage_timings ?? null;
      const evaluation = summarizeEvaluation({
        language: scenario.language,
        durationMs,
        scenario,
        payload: response.result
      });

      reports.push({
        id: scenario.id,
        query: scenario.query,
        expected_behavior: scenario.expectedBehavior,
        duration_ms: durationMs,
        output: {
          answer_language: response.result.answer_language,
          mode: response.result.support_answer?.mode,
          direct_answer: response.result.support_answer?.direct_answer ?? response.result.answer,
          why: response.result.support_answer?.why ?? [],
          what_to_do_now: response.result.support_answer?.what_to_do_now ?? [],
          still_need_to_confirm: response.result.support_answer?.still_need_to_confirm ?? [],
          verification: response.result.verification?.verdict ?? null,
          citations: response.result.citations.map((item) => ({
            id: item.id,
            title: item.title,
            source_url: item.source_url
          })),
          retrieval_status: response.result.retrieval_status,
          unresolved_reason_code: response.result.unresolved_reason_code,
          clarification_round: response.result.clarification_round,
          follow_up_question: response.result.follow_up_question,
          show_create_ticket_now: response.result.show_create_ticket_now,
          stage_timings: stageTimings
        },
        evaluation
      });
    }

    console.log(JSON.stringify({ generated_at: new Date().toISOString(), reports }, null, 2));
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
