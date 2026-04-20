import { env } from "../../config/env.js";
import { extractSupportSignals } from "../github-kb/memory-extractor.js";
import {
  buildSupportEvidencePolicy,
  filterSupportEvidenceByPolicy,
  type SupportEvidenceLike,
  getSupportEvidenceProfile,
  matchesSupportEvidencePolicy
} from "./support-evidence-policy.js";
import type { SearchReference, SupportCaseFrame } from "./types.js";
import type {
  HybridEvidenceGateInput,
  HybridEvidenceGateResult,
  HybridFusedCandidate,
  HybridGroundedEvidence,
  HybridPublication,
  HybridRuntimeBudget,
  HybridRetrievalDiagnostics,
  HybridRetrievalProvider,
  HybridRetrievalRequest,
  HybridRetrievalResult,
  HybridRecallCandidate,
  HybridRecallChannel
} from "./hybrid-retrieval-types.js";

function clamp(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function collapseWhitespace(input: string): string {
  return input.replace(/\s+/g, " ").trim();
}

function uniqueStrings(input: Array<string | null | undefined>, limit = 12): string[] {
  const seen = new Set<string>();
  const values: string[] = [];
  for (const item of input) {
    const value = collapseWhitespace(String(item ?? ""));
    if (!value) continue;
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    values.push(value);
    if (values.length >= limit) break;
  }
  return values;
}

function normalizeLookup(input: string): string {
  return collapseWhitespace(input).toLowerCase();
}

function summarizeConversationContext(history: Array<{ role: "user" | "assistant"; content: string }> = []): string {
  return history
    .slice(-4)
    .map((item) => `${item.role}: ${collapseWhitespace(item.content)}`)
    .filter(Boolean)
    .join(" | ");
}

function inferRequiredObjectTypes(input: { query: string; caseFrame?: SupportCaseFrame }): string[] {
  const exactObject = collapseWhitespace(String(input.caseFrame?.object ?? ""));
  const objectHints = uniqueStrings(
    [
      exactObject,
      ...[
        /redirect uri/i.test(input.query) ? "redirect uri" : "",
        /callback/i.test(input.query) && !exactObject ? "callback" : "",
        /scope/i.test(input.query) ? "scope" : ""
      ]
    ],
    4
  );
  return objectHints.filter((item) => item.length <= 80);
}

export function buildHybridRetrievalRequest(input: {
  query: string;
  rewrites?: string[];
  answerLanguage: "zh" | "en";
  caseFrame?: SupportCaseFrame;
  conversationHistory?: Array<{ role: "user" | "assistant"; content: string }>;
  repoId?: string;
  branch?: string;
  knowledgeSpace: HybridRetrievalRequest["knowledgeSpace"];
  topK: number;
  runtimeBudget?: HybridRuntimeBudget;
}): HybridRetrievalRequest {
  const query = collapseWhitespace(input.query);
  const conversationContextSummary = summarizeConversationContext(input.conversationHistory);
  const rewrites = uniqueStrings(
    [
      query,
      ...(input.rewrites ?? []),
      collapseWhitespace(String(input.caseFrame?.symptom ?? "")),
      collapseWhitespace(String(input.caseFrame?.goal ?? ""))
    ],
    6
  );

  return {
    query,
    rewrites,
    caseFrame: input.caseFrame,
    requiredDocKinds: uniqueStrings(input.caseFrame?.required_doc_kinds ?? [], 6),
    requiredObjectTypes: inferRequiredObjectTypes({ query, caseFrame: input.caseFrame }),
    supportSignals: extractSupportSignals(query),
    answerLanguage: input.answerLanguage,
    conversationContextSummary,
    repoId: input.repoId,
    branch: input.branch,
    knowledgeSpace: input.knowledgeSpace,
    topK: Math.max(1, input.topK),
    runtimeBudget: input.runtimeBudget
  };
}

function channelWeight(channel: HybridRecallChannel): number {
  switch (channel) {
    case "exact_signal":
      return 1.0;
    case "structured_artifact":
      return 0.95;
    case "sparse_memory":
      return 0.85;
    case "dense_citation":
      return 0.68;
    case "sparse_citation":
      return 0.72;
    case "relation_expansion":
      return 0.4;
    default:
      return 0.5;
  }
}

function questionTypeFamilyBoost(questionType: string, candidate: HybridRecallCandidate): number {
  const family = normalizeLookup(candidate.candidateFamily);
  if (questionType.startsWith("api_")) {
    if (family.includes("openapi") || family.includes("api_operation") || family.includes("permission")) return 0.18;
    if (family.includes("config")) return 0.08;
    return -0.06;
  }
  if (questionType === "config_setup") {
    if (family.includes("config") || family.includes("procedure")) return 0.16;
    return -0.04;
  }
  if (questionType === "troubleshooting") {
    if (family.includes("troubleshooting") || family.includes("behavior") || family.includes("schema") || family.includes("symbol")) {
      return 0.14;
    }
  }
  if (questionType === "why_behavior" || questionType === "capability_confirmation") {
    if (family.includes("behavior") || family.includes("symbol") || family.includes("test")) return 0.14;
  }
  return 0;
}

function computeCaseFrameFit(candidate: HybridRecallCandidate, caseFrame?: SupportCaseFrame): number {
  if (!caseFrame) return 0;
  const profile = getSupportEvidenceProfile(candidate);
  let score = 0;
  const candidateProductArea = normalizeLookup(profile.productArea);
  const caseProductArea = normalizeLookup(caseFrame.product_area ?? "");
  if (caseProductArea && caseProductArea !== "general" && caseProductArea !== "unknown") {
    if (candidateProductArea === caseProductArea) score += 0.18;
    else if (candidateProductArea) score -= 0.06;
  }
  const candidateDeployment = normalizeLookup(profile.deploymentModel);
  const caseDeployment = normalizeLookup(caseFrame.deployment_model ?? "");
  if (caseDeployment) {
    if (candidateDeployment === caseDeployment) score += 0.12;
    else if (candidateDeployment) score -= 0.04;
  }
  const candidateObject = normalizeLookup(profile.objectType);
  const caseObject = normalizeLookup(caseFrame.object ?? "");
  if (caseObject && candidateObject.includes(caseObject)) score += 0.14;
  score += questionTypeFamilyBoost(normalizeLookup(caseFrame.question_type ?? ""), candidate);
  return score;
}

function computeDocKindFit(candidate: HybridRecallCandidate, requiredDocKinds: string[]): number {
  if (!requiredDocKinds.length) return 0;
  const docKind = normalizeLookup(getSupportEvidenceProfile(candidate).docKind);
  for (const item of requiredDocKinds) {
    const required = normalizeLookup(item);
    if (!required) continue;
    if (docKind === required) return 0.16;
    if (required === "deployment_runbook" && /deployment|runbook|troubleshooting/.test(docKind)) return 0.12;
    if (required === "openapi/api" && /openapi|api/.test(docKind)) return 0.16;
    if (required === "troubleshooting" && /troubleshooting|rules/.test(docKind)) return 0.12;
  }
  return -0.04;
}

function collectSemanticFocusTerms(request: HybridRetrievalRequest): string[] {
  return uniqueStrings(
    [
      request.query,
      ...request.rewrites,
      ...request.requiredObjectTypes,
      ...(request.caseFrame?.retrieval_queries ?? []),
      ...(request.caseFrame?.query_plan?.concept_queries ?? []),
      ...(request.caseFrame?.query_plan?.object_queries ?? []),
      ...(request.caseFrame?.query_plan?.behavior_queries ?? [])
    ],
    16
  ).map(normalizeLookup);
}

function scoreCandidateSemanticFocus(candidate: SupportEvidenceLike, request: HybridRetrievalRequest): number {
  const profile = getSupportEvidenceProfile(candidate);
  const focusTerms = collectSemanticFocusTerms(request);
  const heading = profile.heading;
  const title = profile.title;
  const snippet = profile.snippet;
  const semanticText = `${profile.path} ${title} ${heading} ${snippet}`;
  let score = 0;

  for (const term of focusTerms) {
    if (!term || term.length < 2) continue;
    if (heading.includes(term)) score += 0.08;
    else if (title.includes(term)) score += 0.05;
    else if (snippet.includes(term)) score += term.length >= 6 ? 0.03 : 0.015;
  }

  if (
    normalizeLookup(request.caseFrame?.product_area ?? "") === "deployment" &&
    normalizeLookup(request.caseFrame?.action_type ?? "") === "capability_confirmation"
  ) {
    if (
      /support matrix|compatibility|system requirements?|environment requirements?|operating system requirements?|requirements?|不支持|支持矩阵|兼容性|系统要求|环境要求|操作系统要求/.test(
        semanticText
      )
    ) {
      score += 0.18;
    }
    if (
      request.requiredObjectTypes.some((item) => /linux/.test(item)) &&
      /linux|ubuntu|red hat|centos|debian|uos|麒麟/.test(semanticText)
    ) {
      score += 0.16;
    }
    if (/本文描述|本文介绍|前言说明|概览|简介|overview|introduction|可配合.*阅读/.test(semanticText)) {
      score -= 0.14;
    }
  }

  if (normalizeLookup(String(candidate.headingPath ?? "")) && normalizeLookup(String(candidate.headingPath ?? "")) !== "root") {
    score += 0.04;
  }

  return score;
}

function normalizeAndFuseCandidates(input: {
  request: HybridRetrievalRequest;
  publication: HybridPublication;
  channelOutputs: Partial<Record<HybridRecallChannel, HybridRecallCandidate[]>>;
}): HybridFusedCandidate[] {
  const fused = new Map<string, HybridFusedCandidate>();
  const k = 60;

  for (const [channelName, channelCandidates] of Object.entries(input.channelOutputs) as Array<[HybridRecallChannel, HybridRecallCandidate[] | undefined]>) {
    const sorted = [...(channelCandidates ?? [])].sort((left, right) => right.rawScore - left.rawScore);
    sorted.forEach((candidate, index) => {
      if (
        candidate.knowledgeSpace !== input.publication.knowledgeSpace ||
        candidate.buildVersion !== input.publication.publishedBuildVersion
      ) {
        return;
      }
      const key = `${candidate.candidateType}:${candidate.retrievalAbstractionId}`;
      const existing = fused.get(key);
      const fusionIncrement = channelWeight(channelName) / (k + index + 1);
      if (!existing) {
        fused.set(key, {
          ...candidate,
          rawChannelScores: { [channelName]: candidate.rawScore },
          channelRanks: { [channelName]: index + 1 },
          fusionScore: fusionIncrement,
          rerankScore: 0,
          channelAgreement: 1
        });
        return;
      }
      existing.fusionScore += fusionIncrement;
      existing.rawChannelScores[channelName] = Math.max(existing.rawChannelScores[channelName] ?? 0, candidate.rawScore);
      existing.channelRanks[channelName] = Math.min(existing.channelRanks[channelName] ?? Number.POSITIVE_INFINITY, index + 1);
      existing.channelAgreement = Object.keys(existing.rawChannelScores).length;
      existing.rawScore = Math.max(existing.rawScore, candidate.rawScore);
      existing.matchedFields = uniqueStrings([...existing.matchedFields, ...candidate.matchedFields], 12);
      existing.citationCandidateIds = uniqueStrings([...existing.citationCandidateIds, ...candidate.citationCandidateIds], 8);
      if (!existing.snippet && candidate.snippet) existing.snippet = candidate.snippet;
      if (!existing.sourceUrl && candidate.sourceUrl) existing.sourceUrl = candidate.sourceUrl;
      if (!existing.repoSourceUrl && candidate.repoSourceUrl) existing.repoSourceUrl = candidate.repoSourceUrl;
    });
  }

  return [...fused.values()];
}

function rerankCandidates(candidates: HybridFusedCandidate[], request: HybridRetrievalRequest): HybridFusedCandidate[] {
  const strictPolicy = request.caseFrame ? buildSupportEvidencePolicy(request.caseFrame) : null;
  return [...candidates]
    .map((candidate) => {
      const channelAgreementScore = Math.min(0.18, candidate.channelAgreement * 0.06);
      const exactSignalScore = candidate.rawChannelScores.exact_signal ? 0.16 : 0;
      const citationAvailabilityScore =
        candidate.citationAvailability === "linked" ? 0.14 : candidate.citationAvailability === "available" ? 0.08 : -0.08;
      const degradedPenalty = candidate.degradedParser ? -0.12 : 0;
      const caseFrameFit = computeCaseFrameFit(candidate, request.caseFrame);
      const docKindFit = computeDocKindFit(candidate, request.requiredDocKinds);
      const semanticFocusFit = scoreCandidateSemanticFocus(candidate, request);
      const objectTypeFit = request.requiredObjectTypes.some((item) =>
        normalizeLookup(getSupportEvidenceProfile(candidate).objectType).includes(normalizeLookup(item))
      )
        ? 0.12
        : 0;
      const fusionBase = clamp(candidate.fusionScore * 18);
      const strictPolicyAdjustment =
        strictPolicy?.strict && request.caseFrame
          ? matchesSupportEvidencePolicy(candidate, request.caseFrame)
            ? 0.28
            : -0.46
          : 0;
      candidate.rerankScore =
        fusionBase +
          channelAgreementScore +
          exactSignalScore +
          citationAvailabilityScore +
          caseFrameFit +
          docKindFit +
          semanticFocusFit +
          objectTypeFit +
          degradedPenalty +
          strictPolicyAdjustment;
      return candidate;
    })
    .sort((left, right) => right.rerankScore - left.rerankScore || right.fusionScore - left.fusionScore);
}

function dedupeReferences(references: SearchReference[]): SearchReference[] {
  const byKey = new Map<string, SearchReference>();
  for (const reference of references) {
    const key = `${reference.path ?? reference.sourceUrl}::${reference.headingPath ?? "ROOT"}`;
    const previous = byKey.get(key);
    if (!previous || reference.score > previous.score || reference.snippet.length > previous.snippet.length) {
      byKey.set(key, reference);
    }
  }
  return [...byKey.values()];
}

function toSearchReference(evidence: HybridGroundedEvidence, score: number): SearchReference {
  return {
    documentId: evidence.documentId,
    evidenceId: evidence.evidenceId,
    title: evidence.title,
    snippet: evidence.snippet,
    sourceUrl: evidence.sourceUrl,
    repoSourceUrl: evidence.repoSourceUrl,
    repo: evidence.repo,
    branch: evidence.branch,
    path: evidence.path,
    commitSha: evidence.commitSha,
    headingPath: evidence.headingPath ?? undefined,
    score,
    retrievedAt: new Date().toISOString(),
    supportMetadata: evidence.supportMetadata,
    chunkMetadata: evidence.chunkMetadata,
    docMetadata: evidence.docMetadata,
    authority: "canonical_visible",
    sourceType: "github_kb"
  };
}

function isRootHeadingPath(value?: string | null): boolean {
  const normalized = normalizeLookup(String(value ?? ""));
  return !normalized || normalized === "root";
}

function groundedEvidenceDocumentKey(item: HybridGroundedEvidence): string {
  return `${item.documentId}::${item.path ?? item.sourceUrl ?? item.title}`;
}

function prioritizeGroundedEvidenceForServing(input: {
  groundedEvidence: HybridGroundedEvidence[];
  request: HybridRetrievalRequest;
  candidateScoreById: Map<string, number>;
}): HybridGroundedEvidence[] {
  const documentKeysWithSpecificHeading = new Set(
    input.groundedEvidence
      .filter((item) => !isRootHeadingPath(item.headingPath))
      .map((item) => groundedEvidenceDocumentKey(item))
  );

  const filtered = input.groundedEvidence.filter((item) => {
    const documentKey = groundedEvidenceDocumentKey(item);
    const suppressGenericRoot =
      documentKeysWithSpecificHeading.has(documentKey) &&
      isRootHeadingPath(item.headingPath) &&
      item.sourceCandidateType !== "chunk";
    return !suppressGenericRoot;
  });

  return [...filtered].sort((left, right) => {
    const leftProfile = getSupportEvidenceProfile(left);
    const rightProfile = getSupportEvidenceProfile(right);
    const leftText = normalizeLookup(`${leftProfile.path} ${leftProfile.title} ${leftProfile.heading} ${leftProfile.snippet}`);
    const rightText = normalizeLookup(`${rightProfile.path} ${rightProfile.title} ${rightProfile.heading} ${rightProfile.snippet}`);
    const leftObjectMatch = input.request.requiredObjectTypes.some((item) => leftText.includes(normalizeLookup(item))) ? 1 : 0;
    const rightObjectMatch = input.request.requiredObjectTypes.some((item) => rightText.includes(normalizeLookup(item))) ? 1 : 0;
    const leftSpecificHeading = isRootHeadingPath(left.headingPath) ? 0 : 1;
    const rightSpecificHeading = isRootHeadingPath(right.headingPath) ? 0 : 1;
    const leftScore =
      (input.candidateScoreById.get(left.candidateId) ?? 0) +
      leftObjectMatch * 0.2 +
      leftSpecificHeading * 0.14 +
      scoreCandidateSemanticFocus(left, input.request);
    const rightScore =
      (input.candidateScoreById.get(right.candidateId) ?? 0) +
      rightObjectMatch * 0.2 +
      rightSpecificHeading * 0.14 +
      scoreCandidateSemanticFocus(right, input.request);
    return rightScore - leftScore;
  });
}

export class DefaultHybridEvidenceGate {
  evaluate(input: HybridEvidenceGateInput): HybridEvidenceGateResult {
    const reasons: string[] = [];
    const evidenceFamilies = uniqueStrings(input.groundedEvidence.map((item) => item.evidenceFamily), 8);
    const allOnPublishedBuild = input.groundedEvidence.every((item) => item.buildVersion === input.publishedBuildVersion);
    const strictPolicy = input.caseFrame ? buildSupportEvidencePolicy(input.caseFrame) : null;
    const strictPolicyGroundedEvidence =
      input.caseFrame && strictPolicy?.strict
        ? filterSupportEvidenceByPolicy(input.groundedEvidence, input.caseFrame, (item) => item)
        : input.groundedEvidence;

    if (!input.groundedEvidence.length) reasons.push("no_grounded_citation");
    if (!allOnPublishedBuild) reasons.push("cross_build_evidence");
    if (strictPolicy?.strict && input.groundedEvidence.length > 0 && strictPolicyGroundedEvidence.length === 0) {
      reasons.push("no_strict_policy_grounding");
    }

    const topCandidateTypes = new Set(input.topCandidates.slice(0, 3).map((item) => item.candidateType));
    if (topCandidateTypes.size > 0 && topCandidateTypes.size === 1 && topCandidateTypes.has("memory") && !input.groundedEvidence.length) {
      reasons.push("memory_only_without_grounding");
    }

    const questionType = normalizeLookup(input.caseFrame?.question_type ?? "");
    if (questionType === "troubleshooting" && evidenceFamilies.length === 1 && input.groundedEvidence.length > 0) {
      reasons.push("single_evidence_family_for_troubleshooting");
    }

    return {
      verdict: reasons.some((item) => item !== "single_evidence_family_for_troubleshooting") ? "insufficient" : "grounded",
      reasons: uniqueStrings(reasons, 6),
      evidenceFamilies
    };
  }
}

export class HybridRetrievalRuntime {
  private readonly evidenceGate = new DefaultHybridEvidenceGate();

  constructor(private readonly provider: HybridRetrievalProvider) {}

  async retrieve(request: HybridRetrievalRequest): Promise<HybridRetrievalResult> {
    const publication = await this.provider.resolvePublication(request);
    if (!publication) {
      return {
        query: request.query,
        references: [],
        confidence: 0,
        retrievalStatus: "kb_unavailable",
        unresolvedReasonCode: "KB_RETRIEVAL_UNAVAILABLE",
        diagnostics: {
          publication: null,
          rewrites: request.rewrites,
          requiredObjectTypes: request.requiredObjectTypes,
          perChannelCounts: {},
          channelTopIds: {},
          fusionTopIds: [],
          rerankTopIds: [],
          groundingSuccessRate: 0,
          evidenceGate: {
            verdict: "kb_unavailable",
            reasons: ["no_published_snapshot"],
            evidenceFamilies: []
          },
          finalConfidence: 0
        }
      };
    }

    const safeRecall = async (
      channel: HybridRecallChannel,
      fn: () => Promise<HybridRecallCandidate[]>
    ): Promise<[HybridRecallChannel, HybridRecallCandidate[]]> => {
      try {
        return [channel, await fn()];
      } catch {
        return [channel, []];
      }
    };

    const budgetMode = request.runtimeBudget?.mode ?? "full";
    const initialChannelEntries = await Promise.all([
      safeRecall("exact_signal", () => this.provider.recallExactSignal(request, publication)),
      safeRecall("sparse_memory", () => this.provider.recallSparseMemory(request, publication)),
      safeRecall("sparse_citation", () => this.provider.recallSparseCitation(request, publication)),
      ...(budgetMode === "minimal"
        ? []
        : [safeRecall("dense_citation", () => this.provider.recallDenseCitation(request, publication))]),
      safeRecall("structured_artifact", () => this.provider.recallStructuredArtifact(request, publication))
    ]);
    const initialChannelOutputs = {
      exact_signal: [],
      sparse_memory: [],
      sparse_citation: [],
      dense_citation: [],
      structured_artifact: [],
      relation_expansion: [],
      ...(Object.fromEntries(initialChannelEntries) as Partial<Record<HybridRecallChannel, HybridRecallCandidate[]>>)
    };
    const initiallyFused = normalizeAndFuseCandidates({
      request,
      publication,
      channelOutputs: initialChannelOutputs
    });
    const relationCandidates =
      budgetMode === "full"
        ? await this.provider
            .recallRelationExpansion(request, publication, rerankCandidates(initiallyFused, request).slice(0, 6))
            .catch(() => [])
        : [];
    const channelOutputs = {
      ...initialChannelOutputs,
      relation_expansion: relationCandidates
    } as Partial<Record<HybridRecallChannel, HybridRecallCandidate[]>>;
    const fused = normalizeAndFuseCandidates({
      request,
      publication,
      channelOutputs
    });
    const reranked = rerankCandidates(fused, request).slice(0, Math.max(request.topK * 2, 8));
    const groundedEvidence = await this.provider.groundCandidates(request, publication, reranked).catch(() => []);
    const evidenceGate = this.evidenceGate.evaluate({
      groundedEvidence,
      topCandidates: reranked,
      publishedBuildVersion: publication.publishedBuildVersion,
      caseFrame: request.caseFrame
    });

    const candidateScoreById = new Map(reranked.map((item) => [item.candidateId, item.rerankScore] as const));
    const eligibleGroundedEvidence =
      request.caseFrame != null
        ? filterSupportEvidenceByPolicy(groundedEvidence, request.caseFrame, (item) => item)
        : groundedEvidence;
    const prioritizedGroundedEvidence = prioritizeGroundedEvidenceForServing({
      groundedEvidence: eligibleGroundedEvidence,
      request,
      candidateScoreById
    });
    const references =
      evidenceGate.verdict === "grounded"
        ? dedupeReferences(
            prioritizedGroundedEvidence
              .filter((item) => item.buildVersion === publication.publishedBuildVersion)
              .map((item) => toSearchReference(item, candidateScoreById.get(item.candidateId) ?? 0.2))
          ).slice(0, request.topK)
        : [];
    const groundingSuccessRate = reranked.length ? eligibleGroundedEvidence.length / reranked.length : 0;
    const finalConfidence = clamp((reranked[0]?.rerankScore ?? 0) * 0.82 + groundingSuccessRate * 0.18);
    const diagnostics: HybridRetrievalDiagnostics = {
      publication,
      rewrites: request.rewrites,
      requiredObjectTypes: request.requiredObjectTypes,
      perChannelCounts: Object.fromEntries(
        Object.entries(channelOutputs).map(([channel, candidates]) => [channel, (candidates ?? []).length])
      ) as Partial<Record<HybridRecallChannel, number>>,
      channelTopIds: Object.fromEntries(
        Object.entries(channelOutputs).map(([channel, candidates]) => [
          channel,
          [...(candidates ?? [])].sort((left, right) => right.rawScore - left.rawScore).slice(0, 3).map((item) => item.candidateId)
        ])
      ) as Partial<Record<HybridRecallChannel, string[]>>,
      fusionTopIds: fused.sort((left, right) => right.fusionScore - left.fusionScore).slice(0, 5).map((item) => item.candidateId),
      rerankTopIds: reranked.slice(0, 5).map((item) => item.candidateId),
      groundingSuccessRate,
      evidenceGate,
      finalConfidence
    };

    if (!references.length) {
      return {
        query: request.query,
        references: [],
        confidence: 0,
        retrievalStatus: "no_results",
        unresolvedReasonCode: "NO_MATCHING_KB",
        diagnostics
      };
    }

    return {
      query: request.query,
      references,
      confidence: finalConfidence,
      retrievalStatus: "grounded",
      unresolvedReasonCode: finalConfidence < env.AI_SEARCH_ANSWER_CONFIDENCE_THRESHOLD ? "LOW_CONFIDENCE" : null,
      diagnostics
    };
  }
}
