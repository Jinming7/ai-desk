import { spawn } from "node:child_process";

const baseUrl = String(process.env.SUPPORT_SMOKE_BASE_URL ?? "").replace(/\/$/, "");
const deploymentUrl = String(process.env.SUPPORT_SMOKE_DEPLOYMENT_URL ?? baseUrl).replace(/\/$/, "");
const basicUser = String(process.env.SUPPORT_SMOKE_BASIC_USER ?? "").trim();
const basicPass = String(process.env.SUPPORT_SMOKE_BASIC_PASS ?? "").trim();
const perQuestionTimeoutMs = Number(process.env.SUPPORT_SMOKE_PER_QUESTION_TIMEOUT_MS ?? 240000);
const useJobs = String(process.env.SUPPORT_SMOKE_USE_JOBS ?? "true").toLowerCase() !== "false";
const includeIds = new Set(
  String(process.env.SUPPORT_SMOKE_IDS ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
);

if (!baseUrl) {
  console.error("Missing SUPPORT_SMOKE_BASE_URL");
  process.exit(1);
}

const authHeader =
  basicUser && basicPass ? `Basic ${Buffer.from(`${basicUser}:${basicPass}`, "utf8").toString("base64")}` : null;

const questions = [
  { id: "q01_private_reset_without_mail", language: "zh", query: "私有化部署里管理员忘记密码且邮件不可用时，应该如何重置管理员密码？" },
  { id: "q02_private_supported_os", language: "zh", query: "ONES 私有化部署当前支持哪些 Linux 发行版和版本？" },
  { id: "q03_private_cluster_sizing_500", language: "zh", query: "私有化部署 K3s 集群版 500 人以内时，每台工作节点的 CPU、内存和磁盘要求是什么？" },
  { id: "q04_gitlab_callback_404", language: "zh", query: "GitLab 集成授权后回调页面出现 page not found，优先排查哪些配置？" },
  { id: "q05_github_webhook_not_triggered", language: "zh", query: "GitHub 集成后 webhook 没有触发同步，应该先检查哪些项？" },
  { id: "q06_openapi_issue_detail_endpoint", language: "en", query: "What is the OpenAPI endpoint and HTTP method to fetch issue details?" },
  { id: "q07_openapi_comment_scope_variant", language: "en", query: "For creating an issue comment through OpenAPI, what OAuth scope is required?" },
  { id: "q08_onesql_sort_and_aggregate", language: "en", query: "Can ONESQL queries use ORDER BY together with GROUP BY?" },
  { id: "q09_private_callback_domain_mismatch", language: "zh", query: "私有化部署场景下，第三方 OAuth 回调域名不一致通常会导致什么问题，怎么定位？" },
  { id: "q10_export_reporting_capability", language: "zh", query: "ONES 是否支持导出报表或统计数据？如果支持，通常在哪里操作？" }
];
const selectedQuestions = includeIds.size > 0 ? questions.filter((item) => includeIds.has(item.id)) : questions;

function extractSearchPayload(value) {
  const payload = value?.result ?? value ?? null;
  if (payload && typeof payload === "object" && "error" in payload && payload.error) {
    throw new Error(String(payload.error));
  }
  return payload;
}

async function withTimeout(run, timeoutMs, label) {
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`timeout after ${timeoutMs}ms: ${label}`));
    }, timeoutMs);
    run()
      .then((value) => {
        clearTimeout(timer);
        resolve(value);
      })
      .catch((error) => {
        clearTimeout(timer);
        reject(error);
      });
  });
}

