import { canTransition } from "../../domain/state-machine.js";
import type { OpenClawAdapter, OpenClawAnalyzeOutput, OpenClawDecisionAction, OpenClawRuntimeContext } from "../../infrastructure/openclaw/types.js";
import { env } from "../../config/env.js";
import crypto from "node:crypto";
import * as aiRepo from "./repository.js";
import { buildSearchRuntime, resolveExecutionRuntime } from "./agent-router.js";
import { summarizeImageAttachments, summarizeTextAttachments } from "./multimodal.js";
import { runSupportSearchAgent, runSupportTriageAgent } from "./support-agent.js";
import {
  claimDueSupportSearchJobs,
  enqueueSupportSearchJob,
  getSupportSearchJob,
  heartbeatSupportSearchJob,
  markSupportSearchJobFailed,
  markSupportSearchJobSucceeded,
  requeueStaleRunningSupportSearchJobs,
  type SupportSearchJob
} from "./support-search-jobs.js";
import type {
  ConversationTurn,
  ChatTicketDraft,
  ChatTicketDraftField,
  SearchModeResult,
  SearchResponseEnvelope,
  SearchReference,
  SearchDialogState,
  StructuredSearchAnswer,
  SupportCaseFrame,
  SupportVerificationResult,
  TriageSupportInsight
} from "./types.js";
import * as tickets from "../tickets/repository.js";
import * as settings from "../settings/repository.js";
import * as onesSync from "../ones-sync/service.js";
import * as githubKbService from "../github-kb/service.js";

type SearchRuntimeDelivery = "interactive" | "async_job";
type SupportSearchJobStageState = {
  currentStage: string;
  lastCompletedStage?: string;
};
type SupportSearchJobHeartbeat = (input: {
  jobId: string;
  leaseKey: string;
  stageState?: Record<string, unknown>;
  leaseMs?: number;
}) => Promise<void>;

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

function uniqueStrings(input: Array<string | undefined | null>, limit = 8): string[] {
  const seen = new Set<string>();
  const values: string[] = [];
  for (const item of input) {
    const value = String(item ?? "").trim();
    if (!value || seen.has(value)) continue;
    seen.add(value);
    values.push(value);
    if (values.length >= limit) break;
  }
  return values;
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

async function buildKbFallbackSearchResult(input: {
  sessionId: string;
  query: string;
  language: "zh" | "en";
  currentRound: number;
}): Promise<SearchModeResult | null> {
  try {
    const retrieval = await githubKbService.retrieveKnowledgeWithRetry({
      query: input.query,
      answerLanguage: input.language,
      profile: "agent",
      includeFallback: true
    });
    const references: SearchReference[] = retrieval.hits.map((hit) => ({
      documentId: hit.documentId,
      title: hit.title,
      snippet: hit.snippet,
      sourceUrl: hit.sourceUrl,
      repoSourceUrl: hit.repoSourceUrl,
      repo: hit.repo,
      branch: hit.branch,
      path: hit.path,
      commitSha: hit.commitSha,
      headingPath: hit.headingPath,
      supportMetadata: hit.supportMetadata,
      chunkMetadata: hit.chunkMetadata,
      docMetadata: hit.docMetadata,
      sourceType: "github_kb",
      score: hit.score,
      retrievedAt: new Date().toISOString()
    }));
    const citations = references.slice(0, 6).map((ref, index) => ({
      id: `kb-${index + 1}`,
      title: ref.title,
      excerpt: ref.snippet,
      score: ref.score,
      source_url: ref.sourceUrl,
      retrieved_at: ref.retrievedAt,
      repo: ref.repo,
      path: ref.path,
      commit_sha: ref.commitSha
    }));
    const answer =
      retrieval.answer?.trim() ||
      (input.language === "zh"
        ? "已从知识库检索到相关文档，请参考下方引用。"
        : "Relevant documentation was found in the knowledge base. Please review the references below.");
    return {
      session_id: input.sessionId,
      answer,
      answer_language: input.language,
      delivery_mode: "kb_direct",
      support_answer: {
        mode: references.length > 0 ? "partial" : "handoff",
        question_type: "troubleshooting",
        render_variant: references.length > 0 ? "troubleshooting" : "handoff",
        direct_answer: answer,
        sections: [],
        why: [],
        what_to_do_now: [],
        still_need_to_confirm: []
      },
      verification: {
        verdict: references.length > 0 ? "partial" : "unsupported",
        summary:
          input.language === "zh"
            ? "已回退为知识库直检索结果。"
            : "Fell back to direct knowledge-base retrieval.",
        unsupported_claims: [],
        missing_info: [],
        verified_citation_ids: citations.map((item) => item.id),
        display_citation_ids: citations.map((item) => item.id),
        verified_claims: [],
        claim_to_citation_map: []
      },
      structured_answer: {
        summary: answer,
        steps: [],
        validation: [],
        style: "diagnosis"
      },
      confidence: retrieval.confidence,
      suggested_next_step: references.length > 0 ? "self_serve" : "submit_ticket",
      retrieval_status: references.length > 0 ? "grounded" : "no_results",
      unresolved_reason_code: references.length > 0 ? null : "KB_RETRIEVAL_UNAVAILABLE",
      references,
      citations,
      state: references.length > 0 ? "GROUNDABLE_ANSWER_READY" : "TICKET_HANDOFF_RECOMMENDED",
      clarification_round: input.currentRound,
      show_create_ticket_now: references.length === 0,
      follow_up_question: null
    };
  } catch {
    return null;
  }
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
      summary: "这是 ONES OpenAPI 相关问题。以下是常见的 API 对象和操作入口，请告诉我你具体需要哪个接口的信息。",
      assessment: "当前可以确认这是文档/接口问答场景。如果能明确对象或接口路径，可以给出更精确的答案。",
      style: "kb_answer",
      steps: [
        "常见 API 对象：issue（工作项）、wiki（知识库页面）、project（项目）、user（用户）、field（属性）、sprint（迭代）。",
        "如果你已有接口路径，直接贴 `Method + Path`（如 `GET /project/issues`），我可以给出参数和示例。",
        "如果你在问某个参数怎么获取（如 issueTypeID、teamID），直接说参数名即可。"
      ],
      validation: ["明确对象后，可直接收敛到具体接口文档。"]
    };
  }
  return {
    summary: "This is an ONES OpenAPI question. Here are the common API objects and entry points — let me know which specific endpoint you need.",
    assessment: "This is clearly documentation/API guidance. Specifying the object or endpoint path will yield a precise answer.",
    style: "kb_answer",
    steps: [
      "Common API objects: issue, wiki, project, user, field, sprint.",
      "If you have an endpoint path, provide `Method + Path` (e.g. `GET /project/issues`) for detailed parameters and examples.",
      "If you need to obtain a specific parameter (e.g. issueTypeID, teamID), just name it."
    ],
    validation: ["Once the target object is specified, the answer will narrow down to the exact API."]
  };
}

