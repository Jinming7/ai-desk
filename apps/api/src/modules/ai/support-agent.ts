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
  SearchDialogState,
  SearchModeResult,
  SpecialistDraftAnswer,
  StructuredSearchAnswer,
  SupportAnswer,
  SupportAgentStageTiming,
  SupportAgentStageTraceEntry,
  SupportAgentStageTimings,
  SupportCaseFrame,
  SupportEvidenceBundle,
  SupportEvidencePlan,
  SupportEvidenceSelection,
  SupportQuestionRoute,
  SupportVerificationResult,
  TriageSupportInsight
} from "./types.js";
import { resolveSearchReferenceEvidenceId, type SearchReference } from "./types.js";
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

function sanitizeMissingCriticalInfo(input: Array<string | undefined | null>, limit = 3): string[] {
  return uniqueStrings(input, limit);
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

function mergeStageTimings(timings: SupportAgentStageTiming[]): SupportAgentStageTiming {
  if (timings.length === 0) {
    return skippedStageTiming();
  }
  const duration_ms = timings.reduce((sum, item) => sum + item.duration_ms, 0);
  const status: SupportAgentStageTiming["status"] = timings.some((item) => item.status === "fallback")
    ? "fallback"
    : timings.every((item) => item.status === "skipped")
    ? "skipped"
    : "completed";
  const query_count = timings.reduce((sum, item) => sum + (item.query_count ?? 0), 0);
  const reference_count = timings.reduce((sum, item) => sum + (item.reference_count ?? 0), 0);
  return {
    duration_ms,
    status,
    ...(query_count > 0 ? { query_count } : {}),
    ...(reference_count > 0 ? { reference_count } : {})
  };
}

function supportStageErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error ?? "unknown_error");
}

