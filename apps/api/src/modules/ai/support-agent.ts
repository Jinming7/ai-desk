import crypto from "node:crypto";
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
  const useExecutionAgent =
    stage === "router" ||
    stage === "evidence-planner" ||
    stage === "api-specialist" ||
    stage === "howto-specialist" ||
    stage === "behavior-specialist" ||
    stage === "troubleshooting-specialist" ||
    stage === "evidence-judge" ||
    stage === "citation-curator" ||
    stage === "answer-composer" ||
    stage === "planner" ||
    stage === "support-evidence-selector" ||
    stage === "support-writer" ||
    stage === "support-verifier" ||
    stage === "support-citation-binder" ||
    stage === "support-citation-selector" ||
    stage === "support-answer-composer" ||
    stage === "triage-writer" ||
    stage === "triage-verifier";
  const agentId = useExecutionAgent
    ? env.OPENCLAW_AGENT_ID_EXECUTION.trim() || env.OPENCLAW_AGENT_ID.trim() || "main"
    : base.agentId?.trim() || env.OPENCLAW_AGENT_ID_RETRIEVAL.trim() || env.OPENCLAW_AGENT_ID.trim() || "main";
  const model = useExecutionAgent
    ? env.OPENCLAW_AGENT_MODEL_EXECUTION.trim() || env.OPENCLAW_AGENT_MODEL.trim() || undefined
    : base.model?.trim() || env.OPENCLAW_AGENT_MODEL_RETRIEVAL.trim() || env.OPENCLAW_AGENT_MODEL.trim() || undefined;
  return {
    ...base,
    stage,
    agentId,
    model,
    sessionKey: `agent:${agentId}:${sanitizeSessionPart(`${prefix}:${stage}:${sessionSeed}`)}`
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
    missing_critical_info: ["the exact object or scenario you are working with"],
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
    routing_confidence: 0.7
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
    required_doc_kinds: []
  };
}

function mergeRouteAndEvidencePlan(caseFrame: SupportCaseFrame, route: SupportQuestionRoute, plan: SupportEvidencePlan): SupportCaseFrame {
  return {
    ...caseFrame,
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
  const primary = selectedPrimary.length ? selectedPrimary.slice(0, 3) : reranked.slice(0, 3);
  const supplemental = selectedSupplemental.length
    ? selectedSupplemental.slice(0, 5)
    : reranked.filter((item) => !primary.some((primaryRef) => primaryRef.documentId === item.documentId)).slice(0, 5);
  return {
    primary,
    supplemental,
    evidence_gaps: input.caseFrame.missing_critical_info.slice(0, 3),
    confidence: input.confidence,
    fallbackUsed: input.fallbackUsed,
    resolvedQueries: input.resolvedQueries
  };
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
  const focusTerms = collectFocusTerms(query, caseFrame);
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
  const why = uniqueStrings(
    [
      ...(input.composed?.why ?? []),
      ...supportedClaims.filter((claim) => claim.kind === "verified_fact" || claim.kind === "grounded_inference").map((claim) => claim.text)
    ],
    4
  );
  const whatToDoNow = uniqueStrings(
    [
      ...(input.composed?.what_to_do_now ?? []),
      ...filterUnsupported(input.draft.next_actions, input.verification.unsupported_claims)
    ],
    4
  );
  const stillNeedToConfirm = uniqueStrings(
    [...(input.composed?.still_need_to_confirm ?? []), ...input.draft.unknowns, ...input.verification.missing_info, ...input.missingInfo],
    4
  );
  const fallback = fallbackSupportAnswer({
    language: input.language,
    mode: input.mode,
    route: input.route,
    missingInfo: stillNeedToConfirm
  });
  const directAnswer =
    input.mode === "grounded" || input.mode === "partial"
      ? input.composed?.direct_answer?.trim() ||
        buildFallbackDirectAnswerFromSupportedClaims({
          language: input.language,
          mode: input.mode,
          supportedClaims,
          fallback
        })
      : fallback.direct_answer;
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

function combineRetrievalQueries(query: string, caseFrame: SupportCaseFrame, orchestrator: SearchOrchestrator): string[] {
  const groupedQueries = [
    ...(caseFrame.query_plan?.concept_queries ?? []),
    ...(caseFrame.query_plan?.object_queries ?? []),
    ...(caseFrame.query_plan?.behavior_queries ?? []),
    ...caseFrame.retrieval_queries,
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
    }));

  const [plannerResult, baseEvidenceResult] = await Promise.all([plannerPromise, baseEvidencePromise]);
  const route = routeResult.route;
  const caseFrame = mergeRouteAndEvidencePlan(plannerResult.value ?? fallbackCaseFrame(input.query), route, evidencePlanResult.plan);
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

  const writerStartedAt = performance.now();
  const specialistRuntime = withStageRuntime(
    buildStageRuntime(input.runtime, 12000, 5000, 18000),
    route.specialist_agent,
    `${input.idempotencyKey}:${route.specialist_agent}`
  );
  const specialistResult = hasEnoughBudget(input.runtime, 6000)
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
  const draftSupportAnswer =
    specialistResult.value ??
    fallbackSpecialistDraftAnswer({
      language: input.language,
      route,
      query: input.query,
      evidenceBundle,
      missingInfo: caseFrame.missing_critical_info
    });

  const verifierStartedAt = performance.now();
  const judgeRuntime = withStageRuntime(
    buildStageRuntime(input.runtime, 5000, 6000, 25000),
    "evidence-judge",
    `${input.idempotencyKey}:evidence-judge`
  );
  const verificationResult = hasEnoughBudget(input.runtime, 7000)
    ? await input.adapter
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
    !draftSupportAnswer.claims.length || !evidenceBundle.primary.length || !hasEnoughBudget(input.runtime, 5000)
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
  const writerBoundVerification = sanitizeVerification({
    verification: {
      verdict:
        draftSupportAnswer.claims.some((claim: SpecialistDraftAnswer["claims"][number]) => claim.evidence_ids.length > 0)
          ? "partial"
          : "unsupported",
      summary:
        input.language === "zh"
          ? "已根据回答草稿中的证据引用补充文档绑定。"
          : "Documentation bindings were recovered from the draft answer evidence ids.",
      unsupported_claims: draftSupportAnswer.claims
        .filter((claim: SpecialistDraftAnswer["claims"][number]) => claim.evidence_ids.length === 0)
        .map((claim: SpecialistDraftAnswer["claims"][number]) => claim.text),
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
    "citation-curator",
    `${input.idempotencyKey}:citation-curator`
  );
  const selectedDisplayCitations =
    supportedVerificationClaims(preselectedVerification).length > 0 && hasEnoughBudget(input.runtime, 4500)
      ? await input.adapter
          .curateSupportCitations(
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
          )
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
  const composedSupportAnswer =
    (mode === "grounded" || mode === "partial") && supportedVerificationClaims(finalVerification).length > 0 && hasEnoughBudget(input.runtime, 4500)
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
      follow_up_question: mode === "clarification" ? missingInfo[0] ?? supportAnswer.still_need_to_confirm[0] ?? null : null
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
