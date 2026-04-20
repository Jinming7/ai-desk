import crypto from "node:crypto";
import { env } from "../../config/env.js";
import type { RetrievalHit } from "./types.js";
import type { KbKnowledgeSpace } from "./types.js";
import { extractMemoryEntriesForDocument, extractSupportSignals } from "./memory-extractor.js";
import * as memoryRepo from "./memory-repository.js";
import type {
  KbMemoryEntry,
  MemoryCaseFrame,
  MemoryEntryDraft,
  MemoryProfileDraft,
  MemoryRetrievalDiagnostics,
  MemoryRetrievalHit,
  MemoryRelationDraft,
  MemoryRelationHit,
  MemorySourceChunkHit,
  SupportExactSignals
} from "./memory-types.js";

function clamp(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function collapseWhitespace(input: string): string {
  return input.replace(/\s+/g, " ").trim();
}

function normalizeText(input: string): string {
  return collapseWhitespace(input).toLowerCase();
}

function uniqueStrings(input: Array<string | undefined | null>, limit = 12): string[] {
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

function tokenize(input: string): string[] {
  const normalized = normalizeText(input);
  if (!normalized) return [];
  const ascii = normalized.match(/[a-z0-9:_./-]{2,}/g) ?? [];
  const cjk = normalized.match(/[\u3400-\u9FBF]{2,}/g) ?? [];
  return uniqueStrings([...ascii, ...cjk], 24).map((item) => item.toLowerCase());
}

function stableUuid(parts: string[]): string {
  const hex = crypto.createHash("sha256").update(parts.join("::")).digest("hex").slice(0, 32).split("");
  hex[12] = "5";
  hex[16] = ["8", "9", "a", "b"][Number.parseInt(hex[16] ?? "0", 16) % 4];
  return `${hex.slice(0, 8).join("")}-${hex.slice(8, 12).join("")}-${hex.slice(12, 16).join("")}-${hex.slice(16, 20).join("")}-${hex.slice(20, 32).join("")}`;
}

type CandidateState = MemoryRetrievalHit & {
  exactSignalScore: number;
  aliasMatchScore: number;
  canonicalClaimScore: number;
  summaryScore: number;
  headingTitleScore: number;
  caseFrameScore: number;
  docKindScore: number;
  relationBonus: number;
  recencyBonus: number;
  finalScore: number;
  reasons: string[];
};

function defaultCandidate(hit: MemoryRetrievalHit): CandidateState {
  return {
    ...hit,
    exactSignalScore: 0,
    aliasMatchScore: 0,
    canonicalClaimScore: 0,
    summaryScore: 0,
    headingTitleScore: 0,
    caseFrameScore: 0,
    docKindScore: 0,
    relationBonus: 0,
    recencyBonus: 0,
    finalScore: 0,
    reasons: []
  };
}

function signalRowsFromExactSignals(signals: SupportExactSignals): Array<{ signalType?: string; value: string }> {
  return [
    ...signals.methods.map((value) => ({ signalType: "http_method", value })),
    ...signals.apiPaths.map((value) => ({ signalType: "api_path", value })),
    ...signals.scopes.map((value) => ({ signalType: "scope", value })),
    ...signals.callbacks.map((value) => ({ signalType: "callback", value })),
    ...signals.redirectUris.map((value) => ({ signalType: "redirect_uri", value })),
    ...signals.baseUrls.map((value) => ({ signalType: "baseurl", value })),
    ...signals.errorCodes.map((value) => ({ signalType: "error_code", value })),
    ...signals.errorTexts.map((value) => ({ signalType: "error_text", value })),
    ...signals.pageTexts.map((value) => ({ signalType: "page_text", value })),
    ...signals.objects.map((value) => ({ signalType: "object", value })),
    ...signals.actions.map((value) => ({ signalType: "action", value }))
  ];
}

function docKindCompatibility(candidateDocKind: string, requiredDocKinds: string[]): number {
  if (!requiredDocKinds.length) return 0;
  const normalized = normalizeText(candidateDocKind);
  let best = 0;
  for (const required of requiredDocKinds.map((item) => normalizeText(item))) {
    if (!required) continue;
    if (required === normalized) best = Math.max(best, 1);
    else if (
      (required === "openapi/api" && normalized.startsWith("openapi")) ||
      (required === "troubleshooting" && /troubleshooting|rules/.test(normalized)) ||
      (required === "rules" && /rules|general/.test(normalized)) ||
      (required === "deployment_runbook" && /deployment|troubleshooting/.test(normalized))
    ) {
      best = Math.max(best, 0.55);
    } else if (normalized) {
      best = Math.max(best, 0);
    }
  }
  return best;
}

function computeCaseFrameScore(hit: MemoryRetrievalHit, caseFrame?: MemoryCaseFrame): number {
  if (!caseFrame) return 0;
  let score = 0;
  const productArea = normalizeText(caseFrame.product_area ?? "");
  const deploymentModel = normalizeText(caseFrame.deployment_model ?? "");
  const actionType = normalizeText(caseFrame.action_type ?? "");
  const questionType = normalizeText(caseFrame.question_type ?? "");
  const object = normalizeText(caseFrame.object ?? "");

  if (productArea) {
    if (normalizeText(hit.productArea) === productArea) score += 0.4;
    else if (normalizeText(hit.productArea)) score -= 0.14;
  }
  if (deploymentModel) {
    if (normalizeText(hit.deploymentModel ?? "") === deploymentModel) score += 0.18;
    else if (normalizeText(hit.deploymentModel ?? "")) score -= 0.08;
  }
  if (actionType) {
    if (normalizeText(hit.actionType ?? "") === actionType) score += 0.16;
    else if (normalizeText(hit.actionType ?? "")) score -= 0.05;
  }
  if (questionType.startsWith("api_")) {
    if (hit.memoryKind === "api_operation") score += 0.14;
    if (normalizeText(hit.productArea) === "openapi") score += 0.1;
  }
  if (questionType === "troubleshooting" && hit.memoryKind === "troubleshooting_pattern") score += 0.16;
  if (object) {
    const objectText = `${hit.objectType ?? ""} ${hit.canonicalClaim} ${hit.summary}`;
    if (normalizeText(objectText).includes(object)) score += 0.18;
  }
  return clamp(score);
}

function computeRecencyBonus(updatedAt?: string): number {
  if (!updatedAt) return 0;
  const ts = Date.parse(updatedAt);
  if (!Number.isFinite(ts)) return 0;
  const ageDays = Math.max(0, (Date.now() - ts) / (24 * 60 * 60 * 1000));
  return clamp(1 - ageDays / 365);
}

function finalizeCandidate(candidate: CandidateState, requiredDocKinds: string[], caseFrame?: MemoryCaseFrame): CandidateState {
  candidate.caseFrameScore = computeCaseFrameScore(candidate, caseFrame);
  candidate.docKindScore = docKindCompatibility(candidate.docKind, requiredDocKinds);
  candidate.recencyBonus = computeRecencyBonus(candidate.updatedAt);
  candidate.finalScore = clamp(
    0.28 * candidate.exactSignalScore +
      0.16 * candidate.aliasMatchScore +
      0.14 * candidate.canonicalClaimScore +
      0.08 * candidate.summaryScore +
      0.08 * candidate.headingTitleScore +
      0.12 * candidate.caseFrameScore +
      0.08 * candidate.docKindScore +
      0.04 * candidate.relationBonus +
      0.02 * candidate.recencyBonus
  );
  return candidate;
}

function deriveReasons(candidate: CandidateState): string[] {
  const reasons: string[] = [];
  if (candidate.exactSignalScore >= 0.85) reasons.push("exact_signal");
  if (candidate.aliasMatchScore >= 0.72) reasons.push("alias_match");
  if (candidate.canonicalClaimScore >= 0.7) reasons.push("claim_match");
  if (candidate.caseFrameScore >= 0.55) reasons.push("case_frame_match");
  if (candidate.docKindScore >= 0.55) reasons.push("doc_kind_match");
  if (candidate.relationBonus > 0) reasons.push("relation_expansion");
  return reasons.slice(0, 4);
}

function relationBonusForType(type: MemoryRelationHit["relationType"]): number {
  if (type === "updates") return 0.2;
  if (type === "extends") return 0.12;
  return 0.08;
}

function overlapScore(left: string, right: string): number {
  const leftTokens = new Set(tokenize(left));
  const rightTokens = new Set(tokenize(right));
  if (!leftTokens.size || !rightTokens.size) return 0;
  let overlap = 0;
  for (const token of leftTokens) {
    if (rightTokens.has(token)) overlap += 1;
  }
  return overlap / Math.max(leftTokens.size, rightTokens.size);
}

function buildProfileDrafts(entries: KbMemoryEntry[], buildVersion: string): MemoryProfileDraft[] {
  const groups = new Map<string, KbMemoryEntry[]>();
  for (const entry of entries) {
    const key = `${entry.product_area}/${entry.object_type || "general"}`;
    const list = groups.get(key) ?? [];
    list.push(entry);
    groups.set(key, list);
  }
  return [...groups.entries()].slice(0, 24).map(([profileKey, group]) => {
    const [productArea, objectType] = profileKey.split("/");
    const title = `${productArea} ${objectType === "general" ? "support" : objectType}`.trim();
    const summaries = group.map((item) => item.summary).slice(0, 3);
    return {
      id: stableUuid([group[0].repo_id, group[0].branch, "profile", profileKey, buildVersion]),
      repo_id: group[0].repo_id,
      knowledge_space: group[0].knowledge_space,
      branch: group[0].branch,
      profile_key: profileKey,
      profile_kind: objectType === "general" ? "product_area" : "surface",
      title,
      static_summary: collapseWhitespace(summaries.join(" ")),
      dynamic_summary: null,
      build_version: buildVersion,
      metadata_json: {
        product_area: productArea,
        object_type: objectType,
        memory_count: group.length
      }
    };
  });
}

function buildRelationDrafts(entries: KbMemoryEntry[]): MemoryRelationDraft[] {
  const relations: MemoryRelationDraft[] = [];
  const active = [...entries];
  for (let index = 0; index < active.length; index += 1) {
    const current = active[index];
    for (let inner = 0; inner < active.length; inner += 1) {
      if (index === inner) continue;
      const target = active[inner];
      if (current.id === target.id) continue;
      const sameArea = current.product_area === target.product_area;
      const sameObject = normalizeText(current.object_type ?? "") && normalizeText(current.object_type ?? "") === normalizeText(target.object_type ?? "");
      const similarity = overlapScore(
        `${current.canonical_claim} ${current.summary} ${current.object_type ?? ""}`,
        `${target.canonical_claim} ${target.summary} ${target.object_type ?? ""}`
      );
      if (!sameArea || (!sameObject && similarity < 0.34)) continue;

      if (
        similarity >= 0.58 &&
        normalizeText(current.build_version) !== normalizeText(target.build_version) &&
        Date.parse(current.updated_at) < Date.parse(target.updated_at)
      ) {
        relations.push({
          id: stableUuid([current.id, target.id, "updates"]),
          from_memory_id: current.id,
          to_memory_id: target.id,
          relation_type: "updates",
          weight: clamp(0.7 + similarity * 0.3),
          metadata_json: { similarity }
        });
        continue;
      }

      const detailScore =
        (target.summary.length > current.summary.length ? 0.2 : 0) +
        (target.memory_kind === "procedure" || target.memory_kind === "troubleshooting_pattern" ? 0.2 : 0) +
        similarity;
      if (detailScore >= 0.52) {
        relations.push({
          id: stableUuid([current.id, target.id, "extends"]),
          from_memory_id: current.id,
          to_memory_id: target.id,
          relation_type: "extends",
          weight: clamp(0.45 + Math.min(similarity, 0.5)),
          metadata_json: { similarity }
        });
      }
    }
  }
  return relations.slice(0, 200);
}

export function buildMemoryBuildVersion(commitSha: string, seed?: string): string {
  const normalizedSeed = String(seed ?? "").trim();
  return normalizedSeed ? `${commitSha}:${normalizedSeed}` : `${commitSha}:${Date.now()}`;
}

export async function syncDocumentMemoryGraph(input: {
  knowledgeSpace: KbKnowledgeSpace;
  repoId: string;
  branch: string;
  commitSha: string;
  buildVersion?: string;
  activationMode?: "immediate" | "staged";
  docId: string;
  path: string;
  title: string;
  docSupportEvidence: Record<string, unknown>;
  chunks: Array<{
    id: string;
    headingPath: string;
    ordinal: number;
    content: string;
    metadata: Record<string, unknown>;
  }>;
  memoryEntries?: MemoryEntryDraft[];
}): Promise<void> {
  if (!env.FEATURE_KB_MEMORY_GRAPH) return;
  const buildVersion = input.buildVersion?.trim() || buildMemoryBuildVersion(input.commitSha);
  const activationMode = input.activationMode ?? "immediate";
  const productArea = String(input.docSupportEvidence.product_area ?? "general") || "general";
  await memoryRepo.withMemoryScopeLock(
    {
      knowledgeSpace: input.knowledgeSpace,
      repoId: input.repoId,
      branch: input.branch,
      productArea,
      buildVersion: activationMode === "staged" ? buildVersion : undefined
    },
    async () => {
      await memoryRepo.deactivateMemoryArtifactsByDocument(input.docId);
      await memoryRepo.deleteBuildScopedMemoryEntriesForDocument(input.docId, buildVersion);

      const entries =
        input.memoryEntries && input.memoryEntries.length
          ? input.memoryEntries
          : extractMemoryEntriesForDocument({
              repoId: input.repoId,
              knowledgeSpace: input.knowledgeSpace,
              branch: input.branch,
              docId: input.docId,
              path: input.path,
              title: input.title,
              buildVersion,
              docSupportEvidence: input.docSupportEvidence,
              chunks: input.chunks
            });

      for (const entry of entries) {
        await memoryRepo.upsertMemoryEntry(entry);
        await memoryRepo.replaceMemoryAliases(entry.id, entry.aliases);
        await memoryRepo.replaceMemorySignals(entry.id, entry.signals);
        await memoryRepo.replaceMemorySources(entry.id, entry.sources);
        await memoryRepo.replaceMemoryCitations(entry.id, entry.citations ?? []);
      }

      if (activationMode === "immediate") {
        await memoryRepo.markPriorBuildVersionInactive(input.repoId, input.branch, input.path, buildVersion);
      }

      const scopeEntries = await memoryRepo.listActiveMemoryEntriesForScope({
        knowledgeSpace: input.knowledgeSpace,
        repoId: input.repoId,
        branch: input.branch,
        productArea,
        buildVersion: activationMode === "staged" ? buildVersion : undefined,
        limit: 200
      });

      if (env.FEATURE_KB_MEMORY_RELATION_EXPANSION) {
        const relations = buildRelationDrafts(scopeEntries);
        await memoryRepo.replaceRelationsForMemoryIds(scopeEntries.map((item) => item.id), relations);
      }

      if (env.FEATURE_KB_MEMORY_PROFILES) {
        const profiles = buildProfileDrafts(scopeEntries, buildVersion);
        await memoryRepo.upsertMemoryProfiles(profiles);
        if (activationMode === "immediate") {
          await memoryRepo.deactivatePriorProfiles(
            input.repoId,
            input.branch,
            buildVersion,
            profiles.map((item) => item.profile_key)
          );
        }
      }
    }
  );
}

export async function retrieveGroundedMemoryHits(input: {
  query: string;
  rewrites?: string[];
  knowledgeSpace: KbKnowledgeSpace;
  repoId?: string;
  branch?: string;
  limit?: number;
  supportSignals?: SupportExactSignals;
  caseFrame?: MemoryCaseFrame;
  requiredDocKinds?: string[];
}): Promise<{ hits: RetrievalHit[]; diagnostics: MemoryRetrievalDiagnostics }> {
  const diagnostics: MemoryRetrievalDiagnostics = {
    rewrittenQueries: [],
    extractedSignals: input.supportSignals ?? extractSupportSignals(input.query),
    candidateCounts: {
      entry: 0,
      alias: 0,
      signal: 0,
      profile: 0,
      relation: 0,
      grounded: 0
    },
    topMemoryReasons: []
  };

  if (!env.FEATURE_KB_MEMORY_GRAPH) {
    return { hits: [], diagnostics };
  }

  const rewrites = uniqueStrings([input.query, ...(input.rewrites ?? [])], env.FEATURE_KB_MEMORY_QUERY_REWRITE ? 6 : 1);
  diagnostics.rewrittenQueries = rewrites;
  const requiredDocKinds = input.requiredDocKinds ?? input.caseFrame?.required_doc_kinds ?? [];
  const rawLimit = 24;

  const [entryHits, aliasHits, profileHits] = await Promise.all([
    Promise.all(
      rewrites.map((query) =>
        memoryRepo.searchMemoryEntries({ knowledgeSpace: input.knowledgeSpace, repoId: input.repoId, branch: input.branch, query, limit: rawLimit })
      )
    ).then(
      (rows) => rows.flat()
    ),
    Promise.all(
      rewrites.map((query) =>
        memoryRepo.searchMemoryAliases({ knowledgeSpace: input.knowledgeSpace, repoId: input.repoId, branch: input.branch, query, limit: rawLimit })
      )
    ).then(
      (rows) => rows.flat()
    ),
    env.FEATURE_KB_MEMORY_PROFILES
      ? Promise.all(
          rewrites.slice(0, 2).map((query) =>
            memoryRepo.searchMemoryProfiles({
              knowledgeSpace: input.knowledgeSpace,
              repoId: input.repoId,
              branch: input.branch,
              query,
              caseFrame: input.caseFrame,
              limit: 2
            })
          )
        ).then((rows) => rows.flat())
      : Promise.resolve([])
  ]);

  const signalHits = diagnostics.extractedSignals.all.length
    ? await memoryRepo.searchMemorySignals({
        knowledgeSpace: input.knowledgeSpace,
        repoId: input.repoId,
        branch: input.branch,
        signals: signalRowsFromExactSignals(diagnostics.extractedSignals),
        limit: rawLimit
      })
    : [];

  diagnostics.candidateCounts.entry = entryHits.length;
  diagnostics.candidateCounts.alias = aliasHits.length;
  diagnostics.candidateCounts.signal = signalHits.length;
  diagnostics.candidateCounts.profile = profileHits.length;

  const candidates = new Map<string, CandidateState>();
  const upsertCandidate = (hit: MemoryRetrievalHit) => {
    const candidate = candidates.get(hit.memoryId) ?? defaultCandidate(hit);
    candidate.title = candidate.title || hit.title;
    candidate.canonicalClaim = candidate.canonicalClaim || hit.canonicalClaim;
    candidate.summary = candidate.summary || hit.summary;
    candidate.score = Math.max(candidate.score, hit.score);
    candidate.updatedAt = hit.updatedAt ?? candidate.updatedAt;
    candidate.buildVersion = hit.buildVersion ?? candidate.buildVersion;

    if (hit.source === "memory_entry") {
      candidate.canonicalClaimScore = Math.max(candidate.canonicalClaimScore, Number(hit.metadata?.canonicalClaimScore ?? hit.score));
      candidate.summaryScore = Math.max(candidate.summaryScore, Number(hit.metadata?.summaryScore ?? 0));
      candidate.headingTitleScore = Math.max(candidate.headingTitleScore, Number(hit.metadata?.headingTitleScore ?? 0));
    } else if (hit.source === "alias") {
      candidate.aliasMatchScore = Math.max(candidate.aliasMatchScore, Number(hit.metadata?.aliasMatchScore ?? hit.score));
    } else if (hit.source === "signal") {
      candidate.exactSignalScore = Math.max(candidate.exactSignalScore, Number(hit.metadata?.exactSignalScore ?? hit.score));
    }

    if (candidate.source === "memory_entry") {
      candidate.source = hit.source === "signal" ? "signal" : candidate.source;
    } else if (hit.source === "signal" || (hit.source === "alias" && candidate.source !== "signal")) {
      candidate.source = hit.source;
    }
    candidates.set(hit.memoryId, candidate);
  };

  entryHits.forEach(upsertCandidate);
  aliasHits.forEach(upsertCandidate);
  signalHits.forEach(upsertCandidate);

  let ranked = [...candidates.values()]
    .map((candidate) => finalizeCandidate(candidate, requiredDocKinds, input.caseFrame))
    .sort((left, right) => right.finalScore - left.finalScore)
    .slice(0, 20);

  if (env.FEATURE_KB_MEMORY_RELATION_EXPANSION && ranked.length) {
    const relationHits = await memoryRepo.expandMemoryRelations({
      knowledgeSpace: input.knowledgeSpace,
      memoryIds: ranked.map((item) => item.memoryId),
      limitPerMemory: 4
    });
    diagnostics.candidateCounts.relation = relationHits.length;
    for (const relation of relationHits) {
      const candidate = candidates.get(relation.memoryId) ?? defaultCandidate(relation);
      candidate.relationBonus = Math.max(candidate.relationBonus, relationBonusForType(relation.relationType) * relation.relationWeight);
      candidate.canonicalClaimScore = Math.max(candidate.canonicalClaimScore, clamp(overlapScore(input.query, relation.canonicalClaim)));
      candidate.summaryScore = Math.max(candidate.summaryScore, clamp(overlapScore(input.query, relation.summary)));
      candidate.headingTitleScore = Math.max(candidate.headingTitleScore, clamp(overlapScore(input.query, `${relation.title ?? ""} ${relation.path}`)));
      candidate.source = candidate.source === "signal" || candidate.source === "alias" ? candidate.source : "relation";
      candidates.set(relation.memoryId, candidate);
    }
    ranked = [...candidates.values()]
      .map((candidate) => finalizeCandidate(candidate, requiredDocKinds, input.caseFrame))
      .sort((left, right) => right.finalScore - left.finalScore)
      .slice(0, 16);
  }

  const candidateMap = new Map(ranked.map((item) => [item.memoryId, item]));
  const citationSources = ranked.length
    ? await memoryRepo.resolveMemorySourcesToCitations({
        knowledgeSpace: input.knowledgeSpace,
        memoryIds: ranked.slice(0, 8).map((item) => item.memoryId),
        limitPerMemory: 2
      })
    : [];
  const groundedSources =
    citationSources.length > 0
      ? citationSources
      : ranked.length
      ? await memoryRepo.resolveMemorySourcesToChunks({
          knowledgeSpace: input.knowledgeSpace,
          memoryIds: ranked.slice(0, 8).map((item) => item.memoryId),
          limitPerMemory: 2
        })
      : [];
  diagnostics.candidateCounts.grounded = groundedSources.length;

  const hits = groundedSources
    .map((source): RetrievalHit | null => {
      const candidate = candidateMap.get(source.memoryId);
      if (!candidate) return null;
      const isCitation = "citationId" in source;
      const supportMetadata = {
        ...(((source.docMetadata ?? {}) as Record<string, unknown>).supportEvidence as Record<string, unknown> | undefined),
        ...(isCitation ? ((source.citationMetadata ?? {}) as Record<string, unknown>) : (((source.chunkMetadata ?? {}) as Record<string, unknown>).supportEvidence as Record<string, unknown> | undefined)),
        memory_id: source.memoryId,
        memory_kind: candidate.memoryKind,
        memory_source: candidate.source,
        memory_relation_path: candidate.relationBonus > 0 ? candidate.reasons.filter((item) => item === "relation_expansion") : [],
        memory_doc_kind: candidate.docKind,
        citation_family: isCitation ? source.citationFamily : "doc_chunk",
        source_family: isCitation ? source.sourceFamily : "doc_page"
      };
      return {
        chunkId: isCitation ? source.citationId : source.chunkId,
        documentId: source.documentId,
        repoId: source.repoId,
        repo: source.repo,
        branch: source.branch,
        path: source.path,
        sourceUrl: source.sourceUrl,
        repoSourceUrl: source.repoSourceUrl,
        commitSha: source.commitSha,
        title: source.title,
        headingPath: source.headingPath,
        snippet: source.snippet,
        score: 0.08 + candidate.finalScore * 0.12 + clamp(source.sourceScore) * 0.02,
        rankSignals: {
          memoryGraph: candidate.finalScore,
          memorySourceScore: source.sourceScore
        },
        supportMetadata,
        chunkMetadata: isCitation ? undefined : source.chunkMetadata,
        docMetadata: source.docMetadata
      };
    })
    .filter((item): item is RetrievalHit => Boolean(item))
    .sort((left, right) => right.score - left.score);

  diagnostics.topMemoryReasons = ranked.slice(0, 5).map((candidate) => {
    candidate.reasons = deriveReasons(candidate);
    return {
      memoryId: candidate.memoryId,
      score: Number(candidate.finalScore.toFixed(4)),
      source: candidate.source,
      reasons: candidate.reasons
    };
  });

  return {
    hits,
    diagnostics
  };
}
