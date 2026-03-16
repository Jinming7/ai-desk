import { canTransition } from "../../domain/state-machine.js";
import type { OpenClawAdapter, OpenClawAnalyzeOutput, OpenClawDecisionAction } from "../../infrastructure/openclaw/types.js";
import { env } from "../../config/env.js";
import crypto from "node:crypto";
import * as aiRepo from "./repository.js";
import { SearchOrchestrator } from "./search-orchestrator.js";
import { buildSearchRuntime, resolveExecutionRuntime } from "./agent-router.js";
import { summarizeImageAttachments, summarizeTextAttachments } from "./multimodal.js";
import type {
  ChatTicketDraft,
  ChatTicketDraftField,
  SearchModeResult,
  SearchResponseEnvelope,
  SearchReference,
  SearchDialogState,
  StructuredSearchAnswer
} from "./types.js";
import * as tickets from "../tickets/repository.js";
import * as settings from "../settings/repository.js";
import * as onesSync from "../ones-sync/service.js";

function normalizeAction(action: string): OpenClawDecisionAction {
  if (action === "ask_info") return "ask_user";
  if (action === "auto_resolve") return "resolve";
  if (action === "none") return "none";
  if (action === "escalate" || action === "ask_user" || action === "resolve") return action;
  return "ask_user";
}

function containsCjk(text: string): boolean {
  return /[\u3400-\u9FBF]/.test(text);
}

function detectLanguage(text: string): "zh" | "en" {
  return containsCjk(text) ? "zh" : "en";
}

function buildUserFacingDraftTitle(query: string): string {
  const firstSegment = query
    .split(/(?:\bAction:|\bSteps?:|\bRepro(?:duction)?\b|\n)/i)
    .map((part) => part.trim())
    .find(Boolean);
  return (firstSegment || query.trim()).slice(0, 180);
}

function buildUserFacingDraftDescription(input: {
  query: string;
  transcript: Array<{ role: string; content: string }>;
}): string {
  const normalizedQuery = input.query
    .replace(/\r\n?/g, "\n")
    .replace(/\bAction:\s*/gi, "\n\nAction:\n")
    .replace(/\bExpected(?: result| behavior)?:\s*/gi, "\n\nExpected:\n")
    .replace(/\bActual(?: result| behavior)?:\s*/gi, "\n\nActual:\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  const recentUserNotes = input.transcript
    .filter((item) => item.role === "user")
    .map((item) => item.content.trim())
    .filter(Boolean)
    .slice(-3);

  const extraNotes = recentUserNotes.filter((item) => item !== input.query.trim());
  if (!extraNotes.length) {
    return normalizedQuery;
  }

  return `${normalizedQuery}\n\nAdditional context:\n${extraNotes.join("\n\n")}`.trim();
}

function normalizeReplyToEnglish(action: OpenClawDecisionAction, text: string): string {
  const trimmed = text.trim();
  if (!trimmed) {
    if (action === "none") return "";
    return action === "resolve"
      ? "Thanks for your report. We have applied a fix and marked this ticket as resolved. Please verify and let us know if you still see the issue."
      : action === "escalate"
      ? "Thanks for your report. This issue requires deeper investigation, so I have escalated it to our R&D team."
      : "Thanks for contacting support. I need a bit more detail to proceed. Please share expected behavior, actual behavior, exact steps, and any error logs or screenshots.";
  }
  if (containsCjk(trimmed)) {
    if (action === "resolve") {
      return "Thanks for your report. We have completed the fix and set this ticket to resolved. Please confirm whether the issue is solved.";
    }
    if (action === "escalate") {
      return "Thanks for your report. We need deeper technical analysis, so this ticket has been escalated to our R&D team.";
    }
  return action === "none"
      ? ""
      : "Thanks for contacting support. Your ticket currently lacks actionable details. Please provide the exact issue, expected result, actual result, and reproduction steps.";
  }
  return trimmed;
}

async function buildTicketImageSummary(input: {
  title: string;
  description: string;
  history: Array<{ author: string; body: string }>;
  attachments: string[];
}): Promise<string | null> {
  if (!input.attachments.length) return null;

  const queryContext = [
    input.title.trim(),
    input.description.trim(),
    ...input.history.slice(-6).map((item) => `${item.author}: ${item.body}`)
  ]
    .filter(Boolean)
    .join("\n");

  const summary = await summarizeImageAttachments({
    query: queryContext,
    attachments: input.attachments,
    answerLanguage: "en"
  });

  if (!summary?.trim()) return null;
  return `[Screenshot analysis]\n${summary.trim()}`;
}

async function buildTicketTextAttachmentSummary(input: { attachments: string[] }): Promise<string | null> {
  return summarizeTextAttachments({
    attachments: input.attachments,
    answerLanguage: "en"
  });
}

function normalizeAnalyzeOutput(raw: OpenClawAnalyzeOutput): OpenClawAnalyzeOutput & { fallback_applied: boolean } {
  const normalizedAction = normalizeAction(raw.action);
  const fallbackApplied = raw.action !== normalizedAction || raw.action === undefined || raw.action === null;
  const reply = normalizeReplyToEnglish(normalizedAction, raw.reply);
  return {
    ...raw,
    action: normalizedAction,
    reply,
    fallback_applied: fallbackApplied
  };
}

function hasValidCitations(references: SearchReference[]): boolean {
  return references.some((item) => {
    if (!(item.documentId && item.title && item.sourceUrl)) return false;
    try {
      const url = new URL(item.sourceUrl);
      return url.protocol === "https:" || url.protocol === "http:";
    } catch {
      return false;
    }
  });
}

function parseCitationFromSourceUrl(sourceUrl: string): { repo?: string; path?: string; commitSha?: string } {
  try {
    const url = new URL(sourceUrl);
    if (url.hostname !== "github.com") return {};
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts.length < 5 || parts[2] !== "blob") return {};
    return {
      repo: `${parts[0]}/${parts[1]}`,
      commitSha: parts[3],
      path: parts.slice(4).join("/")
    };
  } catch {
    return {};
  }
}

function getCitationMeta(reference: SearchReference): { repo?: string; path?: string; commitSha?: string } {
  if (reference.repo && reference.path && reference.commitSha) {
    return {
      repo: reference.repo,
      path: reference.path,
      commitSha: reference.commitSha
    };
  }
  const fallback = parseCitationFromSourceUrl(reference.repoSourceUrl ?? reference.sourceUrl);
  return {
    repo: reference.repo ?? fallback.repo,
    path: reference.path ?? fallback.path,
    commitSha: reference.commitSha ?? fallback.commitSha
  };
}

type QueryIntent = "api_operation" | "feature_usage" | "troubleshooting" | "concept_explanation" | "configuration" | "general";
type QueryRoute = "openapi_doc" | "infra_runbook" | "integration_diagnosis" | "product_diagnosis" | "kb_guidance" | "clarification";

type QuerySignals = {
  namespace?: string;
  appLabel?: string;
  podName?: string;
  hasReindexHint: boolean;
  hasStaleLogHint: boolean;
  hasLoadStoreHint: boolean;
};

function detectIntent(query: string): QueryIntent {
  const q = query.toLowerCase();
  if (/\b(kubectl|pod|pvc|pv|pd|tikv|tidb|cdc|reindex|rebuild|index|sync|log|logs|stderr|stdout)\b/i.test(q)) {
    return "troubleshooting";
  }
  if (/\b(page not found|redirect|callback|authorize|authorization page|404|401|500|报错|错误|异常|失败|无法|不能)\b/i.test(q)) {
    return "troubleshooting";
  }
  const authConfigHint = /\b(oauth|token|access[_ -]?token|refresh[_ -]?token|authorization|scope|client_id|client_secret|redirect_uri|鉴权|授权|令牌|凭据)\b/i.test(q);
  const configActionHint = /\b(config|configure|setup|install|deploy|integration|webhook|设置|部署|配置|集成|如何配置|怎么配置)\b/i.test(q);
  const explicitApiCallHint = /\b(endpoint|rest|http|request|response|curl|sdk|status code|header|body)\b/i.test(q);
  if (authConfigHint && !explicitApiCallHint) return "configuration";
  if (configActionHint && !explicitApiCallHint) return "configuration";
  if (/\b(api|openapi|open api|endpoint|rest|http|request|response|curl|sdk)\b/i.test(q) || /接口|开放平台|open api|openapi/i.test(query)) {
    return "api_operation";
  }
  if (/\b(error|errors|failed|failure|timeout|exception|crash|stuck|not work|cannot|can't|500|404|403|401|报错|错误|异常|失败|超时|卡住|无法|不能)\b/i.test(q)) return "troubleshooting";
  if (/\bwhat is|meaning|difference|vs|compare|概念|区别|是什么|什么意思\b/i.test(q)) return "concept_explanation";
  if (/\b(config|configure|setup|install|deploy|integration|webhook|oauth|token|权限|部署|配置|集成)\b/i.test(q)) return "configuration";
  if (/\bhow to|how can|where|步骤|怎么|如何|在哪里|入口\b/i.test(q)) return "feature_usage";
  return "general";
}

function looksLikeProductBug(query: string): boolean {
  const q = query.toLowerCase();
  const searchFailure =
    /\b(search|filter|find|lookup)\b/.test(q) &&
    /\b(no results|cannot|can't|not work|not working|missing|empty result)\b/.test(q);
  return (
    searchFailure ||
    /\b(bug|regression|unexpected|incorrect|wrong result|blank|空白|缺失|异常|回归|不生效|未生效)\b/i.test(query)
  );
}

function isIntegrationDiagnosisQuery(query: string): boolean {
  const q = query.toLowerCase();
  const integrationSurface =
    /\b(github|gitlab|bitbucket|teams|slack|webhook|oauth|授权账号|授权账户|代码仓|仓库|repo|repository|集成)\b/i.test(query);
  const concreteFailure =
    /\b(page not found|redirect|callback|authorize|授权|跳转|404|401|403|500|报错|错误|异常|失败|无法|不能)\b/i.test(q);
  return integrationSurface && concreteFailure;
}

function classifyQuerySync(input: { query: string; conversation?: string[]; attachments?: string[] }) {
  const combined = [input.query, ...(input.conversation ?? [])].join("\n").trim();
  const intent = detectIntent(combined);
  const docDrivenOpenApi = isDocDrivenOpenApiQuery(combined);
  const infraRunbook = isInfraTroubleshooting(combined);
  const evidenceRich = hasEvidenceRichInput(input);
  const productBug = looksLikeProductBug(combined);
  const authProblem =
    /\b(oauth|token|authorization|access[_ -]?token|refresh[_ -]?token|scope|client_id|client_secret|redirect_uri|鉴权|授权|令牌|凭据)\b/i.test(
      combined
    );

  let route: QueryRoute;
  if (docDrivenOpenApi) {
    route = "openapi_doc";
  } else if (infraRunbook) {
    route = "infra_runbook";
  } else if (isIntegrationDiagnosisQuery(combined)) {
    route = "integration_diagnosis";
  } else if (evidenceRich && productBug) {
    route = "product_diagnosis";
  } else if (intent !== "general" || authProblem) {
    route = "kb_guidance";
  } else if (input.conversation?.length) {
    // If there is conversation context, treat as kb_guidance rather than clarification
    // so the agent can leverage prior turns to answer.
    route = "kb_guidance";
  } else {
    route = "clarification";
  }

  return {
    combined,
    intent,
    route,
    docDrivenOpenApi,
    infraRunbook,
    evidenceRich,
    authProblem
  };
}

async function classifyQuery(
  input: { query: string; conversation?: string[]; attachments?: string[] },
  adapter?: OpenClawAdapter
) {
  const combined = [input.query, ...(input.conversation ?? [])].join("\n").trim();
  const regexResult = classifyQuerySync(input);

  // Try agent-based classification when adapter supports it.
  // Use a short timeout (5s) so this never blocks the main flow.
  if (adapter?.classifyIntent) {
    try {
      const language = containsCjk(combined) ? "zh" : "en";
      const classifyTimeout = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("classifyIntent timeout")), 5000)
      );
      const agentResult = await Promise.race([
        adapter.classifyIntent(
          {
            query: input.query,
            language,
            conversationContext: input.conversation
          },
          `classify:${Date.now()}:${input.query.slice(0, 32)}`
        ),
        classifyTimeout
      ]);

      // Use agent result if confidence is reasonable
      if (agentResult.confidence >= 0.5) {
        return {
          combined,
          intent: agentResult.intent as QueryIntent,
          route: agentResult.route as QueryRoute,
          docDrivenOpenApi: agentResult.route === "openapi_doc",
          infraRunbook: agentResult.route === "infra_runbook",
          evidenceRich: regexResult.evidenceRich,
          authProblem: regexResult.authProblem
        };
      }
    } catch {
      // Fall through to regex-based classification on timeout or error
    }
  }

  return regexResult;
}

