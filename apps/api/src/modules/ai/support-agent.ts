import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { env } from "../../config/env.js";
import type {
  OpenClawAdapter,
  OpenClawAnalyzeOutput,
  OpenClawRuntimeContext
} from "../../infrastructure/openclaw/types.js";
import type {
  DraftSupportAnswer,
  SearchDialogState,
  SearchModeResult,
  SearchReference,
  SpecialistDraftAnswer,
  StructuredSearchAnswer,
  SupportAnswer,
  SupportAgentStageTiming,
  SupportAgentStageTimings,
  SupportCaseFrame,
  SupportEvidenceBundle,
  SupportEvidencePlan,
  SupportEvidenceSelection,
  SupportQuestionRoute,
  SupportVerificationResult,
  TriageSupportInsight
} from "./types.js";
import { SearchOrchestrator } from "./search-orchestrator.js";
import { resolveStageSpecificAgent } from "./agent-router.js";

function uniqueStrings(input: Array<string | undefined | null>, limit = 6): string[] {
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

function isLowSignalMissingInfo(item: string): boolean {
  const normalized = item.trim().toLowerCase();
  return (
    normalized === "the exact object or scenario you are working with" ||
    normalized === "the single most important missing detail" ||
    normalized === "more context" ||
    normalized === "more details"
  );
}

function sanitizeMissingCriticalInfo(input: Array<string | undefined | null>, limit = 3): string[] {
  return uniqueStrings(input, limit).filter((item) => !isLowSignalMissingInfo(item));
}

function elapsedMs(startedAt: number): number {
  return Math.max(0, Math.round(performance.now() - startedAt));
}

function stageTiming(
  status: SupportAgentStageTiming["status"],
  durationMs: number,
  extra: Partial<SupportAgentStageTiming> = {}
): SupportAgentStageTiming {
  return {
    duration_ms: durationMs,
    status,
    ...extra
  };
}

function skippedStageTiming(): SupportAgentStageTiming {
  return { duration_ms: 0, status: "skipped" };
}

function remainingBudgetMs(runtime?: OpenClawRuntimeContext): number | null {
  const startedAt = runtime?.requestStartedAtMs;
  const overallTimeoutMs = runtime?.overallTimeoutMs;
  if (!startedAt || !overallTimeoutMs) return null;
  return Math.max(0, overallTimeoutMs - (Date.now() - startedAt));
}

function hasEnoughBudget(runtime: OpenClawRuntimeContext | undefined, minimumMs: number): boolean {
  const remaining = remainingBudgetMs(runtime);
  return remaining === null || remaining >= minimumMs;
}

function buildStageRuntime(
  runtime: OpenClawRuntimeContext | undefined,
  reserveMs: number,
  minimumTimeoutMs = 3000,
  stageTimeoutMs = 12000
): OpenClawRuntimeContext | undefined {
  if (!runtime) {
    return {
      timeoutMs: stageTimeoutMs
    };
  }
  const remaining = remainingBudgetMs(runtime);
  if (remaining === null) {
    return {
      ...runtime,
      timeoutMs: stageTimeoutMs
    };
  }
  const timeoutMs = Math.max(minimumTimeoutMs, Math.min(stageTimeoutMs, remaining - reserveMs));
  return {
    ...runtime,
    timeoutMs
  };
}

function sanitizeSessionPart(input: string): string {
  return input.replace(/[^a-zA-Z0-9:_-]/g, "_").slice(0, 120);
}

function withStageRuntime(
  runtime: OpenClawRuntimeContext | undefined,
  stage: NonNullable<OpenClawRuntimeContext["stage"]>,
  sessionSeed: string
): OpenClawRuntimeContext | undefined {
  const prefix = env.OPENCLAW_AGENT_SESSION_PREFIX.trim() || "nf";
  const base = runtime ?? {};
  const { agentId, model } = resolveStageSpecificAgent(stage, base);
  return {
    ...base,
    stage,
    agentId,
    model,
    sessionKey: `agent:${agentId}:${sanitizeSessionPart(`${prefix}:${stage}:${sessionSeed}`)}`
  };
}

function withExplicitStageRuntime(input: {
  runtime?: OpenClawRuntimeContext;
  stage: NonNullable<OpenClawRuntimeContext["stage"]>;
  sessionSeed: string;
  agentId: string;
  model?: string;
}): OpenClawRuntimeContext {
  const prefix = env.OPENCLAW_AGENT_SESSION_PREFIX.trim() || "nf";
  const base = input.runtime ?? {};
  return {
    ...base,
    stage: input.stage,
    agentId: input.agentId,
    model: input.model,
    sessionKey: `agent:${input.agentId}:${sanitizeSessionPart(`${prefix}:${input.stage}:${input.sessionSeed}`)}`
  };
}

function fallbackCaseFrame(query: string): SupportCaseFrame {
  const normalized = query.trim();
  return {
    goal: normalized,
    symptom: normalized,
    object: "unspecified",
    action_type: /how|如何|怎么|步骤|api|接口/i.test(query) ? "how_to" : "troubleshooting",
    deployment_model: /公有云|public cloud/i.test(query)
      ? "public_cloud"
      : /私有部署|private deployment|on[- ]?prem/i.test(query)
      ? "private_deployment"
      : "shared",
    product_area: /api|openapi|接口/i.test(query) ? "openapi" : "general",
    constraints: [],
    missing_critical_info: [],
    retrieval_queries: [normalized],
    query_plan: {
      concept_queries: [normalized],
      object_queries: [normalized],
      behavior_queries: [normalized]
    }
  };
}

function fallbackQuestionRoute(query: string): SupportQuestionRoute {
  const lowered = query.toLowerCase();
  const question_type: SupportQuestionRoute["question_type"] =
    /\b(scope|oauth|token)\b/i.test(query)
      ? "api_scope_auth"
      : /\b(api|endpoint|method|path|openapi|接口)\b/i.test(query)
      ? "api_endpoint_lookup"
      : /\b(status|field|字段)\b/i.test(query) && /\b(api|接口|openapi)\b/i.test(query)
      ? "api_field_lookup"
      : /为什么|why|预期|行为/.test(query)
      ? "why_behavior"
      : /如何|怎么|步骤|setup|configure|config|导出|export/.test(query)
      ? "how_to_product"
      : /\b(not work|failed|failure|error|报错|异常|失败)\b/i.test(query)
      ? "troubleshooting"
      : "capability_confirmation";
  const specialist_agent: SupportQuestionRoute["specialist_agent"] =
    question_type === "api_endpoint_lookup" || question_type === "api_field_lookup" || question_type === "api_scope_auth"
      ? "api-specialist"
      : question_type === "how_to_product"
      ? "howto-specialist"
      : question_type === "why_behavior" || question_type === "capability_confirmation"
      ? "behavior-specialist"
      : "troubleshooting-specialist";
  return {
    question_type,
    user_goal: query.trim(),
    answer_contract:
      specialist_agent === "api-specialist"
        ? "Give the exact API answer first."
        : specialist_agent === "howto-specialist"
        ? "Give direct steps first."
        : specialist_agent === "behavior-specialist"
        ? "Give the most likely explanation first."
        : "Give the most likely cause and checks first.",
    specialist_agent,
    routing_confidence: 0.7,
    specialist_budget: 1
  };
}

function fallbackEvidencePlan(query: string): SupportEvidencePlan {
  return {
    query_plan: {
      concept_queries: [query],
      object_queries: [query],
      behavior_queries: [query]
    },
    evidence_priority: [],
    required_doc_kinds: [],
    retrieval_rounds: 2,
    allow_refinement: true,
    stop_after_grounded_evidence: false
  };
}

function mergeRouteAndEvidencePlan(caseFrame: SupportCaseFrame, route: SupportQuestionRoute, plan: SupportEvidencePlan): SupportCaseFrame {
  return {
    ...caseFrame,
    missing_critical_info: sanitizeMissingCriticalInfo(caseFrame.missing_critical_info, 3),
    question_type: route.question_type,
    specialist_agent: route.specialist_agent,
    answer_contract: route.answer_contract,
    routing_confidence: route.routing_confidence,
    query_plan: {
      concept_queries: uniqueStrings([...(plan.query_plan?.concept_queries ?? []), ...(caseFrame.query_plan?.concept_queries ?? []), ...caseFrame.retrieval_queries], 4),
      object_queries: uniqueStrings([...(plan.query_plan?.object_queries ?? []), ...(caseFrame.query_plan?.object_queries ?? []), caseFrame.object], 4),
      behavior_queries: uniqueStrings([...(plan.query_plan?.behavior_queries ?? []), ...(caseFrame.query_plan?.behavior_queries ?? []), caseFrame.action_type], 4)
    },
    evidence_priority: uniqueStrings([...(plan.evidence_priority ?? [])], 6),
    required_doc_kinds: uniqueStrings([...(plan.required_doc_kinds ?? [])], 6)
  };
}

function normalizeStageBudget(input: { route: SupportQuestionRoute; plan: SupportEvidencePlan }) {
  const retrievalRounds = Math.max(1, Math.min(2, Number(input.plan.retrieval_rounds ?? 2) || 2));
  const rawSpecialistBudget = input.route.specialist_budget ?? 1;
  const specialistBudget = Math.max(0, Math.min(1, Number.isFinite(rawSpecialistBudget) ? rawSpecialistBudget : 1));
  return {
    retrieval_rounds: retrievalRounds,
    allow_refinement: input.plan.allow_refinement !== false,
    stop_after_grounded_evidence: Boolean(input.plan.stop_after_grounded_evidence),
    specialist_budget: specialistBudget
  };
}

function buildClaimGraph(verification: SupportVerificationResult) {
  return verification.claim_to_citation_map.map((claim) => ({
    text: claim.text,
    kind: claim.kind,
    verdict: claim.verdict,
    citation_ids: claim.citation_ids,
    has_citation: claim.citation_ids.length > 0
  }));
}

function buildOrchestrationTrace(input: {
  route: SupportQuestionRoute;
  specialistSkipped: boolean;
}): Array<{ stage: string; agent_id: string; model?: string | null }> {
  const stages: Array<string> = [
    "router",
    "evidence-planner",
    "planner",
    "support-evidence-selector",
    "evidence-judge",
    "citation-curator",
    "answer-composer"
  ];
  if (!input.specialistSkipped) {
    stages.splice(3, 0, input.route.specialist_agent);
  }
  return stages.map((stage) => {
    const resolved = resolveStageSpecificAgent(stage as NonNullable<OpenClawRuntimeContext["stage"]>);
    return {
      stage,
      agent_id: resolved.agentId,
      model: resolved.model ?? null
    };
  });
}

function fallbackDraftSupportAnswer(input: {
  language: "zh" | "en";
  hasEvidence: boolean;
  missingInfo: string[];
}): DraftSupportAnswer {
  if (input.language === "zh") {
    return input.hasEvidence
      ? {
          direct_answer: "我已经找到可以支撑当前问题的文档证据，先给你最稳妥的判断。",
          claims: [],
          next_actions: ["先按当前回答执行最直接的一步。", "如果结果仍不符合预期，再补充报错原文和复现步骤。"],
          unknowns: input.missingInfo,
          escalation_needed: false
        }
      : {
          direct_answer: "抱歉，我暂时还不能给出可靠结论，因为当前缺少能支撑核心判断的文档证据。",
          claims: [],
          next_actions: input.missingInfo.length ? [`请先补充：${input.missingInfo[0]}`] : ["建议直接创建工单并附上完整上下文。"],
          unknowns: input.missingInfo,
          escalation_needed: !input.missingInfo.length
        };
  }

  return input.hasEvidence
    ? {
        direct_answer: "I found documentation evidence that supports a useful first answer.",
        claims: [],
        next_actions: [
          "Start with the most direct next step from the current answer.",
          "If the issue persists, add the exact error and repro steps."
        ],
        unknowns: input.missingInfo,
        escalation_needed: false
      }
    : {
        direct_answer: "I’m sorry, but I cannot give a reliable conclusion yet because the core answer is not supported by documentation evidence.",
        claims: [],
        next_actions: input.missingInfo.length ? [`Please share: ${input.missingInfo[0]}`] : ["Create a ticket with the current context."],
        unknowns: input.missingInfo,
        escalation_needed: !input.missingInfo.length
      };
}

function fallbackSpecialistDraftAnswer(input: {
  language: "zh" | "en";
  route: SupportQuestionRoute;
  query: string;
  evidenceBundle: SupportEvidenceBundle;
  missingInfo: string[];
}): SpecialistDraftAnswer {
  const base = fallbackDraftSupportAnswer({
    language: input.language,
    hasEvidence: input.evidenceBundle.primary.length > 0,
    missingInfo: input.missingInfo
  });
  const render_variant: SpecialistDraftAnswer["render_variant"] =
    input.route.specialist_agent === "api-specialist"
      ? "api"
      : input.route.specialist_agent === "howto-specialist"
      ? "how_to"
      : input.route.specialist_agent === "behavior-specialist"
      ? "behavior"
      : "troubleshooting";
  return {
    question_type: input.route.question_type,
    render_variant,
    ...base
  };
}

function fallbackSupportAnswer(input: {
  language: "zh" | "en";
  mode: SupportAnswer["mode"];
  route?: SupportQuestionRoute;
  missingInfo: string[];
}): SupportAnswer {
  const route = input.route ?? fallbackQuestionRoute("");
  const render_variant: SupportAnswer["render_variant"] =
    input.mode === "handoff"
      ? "handoff"
      : input.mode === "clarification"
      ? "clarification"
      : route.specialist_agent === "api-specialist"
      ? "api"
      : route.specialist_agent === "howto-specialist"
      ? "how_to"
      : route.specialist_agent === "behavior-specialist"
      ? "behavior"
      : "troubleshooting";
  const baseMeta = {
    question_type: route.question_type,
    render_variant,
    sections: [] as SupportAnswer["sections"]
  };
  if (input.language === "zh") {
    if (input.mode === "handoff") {
      return {
        ...baseMeta,
        mode: "handoff",
        direct_answer: "抱歉，当前还没有足够的已验证证据形成可靠结论。建议直接创建工单，我会自动预填当前上下文。",
        why: [],
        what_to_do_now: ["点击“Create ticket now”生成工单草稿。", "补充报错原文、复现步骤和影响范围。"],
        still_need_to_confirm: []
      };
    }
    if (input.mode === "clarification") {
      return {
        ...baseMeta,
        mode: "clarification",
        direct_answer: "为了给你更可靠的结论，我还缺少一个关键信息。",
        why: [],
        what_to_do_now: [input.missingInfo[0] ? `请先补充：${input.missingInfo[0]}` : "请先补充最关键的一条上下文。"],
        still_need_to_confirm: input.missingInfo.slice(0, 3)
      };
    }
    if (input.mode === "partial") {
      return {
        ...baseMeta,
        mode: "partial",
        direct_answer: "我可以先给出当前最可能的判断，但还有一部分结论尚未被文档直接确认。",
        why: [],
        what_to_do_now: [],
        still_need_to_confirm: input.missingInfo.slice(0, 3)
      };
    }
    return {
      ...baseMeta,
      mode: "grounded",
      direct_answer: "现有文档已经足够支撑当前结论。",
      why: [],
      what_to_do_now: [],
      still_need_to_confirm: []
    };
  }

  if (input.mode === "handoff") {
    return {
      ...baseMeta,
      mode: "handoff",
      direct_answer: "I’m sorry, but there is still not enough verified evidence for a reliable final answer. Create a ticket now and I will prefill the current context.",
      why: [],
      what_to_do_now: ["Create a ticket draft from this conversation.", "Add the exact error, repro steps, and impact scope."],
      still_need_to_confirm: []
    };
  }
  if (input.mode === "clarification") {
    return {
      ...baseMeta,
      mode: "clarification",
      direct_answer: "To give you a more reliable answer, I still need one critical detail.",
      why: [],
      what_to_do_now: [input.missingInfo[0] ? `Please share: ${input.missingInfo[0]}` : "Provide the single most important missing detail."],
      still_need_to_confirm: input.missingInfo.slice(0, 3)
    };
  }
  if (input.mode === "partial") {
    return {
      ...baseMeta,
      mode: "partial",
      direct_answer: "I can give the most likely answer now, but part of the conclusion is still not directly confirmed by documentation.",
      why: [],
      what_to_do_now: [],
      still_need_to_confirm: input.missingInfo.slice(0, 3)
    };
  }
  return {
    ...baseMeta,
    mode: "grounded",
    direct_answer: "The current conclusion is fully supported by documentation evidence.",
    why: [],
    what_to_do_now: [],
    still_need_to_confirm: []
  };
}

function fallbackVerification(language: "zh" | "en", verdict: SupportVerificationResult["verdict"], missingInfo: string[]): SupportVerificationResult {
  return {
    verdict,
    summary:
      language === "zh"
        ? verdict === "verified"
          ? "当前回答已被现有证据支撑。"
          : verdict === "partial"
          ? "当前回答仅有部分证据支撑。"
          : "当前回答缺少足够证据支撑。"
        : verdict === "verified"
        ? "The current answer is supported by the available evidence."
        : verdict === "partial"
        ? "The current answer is only partially supported by the available evidence."
        : "The current answer lacks enough supporting evidence.",
    unsupported_claims: [],
    missing_info: missingInfo,
    verified_citation_ids: [],
    display_citation_ids: [],
    verified_claims: [],
    claim_to_citation_map: []
  };
}

function buildEvidenceBundle(input: {
  references: SearchReference[];
  confidence: number;
  fallbackUsed: boolean;
  resolvedQueries: string[];
  caseFrame: SupportCaseFrame;
  query: string;
  selection?: SupportEvidenceSelection | null;
}): SupportEvidenceBundle {
  const reranked = rerankReferencesForCaseFrame(input.references, input.query, input.caseFrame);
  const byId = new Map(reranked.map((reference) => [reference.documentId, reference] as const));
  const selectedPrimary =
    input.selection?.primary_ids
      .map((id) => byId.get(id))
      .filter((item): item is SearchReference => Boolean(item)) ?? [];
  const selectedSupplemental =
    input.selection?.supplemental_ids
      .map((id) => byId.get(id))
      .filter(
        (item): item is SearchReference =>
          Boolean(item) && !selectedPrimary.some((primary) => primary.documentId === (item as SearchReference).documentId)
      ) ?? [];
  const primary = uniqueStrings(
    [
      ...selectedPrimary.map((item) => item.documentId),
      ...collectProcedureCompanionChunkIds(reranked, selectedPrimary, input.caseFrame),
      ...reranked.slice(0, 3).map((item) => item.documentId)
    ],
    3
  )
    .map((id) => byId.get(id))
    .filter((item): item is SearchReference => Boolean(item))
    .map((item) => hydrateReferenceEvidence(item));
  const supplemental = uniqueStrings(
    [
      ...selectedSupplemental.map((item) => item.documentId),
      ...collectProcedureCompanionChunkIds(reranked, primary, input.caseFrame),
      ...collectApiCompanionChunkIds(reranked, primary, input.caseFrame),
      ...reranked
        .filter((item) => !primary.some((primaryRef) => primaryRef.documentId === item.documentId))
        .slice(0, 5)
        .map((item) => item.documentId)
    ],
    5
  )
    .map((id) => byId.get(id))
    .filter((item): item is SearchReference => Boolean(item))
    .map((item) => hydrateReferenceEvidence(item));
  return {
    primary,
    supplemental,
    evidence_gaps: input.caseFrame.missing_critical_info.slice(0, 3),
    confidence: input.confidence,
    fallbackUsed: input.fallbackUsed,
    resolvedQueries: input.resolvedQueries
  };
}

function collectProcedureCompanionChunkIds(
  references: SearchReference[],
  primary: SearchReference[],
  caseFrame: SupportCaseFrame
): string[] {
  if (!["how_to_product", "config_setup", "data_export_reporting"].includes(String(caseFrame.question_type ?? ""))) {
    return [];
  }
  const ids: string[] = [];
  for (const item of primary) {
    const canonicalPath = canonicalDocsPath(item.path);
    if (!canonicalPath) continue;
    if (String(item.headingPath ?? "").toUpperCase() === "ROOT") continue;
    const companion = references.find(
      (candidate) =>
        candidate.documentId !== item.documentId &&
        canonicalDocsPath(candidate.path) === canonicalPath &&
        String(candidate.headingPath ?? "").toUpperCase() === "ROOT"
    );
    if (companion) ids.push(companion.documentId);
  }
  return uniqueStrings(ids, 3);
}

function collectApiCompanionChunkIds(
  references: SearchReference[],
  primary: SearchReference[],
  caseFrame: SupportCaseFrame
): string[] {
  if (!String(caseFrame.question_type ?? "").startsWith("api_")) return [];
  const ids: string[] = [];
  for (const item of primary) {
    const canonicalPath = canonicalDocsPath(item.path);
    if (!canonicalPath.includes("open-docs/docs/openapi/api/")) continue;
    if (String(item.headingPath ?? "").toUpperCase() !== "ROOT") continue;
    const companion = references.find(
      (candidate) =>
        candidate.documentId !== item.documentId &&
        canonicalDocsPath(candidate.path) === canonicalPath &&
        String(candidate.headingPath ?? "").toUpperCase() !== "ROOT"
    );
    if (companion) ids.push(companion.documentId);
  }
  return uniqueStrings(ids, 3);
}

function fallbackEvidenceSelection(references: SearchReference[], query: string, caseFrame: SupportCaseFrame): SupportEvidenceSelection {
  const reranked = rerankReferencesForCaseFrame(references, query, caseFrame);
  return {
    primary_ids: reranked.slice(0, 3).map((item) => item.documentId),
    supplemental_ids: reranked.slice(3, 6).map((item) => item.documentId),
    rejected_ids: reranked.slice(6).map((item) => item.documentId)
  };
}

function canonicalDocsPath(input?: string): string {
  return String(input ?? "")
    .trim()
    .replace(/^i18n\/[^/]+\/docusaurus-plugin-content-docs-open-docs\/current\//i, "open-docs/docs/")
    .replace(/^i18n\/[^/]+\/docusaurus-plugin-content-docs\/current\//i, "docs/");
}

function resolveLocalDocsMirrorPath(reference: SearchReference): string | null {
  const rawPath = String(reference.path ?? "").trim();
  if (!rawPath || !env.LOCAL_DOCS_COM_PATH.trim()) return null;
  const candidates = [rawPath, canonicalDocsPath(rawPath)]
    .filter(Boolean)
    .map((candidate) => path.resolve(env.LOCAL_DOCS_COM_PATH, candidate));
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function buildLocalDocsEvidenceSnippet(reference: SearchReference): string | null {
  const resolvedPath = resolveLocalDocsMirrorPath(reference);
  if (!resolvedPath) return null;

  const raw = fs.readFileSync(resolvedPath, "utf8");
  const normalizeEvidenceLine = (line: string): string => {
    const trimmed = line.trim();
    const methodMatch = trimmed.match(/<MethodEndpoint[\s\S]*method=\{"([^"]+)"\}[\s\S]*path=\{"([^"]+)"\}/);
    if (methodMatch) {
      return `MethodEndpoint method={"${methodMatch[1]}"} path={"${methodMatch[2]}"}`;
    }
    const paramsMatch = trimmed.match(/<ParamsItem[\s\S]*"name":"([^"]+)"[\s\S]*"description":"([^"]+)"/);
    if (paramsMatch) {
      return `ParamsItem name={"${paramsMatch[1]}"} description={"${paramsMatch[2]}"}`;
    }
    const schemaMatch = trimmed.match(/<SchemaItem[\s\S]*name=\{"([^"]+)"\}[\s\S]*description":"([^"]+)"/);
    if (schemaMatch) {
      return `SchemaField name={"${schemaMatch[1]}"} description={"${schemaMatch[2]}"}`;
    }
    return trimmed.length <= 220 ? trimmed : trimmed.slice(0, 220);
  };
  const cleanedLines = raw
    .replace(/^---[\s\S]*?---\s*/, "")
    .split("\n")
    .map((line) => normalizeEvidenceLine(line))
    .filter(Boolean)
    .filter((line) => !line.startsWith("import "))
    .filter((line) => !/^api:\s/.test(line))
    .filter((line) => !/^(sidebar_|hide_|custom_edit_url:|info_path:)/.test(line))
    .filter((line) => line.length <= 220);

  const heading = String(reference.headingPath ?? "").trim();
  const headingNeedle = heading && heading.toUpperCase() !== "ROOT" ? shortHeadingLabel(heading).toLowerCase() : "";
  const anchorIndex = headingNeedle ? cleanedLines.findIndex((line) => line.toLowerCase().includes(headingNeedle)) : -1;
  const scopedLines =
    anchorIndex >= 0 ? cleanedLines.slice(Math.max(0, anchorIndex - 18), anchorIndex + 90) : cleanedLines.slice(0, 140);
  const enriched = scopedLines.join(" ").replace(/\s+/g, " ").trim();
  return enriched ? enriched.slice(0, 3200) : null;
}

function hydrateReferenceEvidence(reference: SearchReference): SearchReference {
  if (reference.sourceType !== "local_docs") return reference;
  const enrichedSnippet = buildLocalDocsEvidenceSnippet(reference);
  if (!enrichedSnippet || enrichedSnippet.length <= reference.snippet.length) return reference;
  return {
    ...reference,
    snippet: enrichedSnippet
  };
}

function uniqueCitationIds(claims: SupportVerificationResult["claim_to_citation_map"]): string[] {
  return uniqueStrings(
    claims
      .filter((claim) => (claim.verdict === "verified" || claim.verdict === "supported_inference") && claim.citation_ids.length > 0)
      .flatMap((claim) => claim.citation_ids),
    12
  );
}

function collectFocusTerms(query: string, caseFrame: SupportCaseFrame): string[] {
  const raw = [
    query,
    caseFrame.goal,
    caseFrame.object,
    caseFrame.symptom,
    caseFrame.product_area,
    caseFrame.action_type,
    ...caseFrame.retrieval_queries,
    ...(caseFrame.query_plan?.concept_queries ?? []),
    ...(caseFrame.query_plan?.object_queries ?? []),
    ...(caseFrame.query_plan?.behavior_queries ?? [])
  ]
    .map((item) => String(item ?? "").trim())
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  const ascii = [...raw.matchAll(/[a-z0-9:_./-]{3,}/g)].map((match) => match[0]);
  const cjk = [...raw.matchAll(/[\u4e00-\u9fff]{2,}/g)].map((match) => match[0]);
  return uniqueStrings([...ascii, ...cjk], 24);
}

function buildCompactFocusQuery(query: string, caseFrame: SupportCaseFrame): string | null {
  const stopwords = new Set([
    "does",
    "what",
    "when",
    "where",
    "which",
    "with",
    "that",
    "this",
    "have",
    "from",
    "into",
    "such",
    "used",
    "commonly",
    "noticed",
    "support",
    "supports",
    "query",
    "queries",
    "function",
    "seems",
    "translate",
    "changing",
    "exact",
    "object",
    "scenario",
    "working"
  ]);
  const focusTerms = collectFocusTerms(query, caseFrame).filter((term) => {
    const normalized = term.toLowerCase();
    return normalized.length > 2 && !stopwords.has(normalized);
  });
  const compact = uniqueStrings(focusTerms, 8).join(" ").trim();
  if (!compact) return null;
  return compact.toLowerCase() === query.trim().toLowerCase() ? null : compact;
}

function rerankReferencesForCaseFrame(references: SearchReference[], query: string, caseFrame: SupportCaseFrame): SearchReference[] {
  const requiredDocKinds = caseFrame.required_doc_kinds ?? [];
  const focusTerms = collectFocusTerms(query, caseFrame);
  const normalizedQuery = query.toLowerCase();
  const wantsListVariant =
    /列表|枚举|可选|全部|有哪些/.test(query) || /\b(list|enum|options|all statuses?)\b/.test(normalizedQuery);
  return [...references].sort((a, b) => {
    const scoreRef = (reference: SearchReference) => {
      const title = String(reference.title ?? "").toLowerCase();
      const heading = String(reference.headingPath ?? "").toLowerCase();
      const refPath = String(reference.path ?? "").toLowerCase();
      const snippet = String(reference.snippet ?? "").toLowerCase();
      let topicScore = 0;
      for (const term of focusTerms) {
        if (title.includes(term)) topicScore += 8;
        else if (heading.includes(term)) topicScore += 5;
        else if (refPath.includes(term)) topicScore += 4;
        else if (snippet.includes(term)) topicScore += 1;
      }
      if (reference.sourceType === "local_docs" || reference.sourceType === "github_kb") {
        topicScore += 2;
      }
      for (const kind of requiredDocKinds.map((item) => item.toLowerCase())) {
        if (kind === "openapi/api" && refPath.includes("openapi/api/")) topicScore += 22;
        else if ((kind === "schema" || kind === "field") && (refPath.includes("issue-field") || refPath.includes("field"))) {
          topicScore += 14;
        } else if (kind === "syntax_reference" && (refPath.includes("onesql") || title.includes("onesql") || heading.includes("onesql"))) {
          topicScore += 18;
        } else if (kind === "permissions" && (refPath.includes("scope") || title.includes("scope") || title.includes("permission"))) {
          topicScore += 16;
        } else if (kind === "rules" && (title.includes("workflow") || heading.includes("workflow") || title.includes("rule"))) {
          topicScore += 12;
        } else if (
          kind === "product_guide" &&
          (refPath.startsWith("docs/") || refPath.includes("/docs/") || refPath.startsWith("open-docs/docs/")) &&
          !refPath.includes("openapi/api/")
        ) {
          topicScore += 10;
        }
      }
      if (
        caseFrame.question_type &&
        caseFrame.question_type.startsWith("api_") &&
        refPath.includes("openapi/api/")
      ) {
        topicScore += 8;
      }
      if (caseFrame.question_type === "api_field_lookup") {
        const isIssueDetailsOperation =
          /03-get-a-issue-details|\/project\/issues\/\{issueid\}/.test(refPath + " " + snippet) ||
          title.includes("issue details") ||
          title.includes("工作项详细信息");
        const isStatusListOperation =
          /get-a-list-of-issue-status|\/project\/issuestatuses/.test(refPath + " " + snippet) ||
          title.includes("issue status") ||
          title.includes("工作项状态列表");
        const hasFieldSignal =
          /status object|"status"|name=\{"status"\}|状态|字段|responseexample/.test(snippet) ||
          heading.includes("schema") ||
          heading.includes("responses");
        if (isIssueDetailsOperation) {
          topicScore += wantsListVariant ? 6 : 20;
          if (hasFieldSignal) topicScore += 14;
        }
        if (isStatusListOperation) {
          topicScore += wantsListVariant ? 18 : -8;
        }
      }
      if (
        /sidebar label|hide title|custom edit url|import apitabs|import methodendpoint|^---\s*id:/.test(snippet) ||
        (String(reference.headingPath ?? "").toUpperCase() === "ROOT" &&
          /sidebar label|hide title|custom edit url|import apitabs|import methodendpoint/.test(snippet))
      ) {
        topicScore -= 20;
      }
      return topicScore;
    };
    const topicDiff = scoreRef(b) - scoreRef(a);
    if (topicDiff !== 0) return topicDiff;
    return b.score - a.score;
  });
}

function sanitizeVerification(input: {
  verification: SupportVerificationResult;
  evidenceBundle: SupportEvidenceBundle;
}): SupportVerificationResult {
  const evidenceById = new Map(
    [...input.evidenceBundle.primary, ...input.evidenceBundle.supplemental]
      .filter((item) => item.authority === "canonical_visible")
      .map((item) => [item.documentId, item] as const)
  );
  const sanitizedClaims = input.verification.claim_to_citation_map.map((claim) => {
    const validCitationIds = uniqueStrings(
      claim.citation_ids.filter((citationId) => evidenceById.has(citationId)),
      6
    );
    if ((claim.verdict === "verified" || claim.verdict === "supported_inference") && validCitationIds.length === 0) {
      return {
        ...claim,
        verdict: "unsupported" as const,
        citation_ids: []
      };
    }
    return {
      ...claim,
      citation_ids: validCitationIds
    };
  });
  const supportedClaims = sanitizedClaims.filter(
    (claim) => (claim.verdict === "verified" || claim.verdict === "supported_inference") && claim.citation_ids.length > 0
  );
  const claimLinkedCitationIds = uniqueCitationIds(sanitizedClaims);
  const claimLinkedCitationSet = new Set(claimLinkedCitationIds);
  const displayCitationIds = uniqueStrings(input.verification.display_citation_ids, 6).filter(
    (citationId) => evidenceById.has(citationId) && claimLinkedCitationSet.has(citationId)
  );
  const unsupportedClaims = uniqueStrings(
    [
      ...input.verification.unsupported_claims,
      ...sanitizedClaims
        .filter((claim) => claim.verdict === "unsupported")
        .map((claim) => claim.text)
    ],
    12
  );
  return {
    verdict:
      supportedClaims.length === 0
        ? "unsupported"
        : unsupportedClaims.length === 0 && input.verification.verdict === "verified"
        ? "verified"
        : "partial",
    summary: input.verification.summary,
    unsupported_claims: unsupportedClaims,
    missing_info: input.verification.missing_info,
    verified_citation_ids: claimLinkedCitationIds,
    display_citation_ids: displayCitationIds.slice(0, 3),
    verified_claims: supportedClaims.map((claim) => claim.text),
    claim_to_citation_map: sanitizedClaims
  };
}

function buildCitations(input: {
  references: SearchReference[];
  verification: SupportVerificationResult;
}) {
  if (!input.verification.display_citation_ids.length) {
    return [];
  }
  const bestById = new Map<string, SearchReference>();
  for (const item of input.references) {
    if (!item.sourceUrl || item.authority !== "canonical_visible") continue;
    const previous = bestById.get(item.documentId);
    if (!previous || item.score > previous.score) bestById.set(item.documentId, item);
  }
  const selected: SearchReference[] = [];
  const seenCanonicalKeys = new Set<string>();
  for (const citationId of input.verification.display_citation_ids) {
    const item = bestById.get(citationId);
    if (!item) continue;
    const key = [canonicalDocsPath(item.path) || item.sourceUrl || item.documentId, item.headingPath || "ROOT"].join("::");
    if (seenCanonicalKeys.has(key)) continue;
    seenCanonicalKeys.add(key);
    selected.push(item);
    if (selected.length >= 3) break;
  }
  return selected.map((item) => ({
    id: item.documentId,
    title: item.title,
    excerpt: item.snippet,
    score: item.score,
    source_url: item.sourceUrl,
    retrieved_at: item.retrievedAt,
    repo: item.repo,
    path: item.path,
    commit_sha: item.commitSha
  }));
}

function buildStructuredAnswer(
  supportAnswer: SupportAnswer,
  verification: SupportVerificationResult
): StructuredSearchAnswer {
  if (supportAnswer.mode === "clarification") {
    return {
      summary: supportAnswer.direct_answer,
      steps: supportAnswer.what_to_do_now,
      validation: [],
      required_inputs: supportAnswer.still_need_to_confirm.slice(0, 3),
      style: "clarification"
    };
  }

  if (supportAnswer.mode === "handoff") {
    return {
      summary: supportAnswer.direct_answer,
      assessment: supportAnswer.why.join(" ") || verification.summary,
      steps: supportAnswer.what_to_do_now,
      validation: supportAnswer.still_need_to_confirm,
      style: "diagnosis"
    };
  }

  return {
    summary: supportAnswer.direct_answer,
    assessment: supportAnswer.why.join(" ") || undefined,
    steps: supportAnswer.what_to_do_now,
    validation: supportAnswer.still_need_to_confirm,
    style: supportAnswer.mode === "partial" ? "diagnosis" : "kb_answer"
  };
}

function digestEvidenceBundle(bundle: SupportEvidenceBundle): string {
  return crypto.createHash("sha256").update(JSON.stringify(bundle)).digest("hex");
}

function normalizeComparableText(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

function overlapsUnsupportedClaim(text: string, unsupportedClaims: string[]): boolean {
  const normalizedText = normalizeComparableText(text);
  if (!normalizedText) return false;
  return unsupportedClaims.some((claim) => {
    const normalizedClaim = normalizeComparableText(claim);
    return normalizedClaim && (normalizedText.includes(normalizedClaim) || normalizedClaim.includes(normalizedText));
  });
}

function filterUnsupported(items: string[], unsupportedClaims: string[]): string[] {
  return items.filter((item) => !overlapsUnsupportedClaim(item, unsupportedClaims));
}

function resolveSupportMode(input: {
  verification: SupportVerificationResult;
  references: SearchReference[];
  currentRound: number;
  missingInfo: string[];
}): SupportAnswer["mode"] {
  const supportedCoreClaims = input.verification.claim_to_citation_map.filter(
    (claim) => (claim.verdict === "verified" || claim.verdict === "supported_inference") && claim.citation_ids.length > 0
  );
  if (supportedCoreClaims.length > 0 && input.verification.verdict === "verified" && input.missingInfo.length === 0) {
    return "grounded";
  }
  if (supportedCoreClaims.length > 0) {
    return "partial";
  }
  if (input.missingInfo.length > 0 && input.currentRound < env.AI_SEARCH_MAX_CLARIFICATION_ROUNDS) {
    return "clarification";
  }
  if (!input.references.length && input.missingInfo.length > 0 && input.currentRound < env.AI_SEARCH_MAX_CLARIFICATION_ROUNDS) {
    return "clarification";
  }
  return "handoff";
}

function supportedVerificationClaims(verification: SupportVerificationResult) {
  return verification.claim_to_citation_map.filter(
    (claim) => (claim.verdict === "verified" || claim.verdict === "supported_inference") && claim.citation_ids.length > 0
  );
}

function scoreReferenceTopicMatch(reference: SearchReference, focusTerms: string[]): number {
  const title = String(reference.title ?? "").toLowerCase();
  const heading = String(reference.headingPath ?? "").toLowerCase();
  const refPath = canonicalDocsPath(reference.path).toLowerCase();
  const snippet = String(reference.snippet ?? "").toLowerCase();
  let topicScore = 0;
  for (const term of focusTerms) {
    if (title.includes(term)) topicScore += 10;
    else if (heading.includes(term)) topicScore += 7;
    else if (refPath.includes(term)) topicScore += 5;
    else if (snippet.includes(term)) topicScore += 2;
  }
  return topicScore;
}

function scoreVerificationCandidate(
  verification: SupportVerificationResult,
  evidenceBundle: SupportEvidenceBundle,
  query: string,
  caseFrame: SupportCaseFrame
): number {
  const supportedClaims = supportedVerificationClaims(verification);
  const evidenceById = new Map(
    [...evidenceBundle.primary, ...evidenceBundle.supplemental]
      .filter((item) => item.authority === "canonical_visible")
      .map((item) => [item.documentId, item] as const)
  );
  const focusTerms = collectFocusTerms(query, caseFrame);
  let score = 0;
  score += supportedClaims.length * 40;
  score += verification.display_citation_ids.length * 18;
  score -= verification.unsupported_claims.length * 8;
  for (const citationId of verification.display_citation_ids) {
    const reference = evidenceById.get(citationId);
    if (!reference) continue;
    score += scoreReferenceTopicMatch(reference, focusTerms);
    score += Math.round(reference.score * 10);
  }
  return score;
}

function pickBestVerificationCandidate(input: {
  query: string;
  caseFrame: SupportCaseFrame;
  evidenceBundle: SupportEvidenceBundle;
  primary: SupportVerificationResult;
  rebound: SupportVerificationResult | null;
  writerBound: SupportVerificationResult;
}): SupportVerificationResult {
  const candidates = [input.primary, input.rebound].filter(
    (candidate): candidate is SupportVerificationResult => Boolean(candidate)
  );
  const supportedCandidates = candidates.filter((candidate) => supportedVerificationClaims(candidate).length > 0);
  if (supportedCandidates.length > 0) {
    return [...supportedCandidates].sort(
      (a, b) =>
        scoreVerificationCandidate(b, input.evidenceBundle, input.query, input.caseFrame) -
        scoreVerificationCandidate(a, input.evidenceBundle, input.query, input.caseFrame)
    )[0];
  }
  return supportedVerificationClaims(input.writerBound).length > 0 ? input.writerBound : input.primary;
}

function buildFallbackDirectAnswerFromSupportedClaims(input: {
  language: "zh" | "en";
  mode: SupportAnswer["mode"];
  supportedClaims: SupportVerificationResult["claim_to_citation_map"];
  fallback: SupportAnswer;
}): string {
  const leadingClaims = uniqueStrings(
    input.supportedClaims
      .filter((claim) => claim.kind === "verified_fact" || claim.kind === "grounded_inference")
      .map((claim) => claim.text),
    2
  );
  const explicitVerdict = leadingClaims.find((claim) => /could not confirm|does not explicitly|not explicitly|未明确|无法确认|没有明确/i.test(claim));
  if (!leadingClaims.length || (input.mode !== "grounded" && input.mode !== "partial")) {
    return input.fallback.direct_answer;
  }
  if (input.language === "zh") {
    return input.mode === "partial"
      ? explicitVerdict
        ? `${explicitVerdict}${leadingClaims.length > 1 ? ` 另外，${leadingClaims.filter((item) => item !== explicitVerdict).join("；")}` : ""}`
        : `基于当前文档，我可以先确认：${leadingClaims.join("；")}。其余部分还需要进一步确认。`
      : leadingClaims.join("；");
  }
  return input.mode === "partial"
    ? explicitVerdict
      ? `${explicitVerdict}${leadingClaims.length > 1 ? ` ${leadingClaims.filter((item) => item !== explicitVerdict).join(" ")}` : ""}`
      : `Based on the current documentation, I can confirm this much: ${leadingClaims.join("; ")}. The remaining part is still not fully confirmed.`
    : leadingClaims.join("; ");
}

function buildFallbackSectionsFromDraft(draft: SpecialistDraftAnswer): SupportAnswer["sections"] {
  switch (draft.render_variant) {
    case "api":
      return draft.api_method || draft.api_path
        ? [
            {
              kind: "api_card",
              title: "API",
              method: draft.api_method ?? "",
              path: draft.api_path ?? "",
              required_params: draft.required_params ?? [],
              auth_scope: draft.auth_scope ?? [],
              response_field_hint: draft.response_field_hint,
              important_note: draft.important_note,
              related_variant: draft.related_variant
            }
          ]
        : [];
    case "how_to":
      return [
        ...(draft.steps?.length ? [{ kind: "bullet_list" as const, title: "Steps", items: draft.steps }] : []),
        ...(draft.prerequisites?.length ? [{ kind: "bullet_list" as const, title: "Prerequisites", items: draft.prerequisites }] : []),
        ...(draft.limits_or_notes?.length ? [{ kind: "bullet_list" as const, title: "Notes", items: draft.limits_or_notes }] : [])
      ];
    case "behavior":
      return [
        ...(draft.most_likely_explanation
          ? [{ kind: "paragraph" as const, title: "Most likely explanation", body: draft.most_likely_explanation }]
          : []),
        ...(draft.confirmed_facts?.length ? [{ kind: "bullet_list" as const, title: "Confirmed facts", items: draft.confirmed_facts }] : []),
        ...(draft.what_to_check_next?.length
          ? [{ kind: "bullet_list" as const, title: "What to check next", items: draft.what_to_check_next }]
          : [])
      ];
    case "troubleshooting":
      return [
        ...(draft.most_likely_causes?.length
          ? [{ kind: "bullet_list" as const, title: "Most likely causes", items: draft.most_likely_causes }]
          : []),
        ...(draft.recommended_checks?.length
          ? [{ kind: "bullet_list" as const, title: "Recommended checks", items: draft.recommended_checks }]
          : []),
        ...(draft.required_followup_info?.length
          ? [{ kind: "bullet_list" as const, title: "Required follow-up info", items: draft.required_followup_info }]
          : [])
      ];
    default:
      return [];
  }
}

function buildSupportAnswerFromDraft(input: {
  language: "zh" | "en";
  mode: SupportAnswer["mode"];
  route: SupportQuestionRoute;
  draft: SpecialistDraftAnswer;
  verification: SupportVerificationResult;
  missingInfo: string[];
  composed?: Omit<SupportAnswer, "mode"> | null;
}): SupportAnswer {
  const supportedClaims = supportedVerificationClaims(input.verification);
  const preferComposedOnly = input.mode === "clarification" || input.mode === "handoff";
  const why = uniqueStrings(
    preferComposedOnly
      ? [...(input.composed?.why ?? [])]
      : [
          ...(input.composed?.why ?? []),
          ...supportedClaims.filter((claim) => claim.kind === "verified_fact" || claim.kind === "grounded_inference").map((claim) => claim.text)
        ],
    4
  );
  const whatToDoNow = uniqueStrings(
    preferComposedOnly
      ? [...(input.composed?.what_to_do_now ?? [])]
      : [
          ...(input.composed?.what_to_do_now ?? []),
          ...filterUnsupported(input.draft.next_actions, input.verification.unsupported_claims)
        ],
    4
  );
  const stillNeedToConfirm = uniqueStrings(
    preferComposedOnly
      ? [...(input.composed?.still_need_to_confirm ?? []), ...input.verification.missing_info, ...input.missingInfo]
      : [...(input.composed?.still_need_to_confirm ?? []), ...input.draft.unknowns, ...input.verification.missing_info, ...input.missingInfo],
    4
  );
  const fallback = fallbackSupportAnswer({
    language: input.language,
    mode: input.mode,
    route: input.route,
    missingInfo: stillNeedToConfirm
  });
  const safeDraftDirectAnswer =
    input.draft.direct_answer?.trim() && !overlapsUnsupportedClaim(input.draft.direct_answer, input.verification.unsupported_claims)
      ? input.draft.direct_answer.trim()
      : "";
  const safeComposedDirectAnswer =
    input.composed?.direct_answer?.trim() && !overlapsUnsupportedClaim(input.composed.direct_answer, input.verification.unsupported_claims)
      ? input.composed.direct_answer.trim()
      : "";
  const directAnswer =
    input.mode === "grounded" || input.mode === "partial"
      ? safeComposedDirectAnswer ||
        safeDraftDirectAnswer ||
        buildFallbackDirectAnswerFromSupportedClaims({
          language: input.language,
          mode: input.mode,
          supportedClaims,
          fallback
        })
      : safeComposedDirectAnswer || fallback.direct_answer;
  return {
    question_type: input.composed?.question_type ?? input.draft.question_type ?? input.route.question_type,
    render_variant: input.composed?.render_variant ?? input.draft.render_variant ?? fallback.render_variant,
    mode: input.mode,
    direct_answer: directAnswer,
    sections: input.composed?.sections?.length ? input.composed.sections : buildFallbackSectionsFromDraft(input.draft),
    why: why.length ? why : fallback.why,
    what_to_do_now: whatToDoNow.length ? whatToDoNow : fallback.what_to_do_now,
    still_need_to_confirm:
      input.mode === "grounded" && input.verification.verdict === "verified"
        ? []
        : stillNeedToConfirm.length
        ? stillNeedToConfirm
        : fallback.still_need_to_confirm
  };
}

function hasGroundedDraftClaims(draft: SpecialistDraftAnswer): boolean {
  return draft.claims.some(
    (claim) =>
      claim.evidence_ids.length > 0 && (claim.kind === "verified_fact" || claim.kind === "grounded_inference")
  );
}

function shouldUseFastAgentPath(input: {
  route: SupportQuestionRoute;
  caseFrame: SupportCaseFrame;
  evidenceBundle: SupportEvidenceBundle;
  draft: SpecialistDraftAnswer;
  currentRound: number;
}): boolean {
  if (!input.evidenceBundle.primary.length) return false;
  if (!input.draft.direct_answer.trim()) return false;
  if (!hasGroundedDraftClaims(input.draft)) return false;
  if (input.draft.escalation_needed) return false;
  if (input.caseFrame.missing_critical_info.length > 1) return false;
  if (input.currentRound > 0 && input.caseFrame.missing_critical_info.length > 0) return false;

  const fastQuestionTypes = new Set<SupportQuestionRoute["question_type"]>([
    "api_endpoint_lookup",
    "api_field_lookup",
    "api_scope_auth",
    "how_to_product",
    "config_setup",
    "data_export_reporting"
  ]);
  if (!fastQuestionTypes.has(input.route.question_type)) return false;

  return (
    input.evidenceBundle.primary.length >= 2 ||
    input.evidenceBundle.confidence >= env.AI_SEARCH_ANSWER_CONFIDENCE_THRESHOLD ||
    input.route.question_type.startsWith("api_")
  );
}

function shortHeadingLabel(headingPath?: string): string {
  const heading = String(headingPath ?? "").trim();
  if (!heading) return "";
  const parts = heading.split(">").map((item) => item.trim()).filter(Boolean);
  return (parts[parts.length - 1] ?? heading).replace(/^[0-9.\-\s\\]+/, "").trim();
}

function recoverEvidenceAnchoredHowToDraft(input: {
  language: "zh" | "en";
  query: string;
  draft: SpecialistDraftAnswer;
  evidenceBundle: SupportEvidenceBundle;
  route: SupportQuestionRoute;
}): SpecialistDraftAnswer | null {
  if (input.route.specialist_agent !== "howto-specialist") return null;
  if (hasGroundedDraftClaims(input.draft)) return null;

  const ranked = [...input.evidenceBundle.primary, ...input.evidenceBundle.supplemental].filter(
    (reference) => reference.authority === "canonical_visible"
  );
  const actionReference = ranked.find((reference) => {
    const text = `${reference.title} ${reference.headingPath ?? ""} ${reference.snippet}`.toLowerCase();
    return /重建|步骤|指南|配置|导出|setup|configure|guide|step|rebuild|index/.test(text);
  });
  if (!actionReference) return null;

  const noteReference = ranked.find(
    (reference) =>
      reference.documentId !== actionReference.documentId &&
      /影响|验证|注意|前提|prerequisite|impact|validate|note/.test(
        `${reference.title} ${reference.headingPath ?? ""} ${reference.snippet}`.toLowerCase()
      )
  );
  const actionHeading = shortHeadingLabel(actionReference.headingPath) || actionReference.title;
  const noteHeading = noteReference ? shortHeadingLabel(noteReference.headingPath) || noteReference.title : "";

  if (input.language === "zh") {
    return {
      ...input.draft,
      render_variant: "how_to",
      direct_answer: `从当前命中的文档看，可以按《${actionReference.title}》中“${actionHeading}”这一节执行。${
        noteReference ? `另外，执行前后再关注《${noteReference.title}》提到的“${noteHeading}”。` : ""
      }`.trim(),
      claims: [
        {
          text: `《${actionReference.title}》包含“${actionHeading}”这一节，可作为当前问题的直接操作入口。`,
          kind: "verified_fact",
          evidence_ids: [actionReference.documentId],
          authority: "canonical"
        },
        ...(noteReference
          ? [
              {
                text: `《${noteReference.title}》补充说明了“${noteHeading}”相关的执行影响或验证信息。`,
                kind: "verified_fact" as const,
                evidence_ids: [noteReference.documentId],
                authority: "canonical" as const
              }
            ]
          : [])
      ],
      next_actions: uniqueStrings(
        [
          `先按《${actionReference.title}》中“${actionHeading}”的步骤执行。`,
          noteReference ? `执行前后核对《${noteReference.title}》中“${noteHeading}”提到的影响或验证点。` : "执行后确认索引任务已完成。"
        ],
        4
      ),
      steps: uniqueStrings(
        [
          `打开《${actionReference.title}》中“${actionHeading}”对应的操作章节。`,
          `按该章节执行当前操作。`,
          noteReference ? `再核对《${noteReference.title}》中“${noteHeading}”提到的执行影响或验证方式。` : "执行完成后检查结果是否符合预期。"
        ],
        4
      ),
      limits_or_notes: noteReference ? [`补充参考《${noteReference.title}》中“${noteHeading}”的说明。`] : input.draft.limits_or_notes,
      unknowns: []
    };
  }

  return {
    ...input.draft,
    render_variant: "how_to",
    direct_answer: `The retrieved documentation points to "${actionHeading}" in "${actionReference.title}" as the direct procedure to follow.${
      noteReference ? ` Also review "${noteHeading}" in "${noteReference.title}" for execution impact or validation details.` : ""
    }`.trim(),
    claims: [
      {
        text: `"${actionReference.title}" contains a "${actionHeading}" section that is directly relevant to this operation.`,
        kind: "verified_fact",
        evidence_ids: [actionReference.documentId],
        authority: "canonical"
      },
      ...(noteReference
        ? [
            {
              text: `"${noteReference.title}" adds "${noteHeading}" details that are relevant for impact or validation.`,
              kind: "verified_fact" as const,
              evidence_ids: [noteReference.documentId],
              authority: "canonical" as const
            }
          ]
        : [])
    ],
    next_actions: uniqueStrings(
      [
        `Follow the "${actionHeading}" section in "${actionReference.title}".`,
        noteReference ? `Review "${noteHeading}" in "${noteReference.title}" before and after the operation.` : "Verify the result after the operation finishes."
      ],
      4
    ),
    steps: uniqueStrings(
      [
        `Open the "${actionHeading}" section in "${actionReference.title}".`,
        "Execute the procedure described there.",
        noteReference ? `Review "${noteHeading}" in "${noteReference.title}" for impact or validation details.` : "Check the final result after the procedure completes."
      ],
      4
    ),
    limits_or_notes: noteReference ? [`Also review "${noteHeading}" in "${noteReference.title}".`] : input.draft.limits_or_notes,
    unknowns: []
  };
}

type ApiEvidenceCandidate = {
  text: string;
  evidenceId: string;
  kind: SpecialistDraftAnswer["claims"][number]["kind"];
  authority: SpecialistDraftAnswer["claims"][number]["authority"];
  score: number;
  fieldName?: string;
  method?: string;
  path?: string;
};

function expandApiSemanticFocusTerms(query: string, caseFrame: SupportCaseFrame): string[] {
  const raw = `${query} ${caseFrame.goal} ${caseFrame.object} ${caseFrame.symptom}`.toLowerCase();
  const expanded = new Set<string>(collectFocusTerms(query, caseFrame));
  const add = (values: string[]) => values.forEach((value) => expanded.add(value));

  if (/(标识|id|uuid|identifier|唯一)/i.test(raw)) add(["标识", "id", "uuid", "identifier", "项目id", "属性uuid"]);
  if (/(负责人|成员|owner|assignee|user|用户)/i.test(raw)) add(["负责人", "成员", "member", "user", "owner", "assignee", "uuid", "name", "avatar"]);
  if (/(选项|option|options)/i.test(raw)) add(["选项", "option", "options", "field/options", "属性选项"]);
  if (/(项目|project)/i.test(raw)) add(["项目", "project", "projects", "项目id", "项目列表"]);
  if (/(状态|status)/i.test(raw)) add(["状态", "status"]);
  if (/(评论|comment)/i.test(raw)) add(["评论", "comment"]);
  if (/(scope|权限|授权|oauth|token)/i.test(raw)) add(["scope", "权限", "授权", "oauth", "token"]);

  return uniqueStrings([...expanded], 32);
}

function extractApiOperationSignature(reference: SearchReference): { method?: string; path?: string } {
  const snippet = String(reference.snippet ?? "");
  const jsxMatch = snippet.match(/method=\{"([a-z]+)"\}\s+path=\{"([^"]+)"\}/i);
  if (jsxMatch) {
    return {
      method: jsxMatch[1].toUpperCase(),
      path: jsxMatch[2]
    };
  }
  const plainMatch = snippet.match(/\b(GET|POST|PUT|PATCH|DELETE)\s+([/A-Za-z0-9._:-]+)/);
  if (plainMatch) {
    return {
      method: plainMatch[1].toUpperCase(),
      path: plainMatch[2]
    };
  }
  return {};
}

function buildApiExtractionSource(reference: SearchReference): string {
  const snippet = String(reference.snippet ?? "");
  const resolvedPath = resolveLocalDocsMirrorPath(reference);
  if (!resolvedPath) return snippet;
  try {
    const raw = fs.readFileSync(resolvedPath, "utf8");
    return `${snippet}\n${raw}`;
  } catch {
    return snippet;
  }
}

function extractApiFieldCandidates(reference: SearchReference, language: "zh" | "en"): ApiEvidenceCandidate[] {
  const candidates: ApiEvidenceCandidate[] = [];
  const source = buildApiExtractionSource(reference);
  for (const match of source.matchAll(/name=\{"([^"]+)"\}[\s\S]{0,1200}?(?:"description":"|description=\{")([^"}]+)/g)) {
    const fieldName = String(match[1] ?? "").trim();
    const description = String(match[2] ?? "").trim();
    if (!fieldName || !description) continue;
    candidates.push({
      text:
        language === "zh"
          ? `该接口的字段 ${fieldName} 在文档中说明为“${description}”。`
          : `The documentation describes field ${fieldName} as "${description}".`,
      evidenceId: reference.documentId,
      kind: "verified_fact",
      authority: "canonical",
      score: 0,
      fieldName
    });
  }
  return candidates;
}

