import { canTransition } from "../../domain/state-machine.js";
import type { OpenClawAdapter, OpenClawAnalyzeOutput, OpenClawDecisionAction } from "../../infrastructure/openclaw/types.js";
import { env } from "../../config/env.js";
import crypto from "node:crypto";
import * as aiRepo from "./repository.js";
import { SearchOrchestrator } from "./search-orchestrator.js";
import { resolveOpenClawRuntime } from "./agent-router.js";
import type {
  ChatTicketDraft,
  ChatTicketDraftField,
  SearchModeResult,
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
    const parsed = parseCitationFromSourceUrl(item.sourceUrl);
    return Boolean(parsed.repo && parsed.path && parsed.commitSha);
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

type QueryIntent = "api_operation" | "feature_usage" | "troubleshooting" | "concept_explanation" | "configuration" | "general";

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
  if (/\b(api|openapi|endpoint|rest|http|request|response|curl|sdk)\b/i.test(q)) return "api_operation";
  if (/\b(error|errors|failed|failure|timeout|exception|crash|stuck|not work|cannot|can't|500|404|403|401|报错|错误|异常|失败|超时|卡住|无法|不能)\b/i.test(q)) return "troubleshooting";
  if (/\bwhat is|meaning|difference|vs|compare|概念|区别|是什么|什么意思\b/i.test(q)) return "concept_explanation";
  if (/\b(config|configure|setup|install|deploy|integration|webhook|oauth|token|权限|部署|配置|集成)\b/i.test(q)) return "configuration";
  if (/\bhow to|how can|where|步骤|怎么|如何|在哪里|入口\b/i.test(q)) return "feature_usage";
  return "general";
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
    push("当前配置值（脱敏）", "Current config values (sanitized)");
    push("目标配置值", "Target config values");
    push("已执行步骤（到哪一步失败）", "Executed steps (where it failed)");
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
    const path = parseCitationFromSourceUrl(item.sourceUrl).path?.toLowerCase() ?? "";
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
  const citation = parseCitationFromSourceUrl(primary.sourceUrl);
  const sourcePath = citation.path ?? primary.title;
  const endpoint = extractEndpointFromReference(primary);
  const requiredInputs = buildRequiredInputs(language, intent, query);

  if (intent === "api_operation") {
    if (language === "zh") {
      const endpointLine = endpoint.method && endpoint.path ? `使用 \`${endpoint.method} ${endpoint.path}\`` : `先参考接口文档 \`${sourcePath}\``;
      return {
        assessment: `当前问题属于 API 调用场景，主参考来源为 \`${sourcePath}\`。`,
        summary: `${endpointLine} 即可开始处理这个 API 请求。`,
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
        steps: ["先看定义与适用场景。", "再看限制条件与不适用场景。", "最后按文档示例映射到你的实际场景。"],
        validation: ["确认你的目标是否属于文档适用范围。", "若不在适用范围，换用更匹配的能力或流程。"],
        required_inputs: requiredInputs
      };
    }
    return {
      assessment: `This is a concept clarification request. Primary source: \`${sourcePath}\`.`,
      summary: `Use \`${sourcePath}\` as the primary explanation. It defines scope and boundaries clearly.`,
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
  options?: { sessionId?: string; conversation?: string[]; answerLanguage?: "zh" | "en" }
): Promise<SearchModeResult> {
  const sessionId = options?.sessionId ?? crypto.randomUUID();
  const previousDialog = await aiRepo.getDialogState(sessionId);
  const currentRound = previousDialog?.clarification_round ?? 0;
  const searchIntent = currentRound > 0 ? "clarify" : "retrieval";
  const runtime = resolveOpenClawRuntime({ intent: searchIntent, sessionId });
  const orchestrator = new SearchOrchestrator(adapter);
  const language = options?.answerLanguage ?? detectLanguage(query);
  const response = await orchestrator.search(query, `search:${sessionId}:${currentRound + 1}`, runtime, language);
  const filteredReferences = filterReferencesByIntent(response.query, response.references);
  let effectiveReferences = filteredReferences.length ? filteredReferences : response.references;
  const confidenceThreshold = Math.max(0.45, env.AI_SEARCH_ANSWER_CONFIDENCE_THRESHOLD);
  const lowConfidence = response.confidence < confidenceThreshold;
  if (response.retrievalStatus !== "grounded" || lowConfidence) {
    // Avoid showing misleading references when evidence is not strong enough.
    effectiveReferences = [];
  }
  const citationsValid = hasValidCitations(effectiveReferences);
  const grounded = response.retrievalStatus === "grounded" && citationsValid;

  if (!options?.sessionId || !previousDialog) {
    await aiRepo.createSearchSession({
      sessionId,
      query: response.query,
      answer: response.answer,
      confidence: response.confidence,
      retrievalStatus: response.retrievalStatus,
      unresolvedReasonCode: response.unresolvedReasonCode,
      suggestedNextStep: grounded ? "self_serve" : "submit_ticket"
    });
  } else {
    await aiRepo.updateSearchSession({
      sessionId,
      answer: response.answer,
      confidence: response.confidence,
      retrievalStatus: response.retrievalStatus,
      unresolvedReasonCode: response.unresolvedReasonCode,
      suggestedNextStep: grounded ? "self_serve" : "submit_ticket"
    });
  }

  await aiRepo.saveSearchReferences(sessionId, effectiveReferences);

  let state: SearchDialogState = grounded ? "GROUNDABLE_ANSWER_READY" : "CLARIFICATION_REQUIRED";
  let clarificationRound = grounded ? 0 : (previousDialog?.clarification_round ?? 0) + 1;
  let showCreateTicketNow = false;
  let followUpQuestion: string | null = null;
  let answer = response.answer;
  let structuredAnswer: StructuredSearchAnswer | undefined;

  if (grounded) {
    structuredAnswer = buildQueryAwareStructuredAnswer(language, response.query, effectiveReferences) ?? undefined;
    if (structuredAnswer?.summary) {
      answer = structuredAnswer.summary;
    }
    clarificationRound = 0;
  } else if (env.FEATURE_AI_MULTI_TURN_HANDOFF) {
    structuredAnswer = buildQueryAwareStructuredAnswer(language, response.query, effectiveReferences)
      ?? buildClarificationStructuredAnswer(language, response.query);
    const thresholdReached = clarificationRound >= env.AI_SEARCH_MAX_CLARIFICATION_ROUNDS;
    if (thresholdReached) {
      state = "TICKET_HANDOFF_RECOMMENDED";
      showCreateTicketNow = true;
      answer =
        language === "zh"
          ? "当前还没有足够的可引用证据给出可靠结论。建议点击“Create a ticket now”，我将基于对话自动预填工单。"
          : 'There is not enough citable evidence for a reliable final answer. Click "Create a ticket now" and I will prefill a ticket from this conversation.';
      await aiRepo.addHandoffEvent({
        sessionId,
        eventType: "handoff_triggered",
        payload: { clarificationRound, retrievalStatus: response.retrievalStatus }
      });
    } else {
      state = clarificationRound === 1 ? "CLARIFICATION_REQUIRED" : "CLARIFICATION_IN_PROGRESS";
      followUpQuestion = buildClarificationQuestion(language, clarificationRound, response.query);
      answer = followUpQuestion;
    }
  } else {
    structuredAnswer = buildQueryAwareStructuredAnswer(language, response.query, effectiveReferences)
      ?? buildClarificationStructuredAnswer(language, response.query);
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

  await aiRepo.logMetric({
    sessionId,
    name: "hit_rate",
    value: citationsValid ? 1 : 0,
    payload: { retrievalStatus: response.retrievalStatus }
  });
  await aiRepo.logMetric({
    sessionId,
    name: "citation_coverage",
    value: effectiveReferences.length,
    payload: { queryLength: response.query.length }
  });
  await aiRepo.logMetric({
    sessionId,
    name: "fallback_rate",
    value: response.unresolvedReasonCode ? 1 : 0,
    payload: { reasonCode: response.unresolvedReasonCode }
  });
  await aiRepo.logMetric({
    sessionId,
    name: "no_citation_rate",
    value: citationsValid ? 0 : 1,
    payload: { round: clarificationRound }
  });
  if (grounded && previousDialog && previousDialog.clarification_round > 0) {
    await aiRepo.logMetric({
      sessionId,
      name: "clarification_resolution_rate",
      value: 1,
      payload: { round: previousDialog.clarification_round }
    });
  }

  const citations = effectiveReferences
    .filter((ref) => Boolean(ref.sourceUrl))
    .map((item) => ({
      id: item.documentId,
      title: item.title,
      excerpt: item.snippet,
      score: item.score,
      source_url: item.sourceUrl,
      retrieved_at: item.retrievedAt,
      repo: parseCitationFromSourceUrl(item.sourceUrl).repo,
      path: parseCitationFromSourceUrl(item.sourceUrl).path,
      commit_sha: parseCitationFromSourceUrl(item.sourceUrl).commitSha
    }))
    .filter((item) => Boolean(item.repo && item.path && item.commit_sha));

  return {
    session_id: sessionId,
    answer,
    answer_language: language,
    structured_answer: structuredAnswer,
    confidence: response.confidence,
    suggested_next_step: grounded ? "self_serve" : "submit_ticket",
    retrieval_status: response.retrievalStatus,
    unresolved_reason_code: response.unresolvedReasonCode,
    references: effectiveReferences,
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

  const title = query.slice(0, 180);
  const description =
    `Original question:\n${query}\n\nConversation context:\n${transcriptText || input.conversation.join("\n")}\n\n` +
    `Retrieval outcome: ${session.retrieval_status}, reason: ${session.unresolved_reason_code ?? "N/A"}`;

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
    serviceCategory?: "technical_support" | "feature_consulting" | "account_issue";
    onesTicketTypeKey?: string;
    onesFields?: Record<string, unknown>;
    customer?: { id: string; name: string; email?: string };
  };
}): Promise<{
  payload: {
    title: string;
    description: string;
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

  const history = (await tickets.listTicketMessages(ticketId)).map((m) => ({
    author: m.author_name,
    body: m.body,
    at: m.created_at
  }));

  const aiRunSeq = await tickets.bumpAiRunSeq(ticketId);
  const idempotencyKey = `${ticketId}-${aiRunSeq}`;

  const input = {
    ticket_id: refreshedTicket.ticket_no,
    title: refreshedTicket.title,
    description: refreshedTicket.description,
    priority: refreshedTicket.priority,
    customer_meta: {
      customerId: refreshedTicket.customer_id,
      customerName: refreshedTicket.customer_name
    },
    history
  };

  const runId = await tickets.createAiRun({
    ticketId,
    idempotencyKey,
    payload: input
  });

  try {
    const runtime = resolveOpenClawRuntime({ intent: "execution", sessionId: `ticket-${ticketId}` });
    const rawResult = await adapter.analyzeTicket(input, idempotencyKey, runtime);
    const result = normalizeAnalyzeOutput(rawResult);
    const traceId = `${ticketId}:${idempotencyKey}:${Date.now()}`;
    const promptHash = crypto
      .createHash("sha256")
      .update(JSON.stringify(input))
      .digest("hex");
    const aiMode = await settings.getAiAgentMode();
    const modelName = process.env.OPENCLAW_AGENT_ID || "openclaw-agent";

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