function extractQuerySignals(query: string): QuerySignals {
  const q = query.toLowerCase();
  const ns = query.match(/(?:^|\s)-n\s+([a-z0-9-]+)/i)?.[1];
  const app = query.match(/(?:^|\s)-l\s+app=([a-z0-9-]+)/i)?.[1];
  const podCandidate = query.match(/\b([a-z0-9-]*kilob-sync[a-z0-9-]*)\b/i)?.[1];
  const pod = podCandidate && podCandidate !== app ? podCandidate : undefined;
  return {
    namespace: ns,
    appLabel: app,
    podName: pod,
    hasReindexHint: /\b(reindex|rebuild|from scratch|restart)\b/i.test(q),
    hasStaleLogHint: /\b(stale|yesterday|old pod|logs? are from)\b/i.test(q),
    hasLoadStoreHint: /\b(loadstore|from pd failed)\b/i.test(q)
  };
}

function extractEndpointFromReference(reference: SearchReference | undefined): { method?: string; path?: string } {
  if (!reference) return {};
  const titleMatch = reference.title.match(/\b(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+([/A-Za-z0-9._:-]+)/i);
  if (titleMatch) return { method: titleMatch[1].toUpperCase(), path: titleMatch[2] };
  const snippetMatch = reference.snippet.match(/\b(?:Endpoint|接口)[:：]?\s*(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+([/A-Za-z0-9._:-]+)/i);
  if (snippetMatch) return { method: snippetMatch[1].toUpperCase(), path: snippetMatch[2] };
  return {};
}

function buildRequiredInputs(language: "zh" | "en", intent: QueryIntent, query: string): string[] {
  const q = query.toLowerCase();
  const set = new Set<string>();
  const push = (zh: string, en: string) => set.add(language === "zh" ? zh : en);

  if (intent === "api_operation") {
    push("请求 URL + Method", "Request URL + method");
    push("关键请求参数或 body（脱敏）", "Key request params/body (sanitized)");
    push("HTTP 状态码 + 响应体", "HTTP status code + response body");
    push("鉴权方式与 token scope", "Auth mode and token scope");
  } else if (intent === "troubleshooting") {
    push("报错前后至少 10 行日志", "At least 10 lines around the error");
    push("出问题的具体步骤（最后一步最关键）", "Exact failing step (especially the last step)");
    push("环境与版本（prod/staging/test + version）", "Environment and version (prod/staging/test + version)");
    push("实际报错信息（原文）", "Actual error message (raw text)");
    if (isInfraTroubleshooting(query)) {
      push("namespace / pod / PVC 名", "Namespace / pod / PVC names");
      push("是否出现 MountVolume / Read-only file system / no space left", "Whether events include MountVolume / Read-only file system / no space left");
    }
  } else if (intent === "configuration") {
    if (/\b(oauth|token|authorization|scope|client_id|client_secret|redirect_uri|鉴权|授权|令牌|凭据)\b/i.test(q)) {
      push("当前使用的是个人凭据还是组织凭据", "Whether you are using personal credentials or org credentials");
      push("是否已经拿到 client_id / client_secret / code / access_token", "Whether you already have client_id / client_secret / code / access_token");
      push("当前卡在哪一步（授权、换 token、调用接口）", "Which step is blocked (authorize, exchange token, or call API)");
    } else {
      push("当前配置值（脱敏）", "Current config values (sanitized)");
      push("目标配置值", "Target config values");
      push("已执行步骤（到哪一步失败）", "Executed steps (where it failed)");
    }
  } else if (intent === "concept_explanation") {
    push("你当前场景（业务目标）", "Your current scenario (business goal)");
    push("当前版本/部署模式", "Current version/deployment mode");
  } else {
    push("你想达成的目标", "What you want to achieve");
    push("你当前使用的入口/页面/接口", "Entry point/page/API you are using");
    push("复现路径（步骤）", "Reproduction steps");
  }

  if (/\b(403|401|permission|权限|auth|oauth)\b/i.test(q)) {
    push("用户角色/账号", "User role/account");
  }
  if (/\b(timeout|slow|latency|性能|卡顿)\b/i.test(q)) {
    push("发生时间与影响范围", "Occurrence time and impact scope");
  }
  if (/\b(ha|high availability|高可用|可用性|故障转移|multi[- ]?zone|多可用区)\b/i.test(q)) {
    push("当前部署拓扑（单点/多副本/多可用区）", "Current deployment topology (single point/multi-replica/multi-zone)");
    push("RTO/RPO 或可用性目标", "RTO/RPO or availability target");
  }

  return [...set];
}

function isInfraTroubleshooting(query: string): boolean {
  return /\b(k8s|kubernetes|pod|pvc|pv|pd|disk|volume|oom|crashloop|loadstore|rebuild|reindex|index|sync|tikv|tidb|cdc|节点|容器|挂载|索引|重建|存储|磁盘|卷)\b/i.test(
    query.toLowerCase()
  );
}

function filterReferencesByIntent(query: string, references: SearchReference[]): SearchReference[] {
  if (!references.length) return references;
  const intent = detectIntent(query);
  const infra = isInfraTroubleshooting(query);

  const matched = references.filter((item) => {
    const path = getCitationMeta(item).path?.toLowerCase() ?? "";
    if (!path) return false;
    if (infra) {
      return path.startsWith("deploy-docs/troubleshooting/");
    }
    if (intent === "api_operation") {
      return path.includes("/openapi/api/") && path.endsWith(".api.mdx");
    }
    if (intent === "configuration") {
      return path.includes("/integrations/") || path.includes("/guide/");
    }
    return true;
  });

  if (intent === "api_operation") {
    return matched;
  }
  return matched.length ? matched : references;
}

function isOpenApiReference(reference: SearchReference): boolean {
  const path = getCitationMeta(reference).path?.toLowerCase() ?? "";
  const title = reference.title.toLowerCase();
  const source = reference.sourceUrl.toLowerCase();
  return path.includes("/openapi/") || title.includes("/openapi/") || source.includes("/openapi/");
}

function shouldUseRawGroundedAnswer(query: string, references: SearchReference[]): boolean {
  if (!references.length) return false;
  if (isDocDrivenOpenApiQuery(query)) {
    return references.some(isOpenApiReference);
  }
  return true;
}

function buildQueryAwareStructuredAnswer(
  language: "zh" | "en",
  query: string,
  references: SearchReference[]
): StructuredSearchAnswer | null {
  if (!references.length) return null;
  const intent = detectIntent(query);
  const infraTroubleshooting = isInfraTroubleshooting(query);
  const signals = extractQuerySignals(query);
  const primary = references[0];
  const citation = getCitationMeta(primary);
  const sourcePath = citation.path ?? primary.title;
  const endpoint = extractEndpointFromReference(primary);
  const requiredInputs = buildRequiredInputs(language, intent, query);

  if (intent === "api_operation") {
    if (language === "zh") {
      const endpointLine = endpoint.method && endpoint.path ? `使用 \`${endpoint.method} ${endpoint.path}\`` : `先参考接口文档 \`${sourcePath}\``;
      return {
        assessment: `当前问题属于 API 调用场景，主参考来源为 \`${sourcePath}\`。`,
        summary: `${endpointLine} 即可开始处理这个 API 请求。`,
        style: "kb_answer",
        steps: [
          "先确认鉴权方式与 token 权限（scope）满足该接口要求。",
          endpoint.method && endpoint.path
            ? `调用 \`${endpoint.method} ${endpoint.path}\`，并按文档填写必填参数。`
            : `打开主文档，确认请求方法、路径与必填参数后再发起调用。`,
          "按文档示例请求与响应字段进行联调，避免遗漏必填参数。"
        ],
        validation: [
          "检查 HTTP 状态码与响应体字段是否符合文档说明。",
          "若失败，优先排查 401/403（鉴权与权限）和 400（参数缺失/类型错误）。",
          "若仍失败，请补充：请求 URL+Method、状态码+响应体、鉴权方式与 token scope。"
        ],
        required_inputs: requiredInputs
      };
    }
    const endpointLine = endpoint.method && endpoint.path ? `Use \`${endpoint.method} ${endpoint.path}\`` : `Start from \`${sourcePath}\``;
    return {
      assessment: `This is an API-operation question. Primary source: \`${sourcePath}\`.`,
      summary: `${endpointLine} to execute this API request.`,
      style: "kb_answer",
      steps: [
        "Verify auth method and token scopes required by this endpoint.",
        endpoint.method && endpoint.path
          ? `Call \`${endpoint.method} ${endpoint.path}\` with all required fields.`
          : "Open the primary doc and confirm method/path/required parameters before sending the request.",
        "Use the documented request/response examples to validate payload and field mapping."
      ],
      validation: [
        "Check HTTP status code and response fields against the API doc.",
        "If failed, troubleshoot 401/403 (auth/permission) and 400 (missing/invalid params) first.",
        "If still blocked, provide URL+method, status code+response body, and auth mode/scope."
      ],
      required_inputs: requiredInputs
    };
  }

  if (intent === "troubleshooting") {
    const ns = signals.namespace ?? "<ns>";
    const app = signals.appLabel ?? "kilob-sync";
    const pod = signals.podName ?? "<kilob-sync-pod>";
    const isLoadStoreCase = signals.hasLoadStoreHint;
    const isReindexOrStaleLogCase = signals.hasReindexHint || signals.hasStaleLogHint;

    if (infraTroubleshooting && language === "zh") {
      if (!isLoadStoreCase && isReindexOrStaleLogCase) {
        return {
          assessment: `该问题属于 infra 排障场景，优先参考 \`${sourcePath}\`。`,
          summary: "当前现象更像“重建任务打到旧 Pod / 任务未重置”，先做任务切换与状态重置，再判断是否存储层问题。",
          style: "diagnosis",
          steps: [
            `先确认当前目标 Pod：\`kubectl -n ${ns} get pods -l app=${app} -o wide\`，核对 AGE/RESTARTS 与当前执行任务是否一致。`,
            "停止当前重建并重启对应组件（按你们运维流程），随后重新触发一次 reindex/rebuild，避免任务继续命中旧实例。",
            `若仍异常，再采集 \`kubectl -n ${ns} logs ${pod} --since=30m\` 与 \`kubectl -n ${ns} describe pod ${pod}\`，确认是否有调度/挂载/权限事件。`
          ],
          validation: [
            "新触发任务应命中新 Pod，日志时间应推进到当前时间。",
            "若仍持续报错，再按存储层（PVC/PV/挂载）路径继续排查。"
          ],
          required_inputs: [
            `\`kubectl -n ${ns} get pods -l app=${app} -o wide\` 输出（含 AGE/RESTARTS）`,
            "最新一次重建任务触发时间与对应 Pod 名",
            "最近 30 分钟日志与 describe 关键事件"
          ]
        };
      }
      return {
        assessment: `该问题属于 infra 排障场景，优先参考 \`${sourcePath}\`。`,
        summary: "高概率是持久卷（PD/PVC）或挂载状态异常，导致本地 store 无法加载。",
        style: "diagnosis",
        steps: [
          `低风险（先做）：\`kubectl -n ${ns} describe pod ${pod}\` + \`kubectl -n ${ns} logs ${pod} --previous\`，然后 \`kubectl -n ${ns} delete pod ${pod}\` 重建 Pod。`,
          `中风险（定位后处理）：\`kubectl -n ${ns} get pvc\` + \`kubectl get pv | grep <pvc-name>\`；容器内执行 \`df -h\`、\`mount | grep <store-path>\`、\`touch <store-path>/.rw-test\`，若只读/空间不足先修复卷状态。`,
          "高风险（最后再做）：确认 store 数据损坏后，先备份，再清理 store 目录并重新触发 rebuild（不要直接盲删 PV）。"
        ],
        validation: [
          "若出现 MountVolume / Read-only file system / no space left，即可定位到存储或挂载层问题。",
          "修复后再次 rebuild，确认不再出现 `loadStore from PD failed`。"
        ],
        required_inputs: [
          "`loadStore from PD failed` 前后至少 10 行日志",
          "namespace / pod / PVC 名",
          "是否出现 MountVolume / Read-only file system / no space left"
        ]
      };
    }
    if (infraTroubleshooting && language === "en") {
      if (!isLoadStoreCase && isReindexOrStaleLogCase) {
        return {
          assessment: `This is an infra troubleshooting issue. Primary source: \`${sourcePath}\`.`,
          summary: "This looks more like reindex targeting an old pod or a stale job state. Reset execution path first, then verify storage.",
          style: "diagnosis",
          steps: [
            `Confirm active target pod: \`kubectl -n ${ns} get pods -l app=${app} -o wide\` and verify AGE/RESTARTS match the current run.`,
            "Stop current rebuild and restart the related component by your ops runbook, then trigger reindex/rebuild again to avoid hitting stale instance.",
            `If still abnormal, collect \`kubectl -n ${ns} logs ${pod} --since=30m\` and \`kubectl -n ${ns} describe pod ${pod}\` to check scheduling/mount/permission events.`
          ],
          validation: [
            "The new run should hit the new pod and logs should move to current timestamps.",
            "If errors persist, continue with PVC/PV/mount troubleshooting."
          ],
          required_inputs: [
            `Output of \`kubectl -n ${ns} get pods -l app=${app} -o wide\` (with AGE/RESTARTS)`,
            "Latest rebuild trigger time and target pod name",
            "Last 30 min logs and key describe events"
          ]
        };
      }
      return {
        assessment: `This is an infra troubleshooting issue. Primary source: \`${sourcePath}\`.`,
        summary: "Most likely the mounted persistent volume (PD/PVC) is abnormal, so local store cannot be loaded.",
        style: "diagnosis",
        steps: [
          `Low risk (do first): run \`kubectl -n ${ns} describe pod ${pod}\` + \`kubectl -n ${ns} logs ${pod} --previous\`, then restart with \`kubectl -n ${ns} delete pod ${pod}\`.`,
          `Medium risk (fix by signal): run \`kubectl -n ${ns} get pvc\` + \`kubectl get pv | grep <pvc-name>\`; inside container run \`df -h\`, \`mount | grep <store-path>\`, \`touch <store-path>/.rw-test\`; if read-only/no-space, recover volume state first.`,
          "High risk (last resort): if store data is corrupted, backup first, clean store directory, and trigger rebuild again (do not blindly delete PV)."
        ],
        validation: [
          "If you see MountVolume / Read-only file system / no space left, the root cause is in storage/mount layer.",
          "After fix, rebuild should no longer report `loadStore from PD failed`."
        ],
        required_inputs: [
          "10+ lines around `loadStore from PD failed`",
          "Namespace / pod / PVC names",
          "Whether events include MountVolume / Read-only file system / no space left"
        ]
      };
    }
    if (language === "zh") {
      return {
        assessment: `该问题属于故障排查场景，当前优先参考 \`${sourcePath}\`。`,
        summary: "先尝试可直接执行的修复路径；若无效，再补充关键信息收敛。",
        style: "diagnosis",
        steps: [
          "低风险：先做可逆操作（重试、刷新配置、重启对应服务/Pod、回滚最近变更）。",
          "中风险：按文档定位依赖项（权限、配置、外部依赖、资源）并逐项修复。",
          "高风险：仅在确认根因后执行破坏性操作（清理缓存/重建索引/重置状态），并先备份。"
        ],
        validation: [
          "若问题仍在，补充完整错误日志（原文）和时间点继续追问。",
          "若影响范围扩大，直接转工单并附上复现与日志证据。"
        ],
        required_inputs: requiredInputs
      };
    }
    return {
      assessment: `This is a troubleshooting issue. Start with \`${sourcePath}\`.`,
      summary: `Use the primary source \`${sourcePath}\` as your first troubleshooting path.`,
      style: "diagnosis",
      steps: [
        "Confirm environment, reproduction steps, actual error, and expected behavior first.",
        "Follow the primary document steps in order.",
        "Validate immediately after each step and capture the result."
      ],
      validation: [
        "If unresolved, provide full error logs and timestamp for deeper diagnosis.",
        "If impact widens, create/escalate a ticket with repro and evidence."
      ],
      required_inputs: requiredInputs
    };
  }

  if (intent === "concept_explanation") {
    if (language === "zh") {
      return {
        assessment: `该问题属于概念说明场景，主来源为 \`${sourcePath}\`。`,
        summary: `核心说明可参考 \`${sourcePath}\`，该文档包含定义与适用边界。`,
        style: "kb_answer",
        steps: ["先看定义与适用场景。", "再看限制条件与不适用场景。", "最后按文档示例映射到你的实际场景。"],
        validation: ["确认你的目标是否属于文档适用范围。", "若不在适用范围，换用更匹配的能力或流程。"],
        required_inputs: requiredInputs
      };
    }
    return {
      assessment: `This is a concept clarification request. Primary source: \`${sourcePath}\`.`,
      summary: `Use \`${sourcePath}\` as the primary explanation. It defines scope and boundaries clearly.`,
      style: "kb_answer",
      steps: ["Read the definition and supported scenarios first.", "Check limitations and non-applicable cases.", "Map the example to your own use case."],
      validation: ["Verify your scenario fits the documented scope.", "If not, switch to a better-matched feature/process."],
      required_inputs: requiredInputs
    };
  }

  if (intent === "configuration" || intent === "feature_usage" || intent === "general") {
    if (language === "zh") {
      return {
        assessment: `该问题属于功能使用/配置场景，主来源为 \`${sourcePath}\`。`,
        summary: `按文档 \`${sourcePath}\` 可以直接开始操作。`,
        style: "kb_answer",
        steps: [
          "先完成前置条件（账号权限、配置项、依赖环境）。",
          "按文档步骤逐项执行。",
          "执行后在界面或接口中核验结果。"
        ],
        validation: ["确认目标功能已生效。", "若与预期不符，补充上下文继续追问或提交工单。"],
        required_inputs: requiredInputs
      };
    }
    return {
      assessment: `This is a feature/configuration request. Primary source: \`${sourcePath}\`.`,
      summary: `Start with \`${sourcePath}\` to complete this request.`,
      style: "kb_answer",
      steps: [
        "Prepare prerequisites (permissions, config, dependencies).",
        "Execute the steps from the primary document.",
        "Validate the outcome in UI/API after execution."
      ],
      validation: ["Confirm the target behavior is effective.", "If mismatch remains, continue with context or submit a ticket."],
      required_inputs: requiredInputs
    };
  }

  return null;
}

function buildClarificationStructuredAnswer(language: "zh" | "en", query: string): StructuredSearchAnswer {
  const intent = detectIntent(query);
  const requiredInputs = buildRequiredInputs(language, intent, query);
  if (language === "zh") {
    return {
      assessment: "当前知识库命中证据不足，无法直接给出可靠方案。",
      summary: "当前无法确认可靠直修方案；先补充关键上下文，我会给你“先修复后补证据”的可执行路径。",
      style: "clarification",
      steps: [
        "补充下方所需信息（越具体越好）。",
        "我将基于补充内容重新检索并收敛到可执行步骤。",
        "若多轮后仍证据不足，将建议创建工单并自动预填。"
      ],
      validation: ["补充后应能收敛到更相关来源。", "若仍无法收敛，进入工单流程。"],
      required_inputs: requiredInputs
    };
  }
  return {
    assessment: "Current KB evidence is insufficient for a reliable direct answer.",
    summary: "I can’t confirm a reliable direct fix yet. Please provide key context and I will return a repair-first plan.",
    style: "clarification",
    steps: [
      "Provide the required context listed below.",
      "I will re-retrieve with your inputs and narrow down to executable steps.",
      "If evidence is still insufficient after multiple rounds, I will suggest ticket handoff."
    ],
    validation: ["After context is added, sources should become more relevant.", "If ambiguity remains, continue with missing fields or handoff."],
    required_inputs: requiredInputs
  };
}

function buildClarificationQuestion(language: "zh" | "en", round: number, query: string): string {
  const intent = detectIntent(query);
  const required = buildRequiredInputs(language, intent, query);
  const batchSize = round === 1 ? 3 : 4;
  const start = Math.max(0, Math.min(required.length - 1, (round - 1) * batchSize));
  const current = required.slice(start, start + batchSize);
  const picked = current.length ? current : required.slice(0, 3);
  if (language === "zh") {
    return `为给你可靠结论，请先补充：${picked.join("、")}。`;
  }
  return `To give you a reliable answer, please provide: ${picked.join(", ")}.`;
}

function hasEvidenceRichInput(input: { query: string; conversation?: string[]; attachments?: string[] }): boolean {
  const text = [input.query, ...(input.conversation ?? [])].join("\n");
  const attachmentCount = input.attachments?.length ?? 0;
  const hasReproSteps = /\b(step|steps|action|expected|actual|no results|error|failed|bug|repro|reproduce)\b/i.test(text);
  const hasStructuredRepro = /(^|\n)\s*(\d+\.|-\s)/.test(text) || text.length >= 180;
  return attachmentCount > 0 || (hasReproSteps && hasStructuredRepro);
}

function isDocDrivenOpenApiQuery(query: string): boolean {
  const q = query.toLowerCase();
  return (
    /\/openapi\/v2\//.test(q) ||
    /\b(openapi|open api|issuetypeid|issueid|issue id|work item id|工作项id|工作项 id|工作项|projectid|fieldvalues|watchers|teamid|errorcode|errormsg|authorization|access[_ -]?token|client_id|client_secret|redirect_uri)\b/i.test(
      query
    ) ||
    /接口|开放平台|工作项|描述|图片|附件|导出|issueTypeID|teamID|projectID|fieldValues|watchers/i.test(query)
  );
}

function isTrulyVagueQuery(query: string): boolean {
  const compact = query.replace(/\s+/g, " ").trim();
  if (compact.length >= 10) return false;
  return !/\b(api|openapi|open api|token|oauth|github|gitlab|wiki|issue|bug|error|报错|失败|工作项|工单|授权|跳转|pod|pvc|volume|索引|重建)\b/i.test(
    compact
  );
}

function shouldUseEvidenceDiagnosis(input: { query: string; conversation?: string[]; attachments?: string[] }): boolean {
  return classifyQuerySync(input).route === "product_diagnosis";
}

function buildOpenApiAuthFallback(language: "zh" | "en"): StructuredSearchAnswer {
  if (language === "zh") {
    return {
      summary: "如果你问的是 ONES OpenAPI 里的个人令牌获取，文档显示应走 OAuth2 授权码流程：先 `GET /oauth2/authorize` 拿授权码，再 `POST /oauth2/token` 换取 access token。",
      assessment:
        "这是鉴权/凭据问题，不是产品缺陷排查。根据本地 OpenAPI 文档，可确认 `/oauth2/authorize` 与 `/oauth2/token` 是获取和刷新 access token 的核心接口；“组织凭据直接生成 token”不确定（文档未显示）。",
      style: "kb_answer",
      steps: [
        "先发起 `GET /oauth2/authorize`，带上 `client_id`、`response_type=code`、`redirect_uri`、`scope`、`state`。",
        "用户授权后拿到 `code`，再调用 `POST /oauth2/token`，并使用 `application/x-www-form-urlencoded`。",
        "首次换 token 用 `grant_type=authorization_code`；刷新 token 用 `grant_type=refresh_token`。"
      ],
      validation: [
        "如果缺少或错误的认证信息，优先排查 401。",
        "如果 token 有了但 scope 不够，优先排查 403。",
        "如果你告诉我你现在手上是 `client_id/client_secret/code` 还是已有 `access_token`，我可以继续给你下一步固定格式。"
      ]
    };
  }
  return {
    summary: "For ONES OpenAPI personal token acquisition, the documented flow is OAuth2 authorization code: first `GET /oauth2/authorize`, then `POST /oauth2/token` to exchange for an access token.",
    assessment:
      "This is an auth/credential question, not a product-defect diagnosis. The local OpenAPI spec clearly documents `/oauth2/authorize` and `/oauth2/token`; direct org-credential token generation is uncertain (not shown in the spec).",
    style: "kb_answer",
    steps: [
      "Call `GET /oauth2/authorize` with `client_id`, `response_type=code`, `redirect_uri`, `scope`, and `state`.",
      "After user consent, exchange the returned `code` via `POST /oauth2/token` with `application/x-www-form-urlencoded`.",
      "Use `grant_type=authorization_code` for the first exchange and `grant_type=refresh_token` for refresh."
    ],
    validation: [
      "Treat 401 as missing/invalid credentials.",
      "Treat 403 as scope/permission mismatch.",
      "If you tell me whether you currently have `client_id/client_secret/code` or an `access_token`, I can give you the exact next step."
    ]
  };
}

function buildOpenApiRequestFallback(query: string, language: "zh" | "en"): StructuredSearchAnswer | null {
  const q = query.toLowerCase();
  const isIssueCreate =
    /\/openapi\/v2\/project\/issues\b/.test(q) &&
    /\b(post|issueTypeID|projectID|fieldValues|watchers)\b/i.test(query);

  if (!isIssueCreate) {
    return null;
  }

  const hasStatusInPayload = /"status"\s*:\s*"/i.test(query);

  if (language === "zh") {
    return {
      summary: hasStatusInPayload
        ? "按 ONES OpenAPI 文档看，这次 `POST /project/issues` 最应该先删掉的是 `status` 字段。创建 issue 的请求体定义里没有 `status`，状态应通过 issue workflow 单独处理。"
        : "按 ONES OpenAPI 文档看，这次是 `POST /project/issues` 创建 issue 场景，应先核对 `issueTypeID`、`fieldValues` 和 watchers 是否符合文档定义。",
      assessment: hasStatusInPayload
        ? "本地 OpenAPI 文档中的 `AddIssueRequest` 只定义了 `assignee`、`title`、`projectID`、`issueTypeID`、`fieldValues`、`watchers` 和可选 `parentID`，没有 `status`。同时文档单独提供了 issue status 和 execute workflow 接口，说明状态不应在创建时直接传。"
        : "本地 OpenAPI 文档确认 `issueTypeID` 应通过 `GET /project/issueTypes` 获取；`fieldValues`、`watchers` 也必须符合创建 issue 的请求体定义。",
      style: "kb_answer",
      steps: hasStatusInPayload
        ? [
            "先去掉请求体里的 `status` 再重试创建。",
            "如果要把 issue 置为某个状态，创建成功后再走 issue workflow。",
            "用 `GET /project/issueTypes` 核对 `issueTypeID`，必要时再用 `GET /project/issueStatuses` 看状态体系。"
          ]
        : [
            "先用 `GET /project/issueTypes` 确认 `issueTypeID`。",
            "再核对 `fieldValues` 里的每个 `fieldID/type/value` 是否和该 issue type 匹配。",
            "最后确认 `watchers` 和 `assignee` 是否是合法用户 ID。"
          ],
      validation: hasStatusInPayload
        ? [
            "去掉 `status` 后再发一次，看是否由 500 变成成功或更明确的 4xx。",
            "如果仍失败，再继续缩小到最小请求体排查 `fieldValues`。"
          ]
        : [
            "先用最小请求体验证创建是否成功。",
            "如果失败，再逐个加回 `fieldValues` 缩小问题字段。"
          ]
    };
  }

  return {
    summary: hasStatusInPayload
      ? "According to the ONES OpenAPI spec, the first thing to remove from this `POST /project/issues` payload is `status`. `AddIssueRequest` does not define a `status` field; status should be handled via issue workflow separately."
      : "According to the ONES OpenAPI spec, this is a `POST /project/issues` create-issue request. Verify `issueTypeID`, `fieldValues`, and watchers against the documented schema first.",
    assessment: hasStatusInPayload
      ? "The local OpenAPI spec defines `AddIssueRequest` with `assignee`, `title`, `projectID`, `issueTypeID`, `fieldValues`, `watchers`, and optional `parentID`, but not `status`. The spec also exposes separate issue status and workflow APIs."
      : "The local OpenAPI spec confirms `issueTypeID` should come from `GET /project/issueTypes`, and `fieldValues`/`watchers` must match the create-issue schema.",
    style: "kb_answer",
    steps: hasStatusInPayload
      ? [
          "Remove `status` from the create payload and retry.",
          "If you need to move the issue to another status, execute issue workflow after creation.",
          "Use `GET /project/issueTypes` to verify `issueTypeID`, and `GET /project/issueStatuses` if you need status metadata."
        ]
      : [
          "Verify `issueTypeID` through `GET /project/issueTypes`.",
          "Check each `fieldID/type/value` in `fieldValues` against that issue type.",
          "Confirm `watchers` and `assignee` are valid user IDs."
        ],
    validation: hasStatusInPayload
      ? [
          "Retry without `status` first and see whether the 500 turns into success or a clearer 4xx error.",
          "If it still fails, reduce to a minimal payload and add back `fieldValues` one by one."
        ]
      : [
          "Start with the minimal payload and verify creation works.",
          "If it fails, add `fieldValues` back incrementally to isolate the bad field."
        ]
  };
}

function buildOpenApiLookupFallback(query: string, language: "zh" | "en"): StructuredSearchAnswer | null {
  const q = query.toLowerCase();

  if (
    /工作项.*描述.*图片|描述内.*图片|issue.*description.*image|attachment.*description|导出.*工作项.*图片|export.*issue.*image/i.test(query)
  ) {
    if (language === "zh") {
      return {
        summary:
          "可以先通过工作项接口拿到描述内容，再结合附件接口处理图片；但“直接导出工作项描述内图片”这件事，不确定（文档未显示有单独导出接口）。",
        assessment:
          "这是 ONES OpenAPI 能力边界问题，不是产品缺陷。当前本地 OpenAPI 文档明确有 `GET /project/issues/{issueID}` 和工作项附件接口，但没有看到“直接导出描述内图片”的独立接口定义。",
        style: "kb_answer",
        steps: [
          "先用 `GET /project/issues/{issueID}` 获取工作项详情和描述字段。",
          "如果描述里的图片实际对应工作项附件，再用 `GET /project/issues/{issueID}/attachments` 列出附件，并按 `attachmentID` 继续获取对应资源。",
          "如果你的目标是“完整导出描述里的所有图片”，需要自己解析描述中的资源引用关系；文档没有显示一个一步到位的导出接口。"
        ],
        validation: [
          "先确认工作项详情返回里是否包含描述字段原文。",
          "再确认描述中的图片是附件引用、资源链接，还是纯外链。",
          "如果图片不在附件列表里，是否能直接导出，不确定（文档未显示）。"
        ]
      };
    }
    return {
      summary:
        "You can first fetch the issue description, then handle images through attachment/resource APIs; but a direct API that exports images embedded inside an issue description is uncertain (not shown in the spec).",
      assessment:
        "This is an ONES OpenAPI capability-boundary question, not a product defect. The local spec clearly shows `GET /project/issues/{issueID}` and issue attachment endpoints, but it does not show a dedicated endpoint that directly exports images embedded in the description field.",
      style: "kb_answer",
      steps: [
        "Use `GET /project/issues/{issueID}` to fetch the issue detail and description field.",
        "If the images inside the description correspond to issue attachments, use `GET /project/issues/{issueID}/attachments` to list them and continue with the attachment resource path.",
        "If your goal is to export all images referenced inside the description, you will likely need to parse the description and resolve resource references yourself; the spec does not show a one-step export API."
      ],
      validation: [
        "Confirm whether the issue detail response includes the description content.",
        "Confirm whether the images in the description are attachment references, resource links, or external URLs.",
        "If they are not in the attachment list, direct export support is uncertain (not shown in the spec)."
      ]
    };
  }

  if (
    /\b(issueid|issue id|work item id)\b/i.test(query) ||
    /工作项id|工作项 id|通过.*id查询.*工作项|通过.*工作项id.*查询/i.test(query)
  ) {
    if (language === "zh") {
      return {
        summary: "可以。如果你手上已经有工作项 ID，就直接用 `GET /project/issues/{issueID}` 查询单个工作项。",
        assessment:
          "这是 ONES OpenAPI 的接口选择问题，不是产品缺陷。当前本地 OpenAPI 索引里同时存在 `GET /project/issues` 和 `GET /project/issues/{issueID}`，前者偏列表，后者偏按 ID 查询详情。",
        style: "kb_answer",
        steps: [
          "如果你已经知道工作项 ID，优先调用 `GET /project/issues/{issueID}`。",
          "如果你只有项目上下文，还不知道具体工作项 ID，就先用 `GET /project/issues` 做列表查询。",
          "带上正确的 `teamID` 和鉴权 token，再校验返回字段是否就是目标工作项。"
        ],
        validation: [
          "单个工作项查询应命中唯一记录，而不是列表页结果。",
          "如果返回 404，先确认 `issueID` 是否存在于当前团队上下文。",
          "如果返回 401/403，再排查 token 与 scope。"
        ]
      };
    }
    return {
      summary: "Yes. If you already have the work-item ID, use `GET /project/issues/{issueID}` to fetch that specific issue.",
      assessment:
        "This is an OpenAPI endpoint-selection question, not a product defect. The local ONES OpenAPI index contains both `GET /project/issues` and `GET /project/issues/{issueID}`: the former is for listing, the latter is for direct lookup by issue ID.",
      style: "kb_answer",
      steps: [
        "If the issue ID is already known, call `GET /project/issues/{issueID}`.",
        "If you only know the project context and do not know the issue ID yet, use `GET /project/issues` first.",
        "Pass the correct `teamID` and auth token, then verify the response is the target issue."
      ],
      validation: [
        "Direct issue lookup should return a single issue, not a list result.",
        "If you get 404, verify that the `issueID` exists in the current team context.",
        "If you get 401/403, troubleshoot token and scope next."
      ]
    };
  }

  if (/\bissuetypeid\b/i.test(query)) {
    if (language === "zh") {
      return {
        summary: "`issueTypeID` 需要先通过 `GET /project/issueTypes` 获取，不能自己猜。",
        assessment: "这是 ONES OpenAPI 里的参数获取问题，属于文档型问题，不是产品缺陷。`issueTypeID` 对应的是 issue type 列表接口返回的 ID。",
        style: "kb_answer",
        steps: [
          "先调用 `GET /project/issueTypes?teamID=...` 获取当前团队可用的 issue types。",
          "从返回结果里找到目标类型，对应字段里的 ID 就是 `issueTypeID`。",
          "创建 issue 时再把这个 ID 填到 `POST /project/issues` 请求体里。"
        ],
        validation: [
          "确认 `issueTypeID` 来自同一个 team/project 上下文。",
          "如果创建仍失败，再继续核对 `fieldValues` 与 `projectID`。"
        ]
      };
    }
    return {
      summary: "`issueTypeID` should be obtained from `GET /project/issueTypes`; do not guess it manually.",
      assessment: "This is an OpenAPI parameter lookup question, not a product defect. `issueTypeID` is the ID returned by the issue types listing endpoint.",
      style: "kb_answer",
      steps: [
        "Call `GET /project/issueTypes?teamID=...` to list available issue types for the team.",
        "Find the target type in the response; its returned ID is the `issueTypeID`.",
        "Use that ID in `POST /project/issues` when creating the issue."
      ],
      validation: [
        "Make sure the `issueTypeID` comes from the same team/project context.",
        "If creation still fails, then verify `fieldValues` and `projectID` next."
      ]
    };
  }

  if (/\bteamid\b/i.test(query)) {
    if (language === "zh") {
      return {
        summary: "`teamID` 是团队标识，应来自你当前 ONES 团队上下文或相关列表接口返回值。",
        assessment: "这是 OpenAPI 基础参数问题，属于文档型说明，不是产品问题。",
        style: "kb_answer",
        steps: [
          "先确认你当前调用的是哪个 ONES 团队。",
          "优先从已有团队上下文或团队/项目相关接口返回结果中取 `teamID`。",
          "后续所有同团队接口都应复用同一个 `teamID`。"
        ],
        validation: [
          "确认 URL 里的 `teamID` 与你实际所在团队一致。",
          "如果出现 401/403/404，再继续排查 token、权限或环境。"
        ]
      };
    }
    return {
      summary: "`teamID` is the team identifier and should come from your current ONES team context or a related listing response.",
      assessment: "This is a basic OpenAPI parameter lookup question, not a product issue.",
      style: "kb_answer",
      steps: [
        "Confirm which ONES team you are operating on.",
        "Get `teamID` from the current team context or a team/project listing response.",
        "Reuse the same `teamID` consistently across requests for that team."
      ],
      validation: [
        "Verify the `teamID` in the URL matches the actual target team.",
        "If 401/403/404 appears, troubleshoot token, permission, or environment next."
      ]
    };
  }

  if (/\b(fieldvalues|watchers|projectid)\b/i.test(query) || /\b字段|项目id|观察者\b/.test(query)) {
    if (language === "zh") {
      return {
        summary: "这属于创建 issue 请求体字段说明问题，应该先按 OpenAPI 文档拆成 `projectID`、`issueTypeID`、`fieldValues`、`watchers` 四块分别核对。",
        assessment: "当前问题属于请求体结构理解，不应直接落到产品问题或工单分支。",
        style: "kb_answer",
        steps: [
          "`projectID` 先从项目上下文获取。",
          "`issueTypeID` 通过 `GET /project/issueTypes` 获取。",
          "`fieldValues` 与 `watchers` 再按该 issue type 和用户 ID 逐项校验。"
        ],
        validation: [
          "建议先用最小请求体验证能否创建成功。",
          "再逐步加回 `fieldValues` 缩小问题字段。"
        ]
      };
    }
    return {
      summary: "This is a create-issue payload question. Validate `projectID`, `issueTypeID`, `fieldValues`, and `watchers` separately against the OpenAPI spec.",
      assessment: "This is a request-body understanding issue and should not fall into the product-defect path.",
      style: "kb_answer",
      steps: [
        "Get `projectID` from project context first.",
        "Resolve `issueTypeID` via `GET /project/issueTypes`.",
        "Then validate `fieldValues` and `watchers` against that issue type and user IDs."
      ],
      validation: [
        "Start with a minimal create payload.",
        "Add `fieldValues` back incrementally to isolate the bad field."
      ]
    };
  }

  return null;
}

function buildOpenApiClarificationFallback(language: "zh" | "en"): StructuredSearchAnswer {
  if (language === "zh") {
    return {
      summary: "这是 ONES OpenAPI 文档问题，不该直接转产品问题；但当前还缺少具体对象，无法继续精确到接口。",
      assessment: "当前至少可以确认这是文档/接口问答场景，不是产品缺陷。下一步只需要补接口对象，不需要再补一堆泛化上下文。",
      style: "clarification",
      steps: [
        "请明确你问的是哪个对象：issue / comment / attachment / watcher / wiki / project / worklog。",
        "如果你已经有接口路径，直接贴 `Method + Path`。",
        "如果你是在问某个参数怎么拿，直接贴参数名，例如 `issueTypeID`、`teamID`、`projectID`。"
      ],
      validation: ["补上对象或接口路径后，应能直接收敛到明确接口。"]
    };
  }
  return {
    summary: "This is an ONES OpenAPI documentation question, not a product defect, but I still need the target object before I can narrow it to the exact endpoint.",
    assessment: "The route is already clear: this is documentation/API guidance, not product diagnosis. I only need the object scope, not generic extra context.",
    style: "clarification",
    steps: [
      "Tell me the target object: issue / comment / attachment / watcher / wiki / project / worklog.",
      "If you already have an endpoint path, provide `Method + Path` directly.",
      "If you are asking how to obtain a parameter, provide the parameter name such as `issueTypeID`, `teamID`, or `projectID`."
    ],
    validation: ["Once the object or endpoint path is provided, the answer should narrow down to the exact API."]
  };
}

function buildKBGuidanceFallback(query: string, language: "zh" | "en"): StructuredSearchAnswer {
  const intent = detectIntent(query);
  const requiredInputs = buildRequiredInputs(language, intent, query);
  if (language === "zh") {
    return {
      summary: "当前还没有命中足够可靠的知识库文档，先补最关键的一条上下文，我再继续收敛到可执行答案。",
      assessment: "这是知识问答场景，但当前证据不足以直接给可靠结论。",
      style: "clarification",
      steps: [requiredInputs[0] ? `先补充：${requiredInputs[0]}。` : "请补充最关键的场景信息。"],
      validation: ["补充后应命中更相关的知识文档。"],
      required_inputs: requiredInputs.slice(0, 2)
    };
  }
  return {
    summary: "I do not have a reliable grounded document yet. Give me the single most important missing context and I will narrow this down.",
    assessment: "This is a KB-guidance request, but evidence is still too weak for a direct answer.",
    style: "clarification",
    steps: [requiredInputs[0] ? `Start by providing: ${requiredInputs[0]}.` : "Provide the single most important missing context."],
    validation: ["The next round should hit more relevant knowledge documents."],
    required_inputs: requiredInputs.slice(0, 2)
  };
}

type SearchRouteDecision = {
  answer: string;
  structuredAnswer?: StructuredSearchAnswer;
  state: SearchDialogState;
  clarificationRound: number;
  showCreateTicketNow: boolean;
  followUpQuestion: string | null;
  selfServeResolved: boolean;
  effectiveReferences: SearchReference[];
};

function resolveSearchBotDecision(input: {
  language: "zh" | "en";
  query: string;
  classification: Awaited<ReturnType<typeof classifyQuery>>;
  response: SearchResponseEnvelope;
  grounded: boolean;
  effectiveReferences: SearchReference[];
  previousDialog: Awaited<ReturnType<typeof aiRepo.getDialogState>>;
}): SearchRouteDecision {
  const { language, query, classification, response, grounded, previousDialog } = input;
  const groundedAnswer = buildQueryAwareStructuredAnswer(language, response.query, input.effectiveReferences) ?? undefined;

  if (grounded) {
    const structuredAnswer = groundedAnswer;
    const answer =
      response.answer.trim() && shouldUseRawGroundedAnswer(query || response.query, input.effectiveReferences)
        ? response.answer.trim()
        : structuredAnswer?.summary ?? response.answer;
    return {
      answer,
      structuredAnswer: structuredAnswer
        ? {
            ...structuredAnswer,
            summary: response.answer.trim() && shouldUseRawGroundedAnswer(query || response.query, input.effectiveReferences)
              ? response.answer.trim()
              : structuredAnswer.summary
          }
        : undefined,
      state: "GROUNDABLE_ANSWER_READY",
      clarificationRound: 0,
      showCreateTicketNow: false,
      followUpQuestion: null,
      selfServeResolved: true,
      effectiveReferences: input.effectiveReferences
    };
  }

  if (classification.route === "openapi_doc") {
    const structuredAnswer =
      buildOpenApiRequestFallback(query || response.query, language) ??
      buildOpenApiLookupFallback(query || response.query, language) ??
      (classification.authProblem ? buildOpenApiAuthFallback(language) : null) ??
      buildOpenApiClarificationFallback(language);
    const isClarification = structuredAnswer.style === "clarification";
    return {
      answer: structuredAnswer.summary,
      structuredAnswer,
      state: isClarification ? "CLARIFICATION_REQUIRED" : "GROUNDABLE_ANSWER_READY",
      clarificationRound: isClarification ? 1 : 0,
      showCreateTicketNow: false,
      followUpQuestion: isClarification ? structuredAnswer.summary : null,
      selfServeResolved: !isClarification,
      effectiveReferences: []
    };
  }

  if (classification.route === "infra_runbook") {
    const structuredAnswer = buildInfraRunbookFallback(query || response.query, language)!;
    return {
      answer: structuredAnswer.summary,
      structuredAnswer,
      state: "GROUNDABLE_ANSWER_READY",
      clarificationRound: 0,
      showCreateTicketNow: false,
      followUpQuestion: null,
      selfServeResolved: true,
      effectiveReferences: []
    };
  }

  if (classification.route === "integration_diagnosis") {
    const structuredAnswer = buildIntegrationDiagnosisFallback(query || response.query, language)!;
    return {
      answer: structuredAnswer.summary,
      structuredAnswer,
      state: "GROUNDABLE_ANSWER_READY",
      clarificationRound: 0,
      showCreateTicketNow: false,
      followUpQuestion: null,
      selfServeResolved: true,
      effectiveReferences: []
    };
  }

  if (classification.route === "product_diagnosis") {
    const structuredAnswer = inferEvidenceDiagnosis(query || response.query, language);
    return {
      answer: structuredAnswer.summary,
      structuredAnswer,
      state: "TICKET_HANDOFF_RECOMMENDED",
      clarificationRound: 0,
      showCreateTicketNow: true,
      followUpQuestion: null,
      selfServeResolved: false,
      effectiveReferences: []
    };
  }

  if (classification.route === "kb_guidance") {
    const structuredAnswer = groundedAnswer ?? buildKBGuidanceFallback(query || response.query, language);
    const isClarification = structuredAnswer.style === "clarification";
    return {
      answer: structuredAnswer.summary,
      structuredAnswer,
      state: isClarification ? "CLARIFICATION_REQUIRED" : "GROUNDABLE_ANSWER_READY",
      clarificationRound: isClarification ? 1 : 0,
      showCreateTicketNow: false,
      followUpQuestion: isClarification ? structuredAnswer.summary : null,
      selfServeResolved: !isClarification,
      effectiveReferences: isClarification ? [] : input.effectiveReferences
    };
  }

  const trulyVague = isTrulyVagueQuery(query || response.query);
  if (!trulyVague) {
    const structuredAnswer = buildKBGuidanceFallback(query || response.query, language);
    return {
      answer: structuredAnswer.summary,
      structuredAnswer,
      state: "CLARIFICATION_REQUIRED",
      clarificationRound: 1,
      showCreateTicketNow: false,
      followUpQuestion: structuredAnswer.summary,
      selfServeResolved: false,
      effectiveReferences: []
    };
  }

  const structuredAnswer = buildClarificationStructuredAnswer(language, response.query);
  return {
    answer: structuredAnswer.summary,
    structuredAnswer,
    state: "CLARIFICATION_REQUIRED",
    clarificationRound: (previousDialog?.clarification_round ?? 0) + 1,
    showCreateTicketNow: false,
    followUpQuestion: structuredAnswer.summary,
    selfServeResolved: false,
    effectiveReferences: []
  };
}

function buildInfraRunbookFallback(query: string, language: "zh" | "en"): StructuredSearchAnswer | null {
  if (!isInfraTroubleshooting(query)) return null;

  const signals = extractQuerySignals(query);
  const ns = signals.namespace ?? "<ns>";
  const app = signals.appLabel ?? "kilob-sync";
  const pod = signals.podName ?? "<kilob-sync-pod>";
  const q = query.toLowerCase();
  const hasLoadStoreHint = /\bloadstore from pd failed\b/i.test(q);
  const hasReindexHint = /\b(reindex|rebuild|重建索引|重建)\b/i.test(query);

  if (language === "zh") {
    if (hasLoadStoreHint) {
      return {
        summary: "这更像持久卷（PD/PVC）或挂载状态异常，导致 `kilob-sync` 在重建阶段加载本地 store 失败。",
        assessment: "虽然当前没有命中可直接引用的 KB 文档，但故障签名 `loadStore from PD failed` 已经足够明确，优先按存储/挂载路径排查，而不是继续泛化追问。",
        style: "diagnosis",
        steps: [
          `先看 Pod 与卷事件：\`kubectl -n ${ns} describe pod ${pod}\`，重点找 MountVolume、Read-only file system、no space left。`,
          `再查最近日志：\`kubectl -n ${ns} logs ${pod} --previous\`，确认失败前是否有卷挂载、磁盘只读或 store 损坏迹象。`,
          `如果卷状态异常，先恢复 PVC/PV/挂载；如果卷正常，再重启 Pod 或重新触发一次 rebuild，确认是否仍报 \`loadStore from PD failed\`。`
        ],
        validation: [
          "如果 describe 里出现挂载失败、只读、空间不足，这条链路就成立。",
          "修复卷状态后再次重建，日志不应继续停在 `loadStore from PD failed`。"
        ]
      };
    }

    if (hasReindexHint) {
      return {
        summary: "这属于 infra 排障，不该只停留在“补充上下文”。先按 `kilob-sync` 重建任务、Pod 实例与卷状态三条线并行排查。",
        assessment: "你的问题已经包含组件名和故障动作，足够先给出排查路径。当前最重要的是确认重建任务打到哪个 Pod、日志是否是新实例、以及卷状态是否正常。",
        style: "diagnosis",
        steps: [
          `先看实例是否切对：\`kubectl -n ${ns} get pods -l app=${app} -o wide\`，核对 AGE/RESTARTS 与本次重建时间。`,
          `再看目标 Pod：\`kubectl -n ${ns} logs ${pod} --since=30m\` 和 \`kubectl -n ${ns} describe pod ${pod}\`，确认本次任务是否命中新实例。`,
          "如果任务仍命中旧实例，先重启对应组件后再重新触发 reindex/rebuild；如果实例没问题，再转向 PVC/PV/挂载排查。"
        ],
        validation: [
          "新触发任务应命中新 Pod，日志时间应推进到当前时间。",
          "如果仍异常，再补充 Pod 事件和失败前后日志继续收敛。"
        ]
      };
    }

    return {
      summary: "这是 infra 排障问题，当前至少已经可以先从 Pod 状态、日志和卷挂载三条线开始定位。",
      assessment: "当前问题不是文档型使用问答，也不是产品功能缺陷，优先给排查路径比继续空泛追问更有效。",
      style: "diagnosis",
      steps: [
        `先拿到 \`kubectl -n ${ns} get pods -o wide\` 与目标 Pod 的 \`describe\` 输出。`,
        `再看最近日志，确认是否有权限、挂载、只读、磁盘空间或实例切换异常。`,
        "若定位到卷/挂载问题先修基础设施；若定位不到，再提交工单并附上日志与事件。"
      ],
      validation: [
        "能否从 describe/log 中看到明确异常事件。",
        "修复后重新触发操作，确认症状是否消失。"
      ]
    };
  }

  if (hasLoadStoreHint) {
    return {
      summary: "This points more to PD/PVC or mount-state failure during rebuild, causing `kilob-sync` to fail loading the local store.",
      assessment: "Even without a grounded KB hit, the signature `loadStore from PD failed` is specific enough to start from storage/mount troubleshooting instead of generic clarification.",
      style: "diagnosis",
      steps: [
        `Inspect pod and volume events: \`kubectl -n ${ns} describe pod ${pod}\` and look for MountVolume, Read-only file system, or no space left.`,
        `Check recent logs: \`kubectl -n ${ns} logs ${pod} --previous\` and verify whether storage/mount errors appear before the failure.`,
        "If volume state is abnormal, recover PVC/PV/mount first; if volume is healthy, restart the pod or trigger rebuild again and verify whether `loadStore from PD failed` still appears."
      ],
      validation: [
        "If describe shows mount/read-only/no-space events, the storage path is confirmed.",
        "After fixing the volume state, rebuild should no longer stop at `loadStore from PD failed`."
      ]
    };
  }

  return {
    summary: "This is an infra troubleshooting case. Start from pod state, logs, and volume/mount health instead of generic clarification.",
    assessment: "The query already includes enough operational signals to give a first-pass runbook path.",
    style: "diagnosis",
    steps: [
      `Collect \`kubectl -n ${ns} get pods -o wide\` and describe the failing pod.`,
      "Check recent logs for mount, permission, read-only, or storage symptoms.",
      "Fix infra-layer issues first; if no infra signal appears, then escalate with logs and events."
    ],
    validation: [
      "You should be able to confirm or rule out storage/mount failure from describe and logs.",
      "Re-run after the fix and confirm the failure no longer reproduces."
    ]
  };
}

function buildIntegrationDiagnosisFallback(query: string, language: "zh" | "en"): StructuredSearchAnswer | null {
  if (!isIntegrationDiagnosisQuery(query)) return null;

  const q = query.toLowerCase();
  const github = /\bgithub\b/i.test(query);
  const pageNotFound = /page not found|404/.test(q);
  const redirect = /redirect|callback|跳转|回调/.test(q);
  const target = github ? "GitHub" : "第三方集成";

  if (language === "zh") {
    return {
      summary:
        pageNotFound && redirect
          ? `这更像 ${target} 授权跳转配置异常，不是普通使用问题。最高概率在 OAuth 授权地址、回调地址或环境域名不一致。`
          : `这更像 ${target} 集成配置或授权链路异常，应先核对授权地址、回调地址与环境配置。`,
      assessment:
        pageNotFound && github
          ? "现象是点击“添加授权账号”后已跳转到 GitHub，但 GitHub 返回 `Page not found`。这通常说明跳转 URL 本身不合法，或 GitHub OAuth App 配置与当前环境不匹配。"
          : "当前问题已经包含明确故障现象和集成对象，足够先按授权链路排查，而不是直接追问泛化上下文。",
      style: "diagnosis",
      steps: [
        `先检查前端实际跳转出去的 ${target} 授权 URL，确认是否是标准授权地址。`,
        "核对 OAuth App / 集成配置里的 Client ID、Authorization URL、Callback URL。",
        "确认当前环境域名与 OAuth App 配置一致，不要混用本地、测试、预发、生产环境。"
      ],
      validation: [
        "如果修正后能进入正常授权确认页，说明是授权地址或回调配置问题。",
        "如果仍报 404 / page not found，再补充完整跳转 URL 和配置截图继续排查。"
      ]
    };
  }

  return {
    summary:
      pageNotFound && redirect
        ? `This looks more like a ${target} authorization redirect misconfiguration than a normal usage issue. The highest-probability causes are an invalid OAuth authorize URL, callback URL, or environment/domain mismatch.`
        : `This looks more like a ${target} integration configuration or authorization-chain issue. Verify authorize URL, callback URL, and environment mapping first.`,
    assessment:
      pageNotFound && github
        ? "The flow already reaches GitHub, but GitHub returns `Page not found`. That usually means the redirect URL itself is malformed, or the GitHub OAuth App configuration does not match the current environment."
        : "The query already contains a concrete integration surface and failure symptom, so the next step is authorization-chain diagnosis rather than generic clarification.",
    style: "diagnosis",
    steps: [
      `Inspect the actual ${target} authorization URL generated by the frontend and confirm it is the expected OAuth authorize endpoint.`,
      "Verify Client ID, Authorization URL, and Callback URL in the OAuth App / integration configuration.",
      "Confirm the current environment domain matches the OAuth App configuration; do not mix local, staging, pre-prod, and production."
    ],
    validation: [
      "If the fix leads to the normal authorization consent page, the issue was in authorize/callback configuration.",
      "If 404/page not found persists, collect the full redirect URL and config screenshots for the next step."
    ]
  };
}

function renderStructuredAnswerAsAgentReply(language: "zh" | "en", answer: StructuredSearchAnswer): string {
  const lines: string[] = [answer.summary.trim()];
  if (answer.assessment?.trim()) {
    lines.push("", language === "zh" ? "判断依据：" : "Assessment:");
    lines.push(answer.assessment.trim());
  }
  if (answer.steps.length) {
    lines.push("", language === "zh" ? "建议动作：" : "Recommended actions:");
    answer.steps.forEach((step, idx) => {
      lines.push(`${idx + 1}. ${step}`);
    });
  }
  if (answer.validation.length) {
    lines.push("", language === "zh" ? "验证点：" : "Validation:");
    answer.validation.forEach((item) => {
      lines.push(`- ${item}`);
    });
  }
  return lines.join("\n").trim();
}

function buildDeterministicTicketTriage(input: {
  title: string;
  description: string;
  history: Array<{ author: string; body: string }>;
}): OpenClawAnalyzeOutput | null {
  const combined = [
    input.title.trim(),
    input.description.trim(),
    ...input.history.slice(-6).map((item) => `${item.author}: ${item.body}`)
  ]
    .filter(Boolean)
    .join("\n");
  const language = detectLanguage(combined);
  const classification = classifyQuerySync({ query: combined });

  let structured: StructuredSearchAnswer | null = null;
  if (classification.route === "openapi_doc") {
    structured = buildOpenApiRequestFallback(combined, language) ?? buildOpenApiLookupFallback(combined, language) ?? buildOpenApiAuthFallback(language);
  } else if (classification.route === "infra_runbook") {
    structured = buildInfraRunbookFallback(combined, language);
  } else if (classification.route === "integration_diagnosis") {
    structured = buildIntegrationDiagnosisFallback(combined, language);
  } else if (classification.route === "product_diagnosis") {
    return {
      action: "escalate",
      confidence: 0.86,
      reply: "",
      reasoning_summary: "Deterministic orchestration classified the ticket as product defect / ticket handoff.",
      evidence: ["orchestrator:product_diagnosis"],
      risk_flags: ["needs_rnd"]
    };
  }

  if (!structured) return null;
  return {
    action: "ask_user",
    confidence: 0.82,
    reply: renderStructuredAnswerAsAgentReply(language, structured),
    reasoning_summary: `Deterministic orchestration matched route ${classification.route}.`,
    evidence: [`orchestrator:${classification.route}`],
    risk_flags: []
  };
}

function inferEvidenceDiagnosis(query: string, language: "zh" | "en"): StructuredSearchAnswer {
  const q = query.toLowerCase();
  const looksLikeSearchBug =
    /\b(search|filter|find|lookup)\b/.test(q) &&
    /\b(no results|cannot|can't|not work|not working|missing)\b/.test(q);

  const looksLikeProductBug =
    looksLikeSearchBug ||
    /\b(bug|regression|unexpected|incorrect|wrong result|empty result|blank)\b/.test(q);

  if (language === "zh") {
    return looksLikeProductBug
      ? {
          summary: "已结合现有复现步骤与附件证据判断，这更像产品本身的问题，不属于知识库可直接解决的使用类问题。",
          assessment: looksLikeSearchBug
            ? "现象符合搜索/筛选缺陷：对象存在，但输入标题后结果变为空。"
            : "现有证据更符合产品缺陷或回归，而不是配置/操作问题。",
          style: "diagnosis",
          steps: [
            "建议立即提交工单，并附上截图、HAR、实际输入值和期望结果。",
            "在工单中明确写出：数据实际存在，但输入同名标题后返回空结果。",
            "如有条件，请补充一次成功场景与失败场景的请求对比。"
          ],
          validation: [
            "研发应先比对“无搜索词”和“有搜索词”两次请求的查询条件差异。",
            "重点检查后端搜索/分词/精确匹配逻辑是否对特殊字符、版本号或标题字段处理异常。"
          ]
        }
      : {
          summary: "已结合现有证据判断，这更像产品问题或内部逻辑缺陷，知识库暂时无法直接给出修复方案。",
          assessment: "用户已提供了足够上下文，当前更适合转工单定位根因。",
          style: "diagnosis",
          steps: ["建议提交工单并附上全部证据。", "在工单中明确复现步骤、期望结果、实际结果。", "保留附件原件供研发排查。"],
          validation: ["后续应由研发基于请求链路和数据状态继续定位。"]
        };
  }

  return looksLikeProductBug
    ? {
        summary: "Based on the provided repro steps and attachments, this looks like a product issue rather than a KB-solvable usage question.",
        assessment: looksLikeSearchBug
          ? "The symptom matches a search/filter defect: the object exists, but searching by its title returns no results."
          : "The evidence fits a product bug or regression more than a configuration or usage mistake.",
        style: "diagnosis",
        steps: [
          "Submit a ticket now and attach the screenshots, HAR, exact input value, and expected result.",
          "State clearly that the record exists in the unfiltered list but disappears when the same title is searched.",
          "If available, include one success-vs-failure request comparison."
        ],
        validation: [
          "Engineering should compare the query conditions between the unfiltered and filtered requests.",
          "Check backend search/tokenization/exact-match handling for special characters, version strings, or title fields."
        ]
      }
    : {
        summary: "Based on the current evidence, this looks more like a product issue or internal logic defect than a KB-solvable question.",
        assessment: "The user has already provided enough context, so the next step should be ticket handoff rather than generic clarification.",
        style: "diagnosis",
        steps: ["Submit a ticket with the collected evidence.", "State repro steps, expected result, and actual result.", "Keep the original attachments for engineering analysis."],
        validation: ["Engineering should continue from request traces and data state."]
      };
}

function normalizeTranscript(input: string[]): Array<{ role: "user" | "assistant"; content: string; at: string }> {
  const now = new Date().toISOString();
  return input
    .map((text, idx) => {
      const role: "user" | "assistant" = idx % 2 === 0 ? "user" : "assistant";
      return {
        role,
        content: text.trim(),
        at: now
      };
    })
    .filter((item) => item.content.length > 0);
}

function mergeTranscript(
  previous: Array<{ role: "user" | "assistant"; content: string; at: string }> | undefined,
  latestQuery: string,
  latestAnswer: string,
  conversation: string[]
): Array<{ role: "user" | "assistant"; content: string; at: string }> {
  const merged = [...(previous ?? [])];
  merged.push(...normalizeTranscript(conversation));
  merged.push({ role: "user", content: latestQuery.trim(), at: new Date().toISOString() });
  if (latestAnswer.trim()) {
    merged.push({ role: "assistant", content: latestAnswer.trim(), at: new Date().toISOString() });
  }
  return merged.slice(-40);
}

export async function runSearchMode(
  query: string,
  adapter: OpenClawAdapter,
  options?: { sessionId?: string; conversation?: string[]; answerLanguage?: "zh" | "en"; imageAttachments?: string[]; attachments?: string[] }
): Promise<SearchModeResult> {
  const sessionId = options?.sessionId ?? crypto.randomUUID();
  const previousDialog = await aiRepo.getDialogState(sessionId);
  const currentRound = previousDialog?.clarification_round ?? 0;
  const searchIntent = currentRound > 0 ? "clarify" : "retrieval";
  const runtime = buildSearchRuntime({ intent: searchIntent, sessionId });
  const orchestrator = new SearchOrchestrator(adapter);
  const trimmedQuery = query.trim();
  const prevTranscript = previousDialog?.transcript;
  const resolvedQuery = trimmedQuery || (prevTranscript?.length ? prevTranscript[prevTranscript.length - 1].content : "") || "";
  const attachments = options?.attachments ?? options?.imageAttachments ?? [];
  const imageAttachments = options?.imageAttachments ?? attachments.filter((item) => item.includes("/uploads/images/"));
  const classification = await classifyQuery({
    query: resolvedQuery,
    conversation: options?.conversation,
    attachments
  }, adapter);
  const language = options?.answerLanguage ?? detectLanguage(trimmedQuery || "image");
  const baseQuery =
    trimmedQuery ||
    (language === "zh"
      ? "请分析附件截图，并判断问题现象与可能原因。"
      : "Please analyze the attached screenshots and identify the issue.");

  let multimodalQuery = baseQuery;
  try {
    const textAttachmentSummary = await summarizeTextAttachments({
      attachments,
      answerLanguage: language
    });
    if (textAttachmentSummary) {
      multimodalQuery = `${multimodalQuery}\n\n${textAttachmentSummary}`;
    }
  } catch {
    // Ignore text-attachment extraction failures and continue with the user query.
  }
  if (imageAttachments.length > 0) {
    try {
      const imageSummary = await summarizeImageAttachments({
        query: trimmedQuery,
        attachments: imageAttachments,
        answerLanguage: language
      });
      if (imageSummary) {
        multimodalQuery = `${baseQuery}\n\n${language === "zh" ? "[截图分析]" : "[Screenshot analysis]"}\n${imageSummary}`;
      }
    } catch {
      multimodalQuery = baseQuery;
    }
  }

  const response = await orchestrator.search(multimodalQuery, `search:${sessionId}:${currentRound + 1}`, runtime, language, imageAttachments);
  const filteredReferences = filterReferencesByIntent(response.query, response.references);
  const forceScopedReferences = classification.route === "openapi_doc" || classification.intent === "api_operation";
  let effectiveReferences = forceScopedReferences
    ? filteredReferences
    : filteredReferences.length
      ? filteredReferences
      : response.references;
  const confidenceThreshold = Math.max(0.45, env.AI_SEARCH_ANSWER_CONFIDENCE_THRESHOLD);
  const lowConfidence = response.confidence < confidenceThreshold;
  // Only clear references when there are truly no results.
  // Low-confidence references are still passed to the agent for synthesis context;
  // citations are hidden from the user unless confidence is sufficient.
  if (response.retrievalStatus === "no_results" && response.references.length === 0) {
    effectiveReferences = [];
  }
  const showCitationsToUser = response.retrievalStatus === "grounded" && !lowConfidence;
  if (forceScopedReferences && effectiveReferences.length > 0 && !effectiveReferences.some(isOpenApiReference)) {
    effectiveReferences = [];
  }
  const citationsValid = hasValidCitations(effectiveReferences);
  const grounded = response.retrievalStatus === "grounded" && citationsValid && effectiveReferences.length > 0;
  let selfServeResolved = grounded;

  if (!options?.sessionId || !previousDialog) {
    await aiRepo.createSearchSession({
      sessionId,
      query: response.query,
      answer: response.answer,
      confidence: response.confidence,
      retrievalStatus: response.retrievalStatus,
      unresolvedReasonCode: response.unresolvedReasonCode,
      suggestedNextStep: selfServeResolved ? "self_serve" : "submit_ticket"
    });
  } else {
    await aiRepo.updateSearchSession({
      sessionId,
      answer: response.answer,
      confidence: response.confidence,
      retrievalStatus: response.retrievalStatus,
      unresolvedReasonCode: response.unresolvedReasonCode,
      suggestedNextStep: selfServeResolved ? "self_serve" : "submit_ticket"
    });
  }

  await aiRepo.saveSearchReferences(sessionId, effectiveReferences);

  const fallbackDecision = resolveSearchBotDecision({
    language,
    query: trimmedQuery || response.query,
    classification,
    response,
    grounded,
    effectiveReferences,
    previousDialog
  });
  const fallbackStructuredAnswer = fallbackDecision.structuredAnswer;

  let state: SearchDialogState = fallbackDecision.state;
  let clarificationRound: number = fallbackDecision.clarificationRound;
  let showCreateTicketNow: boolean = fallbackDecision.showCreateTicketNow;
  let followUpQuestion: string | null = fallbackDecision.followUpQuestion;
  let answer: string = fallbackDecision.answer;
  let structuredAnswer: StructuredSearchAnswer | undefined = fallbackDecision.structuredAnswer;

  let agentSynthesized = false;

  // Build conversation history for the agent from previous dialog + current conversation
  const agentConversationHistory: Array<{ role: "user" | "assistant"; content: string }> = [];
  if (previousDialog?.transcript?.length) {
    for (const turn of previousDialog.transcript.slice(-6)) {
      agentConversationHistory.push({ role: turn.role, content: turn.content });
    }
  }
  if (options?.conversation?.length) {
    for (const msg of options.conversation.slice(-4)) {
      agentConversationHistory.push({ role: "user", content: msg });
    }
  }

  try {
    const agentAnswer = await adapter.answerSearchQuery(
      {
        query: trimmedQuery || response.query,
        language,
        routeHint: classification.route,
        grounded,
        references: effectiveReferences.map((item) => ({
          title: item.title,
          snippet: item.snippet,
          sourceUrl: item.sourceUrl,
          path: getCitationMeta(item).path
        })),
        draftAnswer: fallbackStructuredAnswer
          ? {
              answer: fallbackDecision.answer,
              style: fallbackStructuredAnswer.style,
              summary: fallbackStructuredAnswer.summary,
              assessment: fallbackStructuredAnswer.assessment,
              steps: fallbackStructuredAnswer.steps,
              validation: fallbackStructuredAnswer.validation,
              required_inputs: fallbackStructuredAnswer.required_inputs
            }
          : undefined,
        conversationHistory: agentConversationHistory.length ? agentConversationHistory : undefined,
        attachments
      },
      `search-answer:${sessionId}:${Date.now()}`,
      runtime
    );

    // Quality gate: agent result must have meaningful content
    const summaryOk = agentAnswer.summary?.trim() && agentAnswer.summary.trim().length > 20;
    const stepsOk = Array.isArray(agentAnswer.steps) && agentAnswer.steps.length >= 1;
    const answerOk = agentAnswer.answer?.trim() && agentAnswer.answer.trim().length > 20;
    const passesQualityGate = summaryOk && (stepsOk || answerOk);

    if (passesQualityGate) {
      agentSynthesized = true;
      answer = agentAnswer.answer?.trim() || agentAnswer.summary.trim();
      structuredAnswer = {
        summary: agentAnswer.summary.trim(),
        assessment: agentAnswer.assessment?.trim() || undefined,
        style: agentAnswer.style,
        steps: agentAnswer.steps,
        validation: agentAnswer.validation,
        required_inputs: agentAnswer.required_inputs
      };

      if (agentAnswer.style === "kb_answer") {
        state = "GROUNDABLE_ANSWER_READY";
        clarificationRound = 0;
        showCreateTicketNow = false;
        followUpQuestion = null;
        selfServeResolved = true;
      } else if (agentAnswer.style === "diagnosis") {
        const shouldTicket = agentAnswer.suggested_next_step === "submit_ticket";
        state = shouldTicket ? "TICKET_HANDOFF_RECOMMENDED" : "GROUNDABLE_ANSWER_READY";
        clarificationRound = 0;
        showCreateTicketNow = shouldTicket;
        followUpQuestion = null;
        selfServeResolved = !shouldTicket;
        if (shouldTicket) {
          effectiveReferences = [];
        }
      } else if (agentAnswer.style === "clarification") {
        clarificationRound = Math.max(1, fallbackDecision.clarificationRound);
        state = clarificationRound > 1 ? "CLARIFICATION_IN_PROGRESS" : "CLARIFICATION_REQUIRED";
        showCreateTicketNow = false;
        followUpQuestion = answer;
        selfServeResolved = false;
        effectiveReferences = [];
      } else {
        // Default: treat unknown style as a grounded answer
        state = "GROUNDABLE_ANSWER_READY";
        clarificationRound = 0;
        showCreateTicketNow = false;
        followUpQuestion = null;
        selfServeResolved = true;
      }
    }
  } catch {
    // Keep deterministic draft answer when search-bot final synthesis fails.
  }

  if (!agentSynthesized) {
    state = fallbackDecision.state;
    clarificationRound = fallbackDecision.clarificationRound;
    showCreateTicketNow = fallbackDecision.showCreateTicketNow;
    followUpQuestion = fallbackDecision.followUpQuestion;
    answer = fallbackDecision.answer;
    structuredAnswer = fallbackDecision.structuredAnswer;
    selfServeResolved = fallbackDecision.selfServeResolved;
    effectiveReferences = fallbackDecision.effectiveReferences;

    if (
      env.FEATURE_AI_MULTI_TURN_HANDOFF &&
      state === "CLARIFICATION_REQUIRED" &&
      clarificationRound >= env.AI_SEARCH_MAX_CLARIFICATION_ROUNDS &&
      classification.route !== "openapi_doc"
    ) {
      state = "TICKET_HANDOFF_RECOMMENDED";
      showCreateTicketNow = true;
      followUpQuestion = null;
      answer =
        language === "zh"
          ? "当前还没有足够的可引用证据给出可靠结论。建议点击“Create a ticket now”，我将基于对话自动预填工单。"
          : 'There is not enough citable evidence for a reliable final answer. Click "Create a ticket now" and I will prefill a ticket from this conversation.';
      await aiRepo.addHandoffEvent({
        sessionId,
        eventType: "handoff_triggered",
        payload: { clarificationRound, retrievalStatus: response.retrievalStatus }
      });
    }
  }

  const transcript = mergeTranscript(previousDialog?.transcript, response.query, answer, options?.conversation ?? []);
  await aiRepo.upsertDialogState({
    sessionId,
    state,
    clarificationRound,
    showCreateTicketNow,
    answerLanguage: language,
    followUpQuestion,
    transcript,
    retrievalOutcome: {
      retrievalStatus: response.retrievalStatus,
      unresolvedReasonCode: response.unresolvedReasonCode,
      confidence: response.confidence,
      references: effectiveReferences.length
    }
  });

  const metricPromises: Promise<void>[] = [
    aiRepo.logMetric({
      sessionId,
      name: "hit_rate",
      value: citationsValid ? 1 : 0,
      payload: { retrievalStatus: response.retrievalStatus }
    }),
    aiRepo.logMetric({
      sessionId,
      name: "citation_coverage",
      value: effectiveReferences.length,
      payload: { queryLength: response.query.length }
    }),
    aiRepo.logMetric({
      sessionId,
      name: "fallback_rate",
      value: response.unresolvedReasonCode ? 1 : 0,
      payload: { reasonCode: response.unresolvedReasonCode }
    }),
    aiRepo.logMetric({
      sessionId,
      name: "no_citation_rate",
      value: citationsValid ? 0 : 1,
      payload: { round: clarificationRound }
    })
  ];
  if (grounded && previousDialog && previousDialog.clarification_round > 0) {
    metricPromises.push(
      aiRepo.logMetric({
        sessionId,
        name: "clarification_resolution_rate",
        value: 1,
        payload: { round: previousDialog.clarification_round }
      })
    );
  }
  await Promise.all(metricPromises);

  // Only show citations to the user when confidence is sufficient
  const userFacingReferences = showCitationsToUser ? effectiveReferences : [];
  const citations = userFacingReferences
    .filter((ref) => Boolean(ref.sourceUrl))
    .map((item) => ({
      id: item.documentId,
      title: item.title,
      excerpt: item.snippet,
      score: item.score,
      source_url: item.sourceUrl,
      retrieved_at: item.retrievedAt,
      repo: getCitationMeta(item).repo,
      path: getCitationMeta(item).path,
      commit_sha: getCitationMeta(item).commitSha
    }));

  return {
    session_id: sessionId,
    answer,
    answer_language: language,
    structured_answer: structuredAnswer,
    confidence: response.confidence,
    suggested_next_step: selfServeResolved ? "self_serve" : "submit_ticket",
    retrieval_status: response.retrievalStatus,
    unresolved_reason_code: response.unresolvedReasonCode,
    references: userFacingReferences,
    citations,
    state,
    clarification_round: clarificationRound,
    show_create_ticket_now: showCreateTicketNow,
    follow_up_question: followUpQuestion
  };
}

function inferServiceCategory(text: string): "technical_support" | "feature_consulting" | "account_issue" {
  const normalized = text.toLowerCase();
  if (/(login|账户|账号|权限|permission|billing)/i.test(normalized)) return "account_issue";
  if (/(feature|需求|咨询|流程设计|enhance|improvement)/i.test(normalized)) return "feature_consulting";
  return "technical_support";
}

function inferTicketType(
  query: string,
  transcriptText: string,
  catalog: Array<{ key: string; name: string; fields: unknown[] }>
): { key: string; name: string; confidence: number; fields: unknown[] } {
  if (!catalog.length) {
    return { key: "", name: "General Support", confidence: 0.25, fields: [] };
  }

  const text = `${query} ${transcriptText}`.toLowerCase();
  let best = catalog[0];
  let bestScore = 0;

  for (const item of catalog) {
    const label = `${item.key} ${item.name}`.toLowerCase();
    let score = 0;
    for (const token of label.split(/[\s_\-]+/).filter(Boolean)) {
      if (token.length > 2 && text.includes(token)) score += 1;
    }
    if (score > bestScore) {
      bestScore = score;
      best = item;
    }
  }

  const confidence = Math.min(0.95, 0.4 + bestScore * 0.12);
  return { key: best.key, name: best.name, confidence, fields: best.fields };
}

function fieldValueFromContext(key: string, label: string, title: string, description: string): string {
  const k = `${key} ${label}`.toLowerCase();
  if (/(title|summary|标题)/.test(k)) return title;
  if (/(desc|description|问题|详情|content|内容)/.test(k)) return description;
  if (/(environment|env|环境)/.test(k)) {
    if (/(production|prod|线上|生产)/i.test(description)) return "production";
    if (/(staging|预发)/i.test(description)) return "staging";
    if (/(test|测试)/i.test(description)) return "test";
    return "unknown";
  }
  if (/(reproduce|reproducibility|复现)/.test(k)) {
    if (/(always|稳定复现|必现)/i.test(description)) return "always";
    if (/(sometimes|偶现)/i.test(description)) return "sometimes";
    if (/(once|一次)/i.test(description)) return "once";
    return "unknown";
  }
  if (/(impact|影响)/.test(k)) {
    return description.slice(0, 300);
  }
  return "";
}

export async function buildTicketDraftFromConversation(input: {
  sessionId: string;
  question: string;
  conversation: string[];
  retrievalTraces: unknown[];
}): Promise<ChatTicketDraft> {
  const session = await aiRepo.getSearchSessionWithReferences(input.sessionId);
  if (!session) {
    throw new Error("Search session not found");
  }

  const dialogState = await aiRepo.getDialogState(input.sessionId);
  const transcript = dialogState?.transcript ?? [];
  const transcriptText = transcript.map((item) => `[${item.role}] ${item.content}`).join("\n");
  const query = input.question.trim() || session.query;

  const catalog = await onesSync.listCustomerTicketTypes();
  const inferred = inferTicketType(query, transcriptText, catalog);

  const title = buildUserFacingDraftTitle(query);
  const description = buildUserFacingDraftDescription({ query, transcript });

  const onesFields: Record<string, string> = {};
  const fieldHints: ChatTicketDraftField[] = [];

  for (const row of inferred.fields as Array<Record<string, unknown>>) {
    const key = String(row.key ?? row.id ?? "");
    if (!key) continue;
    const label = String(row.label ?? row.name ?? key);
    const required = Boolean(row.required ?? false);
    const value = fieldValueFromContext(key, label, title, description);
    const confidence = value ? 0.72 : required ? 0.2 : 0.4;
    onesFields[key] = value;
    fieldHints.push({ key, label, required, value, confidence });
  }

  const missingRequiredFields = fieldHints.filter((item) => item.required && !item.value.trim()).map((item) => item.key);

  const draftId = await aiRepo.upsertTicketDraft({
    sessionId: input.sessionId,
    ticketTypeKey: inferred.key,
    ticketTypeConfidence: inferred.confidence,
    draft: {
      ticketTypeName: inferred.name,
      title,
      description,
      serviceCategory: inferServiceCategory(`${query} ${transcriptText}`),
      onesFields,
      fieldHints
    },
    missingRequiredFields,
    provenance: {
      from_chat: true,
      session_id: input.sessionId,
      transcript_digest: crypto.createHash("sha256").update(transcriptText || query).digest("hex"),
      retrieval_outcome: {
        status: session.retrieval_status,
        unresolved_reason_code: session.unresolved_reason_code
      },
      retrieval_traces_count: input.retrievalTraces.length
    }
  });

  const draft = await aiRepo.getTicketDraft(draftId);
  if (!draft) {
    throw new Error("Failed to create ticket draft");
  }

  await aiRepo.upsertDialogState({
    sessionId: input.sessionId,
    state: "TICKET_DRAFT_READY",
    clarificationRound: dialogState?.clarification_round ?? 0,
    showCreateTicketNow: true,
    answerLanguage: dialogState?.answer_language ?? detectLanguage(query),
    followUpQuestion: null,
    transcript,
    retrievalOutcome: dialogState?.retrieval_outcome ?? {
      retrievalStatus: session.retrieval_status,
      unresolvedReasonCode: session.unresolved_reason_code
    }
  });
  await aiRepo.addHandoffEvent({
    sessionId: input.sessionId,
    draftId,
    eventType: "draft_generated",
    payload: {
      ticketTypeKey: inferred.key,
      missingRequiredFields
    }
  });

  return {
    id: draft.id,
    sessionId: draft.session_id,
    ticketTypeKey: draft.ticket_type_key ?? inferred.key,
    ticketTypeName: draft.draft_json.ticketTypeName,
    ticketTypeConfidence: draft.ticket_type_confidence,
    title: draft.draft_json.title,
    description: draft.draft_json.description,
    serviceCategory: draft.draft_json.serviceCategory,
    onesFields: draft.draft_json.onesFields,
    fieldHints: draft.draft_json.fieldHints,
    missingRequiredFields: draft.missing_required_fields,
    provenance: draft.provenance_json
  };
}

export async function buildTicketPayloadFromDraft(input: {
  draftId: string;
  overrides: {
    title?: string;
    description?: string;
    attachments?: string[];
    serviceCategory?: "technical_support" | "feature_consulting" | "account_issue";
    onesTicketTypeKey?: string;
    onesFields?: Record<string, unknown>;
    customer?: { id: string; name: string; email?: string };
  };
}): Promise<{
  payload: {
    title: string;
    description: string;
    attachments: string[];
    serviceCategory: "technical_support" | "feature_consulting" | "account_issue";
    priority: "P3";
    onesTicketTypeKey?: string;
    onesFields?: Record<string, unknown>;
    customer: { id: string; name: string; email?: string };
    environment: "unknown";
    reproducibility: "unknown";
    impactSummary: string;
  };
  draft: Awaited<ReturnType<typeof aiRepo.getTicketDraft>>;
}> {
  const draft = await aiRepo.getTicketDraft(input.draftId);
  if (!draft || draft.status !== "draft") {
    throw new Error("Ticket draft not found or already submitted");
  }

  const mergedFields: Record<string, unknown> = {
    ...(draft.draft_json.onesFields ?? {}),
    ...(input.overrides.onesFields ?? {})
  };

  const required = (draft.draft_json.fieldHints ?? []).filter((item) => item.required).map((item) => item.key);
  const missing = required.filter((key) => !String(mergedFields[key] ?? "").trim());
  if (missing.length) {
    throw new Error(`Missing required fields: ${missing.join(", ")}`);
  }

  return {
    payload: {
      title: input.overrides.title?.trim() || draft.draft_json.title,
      description: input.overrides.description?.trim() || draft.draft_json.description,
      attachments: input.overrides.attachments ?? [],
      serviceCategory: input.overrides.serviceCategory || draft.draft_json.serviceCategory,
      priority: "P3",
      onesTicketTypeKey: input.overrides.onesTicketTypeKey || draft.ticket_type_key || undefined,
      onesFields: mergedFields,
      customer: input.overrides.customer ?? { id: "customer_demo", name: "Acme User" },
      environment: "unknown",
      reproducibility: "unknown",
      impactSummary: "Generated from AI chat handoff"
    },
    draft
  };
}

export async function markTicketDraftSubmitted(draftId: string, ticketId: string): Promise<void> {
  const draft = await aiRepo.getTicketDraft(draftId);
  if (!draft) {
    throw new Error("Ticket draft not found");
  }
  await aiRepo.markTicketDraftSubmitted({ draftId, ticketId });
  const dialogState = await aiRepo.getDialogState(draft.session_id);
  await aiRepo.upsertDialogState({
    sessionId: draft.session_id,
    state: "TICKET_SUBMITTED",
    clarificationRound: dialogState?.clarification_round ?? 0,
    showCreateTicketNow: false,
    answerLanguage: dialogState?.answer_language ?? "en",
    followUpQuestion: null,
    transcript: dialogState?.transcript ?? [],
    retrievalOutcome: dialogState?.retrieval_outcome ?? {}
  });
  await aiRepo.addHandoffEvent({
    sessionId: draft.session_id,
    draftId,
    ticketId,
    eventType: "ticket_submitted",
    payload: {}
  });
  await aiRepo.logMetric({
    sessionId: draft.session_id,
    name: "chat_to_ticket_conversion",
    value: 1,
    payload: { draftId, ticketId }
  });
}

export async function runTicketTriage(ticketId: string, adapter: OpenClawAdapter) {
  const ticket = await tickets.getTicketById(ticketId);
  if (!ticket) {
    throw new Error("Ticket not found");
  }

  if ((ticket.status === "OPEN" || ticket.status === "WAITING_CUSTOMER") && canTransition(ticket.status, "IN_PROGRESS")) {
    await tickets.transitionTicket(ticketId, ticket.status, "IN_PROGRESS");
  }

  const refreshedTicket = await tickets.getTicketById(ticketId);
  if (!refreshedTicket) {
    throw new Error("Ticket not found");
  }

  const ticketMessages = await tickets.listTicketMessages(ticketId);
  const history = ticketMessages.map((m) => ({
    author: m.author_name,
    body: m.body,
    at: m.created_at
  }));
  const attachmentUrls = ticketMessages.flatMap((m) => m.attachments ?? []).filter(Boolean);
  let imageSummary: string | null = null;
  let textAttachmentSummary: string | null = null;
  try {
    imageSummary = await buildTicketImageSummary({
      title: refreshedTicket.title,
      description: refreshedTicket.description,
      history: history.map((item) => ({ author: item.author, body: item.body })),
      attachments: attachmentUrls
    });
  } catch {
    imageSummary = null;
  }
  try {
    textAttachmentSummary = await buildTicketTextAttachmentSummary({
      attachments: attachmentUrls
    });
  } catch {
    textAttachmentSummary = null;
  }
  const triageDescription = [refreshedTicket.description, imageSummary, textAttachmentSummary].filter(Boolean).join("\n\n");

  const aiRunSeq = await tickets.bumpAiRunSeq(ticketId);
  const idempotencyKey = `${ticketId}-${aiRunSeq}`;

  const input = {
    ticket_id: refreshedTicket.ticket_no,
    title: refreshedTicket.title,
    description: triageDescription,
    priority: refreshedTicket.priority,
    customer_meta: {
      customerId: refreshedTicket.customer_id,
      customerName: refreshedTicket.customer_name
    },
    attachments: attachmentUrls,
    history
  };

  const runId = await tickets.createAiRun({
    ticketId,
    idempotencyKey,
    payload: input
  });

  try {
    const runtime = resolveExecutionRuntime(`ticket-${ticketId}`);
    const deterministicResult = buildDeterministicTicketTriage({
      title: refreshedTicket.title,
      description: triageDescription,
      history
    });
    const rawResult = deterministicResult ?? (await adapter.analyzeTicket(input, idempotencyKey, runtime));
    const result = normalizeAnalyzeOutput(rawResult);
    const traceId = `${ticketId}:${idempotencyKey}:${Date.now()}`;
    const promptHash = crypto
      .createHash("sha256")
      .update(JSON.stringify(input))
      .digest("hex");
    const aiMode = await settings.getAiAgentMode();
    const modelName = process.env.OPENCLAW_AGENT_ID_EXECUTION || process.env.OPENCLAW_AGENT_ID || "openclaw-agent";

    await tickets.finalizeAiRun(runId, {
      response: result as unknown as Record<string, unknown>,
      traceId,
      action: result.action,
      model: modelName,
      confidence: result.confidence,
      evidence: result.evidence,
      fallbackApplied: result.fallback_applied,
      promptHash
    });
    await tickets.setTicketAiSnapshot(ticketId, {
      traceId,
      action: result.action,
      confidence: result.confidence,
      model: modelName,
      fallbackApplied: result.fallback_applied,
      aiModeSnapshot: aiMode.enabled ? "AI_ON" : "AI_OFF"
    });

    if (result.action === "escalate") {
      const latest = await tickets.getTicketById(ticketId);
      if (latest && canTransition(latest.status, "ESCALATED_RND")) {
        await tickets.transitionTicket(ticketId, latest.status, "ESCALATED_RND");
      }
      await tickets.setTicketAssignee(ticketId, "RND_TEAM", "R&D Team");
      await tickets.addAuditLog(ticketId, "ai_triage_escalated", null, null, {
        reason: "model_escalation",
        reasonCode: "ai_model_escalation",
        traceId,
        stage: "escalated_rnd",
        status: "ESCALATED_RND",
        assignee: "R&D Team",
        customer_message_policy: "none",
        sla_effect: "continue_active_timer",
        confidence: result.confidence,
        evidence: result.evidence
      });
      return result;
    }

    const shouldReplyToCustomer = result.reply.trim().length > 0;
    if (shouldReplyToCustomer) {
      await tickets.addMessage({
        ticketId,
        authorType: "AGENT",
        authorName: "Support Team",
        body: result.reply,
        attachments: [],
        isAiGenerated: true,
        aiConfidence: result.confidence
      });
    }

    const latest = await tickets.getTicketById(ticketId);
    if (shouldReplyToCustomer && latest && canTransition(latest.status, "WAITING_CUSTOMER")) {
      await tickets.transitionTicket(ticketId, latest.status, "WAITING_CUSTOMER");
    }

    if (shouldReplyToCustomer) {
      await tickets.setTicketAssignee(ticketId, "SUPPORT_TEAM", "Support Team");
      await tickets.addAuditLog(ticketId, "ai_triage_replied", null, "WAITING_CUSTOMER", {
        action: result.action,
        traceId,
        stage: "waiting_customer",
        status: "WAITING_CUSTOMER",
        assignee: "Support Team",
        customer_message_policy: "reply_from_support_team",
        sla_effect: "pause_active_timer",
        confidence: result.confidence,
        evidence: result.evidence
      });
      return result;
    }

    if (result.action === "none") {
      await tickets.addAuditLog(ticketId, "ai_triage_no_action", null, null, {
        action: "none",
        traceId,
        stage: "triage_no_action",
        confidence: result.confidence,
        evidence: result.evidence
      });
    }

    return result;
  } catch (error) {
    const message = (error as Error).message;
    await tickets.failAiRun(runId, message);

    if (env.DISABLE_AI_TRIAGE_FALLBACK) {
      const latest = await tickets.getTicketById(ticketId);
      if (latest && latest.status !== "ESCALATED_RND" && canTransition(latest.status, "ESCALATED_RND")) {
        await tickets.transitionTicket(ticketId, latest.status, "ESCALATED_RND");
        await tickets.setTicketAssignee(ticketId, "RND_TEAM", "R&D Team");
      }
      await tickets.addAuditLog(ticketId, "ai_triage_escalated", null, "ESCALATED_RND", {
        reason: "openclaw_failure",
        reasonCode: "integration_failure",
        stage: "escalated_rnd",
        status: "ESCALATED_RND",
        assignee: "R&D Team",
        customer_message_policy: "none",
        sla_effect: "continue_active_timer",
        error: message
      });
      throw error;
    }

    const latest = await tickets.getTicketById(ticketId);
    if (latest && latest.status !== "ESCALATED_RND" && canTransition(latest.status, "ESCALATED_RND")) {
      await tickets.transitionTicket(ticketId, latest.status, "ESCALATED_RND");
      await tickets.setTicketAssignee(ticketId, "RND_TEAM", "R&D Team");
      await tickets.addAuditLog(ticketId, "ai_triage_fallback_escalated", latest.status, "ESCALATED_RND", {
        reason: "openclaw_failure",
        reasonCode: "integration_failure",
        stage: "escalated_rnd",
        status: "ESCALATED_RND",
        assignee: "R&D Team",
        customer_message_policy: "none",
        sla_effect: "continue_active_timer",
        error: message
      });
    }
    throw error;
  }
}