function extractApiNarrativeCandidates(reference: SearchReference, language: "zh" | "en"): ApiEvidenceCandidate[] {
  const candidates: ApiEvidenceCandidate[] = [];
  const rawSnippet = String(reference.snippet ?? "").replace(/\s+/g, " ").trim();
  const fragments = rawSnippet
    .split(/\s+-\s+|。|\.\s+/)
    .map((item) => item.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .filter((item) => item.length >= 8 && item.length <= 180);

  for (const fragment of fragments) {
    if (!/(返回包含|支持|获取.+列表|returns?|includes?|supports?)/i.test(fragment)) continue;
    candidates.push({
      text:
        language === "zh"
          ? `《${reference.title}》说明：${fragment.replace(/^[-•]\s*/, "")}。`
          : `"${reference.title}" states: ${fragment.replace(/^[-•]\s*/, "")}.`,
      evidenceId: reference.documentId,
      kind: "verified_fact",
      authority: "canonical",
      score: 0
    });
  }
  return candidates;
}

function extractApiRequestParamNames(reference: SearchReference): string[] {
  const source = buildApiExtractionSource(reference);
  return uniqueStrings(
    [
      ...[...source.matchAll(/param=\{\{"name":"([^"]+)"/g)].map((match) => String(match[1] ?? "").trim()),
      ...[...source.matchAll(/name=\{"([^"]+)"\}[\s\S]{0,400}?required=\{true\}/g)].map((match) => String(match[1] ?? "").trim())
    ],
    6
  );
}

function scoreApiEvidenceCandidate(candidate: ApiEvidenceCandidate, focusTerms: string[], reference: SearchReference, primaryBoost: number): number {
  const haystack = `${candidate.text} ${candidate.fieldName ?? ""} ${candidate.method ?? ""} ${candidate.path ?? ""} ${reference.title} ${reference.headingPath ?? ""} ${reference.path ?? ""}`.toLowerCase();
  let score = primaryBoost + Math.round(reference.score * 10);
  const wantsIdentifier = focusTerms.some((term) => /标识|id|uuid|identifier/i.test(term));
  const wantsProject = focusTerms.some((term) => /项目|project/i.test(term));
  const wantsMember = focusTerms.some((term) => /负责人|成员|member|user|owner|assignee/i.test(term));
  for (const term of focusTerms) {
    if (!term) continue;
    const normalized = term.toLowerCase();
    if (haystack.includes(normalized)) score += normalized.length >= 4 ? 7 : 4;
  }
  if (candidate.fieldName && /^(id|uuid)$/i.test(candidate.fieldName) && wantsIdentifier) {
    score += 18;
  }
  if (wantsProject && /项目|project/i.test(candidate.text)) score += 12;
  if (wantsMember && /负责人|成员|member|user|owner|assignee/i.test(candidate.text)) score += 12;
  if (wantsProject && /成员|member|user|owner|assignee/i.test(candidate.text)) score -= 8;
  if (wantsMember && /项目|project/i.test(candidate.text) && !/成员|member|user|owner|assignee/i.test(candidate.text)) score -= 6;
  if (/(返回包含|returns?)/i.test(candidate.text)) score += 4;
  if (candidate.method && candidate.path) score += 6;
  return score;
}

function recoverEvidenceAnchoredApiDraft(input: {
  language: "zh" | "en";
  query: string;
  draft: SpecialistDraftAnswer;
  evidenceBundle: SupportEvidenceBundle;
  route: SupportQuestionRoute;
  caseFrame: SupportCaseFrame;
}): SpecialistDraftAnswer | null {
  if (input.route.specialist_agent !== "api-specialist") return null;
  if (hasGroundedDraftClaims(input.draft)) return null;

  const ranked = [...input.evidenceBundle.primary, ...input.evidenceBundle.supplemental].filter(
    (reference) => reference.authority === "canonical_visible"
  );
  if (!ranked.length) return null;

  const focusTerms = expandApiSemanticFocusTerms(input.query, input.caseFrame);
  const wantsIdentifier = focusTerms.some((term) => /标识|id|uuid|identifier/i.test(term));
  const scoredClaims: ApiEvidenceCandidate[] = [];
  let topOperationMethod = "";
  let topOperationPath = "";
  let topOperationScore = -1;
  let requiredParams: string[] = [];

  ranked.forEach((reference, index) => {
    const primaryBoost = index < input.evidenceBundle.primary.length ? 24 : 10;
    const operation = extractApiOperationSignature(reference);
    if (operation.method && operation.path) {
      const operationCandidate: ApiEvidenceCandidate = {
        text:
          input.language === "zh"
            ? `《${reference.title}》文档给出的接口是 ${operation.method} ${operation.path}。`
            : `The documented operation in "${reference.title}" is ${operation.method} ${operation.path}.`,
        evidenceId: reference.documentId,
        kind: "verified_fact",
        authority: "canonical",
        score: 0,
        method: operation.method,
        path: operation.path
      };
      operationCandidate.score = scoreApiEvidenceCandidate(operationCandidate, focusTerms, reference, primaryBoost);
      scoredClaims.push(operationCandidate);
      if (operationCandidate.score > topOperationScore) {
        topOperationMethod = operation.method;
        topOperationPath = operation.path;
        topOperationScore = operationCandidate.score;
        requiredParams = extractApiRequestParamNames(reference);
      }
    }

    extractApiFieldCandidates(reference, input.language).forEach((candidate) => {
      candidate.score = scoreApiEvidenceCandidate(candidate, focusTerms, reference, primaryBoost);
      scoredClaims.push(candidate);
    });
    extractApiNarrativeCandidates(reference, input.language).forEach((candidate) => {
      candidate.score = scoreApiEvidenceCandidate(candidate, focusTerms, reference, primaryBoost);
      scoredClaims.push(candidate);
    });
  });

  const selectedClaims = scoredClaims
    .sort((a, b) => {
      const aIdentifierBoost =
        wantsIdentifier && /字段 (?:id|uuid)|field (?:id|uuid)|项目id|属性uuid/i.test(a.text) ? 50 : 0;
      const bIdentifierBoost =
        wantsIdentifier && /字段 (?:id|uuid)|field (?:id|uuid)|项目id|属性uuid/i.test(b.text) ? 50 : 0;
      return b.score + bIdentifierBoost - (a.score + aIdentifierBoost);
    })
    .filter((candidate, index, all) => all.findIndex((item) => item.text === candidate.text) === index)
    .slice(0, 3)
    .map((candidate) => ({
      text: candidate.text,
      kind: candidate.kind,
      evidence_ids: [candidate.evidenceId],
      authority: candidate.authority
    }));

  if (!selectedClaims.length) return null;
  const anchorEvidenceId = selectedClaims[0]?.evidence_ids[0];
  const identifierClaim = wantsIdentifier
    ? selectedClaims.find((claim) => /字段 (?:id|uuid)|field (?:id|uuid)|项目id|属性uuid/i.test(claim.text))
    : undefined;
  const coherentClaims = selectedClaims
    .sort((a, b) => {
      const aAnchor = Number(a.evidence_ids[0] === anchorEvidenceId);
      const bAnchor = Number(b.evidence_ids[0] === anchorEvidenceId);
      const aIdentifier = Number(identifierClaim?.text === a.text);
      const bIdentifier = Number(identifierClaim?.text === b.text);
      return bIdentifier - aIdentifier || bAnchor - aAnchor;
    })
    .slice(0, 3);

  const directAnswerLead = coherentClaims[0]?.text ?? "";
  const operationMethod = topOperationMethod || undefined;
  const operationPath = topOperationPath || undefined;
  const operationLabel = operationMethod && operationPath ? `${operationMethod} ${operationPath}` : "";
  const directAnswer =
    input.language === "zh"
      ? operationLabel
        ? `${directAnswerLead}${directAnswerLead.includes(operationLabel) ? "" : ` 对应接口是 ${operationLabel}。`}`.trim()
        : directAnswerLead
      : operationLabel
      ? `${directAnswerLead}${directAnswerLead.includes(operationLabel) ? "" : ` The endpoint is ${operationLabel}.`}`.trim()
      : directAnswerLead;

  const nextActions =
    input.language === "zh"
      ? uniqueStrings(
          [
            operationLabel ? `优先按 ${operationLabel} 这个接口核对调用。` : "",
            requiredParams.length ? `调用前确认必填参数是否已补齐，例如 ${requiredParams.join("、")}。` : ""
          ],
          3
        )
      : uniqueStrings(
          [
            operationLabel ? `Start by checking ${operationLabel}.` : "",
            requiredParams.length ? `Confirm the required inputs are present, for example ${requiredParams.join(", ")}.` : ""
          ],
          3
        );

  const responseFieldClaim = coherentClaims.find((claim) => /字段|field/i.test(claim.text));
  const responseFieldHint = responseFieldClaim?.text.replace(/^.*?(?:字段|field)\s+/i, "").slice(0, 80);

  return {
    ...input.draft,
    render_variant: "api",
    direct_answer: directAnswer,
    claims: coherentClaims,
    next_actions: nextActions,
    unknowns: [],
    api_method: operationMethod,
    api_path: operationPath,
    required_params: requiredParams,
    response_field_hint: responseFieldHint
  };
}

function combineRetrievalQueries(query: string, caseFrame: SupportCaseFrame, orchestrator: SearchOrchestrator): string[] {
  const groupedQueries = [
    ...caseFrame.retrieval_queries,
    ...(caseFrame.query_plan?.object_queries ?? []),
    ...(caseFrame.query_plan?.concept_queries ?? []),
    ...(caseFrame.query_plan?.behavior_queries ?? []),
    buildCompactFocusQuery(query, caseFrame)
  ];
  return uniqueStrings([query, ...groupedQueries], 6).filter(
    (item) => orchestrator.normalizeQuery(item) !== orchestrator.normalizeQuery(query)
  );
}

async function writeSpecialistDraft(input: {
  adapter: OpenClawAdapter;
  route: SupportQuestionRoute;
  language: "zh" | "en";
  query: string;
  caseFrame: SupportCaseFrame;
  evidenceBundle: SupportEvidenceBundle;
  conversationHistory: Array<{ role: "user" | "assistant"; content: string }>;
  runtime?: OpenClawRuntimeContext;
  idempotencyKey: string;
}): Promise<SpecialistDraftAnswer> {
  const specialistInput = {
    contextType: "search" as const,
    language: input.language,
    query: input.query,
    route: input.route,
    caseFrame: input.caseFrame,
    evidenceBundle: input.evidenceBundle,
    conversationHistory: input.conversationHistory
  };
  switch (input.route.specialist_agent) {
    case "api-specialist":
      return input.adapter.writeApiSpecialistAnswer(specialistInput, input.idempotencyKey, input.runtime);
    case "howto-specialist":
      return input.adapter.writeHowToSpecialistAnswer(specialistInput, input.idempotencyKey, input.runtime);
    case "behavior-specialist":
      return input.adapter.writeBehaviorSpecialistAnswer(specialistInput, input.idempotencyKey, input.runtime);
    default:
      return input.adapter.writeTroubleshootingSpecialistAnswer(specialistInput, input.idempotencyKey, input.runtime);
  }
}

function fallbackTriageInsight(language: "zh" | "en", caseFrame: SupportCaseFrame, mode: "ask_user" | "escalate"): TriageSupportInsight {
  if (language === "zh") {
    return {
      direct_answer: mode === "escalate" ? "现有证据更适合升级给研发处理。" : "当前还缺少一个关键信息，建议先向客户追问。",
      recommended_action: mode,
      customer_reply:
        mode === "escalate"
          ? "感谢反馈。该问题需要更深入的技术分析，我已升级给研发团队继续处理。"
          : `为继续处理，请先补充：${caseFrame.missing_critical_info[0] ?? "最关键的一条上下文"}`,
      customer_reply_policy: mode === "escalate" ? "no_send" : "send_now",
      support_summary: mode === "escalate" ? "Escalate to R&D with current evidence." : "Ask one targeted follow-up question.",
      verified_evidence: [],
      risk_flags: mode === "escalate" ? ["needs_rnd"] : [],
      missing_info: caseFrame.missing_critical_info.slice(0, 3),
      verifier_verdict: mode === "escalate" ? "partial" : "unsupported"
    };
  }

  return {
    direct_answer:
      mode === "escalate"
        ? "The current evidence points to an engineering-level issue that should be escalated."
        : "One critical detail is still missing, so ask the customer a single targeted follow-up question.",
    recommended_action: mode,
    customer_reply:
      mode === "escalate"
        ? "Thanks for the report. This issue needs deeper technical investigation, so I have escalated it to our engineering team."
        : `To continue, please share: ${caseFrame.missing_critical_info[0] ?? "the single most important missing detail"}.`,
    customer_reply_policy: mode === "escalate" ? "no_send" : "send_now",
    support_summary: mode === "escalate" ? "Escalate to R&D with current evidence." : "Ask one targeted follow-up question.",
    verified_evidence: [],
    risk_flags: mode === "escalate" ? ["needs_rnd"] : [],
    missing_info: caseFrame.missing_critical_info.slice(0, 3),
    verifier_verdict: mode === "escalate" ? "partial" : "unsupported"
  };
}

export async function runSupportSearchAgent(input: {
  query: string;
  language: "zh" | "en";
  currentRound: number;
  conversationHistory: Array<{ role: "user" | "assistant"; content: string }>;
  adapter: OpenClawAdapter;
  runtime?: OpenClawRuntimeContext;
  attachments?: string[];
  idempotencyKey: string;
}): Promise<{
  result: SearchModeResult;
  caseFrame: SupportCaseFrame;
  evidenceBundle: SupportEvidenceBundle;
  verification: SupportVerificationResult;
  stageTimings: SupportAgentStageTimings;
}> {
  const runStartedAt = performance.now();
  const orchestrator = new SearchOrchestrator(input.adapter);
  const allowMultiPassRetrieval = input.runtime?.allowMultiPassRetrieval !== false;
  const allowRefinement = input.runtime?.allowRefinement !== false;

  const plannerStartedAt = performance.now();
  const routerRuntime = withStageRuntime(buildStageRuntime(input.runtime, 32000, 5000, 12000), "router", `${input.idempotencyKey}:router`);
  const routeResult = await input.adapter
    .routeSupportQuestion(
      {
        contextType: "search",
        language: input.language,
        query: input.query,
        conversationHistory: input.conversationHistory
      },
      `${input.idempotencyKey}:route`,
      routerRuntime
    )
    .then((value) => ({ route: value, timing: stageTiming("completed", elapsedMs(plannerStartedAt)) }))
    .catch(() => ({ route: fallbackQuestionRoute(input.query), timing: stageTiming("fallback", elapsedMs(plannerStartedAt)) }));
  const evidencePlannerRuntime = withStageRuntime(
    buildStageRuntime(input.runtime, 26000, 4000, 10000),
    "evidence-planner",
    `${input.idempotencyKey}:evidence-planner`
  );
  const evidencePlanResult = await input.adapter
    .planSupportEvidence(
      {
        contextType: "search",
        language: input.language,
        query: input.query,
        route: routeResult.route,
        conversationHistory: input.conversationHistory
      },
      `${input.idempotencyKey}:evidence-plan`,
      evidencePlannerRuntime
    )
    .then((value) => ({ plan: value }))
    .catch(() => ({ plan: fallbackEvidencePlan(input.query) }));
  const plannerRuntime = withStageRuntime(buildStageRuntime(input.runtime, 22000, 5000, 14000), "planner", `${input.idempotencyKey}:planner`);
  const plannerPromise = input.adapter
    .planSupportCase(
      {
        contextType: "search",
        language: input.language,
        query: input.query,
        conversationHistory: input.conversationHistory
      },
      `${input.idempotencyKey}:plan`,
      plannerRuntime
    )
    .then((value) => ({ value }))
    .catch(() => ({ value: null }));

  const baseQueries = uniqueStrings([input.query], 1);
  const baseEvidenceStartedAt = performance.now();
  const baseEvidencePromise = orchestrator
    .collectEvidence({
      queries: baseQueries,
      idempotencyKey: `${input.idempotencyKey}:evidence`,
      runtime: input.runtime,
      answerLanguage: input.language,
      attachments: input.attachments
    })
    .then((value) => ({
      value,
      timing: stageTiming("completed", elapsedMs(baseEvidenceStartedAt), {
        query_count: baseQueries.length,
        reference_count: value.references.length
      })
    }))
    .catch(() => ({
      value: {
        query: input.query,
        answer: "",
        confidence: 0,
        references: [],
        retrievalStatus: "kb_unavailable" as const,
        unresolvedReasonCode: "KB_RETRIEVAL_UNAVAILABLE" as const,
        resolvedQueries: baseQueries,
        fallbackUsed: true
      },
      timing: stageTiming("fallback", elapsedMs(baseEvidenceStartedAt), {
        query_count: baseQueries.length,
        reference_count: 0
      })
    }));

  const [plannerResult, baseEvidenceResult] = await Promise.all([plannerPromise, baseEvidencePromise]);
  const route = routeResult.route;
  const caseFrame = mergeRouteAndEvidencePlan(plannerResult.value ?? fallbackCaseFrame(input.query), route, evidencePlanResult.plan);
  const stageBudget = normalizeStageBudget({
    route,
    plan: evidencePlanResult.plan
  });
  const baseEvidence = baseEvidenceResult.value;
  const additionalQueries = combineRetrievalQueries(input.query, caseFrame, orchestrator);
  const additionalStartedAt = performance.now();
  const additionalEvidence =
    allowMultiPassRetrieval &&
    stageBudget.retrieval_rounds > 1 &&
    additionalQueries.length > 0 &&
    hasEnoughBudget(input.runtime, 9000)
      ? await orchestrator
          .collectEvidence({
            queries: additionalQueries,
            idempotencyKey: `${input.idempotencyKey}:evidence:extra`,
            runtime: input.runtime,
            answerLanguage: input.language,
            attachments: input.attachments
          })
          .catch(() => null)
      : null;
  const preRefinedEvidence = additionalEvidence
    ? orchestrator.combineEvidenceCollections([baseEvidence, additionalEvidence])
    : baseEvidence;
  const refinementEvidence =
    allowRefinement &&
    stageBudget.retrieval_rounds > 1 &&
    stageBudget.allow_refinement &&
    preRefinedEvidence.references.length > 0 &&
    hasEnoughBudget(input.runtime, 7000)
      ? await orchestrator
          .refineEvidence({
            baseQuery: input.query,
            references: preRefinedEvidence.references,
            idempotencyKey: `${input.idempotencyKey}:evidence`,
            runtime: input.runtime,
            answerLanguage: input.language,
            attachments: input.attachments
          })
          .catch(() => null)
      : null;
  const evidenceCollection =
    refinementEvidence && refinementEvidence.references.length > 0
      ? orchestrator.combineEvidenceCollections([preRefinedEvidence, refinementEvidence])
      : preRefinedEvidence;
  const secondRoundQueryCount = (additionalEvidence ? additionalQueries.length : 0) + (refinementEvidence?.resolvedQueries.length ?? 0);
  const additionalTiming =
    secondRoundQueryCount > 0
      ? stageTiming("completed", elapsedMs(additionalStartedAt), {
          query_count: secondRoundQueryCount,
          reference_count: evidenceCollection.references.length
        })
      : skippedStageTiming();

  const selectionRuntime = withStageRuntime(
    buildStageRuntime(input.runtime, 22000, 4000, 12000),
    "support-evidence-selector",
    `${input.idempotencyKey}:evidence-selector`
  );
  const evidenceSelection =
    evidenceCollection.references.length > 0 && hasEnoughBudget(input.runtime, 5000)
      ? await input.adapter
          .selectSupportEvidence(
            {
              contextType: "search",
              language: input.language,
              query: input.query,
              caseFrame,
              references: evidenceCollection.references
            },
            `${input.idempotencyKey}:evidence-selector`,
            selectionRuntime
          )
          .catch(() => fallbackEvidenceSelection(evidenceCollection.references, input.query, caseFrame))
      : fallbackEvidenceSelection(evidenceCollection.references, input.query, caseFrame);

  const evidenceBundle = buildEvidenceBundle({
    references: evidenceCollection.references,
    confidence: evidenceCollection.confidence,
    fallbackUsed: evidenceCollection.fallbackUsed,
    resolvedQueries: evidenceCollection.resolvedQueries,
    caseFrame,
    query: input.query,
    selection: evidenceSelection
  });
  const shouldSkipSpecialist =
    stageBudget.specialist_budget === 0 ||
    (stageBudget.stop_after_grounded_evidence &&
      evidenceBundle.primary.length > 0 &&
      evidenceBundle.confidence >= env.AI_SEARCH_ANSWER_CONFIDENCE_THRESHOLD);

  const writerStartedAt = performance.now();
  const specialistRuntime = withStageRuntime(
    buildStageRuntime(input.runtime, 12000, 5000, 18000),
    route.specialist_agent,
    `${input.idempotencyKey}:${route.specialist_agent}`
  );
  const specialistResult = !shouldSkipSpecialist && hasEnoughBudget(input.runtime, 6000)
    ? await writeSpecialistDraft({
        adapter: input.adapter,
        route,
        language: input.language,
        query: input.query,
        caseFrame,
        evidenceBundle,
        conversationHistory: input.conversationHistory,
        runtime: specialistRuntime,
        idempotencyKey: `${input.idempotencyKey}:specialist`
      })
        .then((value) => ({ value, timing: stageTiming("completed", elapsedMs(writerStartedAt)) }))
        .catch(() => ({ value: null, timing: stageTiming("fallback", elapsedMs(writerStartedAt)) }))
    : { value: null, timing: stageTiming("skipped", elapsedMs(writerStartedAt)) };
  const genericWriterStartedAt = performance.now();
  const genericWriterRuntime = withExplicitStageRuntime({
    runtime: buildStageRuntime(input.runtime, 9000, 4000, 12000),
    stage: "support-writer",
    sessionSeed: `${input.idempotencyKey}:support-writer`,
    agentId: resolveStageSpecificAgent(route.specialist_agent).agentId,
    model: resolveStageSpecificAgent(route.specialist_agent).model
  });
  const genericWriterResult =
    evidenceBundle.primary.length > 0 &&
    hasEnoughBudget(input.runtime, 5000) &&
    (!specialistResult.value || !hasGroundedDraftClaims(specialistResult.value))
      ? await input.adapter
          .writeSupportAnswer(
            {
              contextType: "search",
              language: input.language,
              query: input.query,
              caseFrame,
              evidenceBundle,
              conversationHistory: input.conversationHistory
            },
            `${input.idempotencyKey}:support-writer`,
            genericWriterRuntime
          )
          .then((value) => {
            const routedDraft: SpecialistDraftAnswer = {
              question_type: route.question_type,
              render_variant:
                route.specialist_agent === "api-specialist"
                  ? ("api" as const)
                  : route.specialist_agent === "howto-specialist"
                  ? ("how_to" as const)
                  : route.specialist_agent === "behavior-specialist"
                  ? ("behavior" as const)
                  : ("troubleshooting" as const),
              ...value
            };
            return {
              value: routedDraft,
              timing: stageTiming("completed", elapsedMs(genericWriterStartedAt))
            };
          })
          .catch(() => ({ value: null, timing: stageTiming("fallback", elapsedMs(genericWriterStartedAt)) }))
      : { value: null, timing: stageTiming("skipped", elapsedMs(genericWriterStartedAt)) };
  const rawDraftSupportAnswer =
    specialistResult.value ??
    genericWriterResult.value ??
    fallbackSpecialistDraftAnswer({
      language: input.language,
      route,
      query: input.query,
      evidenceBundle,
      missingInfo: caseFrame.missing_critical_info
    });
  const draftSupportAnswer =
    recoverEvidenceAnchoredApiDraft({
      language: input.language,
      query: input.query,
      draft: rawDraftSupportAnswer,
      evidenceBundle,
      route,
      caseFrame
    }) ??
    recoverEvidenceAnchoredHowToDraft({
      language: input.language,
      query: input.query,
      draft: rawDraftSupportAnswer,
      evidenceBundle,
      route
    }) ??
    rawDraftSupportAnswer;
  const draftClaimsWithEvidence = draftSupportAnswer.claims.filter(
    (claim: SpecialistDraftAnswer["claims"][number]) =>
      claim.evidence_ids.length > 0 && (claim.kind === "verified_fact" || claim.kind === "grounded_inference")
  );
  const draftClaimsWithoutEvidence = draftSupportAnswer.claims.filter(
    (claim: SpecialistDraftAnswer["claims"][number]) =>
      claim.evidence_ids.length === 0 && (claim.kind === "verified_fact" || claim.kind === "grounded_inference")
  );
  const writerBoundVerification = sanitizeVerification({
    verification: {
      verdict:
        draftClaimsWithEvidence.length === 0
          ? "unsupported"
          : draftClaimsWithoutEvidence.length === 0 && draftSupportAnswer.unknowns.length === 0
          ? "verified"
          : "partial",
      summary:
        input.language === "zh"
          ? "已根据回答草稿中的证据引用补充文档绑定。"
          : "Documentation bindings were recovered from the draft answer evidence ids.",
      unsupported_claims: draftClaimsWithoutEvidence.map((claim: SpecialistDraftAnswer["claims"][number]) => claim.text),
      missing_info: [],
      verified_citation_ids: uniqueStrings(
        draftSupportAnswer.claims.flatMap((claim: SpecialistDraftAnswer["claims"][number]) => claim.evidence_ids),
        6
      ),
      display_citation_ids: uniqueStrings(
        draftSupportAnswer.claims.flatMap((claim: SpecialistDraftAnswer["claims"][number]) => claim.evidence_ids),
        3
      ),
      verified_claims: draftSupportAnswer.claims
        .filter((claim: SpecialistDraftAnswer["claims"][number]) => claim.evidence_ids.length > 0)
        .map((claim: SpecialistDraftAnswer["claims"][number]) => claim.text),
      claim_to_citation_map: draftSupportAnswer.claims.map((claim: SpecialistDraftAnswer["claims"][number]) => ({
        text: claim.text,
        kind: claim.kind,
        verdict:
          claim.evidence_ids.length === 0
            ? ("unsupported" as const)
            : claim.kind === "grounded_inference"
            ? ("supported_inference" as const)
            : ("verified" as const),
        citation_ids: claim.evidence_ids
      }))
    },
    evidenceBundle
  });
  const useFastAgentPath =
    shouldUseFastAgentPath({
      route,
      caseFrame,
      evidenceBundle,
      draft: draftSupportAnswer,
      currentRound: input.currentRound
    }) && hasEnoughBudget(input.runtime, 2500);

  const verifierStartedAt = performance.now();
  const verificationResult = useFastAgentPath
    ? { value: writerBoundVerification, timing: stageTiming("skipped", elapsedMs(verifierStartedAt)) }
    : await (async () => {
        const judgeRuntime = withStageRuntime(
          buildStageRuntime(input.runtime, 5000, 6000, 25000),
          "evidence-judge",
          `${input.idempotencyKey}:evidence-judge`
        );
        return hasEnoughBudget(input.runtime, 7000)
          ? input.adapter
              .judgeSupportAnswer(
                {
                  contextType: "search",
                  language: input.language,
                  query: input.query,
                  caseFrame,
                  evidenceBundle,
                  draftSupportAnswer
                },
                `${input.idempotencyKey}:judge`,
                judgeRuntime
              )
              .then((value) => ({ value, timing: stageTiming("completed", elapsedMs(verifierStartedAt)) }))
              .catch(() => ({ value: null, timing: stageTiming("fallback", elapsedMs(verifierStartedAt)) }))
          : { value: null, timing: stageTiming("skipped", elapsedMs(verifierStartedAt)) };
      })();
  const verification =
    verificationResult.value ??
    fallbackVerification(
      input.language,
      evidenceCollection.references.length ? "partial" : "unsupported",
      caseFrame.missing_critical_info
    );
  const sanitizedVerification = sanitizeVerification({
    verification,
    evidenceBundle
  });
  const supportedCoreClaims = supportedVerificationClaims(sanitizedVerification);
  const unsupportedCore = sanitizedVerification.unsupported_claims.some(
    (claim: string) =>
      overlapsUnsupportedClaim(draftSupportAnswer.direct_answer, [claim]) ||
      draftSupportAnswer.claims.some(
        (draftClaim: SpecialistDraftAnswer["claims"][number]) =>
          draftClaim.kind !== "operational_advice" && overlapsUnsupportedClaim(draftClaim.text, [claim])
      )
  );
  const effectiveVerification =
    sanitizedVerification.verdict === "partial" &&
    supportedCoreClaims.length > 0 &&
    sanitizedVerification.unsupported_claims.length > 0 &&
    !unsupportedCore
      ? {
          ...sanitizedVerification,
          verdict: "verified" as const,
          unsupported_claims: [],
          missing_info: []
        }
      : sanitizedVerification;

  const citationBinderRuntime = withStageRuntime(
    buildStageRuntime(input.runtime, 3000, 5000, 16000),
    "support-citation-binder",
    `${input.idempotencyKey}:support-citation-binder`
  );
  const reboundVerification =
    useFastAgentPath || !draftSupportAnswer.claims.length || !evidenceBundle.primary.length || !hasEnoughBudget(input.runtime, 5000)
      ? null
      : await input.adapter
          .bindSupportCitations(
            {
              contextType: "search",
              language: input.language,
              query: input.query,
              caseFrame,
              evidenceBundle,
              draftSupportAnswer
            },
            `${input.idempotencyKey}:support-citation-binder`,
            citationBinderRuntime
          )
          .catch(() => null);
  const reboundSanitized = reboundVerification
    ? sanitizeVerification({
        verification: reboundVerification,
        evidenceBundle
      })
    : null;
  const preselectedVerification = pickBestVerificationCandidate({
    query: input.query,
    caseFrame,
    evidenceBundle,
    primary: effectiveVerification,
    rebound: reboundSanitized,
    writerBound: writerBoundVerification
  });

  const displayCitationSelectorRuntime = withStageRuntime(
    buildStageRuntime(input.runtime, 2500, 4000, 14000),
    useFastAgentPath ? "support-citation-selector" : "citation-curator",
    `${input.idempotencyKey}:${useFastAgentPath ? "support-citation-selector" : "citation-curator"}`
  );
  const selectedDisplayCitations =
    supportedVerificationClaims(preselectedVerification).length > 0 && hasEnoughBudget(input.runtime, 4500)
      ? await (useFastAgentPath
          ? input.adapter.selectDisplayCitations(
              {
                contextType: "search",
                language: input.language,
                query: input.query,
                caseFrame,
                evidenceBundle,
                supportedClaims: supportedVerificationClaims(preselectedVerification)
              },
              `${input.idempotencyKey}:support-citation-selector`,
              displayCitationSelectorRuntime
            )
          : input.adapter.curateSupportCitations(
              {
                contextType: "search",
                language: input.language,
                query: input.query,
                caseFrame,
                evidenceBundle,
                supportedClaims: supportedVerificationClaims(preselectedVerification)
              },
              `${input.idempotencyKey}:citation-curator`,
              displayCitationSelectorRuntime
            ))
          .catch(() => null)
      : null;

  const finalVerification = sanitizeVerification({
    verification: selectedDisplayCitations
      ? {
          ...preselectedVerification,
          display_citation_ids: selectedDisplayCitations.display_citation_ids
        }
      : preselectedVerification,
    evidenceBundle
  });

  const missingInfo = uniqueStrings([...finalVerification.missing_info, ...caseFrame.missing_critical_info], 3);
  const mode = resolveSupportMode({
    verification: finalVerification,
    references: evidenceCollection.references,
    currentRound: input.currentRound + 1,
    missingInfo
  });
  const answerComposerRuntime = withStageRuntime(
    buildStageRuntime(input.runtime, 1500, 4000, 14000),
    "answer-composer",
    `${input.idempotencyKey}:answer-composer`
  );
  const shouldComposeCustomerAnswer =
    !useFastAgentPath &&
    hasEnoughBudget(input.runtime, 4500) &&
    (mode === "clarification" ||
      mode === "handoff" ||
      (supportedVerificationClaims(finalVerification).length > 0 && (mode === "grounded" || mode === "partial")));
  const composedSupportAnswer =
    shouldComposeCustomerAnswer
      ? await input.adapter
          .composeCustomerAnswer(
            {
              contextType: "search",
              language: input.language,
              query: input.query,
              mode,
              route,
              caseFrame,
              draftSupportAnswer,
              supportedClaims: supportedVerificationClaims(finalVerification),
              nextActions: filterUnsupported(draftSupportAnswer.next_actions, finalVerification.unsupported_claims),
              unknowns: uniqueStrings([...draftSupportAnswer.unknowns, ...missingInfo], 4)
            },
            `${input.idempotencyKey}:answer-composer`,
            answerComposerRuntime
          )
          .catch(() => null)
      : null;
  const supportAnswer = buildSupportAnswerFromDraft({
    language: input.language,
    mode,
    route,
    draft: draftSupportAnswer,
    verification: {
      ...finalVerification,
      unsupported_claims: finalVerification.unsupported_claims
    },
    missingInfo,
    composed: composedSupportAnswer
  });
  const structuredAnswer = buildStructuredAnswer(supportAnswer, finalVerification);
  const citations = buildCitations({
    references: [...evidenceBundle.primary, ...evidenceBundle.supplemental],
    verification: finalVerification
  });

  const handoffAfterClarificationExhausted =
    mode === "handoff" && missingInfo.length > 0 && input.currentRound + 1 >= env.AI_SEARCH_MAX_CLARIFICATION_ROUNDS;
  const clarificationRound =
    mode === "clarification"
      ? input.currentRound + 1
      : handoffAfterClarificationExhausted
      ? env.AI_SEARCH_MAX_CLARIFICATION_ROUNDS
      : 0;
  const state: SearchDialogState =
    mode === "clarification"
      ? input.currentRound > 0
        ? "CLARIFICATION_IN_PROGRESS"
        : "CLARIFICATION_REQUIRED"
      : mode === "handoff"
      ? "TICKET_HANDOFF_RECOMMENDED"
      : "GROUNDABLE_ANSWER_READY";
  const unresolvedReasonCode =
    evidenceCollection.retrievalStatus === "kb_unavailable"
      ? "KB_RETRIEVAL_UNAVAILABLE"
      : !evidenceCollection.references.length
      ? "NO_MATCHING_KB"
      : finalVerification.verdict === "verified"
      ? null
      : "LOW_CONFIDENCE";
  const stageTimings: SupportAgentStageTimings = {
    total_ms: elapsedMs(runStartedAt),
    planner: routeResult.timing,
    retrieval_base: baseEvidenceResult.timing,
    retrieval_extra: additionalTiming,
    writer: specialistResult.timing,
    verifier: verificationResult.timing
  };

  return {
    caseFrame,
    evidenceBundle,
    verification: finalVerification,
    stageTimings,
    result: {
      session_id: "",
      answer: supportAnswer.direct_answer,
      answer_language: input.language,
      case_frame: caseFrame,
      support_answer: supportAnswer,
      verification: finalVerification,
      structured_answer: structuredAnswer,
      confidence: evidenceCollection.confidence,
      suggested_next_step: mode === "grounded" ? "self_serve" : "submit_ticket",
      retrieval_status:
        evidenceCollection.retrievalStatus === "kb_unavailable"
          ? "kb_unavailable"
          : evidenceCollection.references.length
          ? "grounded"
          : "no_results",
      unresolved_reason_code: unresolvedReasonCode,
      references: [...evidenceBundle.primary, ...evidenceBundle.supplemental],
      citations,
      state,
      clarification_round: clarificationRound,
      show_create_ticket_now: mode === "handoff",
      follow_up_question: mode === "clarification" ? missingInfo[0] ?? supportAnswer.still_need_to_confirm[0] ?? null : null,
      internal_diagnostics: {
        route,
        evidence_plan: evidencePlanResult.plan,
        stage_budget: stageBudget,
        retrieval_queries_used: uniqueStrings([input.query, ...additionalQueries], 8),
        retrieval_queries_refined: refinementEvidence?.resolvedQueries ?? [],
        claim_graph: buildClaimGraph(finalVerification),
        specialist_skipped: shouldSkipSpecialist,
        specialists_used: shouldSkipSpecialist ? [] : [route.specialist_agent],
        evidence_sources: uniqueStrings(
          evidenceCollection.references.map((item) => item.sourceType ?? "unknown"),
          6
        ),
        fast_path_used: useFastAgentPath,
        confirmed_facts: uniqueStrings(draftSupportAnswer.confirmed_facts ?? [], 4),
        orchestration_trace: buildOrchestrationTrace({
          route,
          specialistSkipped: shouldSkipSpecialist
        })
      }
    }
  };
}

export async function runSupportTriageAgent(input: {
  query: string;
  language: "zh" | "en";
  adapter: OpenClawAdapter;
  runtime?: OpenClawRuntimeContext;
  idempotencyKey: string;
  priority: string;
  customerMeta: Record<string, unknown>;
  history: Array<{ author: string; body: string; at: string }>;
  attachments?: string[];
}): Promise<{
  analyzeOutput: OpenClawAnalyzeOutput & Record<string, unknown>;
  caseFrame: SupportCaseFrame;
  evidenceBundle: SupportEvidenceBundle;
  verification: SupportVerificationResult;
  stageTimings: SupportAgentStageTimings;
}> {
  const runStartedAt = performance.now();
  const orchestrator = new SearchOrchestrator(input.adapter);
  const allowMultiPassRetrieval = input.runtime?.allowMultiPassRetrieval !== false;
  const allowRefinement = input.runtime?.allowRefinement !== false;
  const conversationHistory = input.history
    .slice(-6)
    .map((item) => ({ role: "user" as const, content: `${item.author}: ${item.body}` }));

  const plannerStartedAt = performance.now();
  const plannerRuntime = withStageRuntime(buildStageRuntime(input.runtime, 22000, 5000, 14000), "planner", `${input.idempotencyKey}:planner`);
  const plannerPromise = input.adapter
    .planSupportCase(
      {
        contextType: "triage",
        language: input.language,
        query: input.query,
        conversationHistory,
        ticketContext: {
          priority: input.priority,
          customerMeta: input.customerMeta,
          history: input.history
        }
      },
      `${input.idempotencyKey}:plan`,
      plannerRuntime
    )
    .then((value) => ({ value, timing: stageTiming("completed", elapsedMs(plannerStartedAt)) }))
    .catch(() => ({ value: null, timing: stageTiming("fallback", elapsedMs(plannerStartedAt)) }));

  const baseQueries = uniqueStrings([input.query], 1);
  const baseEvidenceStartedAt = performance.now();
  const baseEvidencePromise = orchestrator
    .collectEvidence({
      queries: baseQueries,
      idempotencyKey: `${input.idempotencyKey}:evidence`,
      runtime: input.runtime,
      answerLanguage: input.language,
      attachments: input.attachments
    })
    .then((value) => ({
      value,
      timing: stageTiming("completed", elapsedMs(baseEvidenceStartedAt), {
        query_count: baseQueries.length,
        reference_count: value.references.length
      })
    }));

  const [plannerResult, baseEvidenceResult] = await Promise.all([plannerPromise, baseEvidencePromise]);
  const caseFrame = plannerResult.value ?? fallbackCaseFrame(input.query);
  const baseEvidence = baseEvidenceResult.value;
  const additionalQueries = combineRetrievalQueries(input.query, caseFrame, orchestrator);
  const additionalStartedAt = performance.now();
  const additionalEvidence =
    allowMultiPassRetrieval && additionalQueries.length > 0 && hasEnoughBudget(input.runtime, 9000)
      ? await orchestrator.collectEvidence({
          queries: additionalQueries,
          idempotencyKey: `${input.idempotencyKey}:evidence:extra`,
          runtime: input.runtime,
          answerLanguage: input.language,
          attachments: input.attachments
        })
      : null;
  const preRefinedEvidence = additionalEvidence
    ? orchestrator.combineEvidenceCollections([baseEvidence, additionalEvidence])
    : baseEvidence;
  const refinementEvidence =
    allowRefinement && preRefinedEvidence.references.length > 0 && hasEnoughBudget(input.runtime, 7000)
      ? await orchestrator.refineEvidence({
          baseQuery: input.query,
          references: preRefinedEvidence.references,
          idempotencyKey: `${input.idempotencyKey}:evidence`,
          runtime: input.runtime,
          answerLanguage: input.language,
          attachments: input.attachments
        })
      : null;
  const evidenceCollection =
    refinementEvidence && refinementEvidence.references.length > 0
      ? orchestrator.combineEvidenceCollections([preRefinedEvidence, refinementEvidence])
      : preRefinedEvidence;
  const secondRoundQueryCount = (additionalEvidence ? additionalQueries.length : 0) + (refinementEvidence?.resolvedQueries.length ?? 0);
  const additionalTiming =
    secondRoundQueryCount > 0
      ? stageTiming("completed", elapsedMs(additionalStartedAt), {
          query_count: secondRoundQueryCount,
          reference_count: evidenceCollection.references.length
        })
      : skippedStageTiming();

  const selectionRuntime = withStageRuntime(
    buildStageRuntime(input.runtime, 14000, 3500, 9000),
    "support-evidence-selector",
    `${input.idempotencyKey}:evidence-selector`
  );
  const evidenceSelection =
    evidenceCollection.references.length > 0 && hasEnoughBudget(input.runtime, 4000)
      ? await input.adapter
          .selectSupportEvidence(
            {
              contextType: "triage",
              language: input.language,
              query: input.query,
              caseFrame,
              references: evidenceCollection.references
            },
            `${input.idempotencyKey}:evidence-selector`,
            selectionRuntime
          )
          .catch(() => fallbackEvidenceSelection(evidenceCollection.references, input.query, caseFrame))
      : fallbackEvidenceSelection(evidenceCollection.references, input.query, caseFrame);

  const evidenceBundle = buildEvidenceBundle({
    references: evidenceCollection.references,
    confidence: evidenceCollection.confidence,
    fallbackUsed: evidenceCollection.fallbackUsed,
    resolvedQueries: evidenceCollection.resolvedQueries,
    caseFrame,
    query: input.query,
    selection: evidenceSelection
  });

  const writerStartedAt = performance.now();
  const writerRuntime = withStageRuntime(
    buildStageRuntime(input.runtime, 7000, 4000, 12000),
    "triage-writer",
    `${input.idempotencyKey}:triage-writer`
  );
  const writtenResult = hasEnoughBudget(input.runtime, 5000)
    ? await input.adapter
    .writeTriageInsight(
      {
        contextType: "triage",
        language: input.language,
        query: input.query,
        caseFrame,
        evidenceBundle,
        conversationHistory,
        ticketContext: {
          priority: input.priority,
          customerMeta: input.customerMeta,
          history: input.history
        }
      },
      `${input.idempotencyKey}:write`,
      writerRuntime
    )
    .then((value) => ({ value, timing: stageTiming("completed", elapsedMs(writerStartedAt)) }))
    .catch(() => ({ value: null, timing: stageTiming("fallback", elapsedMs(writerStartedAt)) }))
    : { value: null, timing: stageTiming("skipped", elapsedMs(writerStartedAt)) };
  const written =
    writtenResult.value ??
    fallbackTriageInsight(input.language, caseFrame, evidenceCollection.references.length ? "escalate" : "ask_user");

  const verifierStartedAt = performance.now();
  const verifierRuntime = withStageRuntime(
    buildStageRuntime(input.runtime, 2500, 3500, 9000),
    "triage-verifier",
    `${input.idempotencyKey}:triage-verifier`
  );
  const verificationResult = hasEnoughBudget(input.runtime, 3500)
    ? await input.adapter
    .verifyTriageInsight(
      {
        contextType: "triage",
        language: input.language,
        query: input.query,
        caseFrame,
        evidenceBundle,
        triageInsight: written
      },
      `${input.idempotencyKey}:verify`,
      verifierRuntime
    )
    .then((value) => ({ value, timing: stageTiming("completed", elapsedMs(verifierStartedAt)) }))
    .catch(() => ({ value: null, timing: stageTiming("fallback", elapsedMs(verifierStartedAt)) }))
    : { value: null, timing: stageTiming("skipped", elapsedMs(verifierStartedAt)) };
  const verification =
    verificationResult.value ??
    fallbackVerification(input.language, written.verifier_verdict, caseFrame.missing_critical_info);

  const action =
    written.recommended_action === "resolve" && verification.verdict === "verified" && evidenceCollection.references.length > 0
      ? "resolve"
      : written.recommended_action === "escalate" && verification.verdict !== "unsupported"
      ? "escalate"
      : "ask_user";
  const insight: TriageSupportInsight = {
    ...written,
    recommended_action: action,
    customer_reply_policy: action === "escalate" ? "no_send" : "send_now",
    verifier_verdict: verification.verdict
  };
  const stageTimings: SupportAgentStageTimings = {
    total_ms: elapsedMs(runStartedAt),
    planner: plannerResult.timing,
    retrieval_base: baseEvidenceResult.timing,
    retrieval_extra: additionalTiming,
    writer: writtenResult.timing,
    verifier: verificationResult.timing
  };

  return {
    caseFrame,
    evidenceBundle,
    verification,
    stageTimings,
    analyzeOutput: {
      action,
      confidence: evidenceCollection.confidence,
      reply: insight.customer_reply_policy === "send_now" ? insight.customer_reply : "",
      reasoning_summary: insight.support_summary,
      evidence: insight.verified_evidence.length
        ? insight.verified_evidence
        : uniqueStrings(evidenceBundle.primary.map((item) => item.title), 4),
      risk_flags: insight.risk_flags,
      support_insight: insight,
      verification_summary: verification,
      case_frame: caseFrame,
      evidence_bundle_digest: digestEvidenceBundle(evidenceBundle),
      stage_timings: stageTimings
    }
  };
}