async function vercelCurl(path, payload) {
  return await new Promise((resolve, reject) => {
    const args = [
      "curl",
      path,
      "--deployment",
      deploymentUrl,
      "--",
      "--silent",
      "--show-error",
      ...(payload
        ? [
            "--request",
            "POST",
            "--header",
            "Content-Type: application/json",
            "--data",
            JSON.stringify(payload)
          ]
        : ["--request", "GET"])
    ];
    const child = spawn("vercel", args, { stdio: ["ignore", "pipe", "pipe"] });
    const hardTimeoutMs = perQuestionTimeoutMs;
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      reject(new Error(`vercel curl timeout after ${hardTimeoutMs}ms: ${path}`));
    }, hardTimeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`vercel curl failed (${code}): ${stderr || stdout}`));
        return;
      }
      const start = stdout.indexOf("{");
      const end = stdout.lastIndexOf("}");
      if (start < 0 || end <= start) {
        reject(new Error(`vercel curl output does not contain JSON: ${stdout.slice(0, 400)}`));
        return;
      }
      const text = stdout.slice(start, end + 1);
      resolve(JSON.parse(text));
    });
  });
}

async function vercelCurlWithRetry(path, payload, attempts = 3) {
  let lastError = null;
  for (let i = 0; i < attempts; i += 1) {
    try {
      return await vercelCurl(path, payload);
    } catch (error) {
      lastError = error;
      const message = String(error instanceof Error ? error.message : error);
      const transient =
        message.includes("HTTP2 framing layer") ||
        message.includes("stream error") ||
        message.includes("ECONNRESET") ||
        message.includes("ETIMEDOUT");
      if (!transient || i === attempts - 1) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 800));
    }
  }
  throw lastError ?? new Error("vercel curl retry exhausted");
}

async function runSearchJobViaVercelCurl(payload) {
  const submitted = await vercelCurlWithRetry("/api/v1/ai/search/jobs", {
    query: payload.query,
    answerLanguage: payload.answerLanguage,
    conversation: []
  });
  const jobId = submitted?.job?.id;
  if (!jobId) {
    throw new Error("search job submission missing job.id");
  }
  const driven = await vercelCurlWithRetry(`/api/v1/ai/search/jobs/${jobId}/drive`, {});
  return extractSearchPayload(driven?.job?.result ?? null);
}

const report = {
  generatedAt: new Date().toISOString(),
  baseUrl,
  perQuestionTimeoutMs,
  count: selectedQuestions.length,
  items: []
};

for (const q of selectedQuestions) {
  const startedAt = Date.now();
  try {
    const apiResult = await withTimeout(
      () =>
        useJobs
          ? runSearchJobViaVercelCurl({
              query: q.query,
              answerLanguage: q.language
            })
          : vercelCurlWithRetry("/api/v1/ai/search", {
              query: q.query,
              answerLanguage: q.language
            }).then((res) => extractSearchPayload(res)),
      perQuestionTimeoutMs,
      q.id
    );
    const payload = apiResult ?? {};
    const diagnostics = payload.internal_diagnostics ?? {};
    report.items.push({
      id: q.id,
      query: q.query,
      language: q.language,
      elapsedMs: Date.now() - startedAt,
      retrievalStatus: payload.retrieval_status ?? null,
      verificationVerdict: payload.verification?.verdict ?? null,
      answerMode: payload.support_answer?.mode ?? null,
      renderVariant: payload.support_answer?.render_variant ?? null,
      answer: payload.support_answer?.direct_answer ?? payload.answer ?? "",
      route: {
        question_type: diagnostics.route?.question_type ?? null,
        specialist_agent: diagnostics.route?.specialist_agent ?? null,
        primary_domain: diagnostics.route?.primary_domain ?? null
      },
      logic: {
        specialists_used: diagnostics.specialists_used ?? [],
        domains_used: diagnostics.domains_used ?? [],
        retrieval_queries_used: diagnostics.retrieval_queries_used ?? [],
        stage_trace: diagnostics.stage_trace ?? []
      },
      citations: (payload.citations ?? []).slice(0, 5).map((item) => ({
        id: item.id,
        title: item.title,
        source_url: item.source_url
      }))
    });
  } catch (error) {
    report.items.push({
      id: q.id,
      query: q.query,
      language: q.language,
      elapsedMs: Date.now() - startedAt,
      error: { message: error instanceof Error ? error.message : String(error) }
    });
  }
}

console.log(JSON.stringify(report, null, 2));
