const baseUrl = String(process.env.SUPPORT_SMOKE_BASE_URL ?? process.env.KB_AUTOMATION_BASE_URL ?? "").replace(/\/$/, "");
const basicUser = String(process.env.SUPPORT_SMOKE_BASIC_USER ?? "").trim();
const basicPass = String(process.env.SUPPORT_SMOKE_BASIC_PASS ?? "").trim();
const maxAttempts = Number(process.env.SUPPORT_SMOKE_MAX_ATTEMPTS ?? 20);
const waitMs = Number(process.env.SUPPORT_SMOKE_WAIT_MS ?? 15000);

if (!baseUrl) {
  console.log("[support-smoke] skipped: SUPPORT_SMOKE_BASE_URL is missing");
  process.exit(0);
}

const searchUrl = `${baseUrl}/api/v1/ai/search`;
const authHeader =
  basicUser && basicPass ? `Basic ${Buffer.from(`${basicUser}:${basicPass}`, "utf8").toString("base64")}` : null;

const scenarios = [
  {
    id: "zh_github_callback_404",
    query: "GitHub 集成授权后回调页面显示 page not found，怎么排查？",
    answerLanguage: "zh",
    evaluate(result) {
      const answer = `${result.support_answer?.direct_answer ?? ""}\n${result.answer ?? ""}\n${(result.support_answer?.what_to_do_now ?? []).join("\n")}`.toLowerCase();
      const citations = result.citations ?? [];
      const answerOk = /(redirect uri|webhook|callback|回调|page not found|baseurl)/i.test(answer);
      const citationOk = citations.some((item) => /github|gitlab|integration|集成/i.test(`${item.title} ${item.source_url}`));
      return {
        pass: answerOk && citationOk && result.retrieval_status === "grounded",
        notes: [
          ...(answerOk ? [] : ["answer missing callback troubleshooting guidance"]),
          ...(citationOk ? [] : ["citations are not clearly tied to integration docs"]),
          ...(result.retrieval_status === "grounded" ? [] : [`retrieval_status=${result.retrieval_status}`])
        ]
      };
    }
  },
  {
    id: "en_openapi_comment_scope",
    query: "What scope is required to create an issue comment via OpenAPI?",
    answerLanguage: "en",
    evaluate(result) {
      const answer = `${result.support_answer?.direct_answer ?? ""}\n${result.answer ?? ""}`.toLowerCase();
      const citations = result.citations ?? [];
      const answerOk = /(write:project:issue-comment|issue comment|scope)/i.test(answer);
      const citationOk = citations.some((item) => /scope|comment|openapi/i.test(`${item.title} ${item.source_url}`));
      return {
        pass: answerOk && citationOk && result.retrieval_status === "grounded",
        notes: [
          ...(answerOk ? [] : ["answer missing issue comment scope guidance"]),
          ...(citationOk ? [] : ["citations are not clearly tied to OpenAPI scope docs"]),
          ...(result.retrieval_status === "grounded" ? [] : [`retrieval_status=${result.retrieval_status}`])
        ]
      };
    }
  },
  {
    id: "en_onesql_order_by",
    query: "Does ONESQL support ORDER BY and GROUP BY?",
    answerLanguage: "en",
    evaluate(result) {
      const answer = `${result.support_answer?.direct_answer ?? ""}\n${result.answer ?? ""}`.toLowerCase();
      const citations = result.citations ?? [];
      const answerOk = /order by/i.test(answer) && /group by/i.test(answer);
      const citationOk =
        citations.some((item) => /onesql|execute onesql query/i.test(`${item.title} ${item.source_url}`)) &&
        !citations.some((item) => /baseurl/i.test(`${item.title} ${item.source_url}`));
      return {
        pass: answerOk && citationOk && result.citations.length > 0,
        notes: [
          ...(answerOk ? [] : ["answer missing ORDER BY / GROUP BY direct response"]),
          ...(citationOk ? [] : ["citations are tangential or unrelated to ONESQL"]),
          ...(result.citations.length > 0 ? [] : ["no citations returned"])
        ]
      };
    }
  }
];

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function postSearch(payload) {
  const response = await fetch(searchUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(authHeader ? { Authorization: authHeader } : {})
    },
    body: JSON.stringify(payload)
  });
  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { response, text, json };
}

async function requestWithRetry(payload) {
  let lastError = "unknown";
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const result = await postSearch(payload).catch((error) => {
      lastError = error instanceof Error ? error.message : String(error);
      return null;
    });
    if (result?.response.ok) {
      return result.json;
    }
    lastError = result ? `${result.response.status} ${result.text}` : lastError;
    console.log(`[support-smoke] attempt ${attempt}/${maxAttempts} not ready: ${lastError}`);
    if (attempt < maxAttempts) {
      await sleep(waitMs);
    }
  }
  throw new Error(`support smoke failed after ${maxAttempts} attempts: ${lastError}`);
}

const reports = [];
for (const scenario of scenarios) {
  const response = await requestWithRetry({
    query: scenario.query,
    answerLanguage: scenario.answerLanguage
  });
  const result = response?.result ?? {};
  const evaluation = scenario.evaluate(result);
  reports.push({
    id: scenario.id,
    query: scenario.query,
    retrieval_status: result.retrieval_status ?? null,
    mode: result.support_answer?.mode ?? null,
    direct_answer: result.support_answer?.direct_answer ?? result.answer ?? "",
    citations: (result.citations ?? []).map((item) => ({
      title: item.title,
      source_url: item.source_url
    })),
    evaluation
  });
}

console.log(JSON.stringify({ generated_at: new Date().toISOString(), reports }, null, 2));

const failed = reports.filter((item) => !item.evaluation.pass);
if (failed.length > 0) {
  console.error(`[support-smoke] failed scenarios: ${failed.map((item) => item.id).join(", ")}`);
  process.exit(1);
}