function buildKBGuidanceFallback(query: string, language: "zh" | "en", refs?: SearchReference[]): StructuredSearchAnswer {
  const intent = detectIntent(query);
  const requiredInputs = buildRequiredInputs(language, intent, query);

  // When we have references, produce a kb_answer instead of clarification
  if (refs && refs.length > 0) {
    const refSummary = refs.slice(0, 3).map((r) => r.title).join("、");
    if (language === "zh") {
      return {
        summary: `基于以下知识文档为你解答：${refSummary}`,
        assessment: "已找到相关知识文档，以下是基于文档的答案。",
        style: "kb_answer",
        steps: refs.slice(0, 3).map((r) => `${r.title}：${r.snippet.slice(0, 150)}`),
        validation: ["如果答案未完全覆盖你的问题，请补充具体场景细节。"]
      };
    }
    return {
      summary: `Based on the following knowledge documents: ${refSummary}`,
      assessment: "Found relevant knowledge documents. Here is the answer based on them.",
      style: "kb_answer",
      steps: refs.slice(0, 3).map((r) => `${r.title}: ${r.snippet.slice(0, 150)}`),
      validation: ["If this doesn't fully address your question, provide more specific context."]
    };
  }

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

function normalizeTranscript(input: ConversationTurn[]): Array<{ role: "user" | "assistant"; content: string; at: string }> {
  return input
    .map((turn) => ({
      role: turn.role,
      content: turn.content.trim(),
      at: turn.at ?? new Date().toISOString()
    }))
    .filter((item) => item.content.length > 0);
}

function mergeTranscript(
  previous: Array<{ role: "user" | "assistant"; content: string; at: string }> | undefined,
  latestQuery: string,
  latestAnswer: string,
  conversation: ConversationTurn[]
): Array<{ role: "user" | "assistant"; content: string; at: string }> {
  const merged = [...(previous ?? [])];
  merged.push(...normalizeTranscript(conversation));
  merged.push({ role: "user", content: latestQuery.trim(), at: new Date().toISOString() });
  if (latestAnswer.trim()) {
    merged.push({ role: "assistant", content: latestAnswer.trim(), at: new Date().toISOString() });
  }
  return merged.slice(-40);
}

function normalizeJobConversation(input: ConversationTurn[] | undefined): Array<{ role: "user" | "assistant"; content: string }> {
  return (input ?? [])
    .map((turn) => ({
      role: turn.role,
      content: turn.content.trim()
    }))
    .filter((turn) => turn.content.length > 0);
}

function buildSupportSearchRequestKey(input: {
  sessionId: string;
  query: string;
  conversation: Array<{ role: "user" | "assistant"; content: string }>;
  attachments: string[];
  answerLanguage: "zh" | "en";
  currentRound: number;
}): string {
  const digest = crypto
    .createHash("sha256")
    .update(
      JSON.stringify({
        query: input.query,
        conversation: input.conversation,
        attachments: [...input.attachments].sort(),
        answerLanguage: input.answerLanguage,
        round: input.currentRound + 1
      })
    )
    .digest("hex");
  return `support-search:${input.sessionId}:${input.currentRound + 1}:${digest}`;
}

export async function submitSearchModeJob(
  query: string,
  options?: {
    sessionId?: string;
    conversation?: ConversationTurn[];
    answerLanguage?: "zh" | "en";
    imageAttachments?: string[];
    attachments?: string[];
  }
): Promise<SupportSearchJob> {
  const sessionId = options?.sessionId ?? crypto.randomUUID();
  const previousDialog = await aiRepo.getDialogState(sessionId);
  const currentRound = previousDialog?.clarification_round ?? 0;
  const attachments = options?.attachments ?? options?.imageAttachments ?? [];
  const answerLanguage = options?.answerLanguage ?? detectLanguage(query.trim() || "image");
  const conversation = normalizeJobConversation(options?.conversation);

  try {
    return await enqueueSupportSearchJob({
      sessionId,
      requestKey: buildSupportSearchRequestKey({
        sessionId,
        query,
        conversation,
        attachments,
        answerLanguage,
        currentRound
      }),
      query,
      answerLanguage,
      currentRound,
      conversation,
      attachments
    });
  } catch (error) {
    if (error instanceof Error && /active support search job/i.test(error.message)) {
      const conflict = new Error(error.message);
      (conflict as Error & { statusCode?: number }).statusCode = 409;
      throw conflict;
    }
    throw error;
  }
}

export async function getSearchModeJob(jobId: string): Promise<SupportSearchJob | null> {
  return getSupportSearchJob(jobId);
}

export async function runSupportSearchJobWithLease<T>(input: {
  jobId: string;
  leaseKey: string;
  leaseMs: number;
  timeoutMs: number;
  initialStageState: SupportSearchJobStageState;
  operation: (helpers: { reportStageProgress: (stageState: SupportSearchJobStageState) => Promise<void> }) => Promise<T>;
  heartbeat?: SupportSearchJobHeartbeat;
  keepAliveIntervalMs?: number;
}): Promise<T> {
  const heartbeat = input.heartbeat ?? heartbeatSupportSearchJob;
  const keepAliveIntervalMs =
    input.keepAliveIntervalMs ?? Math.max(1_000, Math.min(5_000, Math.floor(input.leaseMs / 3)));
  let latestStageState = input.initialStageState;
  let settled = false;
  let timeoutHandle: NodeJS.Timeout | undefined;
  let keepAliveHandle: NodeJS.Timeout | undefined;
  let rejectLeaseFailure: ((reason?: unknown) => void) | null = null;
  const leaseFailure = new Promise<never>((_resolve, reject) => {
    rejectLeaseFailure = reject;
  });
  let heartbeatChain = Promise.resolve();

  const renewLease = async (stageState?: SupportSearchJobStageState): Promise<void> => {
    if (settled) return;
    latestStageState = stageState ?? latestStageState;
    heartbeatChain = heartbeatChain
      .catch(() => undefined)
      .then(async () => {
        if (settled) return;
        await heartbeat({
          jobId: input.jobId,
          leaseKey: input.leaseKey,
          leaseMs: input.leaseMs,
          stageState: latestStageState
        });
      });

    try {
      await heartbeatChain;
    } catch (error) {
      if (!settled && rejectLeaseFailure) {
        const reject = rejectLeaseFailure;
        rejectLeaseFailure = null;
        reject(error);
      }
      throw error;
    }
  };

  await renewLease(input.initialStageState);
  keepAliveHandle = setInterval(() => {
    void renewLease().catch(() => undefined);
  }, keepAliveIntervalMs);

  try {
    return await Promise.race([
      input.operation({
        reportStageProgress: renewLease
      }),
      new Promise<never>((_resolve, reject) => {
        timeoutHandle = setTimeout(() => {
          reject(new Error(`support search job timeout after ${input.timeoutMs}ms`));
        }, input.timeoutMs);
      }),
      leaseFailure
    ]);
  } finally {
    settled = true;
    if (timeoutHandle) clearTimeout(timeoutHandle);
    if (keepAliveHandle) clearInterval(keepAliveHandle);
  }
}

export async function runDueSearchModeJobs(
  limit: number,
  adapter: OpenClawAdapter
): Promise<{
  requeued: number;
  claimed: number;
  completed: number;
  failedRetryable: number;
  failedTerminal: number;
  jobs: Array<{ id: string; sessionId: string; status: SupportSearchJob["status"] }>;
}> {
  const requeued = await requeueStaleRunningSupportSearchJobs(15);
  const claimedJobs = await claimDueSupportSearchJobs({
    limit,
    leaseMs: env.AI_SUPPORT_JOB_LEASE_MS,
    workerId: "support-search-worker"
  });

  let completed = 0;
  let failedRetryable = 0;
  let failedTerminal = 0;
  const jobs: Array<{ id: string; sessionId: string; status: SupportSearchJob["status"] }> = [];

  for (const job of claimedJobs) {
    const status = await runClaimedSearchModeJob(job, adapter);
    if (status === "completed") {
      completed += 1;
    } else if (status === "failed_terminal") {
      failedTerminal += 1;
    } else {
      failedRetryable += 1;
    }
    jobs.push({ id: job.id, sessionId: job.sessionId, status });
  }

  return {
    requeued,
    claimed: claimedJobs.length,
    completed,
    failedRetryable,
    failedTerminal,
    jobs
  };
}

async function runClaimedSearchModeJob(
  job: SupportSearchJob,
  adapter: OpenClawAdapter
): Promise<SupportSearchJob["status"]> {
  if (!job.leaseKey) {
    return "failed_retryable";
  }

  try {
    const requestConversation = Array.isArray(job.request.conversation)
      ? (job.request.conversation as Array<{ role: "user" | "assistant"; content: string }>)
      : [];
    const requestAttachments = Array.isArray(job.request.attachments)
      ? job.request.attachments.map((item) => String(item))
      : [];
    const runtime = buildSearchRuntime({
      intent: job.currentRound > 0 ? "clarify" : "retrieval",
      sessionId: job.sessionId,
      delivery: "async_job"
    });
    const result = await runSupportSearchJobWithLease({
      jobId: job.id,
      leaseKey: job.leaseKey,
      leaseMs: env.AI_SUPPORT_JOB_LEASE_MS,
      timeoutMs: Number(runtime.overallTimeoutMs ?? env.AI_SUPPORT_JOB_TIMEOUT_MS),
      initialStageState: {
        currentStage: "run_search_mode",
        lastCompletedStage: "job_claimed"
      },
      operation: ({ reportStageProgress }) =>
        runSearchMode(String(job.request.query ?? job.query), adapter, {
          sessionId: job.sessionId,
          conversation: requestConversation,
          answerLanguage: job.answerLanguage,
          attachments: requestAttachments,
          runtimeDelivery: "async_job",
          runtimeOverride: runtime,
          onSupportStageProgress: reportStageProgress
        })
    });

    await markSupportSearchJobSucceeded({
      jobId: job.id,
      leaseKey: job.leaseKey,
      result,
      stageState: {
        currentStage: "completed",
        lastCompletedStage: "result_persisted"
      }
    });

    return "completed";
  } catch (error) {
    return markSupportSearchJobFailed({
      jobId: job.id,
      leaseKey: job.leaseKey,
      errorMessage: error instanceof Error ? error.message : String(error),
      retryable: true,
      retryDelaySeconds: 5
    });
  }
}

export async function driveSearchModeJob(jobId: string, adapter: OpenClawAdapter): Promise<SupportSearchJob | null> {
  const current = await getSupportSearchJob(jobId);
  if (!current) return null;
  if (current.status === "completed" || current.status === "failed_terminal" || current.status === "cancelled") {
    return current;
  }
  if (current.status === "running" || current.status === "partial_result_ready") {
    return current;
  }

  const claimed = await claimDueSupportSearchJobs({
    limit: 1,
    leaseMs: env.AI_SUPPORT_JOB_LEASE_MS,
    workerId: "support-search-drive",
    jobId
  });
  if (claimed[0]) {
    await runClaimedSearchModeJob(claimed[0], adapter);
  }

  return getSupportSearchJob(jobId);
}

export async function runSearchMode(
  query: string,
  adapter: OpenClawAdapter,
  options?: {
    sessionId?: string;
    conversation?: ConversationTurn[];
    answerLanguage?: "zh" | "en";
    imageAttachments?: string[];
    attachments?: string[];
    runtimeDelivery?: SearchRuntimeDelivery;
    runtimeOverride?: OpenClawRuntimeContext;
    onSupportStageProgress?: (stageState: SupportSearchJobStageState) => Promise<void> | void;
  }
): Promise<SearchModeResult> {
  const sessionId = options?.sessionId ?? crypto.randomUUID();
  const previousDialog = await aiRepo.getDialogState(sessionId);
  const currentRound = previousDialog?.clarification_round ?? 0;
  const searchIntent: "clarify" | "retrieval" = currentRound > 0 ? "clarify" : "retrieval";
  const runtime =
    options?.runtimeOverride ??
    buildSearchRuntime({
      intent: searchIntent,
      sessionId,
      delivery: options?.runtimeDelivery ?? "interactive"
    });
  const trimmedQuery = query.trim();
  const prevTranscript = previousDialog?.transcript;
  const resolvedQuery = trimmedQuery || (prevTranscript?.length ? prevTranscript[prevTranscript.length - 1].content : "") || "";
  const attachments = options?.attachments ?? options?.imageAttachments ?? [];
  const imageAttachments = options?.imageAttachments ?? attachments.filter((item) => item.includes("/uploads/images/"));
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

  if (!env.FEATURE_KB_GROUNDED_SEARCH) {
    const disabledAnswer =
      language === "zh"
        ? "知识库检索当前已关闭，建议直接创建工单，我们会自动预填你已提供的上下文。"
        : "Knowledge grounding is currently disabled. Create a ticket now and we will prefill the context you already shared.";
    const disabledResult: SearchModeResult = {
      session_id: sessionId,
      answer: disabledAnswer,
      answer_language: language,
      support_answer: {
        mode: "handoff",
        question_type: "troubleshooting",
        render_variant: "handoff",
        direct_answer: disabledAnswer,
        sections: [],
        why: [],
        what_to_do_now:
          language === "zh"
            ? ["点击“Create ticket now”生成工单草稿。", "补充报错原文、复现步骤和影响范围。"]
            : ["Create a ticket draft from this conversation.", "Add the exact error, repro steps, and impact scope."],
        still_need_to_confirm: []
      },
      verification: {
        verdict: "unsupported",
        summary: language === "zh" ? "知识库检索被运行时开关关闭。" : "Knowledge grounding is disabled by runtime switch.",
        unsupported_claims: [],
        missing_info: [],
        verified_citation_ids: [],
        display_citation_ids: [],
        verified_claims: [],
        claim_to_citation_map: []
      },
      structured_answer: {
        summary: disabledAnswer,
        steps:
          language === "zh"
            ? ["创建工单草稿。", "补充错误信息、复现步骤和影响范围。"]
            : ["Create a ticket draft.", "Add the exact error, repro steps, and impact scope."],
        validation: [],
        style: "diagnosis"
      },
      confidence: 0,
      suggested_next_step: "submit_ticket",
      retrieval_status: "kb_unavailable",
      unresolved_reason_code: "KB_RETRIEVAL_UNAVAILABLE",
      references: [],
      citations: [],
      state: "TICKET_HANDOFF_RECOMMENDED",
      clarification_round: currentRound,
      show_create_ticket_now: true,
      follow_up_question: null
    };

    if (!options?.sessionId || !previousDialog) {
      await aiRepo.createSearchSession({
        sessionId,
        query: multimodalQuery,
        answer: disabledResult.answer,
        confidence: disabledResult.confidence,
        retrievalStatus: disabledResult.retrieval_status,
        unresolvedReasonCode: disabledResult.unresolved_reason_code,
        suggestedNextStep: disabledResult.suggested_next_step
      });
    } else {
      await aiRepo.updateSearchSession({
        sessionId,
        answer: disabledResult.answer,
        confidence: disabledResult.confidence,
        retrievalStatus: disabledResult.retrieval_status,
        unresolvedReasonCode: disabledResult.unresolved_reason_code,
        suggestedNextStep: disabledResult.suggested_next_step
      });
    }

    await aiRepo.saveSearchReferences(sessionId, []);
    const transcript = mergeTranscript(previousDialog?.transcript, multimodalQuery, disabledResult.answer, options?.conversation ?? []);
    await aiRepo.upsertDialogState({
      sessionId,
      state: disabledResult.state,
      clarificationRound: disabledResult.clarification_round,
      showCreateTicketNow: disabledResult.show_create_ticket_now,
      answerLanguage: language,
      followUpQuestion: disabledResult.follow_up_question,
      transcript,
      retrievalOutcome: {
        retrievalStatus: disabledResult.retrieval_status,
        unresolvedReasonCode: disabledResult.unresolved_reason_code,
        confidence: 0,
        references: 0,
        verification: disabledResult.verification,
        supportAnswer: disabledResult.support_answer,
        diagnostics: {
          knowledge_grounding_disabled: true
        }
      }
    });

    return disabledResult;
  }

  try {
    const supportConversationHistory: Array<{ role: "user" | "assistant"; content: string }> = [];
    if (previousDialog?.transcript?.length) {
      for (const turn of previousDialog.transcript.slice(-6)) {
        supportConversationHistory.push({ role: turn.role, content: turn.content });
      }
    }
    if (options?.conversation?.length) {
      for (const turn of options.conversation.slice(-6)) {
        if (!turn.content.trim()) continue;
        supportConversationHistory.push({ role: turn.role, content: turn.content.trim() });
      }
    }

    const supportExecution = await runSupportSearchAgent({
      query: multimodalQuery,
      language,
      currentRound,
      conversationHistory: supportConversationHistory,
      adapter,
      runtime,
      attachments,
      onStageProgress: options?.onSupportStageProgress,
      idempotencyKey: `support-search:${sessionId}:${currentRound + 1}`
    });

    const supportResult = {
      ...supportExecution.result,
      session_id: sessionId,
      delivery_mode: "agent_orchestrated" as const,
      internal_diagnostics: supportExecution.result.internal_diagnostics
        ? {
            ...supportExecution.result.internal_diagnostics,
            case_id: sessionId,
            search_agents_used: [
              {
                stage: searchIntent,
                agent_id: runtime.agentId ?? "",
                session_key: runtime.sessionKey ?? ""
              }
            ],
            orchestration_trace: [
              {
                stage: searchIntent,
                agent_id: runtime.agentId ?? "",
                model: runtime.model ?? null
              },
              ...(supportExecution.result.internal_diagnostics.orchestration_trace ?? [])
            ]
          }
        : undefined
    };

    if (!options?.sessionId || !previousDialog) {
      await aiRepo.createSearchSession({
        sessionId,
        query: multimodalQuery,
        answer: supportResult.answer,
        confidence: supportResult.confidence,
        retrievalStatus: supportResult.retrieval_status,
        unresolvedReasonCode: supportResult.unresolved_reason_code,
        suggestedNextStep: supportResult.suggested_next_step
      });
    } else {
      await aiRepo.updateSearchSession({
        sessionId,
        answer: supportResult.answer,
        confidence: supportResult.confidence,
        retrievalStatus: supportResult.retrieval_status,
        unresolvedReasonCode: supportResult.unresolved_reason_code,
        suggestedNextStep: supportResult.suggested_next_step
      });
    }

    await aiRepo.saveSearchReferences(sessionId, supportResult.references);

    const transcript = mergeTranscript(previousDialog?.transcript, multimodalQuery, supportResult.answer, options?.conversation ?? []);
    await aiRepo.upsertDialogState({
      sessionId,
      state: supportResult.state,
      clarificationRound: supportResult.clarification_round,
      showCreateTicketNow: supportResult.show_create_ticket_now,
      answerLanguage: language,
      followUpQuestion: supportResult.follow_up_question,
      transcript,
      retrievalOutcome: {
        retrievalStatus: supportResult.retrieval_status,
        unresolvedReasonCode: supportResult.unresolved_reason_code,
        confidence: supportResult.confidence,
        references: supportResult.references.length,
        caseFrame: supportExecution.caseFrame,
        evidenceBundleDigest: crypto.createHash("sha256").update(JSON.stringify(supportExecution.evidenceBundle)).digest("hex"),
        verification: supportExecution.verification,
        supportAnswer: supportResult.support_answer,
        diagnostics: {
          stage_timings: supportExecution.stageTimings,
          ...(supportResult.internal_diagnostics ? { support_internal_diagnostics: supportResult.internal_diagnostics } : {})
        }
      }
    });

    await Promise.all([
      aiRepo.logMetric({
        sessionId,
        name: "hit_rate",
        value: supportResult.references.length > 0 ? 1 : 0,
        payload: { retrievalStatus: supportResult.retrieval_status }
      }),
      aiRepo.logMetric({
        sessionId,
        name: "citation_coverage",
        value: supportResult.citations.length,
        payload: { queryLength: multimodalQuery.length }
      }),
      aiRepo.logMetric({
        sessionId,
        name: "fallback_rate",
        value: supportResult.unresolved_reason_code ? 1 : 0,
        payload: { reasonCode: supportResult.unresolved_reason_code }
      }),
      aiRepo.logMetric({
        sessionId,
        name: "no_citation_rate",
        value: supportResult.citations.length > 0 ? 0 : 1,
        payload: { round: supportResult.clarification_round }
      })
    ]);

    return supportResult;
  } catch (error) {
    console.error("[support-agent] runSearchMode infrastructure handoff:", error instanceof Error ? error.message : error);

    const kbFallback = await buildKbFallbackSearchResult({
      sessionId,
      query: multimodalQuery,
      language,
      currentRound
    });
    if (kbFallback) {
      if (!options?.sessionId || !previousDialog) {
        await aiRepo.createSearchSession({
          sessionId,
          query: multimodalQuery,
          answer: kbFallback.answer,
          confidence: kbFallback.confidence,
          retrievalStatus: kbFallback.retrieval_status,
          unresolvedReasonCode: kbFallback.unresolved_reason_code,
          suggestedNextStep: kbFallback.suggested_next_step
        });
      } else {
        await aiRepo.updateSearchSession({
          sessionId,
          answer: kbFallback.answer,
          confidence: kbFallback.confidence,
          retrievalStatus: kbFallback.retrieval_status,
          unresolvedReasonCode: kbFallback.unresolved_reason_code,
          suggestedNextStep: kbFallback.suggested_next_step
        });
      }

      await aiRepo.saveSearchReferences(sessionId, kbFallback.references);
      const transcript = mergeTranscript(previousDialog?.transcript, multimodalQuery, kbFallback.answer, options?.conversation ?? []);
      await aiRepo.upsertDialogState({
        sessionId,
        state: kbFallback.state,
        clarificationRound: kbFallback.clarification_round,
        showCreateTicketNow: kbFallback.show_create_ticket_now,
        answerLanguage: language,
        followUpQuestion: kbFallback.follow_up_question,
        transcript,
        retrievalOutcome: {
          retrievalStatus: kbFallback.retrieval_status,
          unresolvedReasonCode: kbFallback.unresolved_reason_code,
          confidence: kbFallback.confidence,
          references: kbFallback.references.length,
          verification: kbFallback.verification,
          supportAnswer: kbFallback.support_answer,
          diagnostics: {
            infrastructure_failure: true,
            fallback_mode: "kb_direct"
          }
        }
      });
      return kbFallback;
    }

    const failureDirectAnswer =
      language === "zh"
        ? "当前暂时无法完成自动诊断，建议直接创建工单，我们会自动预填你已提供的上下文。"
        : "Automatic diagnosis is temporarily unavailable. Create a ticket now and we will prefill the context you already shared.";
    const failureResult: SearchModeResult = {
      session_id: sessionId,
      answer: failureDirectAnswer,
      answer_language: language,
      delivery_mode: "agent_orchestrated",
      support_answer: {
        mode: "handoff",
        question_type: "troubleshooting",
        render_variant: "handoff",
        direct_answer: failureDirectAnswer,
        sections: [],
        why: [],
        what_to_do_now:
          language === "zh"
            ? ["点击“Create ticket now”生成工单草稿。", "补充报错原文、复现步骤和影响范围。"]
            : ["Create a ticket draft from this conversation.", "Add the exact error, repro steps, and impact scope."],
        still_need_to_confirm: []
      },
      verification: {
        verdict: "unsupported",
        summary:
          language === "zh"
            ? "当前自动诊断未能完成。"
            : "Automatic diagnosis could not be completed.",
        unsupported_claims: [],
        missing_info: [],
        verified_citation_ids: [],
        display_citation_ids: [],
        verified_claims: [],
        claim_to_citation_map: []
      },
      structured_answer: {
        summary: failureDirectAnswer,
        steps:
          language === "zh"
            ? ["创建工单草稿。", "补充错误信息、复现步骤和影响范围。"]
            : ["Create a ticket draft.", "Add the exact error, repro steps, and impact scope."],
        validation: [],
        style: "diagnosis"
      },
      confidence: 0,
      suggested_next_step: "submit_ticket",
      retrieval_status: "kb_unavailable",
      unresolved_reason_code: "KB_RETRIEVAL_UNAVAILABLE",
      references: [],
      citations: [],
      state: "TICKET_HANDOFF_RECOMMENDED",
      clarification_round: currentRound,
      show_create_ticket_now: true,
      follow_up_question: null
    };

    if (!options?.sessionId || !previousDialog) {
      await aiRepo.createSearchSession({
        sessionId,
        query: multimodalQuery,
        answer: failureResult.answer,
        confidence: failureResult.confidence,
        retrievalStatus: failureResult.retrieval_status,
        unresolvedReasonCode: failureResult.unresolved_reason_code,
        suggestedNextStep: failureResult.suggested_next_step
      });
    } else {
      await aiRepo.updateSearchSession({
        sessionId,
        answer: failureResult.answer,
        confidence: failureResult.confidence,
        retrievalStatus: failureResult.retrieval_status,
        unresolvedReasonCode: failureResult.unresolved_reason_code,
        suggestedNextStep: failureResult.suggested_next_step
      });
    }

    await aiRepo.saveSearchReferences(sessionId, []);

    const transcript = mergeTranscript(previousDialog?.transcript, multimodalQuery, failureResult.answer, options?.conversation ?? []);
    await aiRepo.upsertDialogState({
      sessionId,
      state: failureResult.state,
      clarificationRound: failureResult.clarification_round,
      showCreateTicketNow: failureResult.show_create_ticket_now,
      answerLanguage: language,
      followUpQuestion: failureResult.follow_up_question,
      transcript,
      retrievalOutcome: {
        retrievalStatus: failureResult.retrieval_status,
        unresolvedReasonCode: failureResult.unresolved_reason_code,
        confidence: 0,
        references: 0,
        verification: failureResult.verification,
        supportAnswer: failureResult.support_answer,
        diagnostics: {
          infrastructure_failure: true
        }
      }
    });

    await Promise.all([
      aiRepo.logMetric({
        sessionId,
        name: "hit_rate",
        value: 0,
        payload: { retrievalStatus: failureResult.retrieval_status }
      }),
      aiRepo.logMetric({
        sessionId,
        name: "citation_coverage",
        value: 0,
        payload: { queryLength: multimodalQuery.length }
      }),
      aiRepo.logMetric({
        sessionId,
        name: "fallback_rate",
        value: 1,
        payload: { reasonCode: failureResult.unresolved_reason_code }
      }),
      aiRepo.logMetric({
        sessionId,
        name: "no_citation_rate",
        value: 1,
        payload: { round: failureResult.clarification_round }
      }),
      aiRepo.addHandoffEvent({
        sessionId,
        eventType: "handoff_triggered",
        payload: { reason: "support_agent_infrastructure_failure" }
      })
    ]);

    return failureResult;
  }
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
  conversation: ConversationTurn[];
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
  const retrievalOutcome = dialogState?.retrieval_outcome ?? {};
  const caseFrame = (retrievalOutcome.caseFrame ?? {}) as Record<string, unknown>;
  const verification = (retrievalOutcome.verification ?? {}) as Record<string, unknown>;
  const supportAnswer = (retrievalOutcome.supportAnswer ?? {}) as Record<string, unknown>;

  const catalog = await onesSync.listCustomerTicketTypes();
  const inferred = inferTicketType(query, transcriptText, catalog);

  const title = uniqueStrings(
    [
      String(caseFrame.goal ?? ""),
      String(caseFrame.object ?? ""),
      String(caseFrame.symptom ?? "")
    ],
    3
  ).join(" - ") || buildUserFacingDraftTitle(query);
  const verifiedFacts = Array.isArray(verification.verified_citation_ids) ? verification.verified_citation_ids : [];
  const verifiedClaims = Array.isArray(verification.verified_claims) ? verification.verified_claims.map((item) => String(item)) : [];
  const citationSummary = session.references
    .slice(0, 3)
    .map((item) => `- ${item.title}${item.path ? ` (${item.path})` : ""}`)
    .join("\n");
  const missingInfo = Array.isArray(verification.missing_info)
    ? verification.missing_info.map((item) => String(item))
    : Array.isArray(caseFrame.missing_critical_info)
    ? caseFrame.missing_critical_info.map((item) => String(item))
    : [];
  const description = [
    buildUserFacingDraftDescription({ query, transcript }),
    supportAnswer.direct_answer ? `\nDirect answer summary:\n${String(supportAnswer.direct_answer).trim()}` : "",
    Array.isArray(supportAnswer.why) && supportAnswer.why.length
      ? `\nVerified points:\n${supportAnswer.why.map((item: unknown) => `- ${String(item)}`).join("\n")}`
      : verifiedClaims.length
      ? `\nVerified points:\n${verifiedClaims.map((item) => `- ${item}`).join("\n")}`
      : "",
    Array.isArray(supportAnswer.still_need_to_confirm) && supportAnswer.still_need_to_confirm.length
      ? `\nStill need to confirm:\n${supportAnswer.still_need_to_confirm.map((item: unknown) => `- ${String(item)}`).join("\n")}`
      : "",
    verifiedFacts.length ? `\nVerified fact references:\n${verifiedFacts.map((item) => `- ${String(item)}`).join("\n")}` : "",
    citationSummary ? `\nKey citations:\n${citationSummary}` : "",
    missingInfo.length ? `\nStill missing:\n${missingInfo.map((item) => `- ${item}`).join("\n")}` : ""
  ]
    .filter(Boolean)
    .join("\n")
    .trim();

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
        unresolved_reason_code: session.unresolved_reason_code,
        case_frame: caseFrame,
        verification_summary: verification,
        evidence_bundle_digest: retrievalOutcome.evidenceBundleDigest ?? null
      },
      retrieval_traces_count: input.retrievalTraces.length,
      support_answer: supportAnswer
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

function buildSupportTriageInfrastructureFailure(input: {
  query: string;
  error: unknown;
}): OpenClawAnalyzeOutput & Record<string, unknown> {
  const errorMessage = input.error instanceof Error ? input.error.message : String(input.error ?? "unknown_error");
  const caseFrame: SupportCaseFrame = {
    goal: input.query.trim() || "support triage",
    symptom: "support_agent_infrastructure_failure",
    object: "ticket",
    action_type: "triage",
    deployment_model: "unknown",
    product_area: "general",
    constraints: ["support_agent_infrastructure_failure"],
    missing_critical_info: [],
    retrieval_queries: [input.query.trim()].filter(Boolean),
    query_plan: {
      concept_queries: [input.query.trim()].filter(Boolean),
      object_queries: [],
      behavior_queries: []
    }
  };
  const verification: SupportVerificationResult = {
    verdict: "unsupported",
    summary: "The AI support triage path could not verify a supported next action because evidence retrieval failed.",
    unsupported_claims: [],
    missing_info: [],
    verified_citation_ids: [],
    display_citation_ids: [],
    verified_claims: [],
    claim_to_citation_map: []
  };
  const supportInsight: TriageSupportInsight = {
    direct_answer: "The AI support triage path is unavailable, so this ticket should be escalated instead of using an unverified fallback action.",
    recommended_action: "escalate",
    customer_reply: "",
    customer_reply_policy: "no_send",
    support_summary: "Escalate because the AI support agent could not complete a verified triage run.",
    verified_evidence: [],
    risk_flags: ["support_agent_infrastructure_failure"],
    missing_info: [],
    verifier_verdict: "unsupported"
  };

  return {
    action: "escalate",
    confidence: 0,
    reply: "",
    reasoning_summary: supportInsight.support_summary,
    evidence: [],
    risk_flags: supportInsight.risk_flags,
    support_insight: supportInsight,
    verification_summary: verification,
    case_frame: caseFrame,
    evidence_bundle_digest: crypto
      .createHash("sha256")
      .update(JSON.stringify({ reason: "support_agent_infrastructure_failure", query: input.query }))
      .digest("hex"),
    failure_mode: "support_agent_infrastructure_failure",
    failure_detail: errorMessage
  };
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
    let rawResult: OpenClawAnalyzeOutput & Record<string, unknown>;
    const legacyGuardResult = await adapter
      .analyzeTicket(input, `${idempotencyKey}:legacy-guard`, runtime)
      .catch(() => null);
    if (legacyGuardResult && normalizeAction(legacyGuardResult.action) === "none") {
      rawResult = legacyGuardResult as OpenClawAnalyzeOutput & Record<string, unknown>;
    } else {
    try {
      const supportTriage = await runSupportTriageAgent({
        query: [refreshedTicket.title, triageDescription, ...history.slice(-4).map((item) => item.body)].filter(Boolean).join("\n\n"),
        language: "en",
        adapter,
        runtime,
        idempotencyKey,
        priority: refreshedTicket.priority,
        customerMeta: {
          customerId: refreshedTicket.customer_id,
          customerName: refreshedTicket.customer_name
        },
        history,
        attachments: attachmentUrls
      });
      rawResult = supportTriage.analyzeOutput;
    } catch (supportError) {
      console.error(
        "[support-agent] triage infrastructure escalation:",
        supportError instanceof Error ? supportError.message : supportError
      );
      rawResult = buildSupportTriageInfrastructureFailure({
        query: [refreshedTicket.title, triageDescription, ...history.slice(-4).map((item) => item.body)].filter(Boolean).join("\n\n"),
        error: supportError
      });
    }
    }
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

    const supportInsight = ((result as unknown) as Record<string, unknown>).support_insight as TriageSupportInsight | undefined;
    const customerReplyPolicy = supportInsight?.customer_reply_policy ?? (result.action === "escalate" ? "no_send" : "send_now");
    const shouldReplyToCustomer = customerReplyPolicy === "send_now" && result.reply.trim().length > 0;

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
    if (result.action === "resolve") {
      if (latest && canTransition(latest.status, "RESOLVED")) {
        await tickets.transitionTicket(ticketId, latest.status, "RESOLVED");
      }
      await tickets.setTicketAssignee(ticketId, "SUPPORT_TEAM", "Support Team");
      await tickets.addAuditLog(ticketId, "ai_triage_replied", null, "RESOLVED", {
        action: result.action,
        traceId,
        stage: "resolved",
        status: "RESOLVED",
        assignee: "Support Team",
        customer_message_policy: shouldReplyToCustomer ? "reply_from_support_team" : "none",
        sla_effect: "continue_active_timer",
        confidence: result.confidence,
        evidence: result.evidence
      });
      return result;
    }

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