function stageTraceEntry(input: {
  stage: SupportAgentStageTraceEntry["stage"];
  timing: SupportAgentStageTiming;
  runtimeStage?: NonNullable<OpenClawRuntimeContext["stage"]>;
  idempotencyKey?: string;
}): SupportAgentStageTraceEntry {
  const resolved = input.runtimeStage ? resolveStageSpecificAgent(input.runtimeStage) : null;
  return {
    stage: input.stage,
    status: input.timing.status,
    duration_ms: input.timing.duration_ms,
    agent_id: resolved?.agentId,
    model: resolved?.model ?? null,
    idempotency_key: input.idempotencyKey,
    query_count: input.timing.query_count,
    reference_count: input.timing.reference_count
  };
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
  const apiRoute = String(input.route.question_type ?? "").startsWith("api_");
  const rawSpecialistBudget = input.route.specialist_budget ?? 1;
  const specialistBudget = Math.max(0, Math.min(1, Number.isFinite(rawSpecialistBudget) ? rawSpecialistBudget : 1));
  const retrievalFloor = apiRoute && !(input.plan.stop_after_grounded_evidence && specialistBudget === 0) ? 2 : 1;
  const retrievalRounds = Math.max(retrievalFloor, Math.min(2, Number(input.plan.retrieval_rounds ?? 2) || 2));
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

function buildEvidenceBundle(input: {
  references: SearchReference[];
  confidence: number;
  fallbackUsed: boolean;
  resolvedQueries: string[];
  caseFrame: SupportCaseFrame;
  query: string;
  selection?: SupportEvidenceSelection | null;
}): SupportEvidenceBundle {
  const candidateReferences = input.references;
  const byId = new Map(candidateReferences.map((reference) => [resolveSearchReferenceEvidenceId(reference), reference] as const));
  const selectedPrimary =
    input.selection?.primary_ids
      .map((id) => byId.get(id))
      .filter((item): item is SearchReference => Boolean(item)) ?? [];
  const selectedSupplemental =
    input.selection?.supplemental_ids
      .map((id) => byId.get(id))
      .filter(
        (item): item is SearchReference =>
          Boolean(item) &&
          !selectedPrimary.some(
            (primary) => resolveSearchReferenceEvidenceId(primary) === resolveSearchReferenceEvidenceId(item as SearchReference)
          )
      ) ?? [];
  const primary = uniqueStrings(
    [
      ...selectedPrimary.map((item) => resolveSearchReferenceEvidenceId(item)),
      ...candidateReferences.slice(0, 3).map((item) => resolveSearchReferenceEvidenceId(item))
    ],
    3
  )
    .map((id) => byId.get(id))
    .filter((item): item is SearchReference => Boolean(item))
    .map((item) => hydrateReferenceEvidence(item));
  const supplemental = uniqueStrings(
    [
      ...selectedSupplemental.map((item) => resolveSearchReferenceEvidenceId(item)),
      ...candidateReferences
        .filter(
          (item) =>
            !primary.some(
              (primaryRef) => resolveSearchReferenceEvidenceId(primaryRef) === resolveSearchReferenceEvidenceId(item)
            )
        )
        .slice(0, 5)
        .map((item) => resolveSearchReferenceEvidenceId(item))
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
        resolveSearchReferenceEvidenceId(candidate) !== resolveSearchReferenceEvidenceId(item) &&
        canonicalDocsPath(candidate.path) === canonicalPath &&
        String(candidate.headingPath ?? "").toUpperCase() === "ROOT"
    );
    if (companion) ids.push(resolveSearchReferenceEvidenceId(companion));
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
    if (!isReferenceEligibleForCaseFrame(item, caseFrame)) continue;
    const canonicalPath = canonicalDocsPath(item.path);
    if (String(item.headingPath ?? "").toUpperCase() !== "ROOT") continue;
    const companion = references.find(
      (candidate) =>
        resolveSearchReferenceEvidenceId(candidate) !== resolveSearchReferenceEvidenceId(item) &&
        isReferenceEligibleForCaseFrame(candidate, caseFrame) &&
        canonicalDocsPath(candidate.path) === canonicalPath &&
        String(candidate.headingPath ?? "").toUpperCase() !== "ROOT"
    );
    if (companion) ids.push(resolveSearchReferenceEvidenceId(companion));
  }
  return uniqueStrings(ids, 3);
}

function fallbackEvidenceSelection(references: SearchReference[], query: string, caseFrame: SupportCaseFrame): SupportEvidenceSelection {
  const reranked = rerankReferencesForCaseFrame(references, query, caseFrame);
  const candidateReferences = filterReferencesByEvidencePolicy(reranked, caseFrame);
  return {
    primary_ids: candidateReferences.slice(0, 3).map((item) => resolveSearchReferenceEvidenceId(item)),
    supplemental_ids: candidateReferences.slice(3, 6).map((item) => resolveSearchReferenceEvidenceId(item)),
    rejected_ids: reranked
      .filter(
        (item) =>
          !candidateReferences.some(
            (candidate) => resolveSearchReferenceEvidenceId(candidate) === resolveSearchReferenceEvidenceId(item)
          )
      )
      .map((item) => resolveSearchReferenceEvidenceId(item))
  };
}

function canonicalDocsPath(input?: string): string {
  return String(input ?? "")
    .trim()
    .replace(/^i18n\/[^/]+\/docusaurus-plugin-content-docs-open-docs\/current\//i, "open-docs/docs/")
    .replace(/^i18n\/[^/]+\/docusaurus-plugin-content-docs\/current\//i, "docs/");
}

type EvidencePolicy = {
  strict: boolean;
  allowedProductAreas: string[];
  allowedEvidenceKinds: string[];
  allowedDeploymentModels?: string[];
  requiresPermissionSignal?: boolean;
};

function buildEvidencePolicy(caseFrame: SupportCaseFrame): EvidencePolicy | null {
  if (String(caseFrame.question_type ?? "").startsWith("api_")) {
    if (caseFrame.question_type === "api_scope_auth") {
      return {
        strict: true,
        allowedProductAreas: ["openapi"],
        allowedEvidenceKinds: ["api_operation", "capability", "constraint"],
        requiresPermissionSignal: true
      };
    }
    return {
      strict: true,
      allowedProductAreas: ["openapi"],
      allowedEvidenceKinds: ["api_operation"]
    };
  }

  const questionType = String(caseFrame.question_type ?? "");
  const productArea = String(caseFrame.product_area ?? "").toLowerCase();
  const deploymentModel = String(caseFrame.deployment_model ?? "").toLowerCase();
  const deploymentScoped = productArea === "deployment" || deploymentModel === "private_deployment";

  if (deploymentScoped) {
    return {
      strict: true,
      allowedProductAreas: ["deployment"],
      allowedEvidenceKinds:
        questionType === "how_to_product" || questionType === "config_setup"
          ? ["procedure", "troubleshooting", "constraint", "capability"]
          : ["capability", "constraint", "procedure", "troubleshooting"],
      allowedDeploymentModels: ["private_deployment"]
    };
  }

  if (productArea === "integrations") {
    return {
      strict: true,
      allowedProductAreas: ["integrations"],
      allowedEvidenceKinds:
        questionType === "troubleshooting"
          ? ["troubleshooting", "procedure", "constraint", "capability"]
          : ["procedure", "capability", "constraint", "troubleshooting"]
    };
  }

  if (questionType === "how_to_product" || questionType === "config_setup" || questionType === "data_export_reporting") {
    return {
      strict: productArea !== "" && productArea !== "general" && productArea !== "unknown",
      allowedProductAreas: productArea && productArea !== "general" && productArea !== "unknown" ? [productArea] : [],
      allowedEvidenceKinds: ["procedure", "capability", "constraint", "troubleshooting"]
    };
  }

  if (questionType === "why_behavior" || questionType === "capability_confirmation" || questionType === "troubleshooting") {
    return {
      strict: productArea !== "" && productArea !== "general" && productArea !== "unknown",
      allowedProductAreas: productArea && productArea !== "general" && productArea !== "unknown" ? [productArea] : [],
      allowedEvidenceKinds: ["capability", "constraint", "procedure", "troubleshooting"]
    };
  }

  return null;
}

function getReferenceMetadataList(reference: SearchReference, key: string): string[] {
  const metadata = (reference.supportMetadata ?? {}) as Record<string, unknown>;
  const raw = metadata[key];
  if (!Array.isArray(raw)) return [];
  return raw.map((item) => String(item ?? "").trim()).filter(Boolean);
}

function getReferenceSupportProfile(reference: SearchReference): {
  title: string;
  heading: string;
  snippet: string;
  evidenceKind: string;
  productArea: string;
  deploymentModel: string;
  permissions: string[];
  prerequisites: string[];
  actions: string[];
} {
  const metadata = (reference.supportMetadata ?? {}) as Record<string, unknown>;
  return {
    title: String(reference.title ?? "").toLowerCase(),
    heading: String(reference.headingPath ?? "").toLowerCase(),
    snippet: String(reference.snippet ?? "").toLowerCase(),
    evidenceKind: String(metadata.evidence_kind ?? "").toLowerCase(),
    productArea: String(metadata.product_area ?? "").toLowerCase(),
    deploymentModel: String(metadata.deployment_model ?? "").toLowerCase(),
    permissions: getReferenceMetadataList(reference, "permissions").map((item) => item.toLowerCase()),
    prerequisites: getReferenceMetadataList(reference, "prerequisites").map((item) => item.toLowerCase()),
    actions: getReferenceMetadataList(reference, "actions").map((item) => item.toLowerCase())
  };
}

function getReferenceSemanticText(reference: SearchReference): string {
  const profile = getReferenceSupportProfile(reference);
  return [
    profile.title,
    profile.heading,
    profile.snippet,
    ...profile.permissions,
    ...profile.prerequisites,
    ...profile.actions
  ]
    .filter(Boolean)
    .join(" ");
}

function referenceHasPermissionSignal(reference: SearchReference): boolean {
  const profile = getReferenceSupportProfile(reference);
  if (profile.permissions.length > 0) return true;
  const semanticText = getReferenceSemanticText(reference);
  return /\b(scope|scopes|permission|permissions|oauth|token|auth|authorization|authentication)\b/.test(semanticText);
}

function isReferenceEligibleForCaseFrame(reference: SearchReference, caseFrame: SupportCaseFrame): boolean {
  const policy = buildEvidencePolicy(caseFrame);
  if (!policy) return true;
  const profile = getReferenceSupportProfile(reference);
  const appliesTo = getReferenceMetadataList(reference, "applies_to").map((item) => item.toLowerCase());
  const productMatched = policy.allowedProductAreas.includes(profile.productArea);
  const kindMatched = policy.allowedEvidenceKinds.includes(profile.evidenceKind);
  const deploymentMatched =
    !policy.allowedDeploymentModels?.length ||
    policy.allowedDeploymentModels.includes(profile.deploymentModel) ||
    appliesTo.some((item) => policy.allowedDeploymentModels?.includes(item));
  const permissionMatched = policy.requiresPermissionSignal ? referenceHasPermissionSignal(reference) : true;
  const topicalMatched =
    (!policy.allowedProductAreas.length || productMatched) &&
    (!policy.allowedEvidenceKinds.length || kindMatched);
  return topicalMatched && deploymentMatched && permissionMatched ? true : !policy.strict;
}

function filterReferencesByEvidencePolicy(references: SearchReference[], caseFrame: SupportCaseFrame): SearchReference[] {
  const policy = buildEvidencePolicy(caseFrame);
  if (!policy?.strict) return references;
  const eligible = references.filter((reference) => isReferenceEligibleForCaseFrame(reference, caseFrame));
  return eligible.length > 0 ? eligible : references;
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

function scoreRequiredDocKindForReference(reference: SearchReference, requiredDocKind: string): number {
  const profile = getReferenceSupportProfile(reference);
  const semanticText = getReferenceSemanticText(reference);
  switch (requiredDocKind.toLowerCase()) {
    case "openapi/api":
      return (profile.productArea === "openapi" ? 16 : 0) + (profile.evidenceKind === "api_operation" ? 18 : 0);
    case "schema":
    case "field":
      return ((profile.productArea === "openapi" || profile.evidenceKind === "api_operation") ? 8 : 0) +
        (/\b(schema|field|fields|property|properties|response|status object)\b|字段|属性|响应/.test(semanticText) ? 14 : 0);
    case "syntax_reference":
      return /\b(onesql|syntax|query language|expression|reference)\b|语法|查询语言|表达式/.test(semanticText) ? 18 : 0;
    case "permissions":
      return (referenceHasPermissionSignal(reference) ? 16 : 0) + (profile.productArea === "openapi" ? 4 : 0);
    case "rules":
      return (profile.evidenceKind === "constraint" ? 12 : 0) +
        (/\b(rule|rules|workflow|workflows|behavior|limitation|limitations)\b|规则|流程|行为|限制/.test(semanticText) ? 12 : 0);
    case "troubleshooting":
      return (profile.evidenceKind === "troubleshooting" ? 16 : 0) +
        (/\b(troubleshoot|troubleshooting|faq|why|failure|error)\b|排查|故障|报错|失败|为什么/.test(semanticText) ? 10 : 0);
    case "product_guide":
      return (profile.evidenceKind === "capability" || profile.evidenceKind === "procedure" ? 10 : 0) +
        (profile.productArea && profile.productArea !== "openapi" ? 6 : 0);
    case "deployment_runbook":
      return (profile.productArea === "deployment" ? 18 : 0) +
        (profile.deploymentModel === "private_deployment" ? 18 : 0) +
        (profile.evidenceKind === "procedure" || profile.evidenceKind === "constraint" || profile.evidenceKind === "troubleshooting" ? 8 : 0);
    default:
      return 0;
  }
}

function rerankReferencesForCaseFrame(references: SearchReference[], query: string, caseFrame: SupportCaseFrame): SearchReference[] {
  const requiredDocKinds = caseFrame.required_doc_kinds ?? [];
  const focusTerms = collectFocusTerms(query, caseFrame);
  const normalizedQuery = query.toLowerCase();
  const wantsListVariant =
    /列表|枚举|可选|全部|有哪些/.test(query) || /\b(list|enum|options|all statuses?)\b/.test(normalizedQuery);
  return [...references].sort((a, b) => {
    const scoreRef = (reference: SearchReference) => {
      const profile = getReferenceSupportProfile(reference);
      const title = profile.title;
      const heading = profile.heading;
      const snippet = profile.snippet;
      const semanticText = getReferenceSemanticText(reference);
      let topicScore = 0;
      for (const term of focusTerms) {
        if (title.includes(term)) topicScore += 8;
        else if (heading.includes(term)) topicScore += 5;
        else if (snippet.includes(term)) topicScore += 1;
      }
      if (reference.sourceType === "local_docs" || reference.sourceType === "github_kb") {
        topicScore += 2;
      }
      for (const kind of requiredDocKinds.map((item) => item.toLowerCase())) {
        topicScore += scoreRequiredDocKindForReference(reference, kind);
      }
      if (caseFrame.deployment_model === "private_deployment") {
        if (profile.deploymentModel === "private_deployment") topicScore += 20;
        if (profile.productArea === "deployment") topicScore += 8;
      }
      if (caseFrame.product_area === "deployment") {
        if (profile.productArea === "deployment") topicScore += 18;
        if (profile.evidenceKind === "procedure") topicScore += 12;
        else if (profile.evidenceKind === "troubleshooting") topicScore += 6;
        else if (profile.evidenceKind === "constraint" || profile.evidenceKind === "capability") topicScore += 8;
        if (/\b(unified|shared|external|externalized|database|storage|topology|architecture|isolation|separate|separable)\b|统一|共享|外置|数据库|存储|拓扑|架构|隔离|独立/.test(semanticText)) {
          topicScore += 14;
        }
      }
      if (caseFrame.product_area === "integrations") {
        if (profile.productArea === "integrations") topicScore += 18;
        if (profile.evidenceKind === "troubleshooting") topicScore += 14;
        else if (profile.evidenceKind === "procedure") topicScore += 10;
        else if (profile.evidenceKind === "constraint" || profile.evidenceKind === "capability") topicScore += 8;
        if (/\b(github|gitlab|oauth|callback|redirect uri|redirect url|webhook|baseurl|page not found)\b|github|gitlab|回调|重定向|redirect uri|webhook|baseurl|page not found/.test(semanticText)) {
          topicScore += 16;
        }
      }
      if (
        caseFrame.question_type &&
        caseFrame.question_type.startsWith("api_") &&
        isReferenceEligibleForCaseFrame(reference, caseFrame)
      ) {
        topicScore += 8;
        topicScore += scoreApiIntentAlignment(
          collectApiOperationIntents(query, caseFrame),
          classifyApiOperationCandidate({
            method: extractApiOperationSignature(reference).method,
            path: extractApiOperationSignature(reference).path,
            title: reference.title,
            snippet
          })
        );
      }
      if (caseFrame.question_type === "api_scope_auth") {
        if (referenceHasPermissionSignal(reference)) {
          topicScore += 16;
        }
      }
      if (caseFrame.question_type === "how_to_product" || caseFrame.question_type === "config_setup") {
        if (profile.evidenceKind === "procedure") topicScore += 14;
        if (profile.deploymentModel === "private_deployment" && profile.productArea === "deployment") topicScore += 12;
      }
      if (caseFrame.question_type === "api_field_lookup") {
        const operationSignature = extractApiOperationSignature(reference);
        const isIssueDetailsOperation =
          /\/project\/issues\/\{issueid\}/.test(`${operationSignature.path} ${snippet}`.toLowerCase()) ||
          title.includes("issue details") ||
          title.includes("工作项详细信息");
        const isStatusListOperation =
          /\/project\/issuestatuses/.test(`${operationSignature.path} ${snippet}`.toLowerCase()) ||
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
      if (String(caseFrame.question_type ?? "").startsWith("api_") && !isReferenceEligibleForCaseFrame(reference, caseFrame)) {
        topicScore -= 40;
      }
      if (caseFrame.deployment_model === "private_deployment" && profile.deploymentModel && profile.deploymentModel !== "private_deployment") {
        topicScore -= 8;
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
      .map((item) => [resolveSearchReferenceEvidenceId(item), item] as const)
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
  const displayCitationIds = uniqueStrings(
    [
      ...claimLinkedCitationIds,
      ...input.verification.display_citation_ids
    ],
    6
  ).filter((citationId) => evidenceById.has(citationId) && claimLinkedCitationSet.has(citationId));
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
    const evidenceId = resolveSearchReferenceEvidenceId(item);
    const previous = bestById.get(evidenceId);
    if (!previous || item.score > previous.score) bestById.set(evidenceId, item);
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
    id: resolveSearchReferenceEvidenceId(item),
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
  const snippet = String(reference.snippet ?? "").toLowerCase();
  let topicScore = 0;
  for (const term of focusTerms) {
    if (title.includes(term)) topicScore += 10;
    else if (heading.includes(term)) topicScore += 7;
    else if (snippet.includes(term)) topicScore += 2;
  }
  return topicScore;
}

function buildSupportAnswerFromDraft(input: {
  language: "zh" | "en";
  mode: SupportAnswer["mode"];
  route: SupportQuestionRoute;
  draft: SpecialistDraftAnswer;
  verification: SupportVerificationResult;
  missingInfo: string[];
  composed?:
    | (Omit<SupportAnswer, "mode"> & {
        suppress_still_need_to_confirm?: boolean;
      })
    | null;
}): SupportAnswer {
  const supportedClaims = supportedVerificationClaims(input.verification);
  const why =
    input.composed?.why?.length
      ? uniqueStrings(input.composed.why, 4)
      : uniqueStrings(
          supportedClaims
            .filter((claim) => claim.kind === "verified_fact" || claim.kind === "grounded_inference")
            .map((claim) => claim.text),
          4
        );
  const whatToDoNow =
    input.composed?.what_to_do_now?.length
      ? uniqueStrings(input.composed.what_to_do_now, 4)
      : uniqueStrings(filterUnsupported(input.draft.next_actions, input.verification.unsupported_claims), 4);
  const stillNeedToConfirm = input.composed?.suppress_still_need_to_confirm
    ? []
    : input.composed?.still_need_to_confirm?.length
    ? uniqueStrings(input.composed.still_need_to_confirm, 4)
    : uniqueStrings([...input.draft.unknowns, ...input.verification.missing_info, ...input.missingInfo], 4);
  const directAnswer = (input.composed?.direct_answer ?? input.draft.direct_answer ?? "").trim();
  const sections = input.composed?.sections?.length ? input.composed.sections : [];
  return {
    question_type: input.composed?.question_type ?? input.draft.question_type ?? input.route.question_type,
    render_variant: input.composed?.render_variant ?? input.draft.render_variant,
    mode: input.mode,
    direct_answer: directAnswer,
    sections,
    why,
    what_to_do_now: whatToDoNow,
    still_need_to_confirm:
      input.mode === "grounded" && input.verification.verdict === "verified"
        ? []
        : stillNeedToConfirm.length
        ? stillNeedToConfirm
        : []
  };
}

function shortHeadingLabel(headingPath?: string): string {
  const heading = String(headingPath ?? "").trim();
  if (!heading) return "";
  const parts = heading.split(">").map((item) => item.trim()).filter(Boolean);
  return (parts[parts.length - 1] ?? heading).replace(/^[0-9.\-\s\\]+/, "").trim();
}
type ApiOperationIntent = "create" | "read" | "list" | "update" | "delete" | "execute";

function collectApiOperationIntents(query: string, caseFrame: SupportCaseFrame): Set<ApiOperationIntent> {
  const raw = `${query} ${caseFrame.goal} ${caseFrame.object} ${caseFrame.symptom} ${caseFrame.action_type}`.toLowerCase();
  const intents = new Set<ApiOperationIntent>();

  if (/(创建|新增|新建|添加|create|add|new )/i.test(raw)) intents.add("create");
  if (/(更新|修改|变更|设置|edit|update|modify|change|set )/i.test(raw)) intents.add("update");
  if (/(删除|移除|remove|delete)/i.test(raw)) intents.add("delete");
  if (/(执行|触发|run |execute|trigger)/i.test(raw)) intents.add("execute");
  if (/(列表|列出|枚举|清单|list |all statuses)/i.test(raw)) intents.add("list");
  if (/(获取|查询|查看|详情|get |fetch|read|detail)/i.test(raw)) intents.add("read");

  if (!intents.size) {
    if (caseFrame.action_type === "update") intents.add("update");
    else if (caseFrame.question_type === "api_field_lookup" || caseFrame.question_type === "api_scope_auth") intents.add("read");
  }

  return intents;
}

function extractApiOperationSignature(reference: SearchReference): { method?: string; path?: string } {
  const source = (() => {
    const snippet = String(reference.snippet ?? "");
    const resolvedPath = resolveLocalDocsMirrorPath(reference);
    if (!resolvedPath) return snippet;
    try {
      const raw = fs.readFileSync(resolvedPath, "utf8");
      return `${snippet}\n${raw}`;
    } catch {
      return snippet;
    }
  })();
  const jsxMatch = source.match(/method=\{"([a-z]+)"\}\s+path=\{"([^"]+)"\}/i);
  if (jsxMatch) {
    return {
      method: jsxMatch[1].toUpperCase(),
      path: jsxMatch[2]
    };
  }
  const plainMatch = source.match(/\b(GET|POST|PUT|PATCH|DELETE)\s+([/A-Za-z0-9._:{}?=&-]+)/);
  if (plainMatch) {
    return {
      method: plainMatch[1].toUpperCase(),
      path: plainMatch[2]
    };
  }
  const titleMatch = String(reference.title ?? "").match(/\b(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+([/A-Za-z0-9._:{}?=&-]+)/i);
  if (titleMatch) {
    return {
      method: titleMatch[1].toUpperCase(),
      path: titleMatch[2]
    };
  }
  return {};
}

function classifyApiOperationCandidate(input: { method?: string; path?: string; title?: string; snippet?: string }): Set<ApiOperationIntent> {
  const intents = new Set<ApiOperationIntent>();
  const method = String(input.method ?? "").toUpperCase();
  const path = String(input.path ?? "").toLowerCase();
  const title = String(input.title ?? "").toLowerCase();
  const snippet = String(input.snippet ?? "").toLowerCase();
  const haystack = `${path} ${title} ${snippet}`;

  if (method === "PUT" || method === "PATCH" || /update|更新|修改|变更|edit|patch/.test(haystack)) intents.add("update");
  if (method === "DELETE" || /delete|remove|删除|移除/.test(haystack)) intents.add("delete");
  if (method === "POST" && /create|创建|新增|新建|add /.test(haystack)) intents.add("create");
  if ((method === "POST" && /execute|执行|触发|trigger|run /.test(haystack)) || /action=executeworkflow/.test(haystack)) intents.add("execute");
  if (method === "GET") {
    if (/list|列表|issuestatuses|\/workflows\b|\/fields\b/.test(haystack) && !/\{[^}]+\}/.test(path)) intents.add("list");
    if (!intents.has("list")) intents.add("read");
  }
  if ((/\{[^}]+\}/.test(path) || /detail|details|详情|详细信息/.test(haystack)) && method === "GET") intents.add("read");

  return intents;
}

function scoreApiIntentAlignment(targetIntents: Set<ApiOperationIntent>, candidateIntents: Set<ApiOperationIntent>): number {
  if (!targetIntents.size || !candidateIntents.size) return 0;

  let score = 0;
  if (targetIntents.has("update")) {
    if (candidateIntents.has("update")) score += 52;
    if (candidateIntents.has("read")) score -= 12;
    if (candidateIntents.has("list")) score -= 30;
  }
  if (targetIntents.has("create")) {
    if (candidateIntents.has("create")) score += 30;
    if (candidateIntents.has("read") || candidateIntents.has("list")) score -= 10;
  }
  if (targetIntents.has("delete")) {
    if (candidateIntents.has("delete")) score += 30;
    if (candidateIntents.has("read") || candidateIntents.has("list")) score -= 10;
  }
  if (targetIntents.has("execute")) {
    if (candidateIntents.has("execute")) score += 28;
    if (candidateIntents.has("read") || candidateIntents.has("list")) score -= 8;
  }
  if (targetIntents.has("list")) {
    if (candidateIntents.has("list")) score += 24;
    if (candidateIntents.has("update") || candidateIntents.has("delete")) score -= 8;
  }
  if (targetIntents.has("read") && !targetIntents.has("update") && !targetIntents.has("create") && !targetIntents.has("delete")) {
    if (candidateIntents.has("read")) score += 16;
    if (candidateIntents.has("list")) score += 8;
  }

  return score;
}

function buildApiRetrievalBridgeQuery(query: string, caseFrame: SupportCaseFrame): string | null {
  if (!String(caseFrame.question_type ?? "").startsWith("api_")) return null;
  const intents = collectApiOperationIntents(query, caseFrame);
  const intentLexicon: Record<ApiOperationIntent, string[]> = {
    create: ["create", "add", "new"],
    read: ["get", "read", "detail"],
    list: ["list", "enum", "statuses"],
    update: ["update", "modify", "edit", "patch", "put"],
    delete: ["delete", "remove"],
    execute: ["execute", "trigger", "run"]
  };
  const intentTokens = uniqueStrings(
    [...intents].flatMap((intent) => intentLexicon[intent] ?? []),
    6
  );
  const focusTerms = collectFocusTerms(query, caseFrame).filter(
    (term) =>
      !/^(api|openapi|endpoint|接口|开放平台|如何|怎么|what|how|through|via|please|question|query)$/i.test(term) &&
      term.length >= 2
  );
  const focusTokens = uniqueStrings(focusTerms, 7);
  const bridgeTokens = uniqueStrings(["openapi", "api", "endpoint", ...intentTokens, ...focusTokens], 14);
  return bridgeTokens.length > 0 ? bridgeTokens.join(" ") : null;
}

function buildStructuredCaseFrameQuery(caseFrame: SupportCaseFrame): string | null {
  const segments = uniqueStrings(
    [
      caseFrame.goal,
      caseFrame.object,
      caseFrame.symptom,
      caseFrame.action_type,
      caseFrame.product_area,
      caseFrame.deployment_model,
      ...(caseFrame.required_doc_kinds ?? []),
      ...(caseFrame.constraints ?? []).slice(0, 2)
    ].map((item) => String(item ?? "").replace(/[_/]+/g, " ")),
    10
  );
  return segments.length ? segments.join(" ") : null;
}

function buildInitialRetrievalQueries(query: string, caseFrame: SupportCaseFrame, orchestrator: SearchOrchestrator): string[] {
  const structuredCaseFrameQuery = buildStructuredCaseFrameQuery(caseFrame);
  const compactFocus = buildCompactFocusQuery(query, caseFrame);
  return uniqueStrings(
    [
      structuredCaseFrameQuery,
      query,
      compactFocus,
      caseFrame.query_plan?.object_queries?.[0],
      caseFrame.query_plan?.concept_queries?.[0]
    ],
    3
  ).filter(Boolean);
}

function combineRetrievalQueries(
  query: string,
  caseFrame: SupportCaseFrame,
  orchestrator: SearchOrchestrator,
  baseQueries: string[] = []
): string[] {
  const apiBridge = buildApiRetrievalBridgeQuery(query, caseFrame);
  const compactFocus = buildCompactFocusQuery(query, caseFrame);
  const groupedQueries = [
    apiBridge,
    compactFocus,
    ...caseFrame.retrieval_queries,
    ...(caseFrame.query_plan?.object_queries ?? []),
    ...(caseFrame.query_plan?.concept_queries ?? []),
    ...(caseFrame.query_plan?.behavior_queries ?? [])
  ];
  const excludedQueries = new Set(baseQueries.map((item) => orchestrator.normalizeQuery(item)));
  return uniqueStrings(groupedQueries, 8).filter((item) => {
    const normalized = orchestrator.normalizeQuery(item);
    return normalized !== orchestrator.normalizeQuery(query) && !excludedQueries.has(normalized);
  });
}

async function writeSpecialistDraft(input: {
  adapter: OpenClawAdapter;
  contextType: "search" | "triage";
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
    contextType: input.contextType,
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

export async function runSupportSearchAgent(input: {
  query: string;
  language: "zh" | "en";
  currentRound: number;
  conversationHistory: Array<{ role: "user" | "assistant"; content: string }>;
  adapter: OpenClawAdapter;
  runtime?: OpenClawRuntimeContext;
  attachments?: string[];
  repoId?: string;
  branch?: string;
  idempotencyKey: string;
  contextType?: "search" | "triage";
  orchestrator?: SearchOrchestrator;
  onStageProgress?: (progress: any) => Promise<void> | void;
  ticketContext?: {
    priority: string;
    customerMeta: Record<string, unknown>;
    history: Array<{ author: string; body: string; at: string }>;
  };
}): Promise<{
  result: SearchModeResult;
  caseFrame: SupportCaseFrame;
  evidenceBundle: SupportEvidenceBundle;
  verification: SupportVerificationResult;
  stageTimings: SupportAgentStageTimings;
}> {
  const runStartedAt = performance.now();
  const orchestrator = input.orchestrator ?? new SearchOrchestrator(input.adapter);
  const allowMultiPassRetrieval = input.runtime?.allowMultiPassRetrieval !== false;
  const allowRefinement = input.runtime?.allowRefinement !== false;
  const contextType = input.contextType ?? "search";

  const routeStartedAt = performance.now();
  const routerRuntime = withStageRuntime(buildStageRuntime(input.runtime, 32000, 5000, 12000), "router", `${input.idempotencyKey}:router`);
  const route = await input.adapter
    .routeSupportQuestion(
      {
        contextType,
        language: input.language,
        query: input.query,
        conversationHistory: input.conversationHistory
      },
      `${input.idempotencyKey}:route`,
      routerRuntime
    )
    .catch((error) => {
      throw new Error(`support route unavailable: ${supportStageErrorMessage(error)}`);
    });
  const routeTiming = stageTiming("completed", elapsedMs(routeStartedAt));
  const evidencePlanStartedAt = performance.now();
  const evidencePlannerRuntime = withStageRuntime(
    buildStageRuntime(input.runtime, 26000, 4000, 10000),
    "evidence-planner",
    `${input.idempotencyKey}:evidence-planner`
  );
  const evidencePlan = await input.adapter
    .planSupportEvidence(
      {
        contextType,
        language: input.language,
        query: input.query,
        route,
        conversationHistory: input.conversationHistory
      },
      `${input.idempotencyKey}:evidence-plan`,
      evidencePlannerRuntime
    )
    .catch((error) => {
      throw new Error(`support evidence planner unavailable: ${supportStageErrorMessage(error)}`);
    });
  const evidencePlanTiming = stageTiming("completed", elapsedMs(evidencePlanStartedAt));
  const casePlanStartedAt = performance.now();
  const plannerRuntime = withStageRuntime(buildStageRuntime(input.runtime, 22000, 5000, 14000), "planner", `${input.idempotencyKey}:planner`);
  const plannedCaseFrame = await input.adapter
    .planSupportCase(
      {
        contextType,
        language: input.language,
        query: input.query,
        conversationHistory: input.conversationHistory,
        ticketContext: input.ticketContext
      },
      `${input.idempotencyKey}:plan`,
      plannerRuntime
    )
    .catch((error) => {
      throw new Error(`support case planner unavailable: ${supportStageErrorMessage(error)}`);
    });
  const casePlanTiming = stageTiming("completed", elapsedMs(casePlanStartedAt));
  const caseFrame = mergeRouteAndEvidencePlan(plannedCaseFrame, route, evidencePlan);
  const stageBudget = normalizeStageBudget({
    route,
    plan: evidencePlan
  });
  const baseQueries = buildInitialRetrievalQueries(input.query, caseFrame, orchestrator);
  const baseEvidenceStartedAt = performance.now();
  const baseEvidence = await orchestrator
    .collectEvidence({
      queries: baseQueries,
      idempotencyKey: `${input.idempotencyKey}:evidence`,
      runtime: input.runtime,
      answerLanguage: input.language,
      attachments: input.attachments,
      caseFrame,
      repoId: input.repoId,
      branch: input.branch
    })
    .catch((error) => {
      throw new Error(`support retrieval unavailable: ${supportStageErrorMessage(error)}`);
    });
  if (baseEvidence.fallbackUsed) {
    throw new Error("support retrieval unavailable: fallback retrieval path is disabled");
  }
  const baseEvidenceTiming = stageTiming("completed", elapsedMs(baseEvidenceStartedAt), {
    query_count: baseQueries.length,
    reference_count: baseEvidence.references.length
  });
  const additionalQueries = combineRetrievalQueries(input.query, caseFrame, orchestrator, baseQueries);
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
            attachments: input.attachments,
            caseFrame,
            repoId: input.repoId,
            branch: input.branch
          })
          .catch((error) => {
            throw new Error(`support retrieval refinement unavailable: ${supportStageErrorMessage(error)}`);
          })
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
            attachments: input.attachments,
            caseFrame
          })
          .catch((error) => {
            throw new Error(`support retrieval query refinement unavailable: ${supportStageErrorMessage(error)}`);
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
  const evidenceSelectionStartedAt = performance.now();
  const evidenceSelection =
    evidenceCollection.references.length > 0 && hasEnoughBudget(input.runtime, 5000)
      ? await input.adapter
          .selectSupportEvidence(
            {
              contextType,
              language: input.language,
              query: input.query,
              caseFrame,
              references: evidenceCollection.references
            },
            `${input.idempotencyKey}:evidence-selector`,
            selectionRuntime
          )
          .then((value) => ({
            value,
            timing: stageTiming("completed", elapsedMs(evidenceSelectionStartedAt), {
              reference_count: value.primary_ids.length + value.supplemental_ids.length
            })
          }))
          .catch((error) => {
            throw new Error(`support evidence selection unavailable: ${supportStageErrorMessage(error)}`);
          })
      : {
          value: null,
          timing: stageTiming("skipped", elapsedMs(evidenceSelectionStartedAt), { reference_count: 0 })
        };

  const evidenceBundle = buildEvidenceBundle({
    references: evidenceCollection.references,
    confidence: evidenceCollection.confidence,
    fallbackUsed: evidenceCollection.fallbackUsed,
    resolvedQueries: evidenceCollection.resolvedQueries,
    caseFrame,
    query: input.query,
    selection: evidenceSelection
      .value
  });

  const writerStartedAt = performance.now();
  const specialistRuntime = withStageRuntime(
    buildStageRuntime(input.runtime, 12000, 5000, 18000),
    route.specialist_agent,
    `${input.idempotencyKey}:${route.specialist_agent}`
  );
  const draftSupportAnswer = await writeSpecialistDraft({
    adapter: input.adapter,
    contextType,
    route,
    language: input.language,
    query: input.query,
    caseFrame,
    evidenceBundle,
    conversationHistory: input.conversationHistory,
    runtime: specialistRuntime,
    idempotencyKey: `${input.idempotencyKey}:specialist`
  }).catch((error) => {
    throw new Error(`support specialist unavailable: ${supportStageErrorMessage(error)}`);
  });
  const specialistTiming = stageTiming("completed", elapsedMs(writerStartedAt));

  const verifierStartedAt = performance.now();
  const judgeRuntime = withStageRuntime(
    buildStageRuntime(input.runtime, 5000, 6000, 25000),
    "evidence-judge",
    `${input.idempotencyKey}:evidence-judge`
  );
  const verification = await input.adapter
    .judgeSupportAnswer(
      {
        contextType,
        language: input.language,
        query: input.query,
        caseFrame,
        evidenceBundle,
        draftSupportAnswer
      },
      `${input.idempotencyKey}:judge`,
      judgeRuntime
    )
    .catch((error) => {
      throw new Error(`support verification unavailable: ${supportStageErrorMessage(error)}`);
    });
  const verificationTiming = stageTiming("completed", elapsedMs(verifierStartedAt));
  const finalVerification = sanitizeVerification({
    verification,
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
  const answerComposerStartedAt = performance.now();
  const composedSupportAnswer = await input.adapter
    .composeCustomerAnswer(
      {
        contextType,
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
    .catch((error) => {
      throw new Error(`support answer composer unavailable: ${supportStageErrorMessage(error)}`);
    });
  const answerComposerTiming = stageTiming("completed", elapsedMs(answerComposerStartedAt));
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
  if (!supportAnswer.direct_answer.trim()) {
    throw new Error("support answer unavailable: empty direct answer from specialist/composer");
  }
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
    planner: mergeStageTimings([routeTiming, evidencePlanTiming, casePlanTiming]),
    retrieval_base: baseEvidenceTiming,
    retrieval_extra: additionalTiming,
    writer: specialistTiming,
    verifier: mergeStageTimings([verificationTiming, answerComposerTiming])
  };
  const stageTrace: SupportAgentStageTraceEntry[] = [
    stageTraceEntry({
      stage: "route",
      timing: routeTiming,
      runtimeStage: "router",
      idempotencyKey: `${input.idempotencyKey}:route`
    }),
    stageTraceEntry({
      stage: "evidence_plan",
      timing: evidencePlanTiming,
      runtimeStage: "evidence-planner",
      idempotencyKey: `${input.idempotencyKey}:evidence-plan`
    }),
    stageTraceEntry({
      stage: "case_plan",
      timing: casePlanTiming,
      runtimeStage: "planner",
      idempotencyKey: `${input.idempotencyKey}:plan`
    }),
    stageTraceEntry({
      stage: "retrieval",
      timing: baseEvidenceTiming,
      idempotencyKey: `${input.idempotencyKey}:evidence`
    }),
    stageTraceEntry({
      stage: "retrieval_refine",
      timing: additionalTiming,
      idempotencyKey: `${input.idempotencyKey}:evidence:extra`
    }),
    stageTraceEntry({
      stage: "evidence_selection",
      timing: evidenceSelection.timing,
      runtimeStage: "support-evidence-selector",
      idempotencyKey: `${input.idempotencyKey}:evidence-selector`
    }),
    stageTraceEntry({
      stage: "specialist",
      timing: specialistTiming,
      runtimeStage: route.specialist_agent,
      idempotencyKey: `${input.idempotencyKey}:specialist`
    }),
    stageTraceEntry({
      stage: "verification",
      timing: verificationTiming,
      runtimeStage: "evidence-judge",
      idempotencyKey: `${input.idempotencyKey}:judge`
    }),
    stageTraceEntry({
      stage: "answer_composition",
      timing: answerComposerTiming,
      runtimeStage: "answer-composer",
      idempotencyKey: `${input.idempotencyKey}:answer-composer`
    })
  ];

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
        evidence_plan: evidencePlan,
        stage_budget: stageBudget,
        retrieval_queries_used: uniqueStrings(
          [
            ...baseQueries,
            ...additionalQueries,
            ...(caseFrame.query_plan?.concept_queries ?? []),
            ...(caseFrame.query_plan?.object_queries ?? []),
            ...(caseFrame.query_plan?.behavior_queries ?? [])
          ],
          12
        ),
        retrieval_queries_refined: refinementEvidence?.resolvedQueries ?? [],
        claim_graph: buildClaimGraph(finalVerification),
        specialist_skipped: false,
        specialists_used: [route.specialist_agent],
        evidence_sources: uniqueStrings(
          evidenceCollection.references.map((item) => item.sourceType ?? "unknown"),
          6
        ),
        fast_path_used: false,
        confirmed_facts: uniqueStrings(draftSupportAnswer.confirmed_facts ?? [], 4),
        stage_trace: stageTrace,
        orchestration_trace: buildOrchestrationTrace({
          route,
          specialistSkipped: false
        })
      }
    }
  };
}

function buildTriageCustomerReply(input: {
  language: "zh" | "en";
  action: TriageSupportInsight["recommended_action"];
  supportAnswer: SupportAnswer;
  missingInfo: string[];
}): string {
  if (input.action === "escalate") {
    return input.language === "zh"
      ? "感谢反馈。当前证据不足以给出可靠自助结论，建议升级给研发继续排查。"
      : "Thanks for the report. The current evidence is not strong enough for a reliable self-serve conclusion, so this should be escalated to engineering.";
  }

  if (input.action === "ask_user") {
    const missing = input.missingInfo[0] ?? input.supportAnswer.still_need_to_confirm[0];
    if (missing) {
      return input.language === "zh" ? `为继续处理，请先补充：${missing}` : `To continue, please share: ${missing}.`;
    }
    return input.language === "zh"
      ? "为继续处理，请补充当前失败步骤、预期结果、实际结果和报错原文。"
      : "To continue, please share the failing step, expected result, actual result, and the exact error message.";
  }

  return uniqueStrings([input.supportAnswer.direct_answer, ...input.supportAnswer.what_to_do_now], 3).join("\n");
}

function buildTriageInsightFromSupportRuntime(input: {
  language: "zh" | "en";
  supportAnswer: SupportAnswer;
  verification: SupportVerificationResult;
  evidenceBundle: SupportEvidenceBundle;
  citations: SearchModeResult["citations"];
}): TriageSupportInsight {
  const missingInfo = uniqueStrings(
    [...input.supportAnswer.still_need_to_confirm, ...input.verification.missing_info],
    3
  );
  const recommended_action: TriageSupportInsight["recommended_action"] =
    input.supportAnswer.mode === "handoff"
      ? "escalate"
      : input.supportAnswer.mode === "clarification"
      ? "ask_user"
      : input.verification.verdict === "verified" && input.evidenceBundle.primary.length > 0
      ? "resolve"
      : "ask_user";

  return {
    direct_answer: input.supportAnswer.direct_answer,
    recommended_action,
    customer_reply: buildTriageCustomerReply({
      language: input.language,
      action: recommended_action,
      supportAnswer: input.supportAnswer,
      missingInfo
    }),
    customer_reply_policy: recommended_action === "escalate" ? "no_send" : "send_now",
    support_summary: input.supportAnswer.direct_answer,
    verified_evidence:
      input.citations.length > 0
        ? input.citations.map((item) => item.title).slice(0, 3)
        : uniqueStrings(input.evidenceBundle.primary.map((item) => item.title), 3),
    risk_flags: recommended_action === "escalate" ? ["needs_rnd"] : [],
    missing_info: missingInfo,
    verifier_verdict: input.verification.verdict
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
  repoId?: string;
  branch?: string;
  orchestrator?: SearchOrchestrator;
}): Promise<{
  analyzeOutput: OpenClawAnalyzeOutput & Record<string, unknown>;
  caseFrame: SupportCaseFrame;
  evidenceBundle: SupportEvidenceBundle;
  verification: SupportVerificationResult;
  stageTimings: SupportAgentStageTimings;
}> {
  const conversationHistory = input.history
    .slice(-6)
    .map((item) => ({ role: "user" as const, content: `${item.author}: ${item.body}` }));
  const supportExecution = await runSupportSearchAgent({
    query: input.query,
    language: input.language,
    currentRound: 0,
    conversationHistory,
    adapter: input.adapter,
    runtime: input.runtime,
    attachments: input.attachments,
    repoId: input.repoId,
    branch: input.branch,
    orchestrator: input.orchestrator,
    idempotencyKey: input.idempotencyKey,
    contextType: "triage",
    ticketContext: {
      priority: input.priority,
      customerMeta: input.customerMeta,
      history: input.history
    }
  });
  const supportAnswer =
    supportExecution.result.support_answer;
  if (!supportAnswer) {
    throw new Error("support triage unavailable: support answer contract missing");
  }
  const insight = buildTriageInsightFromSupportRuntime({
    language: input.language,
    supportAnswer,
    verification: supportExecution.verification,
    evidenceBundle: supportExecution.evidenceBundle,
    citations: supportExecution.result.citations
  });
  const action = insight.recommended_action;

  return {
    caseFrame: supportExecution.caseFrame,
    evidenceBundle: supportExecution.evidenceBundle,
    verification: supportExecution.verification,
    stageTimings: supportExecution.stageTimings,
    analyzeOutput: {
      action,
      confidence: supportExecution.result.confidence,
      reply: insight.customer_reply_policy === "send_now" ? insight.customer_reply : "",
      reasoning_summary: insight.support_summary,
      evidence: insight.verified_evidence.length
        ? insight.verified_evidence
        : uniqueStrings(supportExecution.evidenceBundle.primary.map((item) => item.title), 4),
      risk_flags: insight.risk_flags,
      support_insight: insight,
      verification_summary: supportExecution.verification,
      case_frame: supportExecution.caseFrame,
      evidence_bundle_digest: digestEvidenceBundle(supportExecution.evidenceBundle),
      stage_timings: supportExecution.stageTimings,
      stage_trace: supportExecution.result.internal_diagnostics?.stage_trace ?? []
    }
  };
}
