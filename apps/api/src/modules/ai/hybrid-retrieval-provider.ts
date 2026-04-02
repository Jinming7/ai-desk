import { embedText, toVectorLiteral } from "../github-kb/embedding.js";
import * as memoryRepo from "../github-kb/memory-repository.js";
import type { MemoryRetrievalHit } from "../github-kb/memory-types.js";
import type { KbPublication, RetrievalHit } from "../github-kb/types.js";
import * as repo from "../github-kb/repository.js";
import type {
  HybridGroundedEvidence,
  HybridPublication,
  HybridRetrievalProvider,
  HybridRetrievalRequest,
  HybridFusedCandidate,
  HybridRecallCandidate
} from "./hybrid-retrieval-types.js";

type HybridRepositoryApi = Pick<
  typeof repo,
  | "getPublication"
  | "listPublications"
  | "searchStructuredArtifactCandidates"
  | "searchKeywordCandidates"
  | "searchVectorCandidates"
  | "resolveArtifactCitations"
>;

type HybridMemoryRepositoryApi = Pick<
  typeof memoryRepo,
  | "searchMemorySignals"
  | "searchMemoryEntries"
  | "searchMemoryAliases"
  | "expandMemoryRelations"
  | "resolveMemorySourcesToCitations"
  | "resolveMemorySourcesToChunks"
>;

interface DefaultHybridRetrievalProviderDeps {
  repoApi: HybridRepositoryApi;
  memoryRepoApi: HybridMemoryRepositoryApi;
  embedTextApi: typeof embedText;
  toVectorLiteralApi: typeof toVectorLiteral;
}

type DefaultHybridRetrievalProviderDepOverrides = {
  repoApi?: Partial<HybridRepositoryApi>;
  memoryRepoApi?: Partial<HybridMemoryRepositoryApi>;
  embedTextApi?: typeof embedText;
  toVectorLiteralApi?: typeof toVectorLiteral;
};

const defaultProviderDeps: DefaultHybridRetrievalProviderDeps = {
  repoApi: repo,
  memoryRepoApi: memoryRepo,
  embedTextApi: embedText,
  toVectorLiteralApi: toVectorLiteral
};

function createProviderDeps(overrides?: DefaultHybridRetrievalProviderDepOverrides): DefaultHybridRetrievalProviderDeps {
  return {
    repoApi: {
      ...defaultProviderDeps.repoApi,
      ...(overrides?.repoApi ?? {})
    },
    memoryRepoApi: {
      ...defaultProviderDeps.memoryRepoApi,
      ...(overrides?.memoryRepoApi ?? {})
    },
    embedTextApi: overrides?.embedTextApi ?? defaultProviderDeps.embedTextApi,
    toVectorLiteralApi: overrides?.toVectorLiteralApi ?? defaultProviderDeps.toVectorLiteralApi
  };
}

function uniqueStrings(input: Array<string | null | undefined>, limit = 12): string[] {
  const seen = new Set<string>();
  const values: string[] = [];
  for (const item of input) {
    const value = String(item ?? "").trim();
    if (!value) continue;
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    values.push(value);
    if (values.length >= limit) break;
  }
  return values;
}

function asPublication(input: KbPublication): HybridPublication {
  return {
    knowledgeSpace: input.knowledge_space,
    repoId: input.repo_id,
    branch: input.branch,
    publishedBuildVersion: input.published_build_version
  };
}

function extractSearchTerms(request: HybridRetrievalRequest): string[] {
  return uniqueStrings(
    [
      request.query,
      ...request.rewrites,
      ...request.requiredDocKinds,
      ...request.requiredObjectTypes,
      ...request.supportSignals.all
    ],
    16
  );
}

function mapMemoryHit(hit: MemoryRetrievalHit, channel: HybridRecallCandidate["channel"], request: HybridRetrievalRequest): HybridRecallCandidate {
  return {
    channel,
    candidateId: hit.memoryId,
    candidateType: "memory",
    candidateFamily: hit.memoryKind,
    retrievalAbstractionId: hit.memoryId,
    rawScore: hit.score,
    buildVersion: hit.buildVersion ?? "",
    knowledgeSpace: request.knowledgeSpace,
    repoId: request.repoId,
    repo: undefined,
    branch: request.branch,
    title: hit.title ?? hit.canonicalClaim,
    path: hit.path,
    headingPath: String(hit.metadata?.headingPath ?? hit.metadata?.heading_path ?? "") || null,
    snippet: hit.summary,
    docKind: hit.docKind,
    objectType: hit.objectType,
    productArea: hit.productArea,
    deploymentModel: hit.deploymentModel,
    citationCandidateIds: [],
    matchedFields: Object.keys(hit.metadata ?? {}),
    matchMetadata: hit.metadata ?? {},
    citationAvailability: "linked",
    supportMetadata: {
      memory_kind: hit.memoryKind,
      product_area: hit.productArea,
      deployment_model: hit.deploymentModel,
      doc_kind: hit.docKind
    }
  };
}

function mapRetrievalHit(hit: RetrievalHit, channel: HybridRecallCandidate["channel"], request: HybridRetrievalRequest): HybridRecallCandidate {
  const supportMetadata = (hit.supportMetadata ?? {}) as Record<string, unknown>;
  return {
    channel,
    candidateId: hit.chunkId,
    candidateType: "chunk",
    candidateFamily: String(supportMetadata.evidence_kind ?? supportMetadata.source_family ?? "doc_chunk"),
    retrievalAbstractionId: hit.chunkId,
    rawScore: hit.score,
    buildVersion: String((hit.docMetadata ?? {}).build_version ?? (hit.chunkMetadata ?? {}).build_version ?? ""),
    knowledgeSpace: request.knowledgeSpace,
    repoId: hit.repoId,
    repo: hit.repo,
    branch: hit.branch,
    sourceDocumentId: hit.documentId,
    title: hit.title,
    path: hit.path,
    headingPath: hit.headingPath,
    snippet: hit.snippet,
    sourceUrl: hit.sourceUrl,
    repoSourceUrl: hit.repoSourceUrl,
    commitSha: hit.commitSha,
    docKind: String(supportMetadata.doc_kind ?? ""),
    objectType: String(supportMetadata.object_type ?? ""),
    productArea: String(supportMetadata.product_area ?? ""),
    deploymentModel: String(supportMetadata.deployment_model ?? ""),
    citationCandidateIds: [],
    matchedFields: Object.keys(supportMetadata),
    matchMetadata: {
      rankSignals: hit.rankSignals ?? {},
      vectorScore: hit.vectorScore ?? null,
      lexicalScore: hit.lexicalScore ?? null
    },
    citationAvailability: "available",
    supportMetadata,
    chunkMetadata: hit.chunkMetadata,
    docMetadata: hit.docMetadata
  };
}

function mapArtifactRow(
  row: Awaited<ReturnType<typeof repo.searchStructuredArtifactCandidates>>[number],
  channel: HybridRecallCandidate["channel"],
  request: HybridRetrievalRequest
): HybridRecallCandidate {
  return {
    channel,
    candidateId: row.artifact_id,
    candidateType: "artifact",
    candidateFamily: row.artifact_family,
    retrievalAbstractionId: row.artifact_id,
    rawScore: row.score,
    buildVersion: row.build_version,
    knowledgeSpace: request.knowledgeSpace,
    repoId: request.repoId,
    repo: row.repo,
    branch: row.branch,
    title: row.title,
    path: row.path,
    headingPath: row.heading_path,
    snippet: row.snippet,
    sourceUrl: row.source_url,
    repoSourceUrl: row.repo_source_url,
    commitSha: row.commit_sha,
    docKind: row.doc_kind,
    objectType: row.object_type,
    productArea: row.product_area,
    deploymentModel: row.deployment_model,
    citationCandidateIds: [],
    matchedFields: extractSearchTerms(request).filter((term) => row.snippet.toLowerCase().includes(term.toLowerCase()) || row.title.toLowerCase().includes(term.toLowerCase())),
    matchMetadata: {},
    citationAvailability: "available",
    supportMetadata: row.support_metadata_json ?? undefined
  };
}

function mapDirectCandidateToEvidence(candidate: HybridFusedCandidate): HybridGroundedEvidence | null {
  if (!candidate.sourceUrl || !candidate.title || !candidate.snippet || !candidate.sourceDocumentId) return null;
  return {
    candidateId: candidate.candidateId,
    groundedFrom: candidate.candidateType,
    evidenceId: candidate.candidateId,
    evidenceType: candidate.candidateType === "citation" ? "citation" : "chunk",
    evidenceFamily: candidate.candidateFamily,
    documentId: candidate.sourceDocumentId,
    repoId: candidate.repoId ?? "",
    repo: candidate.repo ?? "",
    branch: candidate.branch ?? "",
    path: candidate.path,
    sourceUrl: candidate.sourceUrl,
    repoSourceUrl: candidate.repoSourceUrl,
    commitSha: candidate.commitSha,
    title: candidate.title,
    headingPath: candidate.headingPath,
    snippet: candidate.snippet,
    buildVersion: candidate.buildVersion,
    knowledgeSpace: candidate.knowledgeSpace,
    sourceFamily: String(candidate.supportMetadata?.source_family ?? "doc_page"),
    supportMetadata: candidate.supportMetadata,
    chunkMetadata: candidate.chunkMetadata,
    docMetadata: candidate.docMetadata,
    sourceCandidateType: candidate.candidateType
  };
}

export class DefaultHybridRetrievalProvider implements HybridRetrievalProvider {
  private readonly deps: DefaultHybridRetrievalProviderDeps;

  constructor(deps?: DefaultHybridRetrievalProviderDepOverrides) {
    this.deps = createProviderDeps(deps);
  }

  async resolvePublication(request: HybridRetrievalRequest): Promise<HybridPublication | null> {
    if (request.repoId && request.branch) {
      const publication = await this.deps.repoApi.getPublication({
        knowledgeSpace: request.knowledgeSpace,
        repoId: request.repoId,
        branch: request.branch
      });
      return publication ? asPublication(publication) : null;
    }
    const publications = await this.deps.repoApi.listPublications({
      knowledgeSpace: request.knowledgeSpace,
      repoId: request.repoId,
      branch: request.branch
    });
    return publications.length === 1 ? asPublication(publications[0]) : null;
  }

  async recallExactSignal(request: HybridRetrievalRequest): Promise<HybridRecallCandidate[]> {
    const exactSignals = request.supportSignals.all;
    if (!exactSignals.length) return [];
    const [signalHits, artifactHits] = await Promise.all([
      this.deps.memoryRepoApi.searchMemorySignals({
        knowledgeSpace: request.knowledgeSpace,
        repoId: request.repoId,
        branch: request.branch,
        signals: [
          ...request.supportSignals.methods.map((value) => ({ signalType: "http_method", value })),
          ...request.supportSignals.apiPaths.map((value) => ({ signalType: "api_path", value })),
          ...request.supportSignals.scopes.map((value) => ({ signalType: "scope", value })),
          ...request.supportSignals.callbacks.map((value) => ({ signalType: "callback", value })),
          ...request.supportSignals.redirectUris.map((value) => ({ signalType: "redirect_uri", value })),
          ...request.supportSignals.baseUrls.map((value) => ({ signalType: "baseurl", value })),
          ...request.supportSignals.errorCodes.map((value) => ({ signalType: "error_code", value })),
          ...request.supportSignals.errorTexts.map((value) => ({ signalType: "error_text", value })),
          ...request.supportSignals.pageTexts.map((value) => ({ signalType: "page_text", value })),
          ...request.supportSignals.objects.map((value) => ({ signalType: "object", value })),
          ...request.supportSignals.actions.map((value) => ({ signalType: "action", value }))
        ],
        limit: request.topK * 3
      }),
      this.deps.repoApi.searchStructuredArtifactCandidates({
        knowledgeSpace: request.knowledgeSpace,
        repoId: request.repoId,
        branch: request.branch,
        query: request.query,
        likeTerms: exactSignals,
        exactTerms: exactSignals,
        exactOnly: true,
        limit: request.topK * 2
      })
    ]);

    return [
      ...signalHits.map((item) => mapMemoryHit(item, "exact_signal", request)),
      ...artifactHits.map((item) => mapArtifactRow(item, "exact_signal", request))
    ];
  }

  async recallSparseMemory(request: HybridRetrievalRequest): Promise<HybridRecallCandidate[]> {
    const rewrites = uniqueStrings([request.query, ...request.rewrites], 6);
    const [entryHits, aliasHits] = await Promise.all([
      Promise.all(
        rewrites.map((query) =>
          this.deps.memoryRepoApi.searchMemoryEntries({
            knowledgeSpace: request.knowledgeSpace,
            repoId: request.repoId,
            branch: request.branch,
            query,
            limit: request.topK * 2
          })
        )
      ),
      Promise.all(
        rewrites.map((query) =>
          this.deps.memoryRepoApi.searchMemoryAliases({
            knowledgeSpace: request.knowledgeSpace,
            repoId: request.repoId,
            branch: request.branch,
            query,
            limit: request.topK * 2
          })
        )
      )
    ]);

    return [
      ...entryHits.flat().map((item) => mapMemoryHit(item, "sparse_memory", request)),
      ...aliasHits.flat().map((item) => mapMemoryHit(item, "sparse_memory", request))
    ];
  }

  async recallSparseCitation(request: HybridRetrievalRequest): Promise<HybridRecallCandidate[]> {
    const rewrites = uniqueStrings([request.query, ...request.rewrites], 4);
    const chunks = await Promise.all(
      rewrites.map((query) =>
        this.deps.repoApi.searchKeywordCandidates({
          knowledgeSpace: request.knowledgeSpace,
          repoId: request.repoId,
          branch: request.branch,
          query,
          limit: request.topK * 3
        })
      )
    );
    return chunks.flat().map((item) => mapRetrievalHit(item, "sparse_citation", request));
  }

  async recallDenseCitation(request: HybridRetrievalRequest): Promise<HybridRecallCandidate[]> {
    const rewrites = uniqueStrings([request.query, ...request.rewrites], 2);
    const vectors = await Promise.all(
      rewrites.map(async (query) => {
        try {
          const embedded = await this.deps.embedTextApi(query);
          return await this.deps.repoApi.searchVectorCandidates({
            knowledgeSpace: request.knowledgeSpace,
            repoId: request.repoId,
            branch: request.branch,
            vectorLiteral: this.deps.toVectorLiteralApi(embedded.vector),
            limit: request.topK * 3
          });
        } catch {
          return [];
        }
      })
    );
    return vectors.flat().map((item) => mapRetrievalHit(item, "dense_citation", request));
  }

  async recallStructuredArtifact(request: HybridRetrievalRequest): Promise<HybridRecallCandidate[]> {
    const rows = await this.deps.repoApi.searchStructuredArtifactCandidates({
      knowledgeSpace: request.knowledgeSpace,
      repoId: request.repoId,
      branch: request.branch,
      query: request.query,
      likeTerms: extractSearchTerms(request),
      exactTerms: request.supportSignals.all,
      limit: request.topK * 3
    });
    return rows.map((item) => mapArtifactRow(item, "structured_artifact", request));
  }

  async recallRelationExpansion(
    request: HybridRetrievalRequest,
    _publication: HybridPublication,
    seededCandidates: HybridFusedCandidate[]
  ): Promise<HybridRecallCandidate[]> {
    const memoryIds = seededCandidates
      .filter((item) => item.candidateType === "memory")
      .map((item) => item.candidateId);
    if (!memoryIds.length) return [];
    const hits = await this.deps.memoryRepoApi.expandMemoryRelations({
      knowledgeSpace: request.knowledgeSpace,
      memoryIds,
      limitPerMemory: 2
    });
    return hits.map((item) => mapMemoryHit(item, "relation_expansion", request));
  }

  async groundCandidates(
    request: HybridRetrievalRequest,
    _publication: HybridPublication,
    candidates: HybridFusedCandidate[]
  ): Promise<HybridGroundedEvidence[]> {
    const grounded: HybridGroundedEvidence[] = [];
    const memoryCandidates = candidates.filter((item) => item.candidateType === "memory");
    const artifactCandidates = candidates.filter((item) => item.candidateType === "artifact");
    const directCandidates = candidates.filter((item) => item.candidateType === "chunk" || item.candidateType === "citation");

    if (memoryCandidates.length) {
      const citations = await this.deps.memoryRepoApi.resolveMemorySourcesToCitations({
        knowledgeSpace: request.knowledgeSpace,
        memoryIds: memoryCandidates.map((item) => item.candidateId),
        limitPerMemory: 2
      });
      grounded.push(
        ...citations.map((item) => ({
          candidateId: item.memoryId,
          groundedFrom: "memory" as const,
          evidenceId: item.citationId,
          evidenceType: "citation" as const,
          evidenceFamily: item.citationFamily,
          documentId: item.documentId,
          repoId: item.repoId,
          repo: item.repo,
          branch: item.branch,
          path: item.path,
          sourceUrl: item.sourceUrl,
          repoSourceUrl: item.repoSourceUrl,
          commitSha: item.commitSha,
          title: item.title,
          headingPath: item.headingPath,
          snippet: item.snippet,
          buildVersion: memoryCandidates.find((candidate) => candidate.candidateId === item.memoryId)?.buildVersion ?? "",
          knowledgeSpace: request.knowledgeSpace,
          sourceFamily: item.sourceFamily,
          supportMetadata: item.memoryMetadata,
          docMetadata: item.docMetadata,
          sourceCandidateType: "memory" as const
        }))
      );

      const unresolvedMemoryIds = memoryCandidates
        .map((item) => item.candidateId)
        .filter((item) => !citations.some((citation) => citation.memoryId === item));
      if (unresolvedMemoryIds.length) {
        const chunks = await this.deps.memoryRepoApi.resolveMemorySourcesToChunks({
          knowledgeSpace: request.knowledgeSpace,
          memoryIds: unresolvedMemoryIds,
          limitPerMemory: 2
        });
        grounded.push(
          ...chunks.map((item) => ({
            candidateId: item.memoryId,
            groundedFrom: "memory" as const,
            evidenceId: item.chunkId,
            evidenceType: "chunk" as const,
            evidenceFamily: "doc_chunk",
            documentId: item.documentId,
            repoId: item.repoId,
            repo: item.repo,
            branch: item.branch,
            path: item.path,
            sourceUrl: item.sourceUrl,
            repoSourceUrl: item.repoSourceUrl,
            commitSha: item.commitSha,
            title: item.title,
            headingPath: item.headingPath,
            snippet: item.snippet,
            buildVersion: memoryCandidates.find((candidate) => candidate.candidateId === item.memoryId)?.buildVersion ?? "",
            knowledgeSpace: request.knowledgeSpace,
            sourceFamily: "doc_page",
            supportMetadata: item.memoryMetadata,
            chunkMetadata: item.chunkMetadata,
            docMetadata: item.docMetadata,
            sourceCandidateType: "memory" as const
          }))
        );
      }
    }

    if (artifactCandidates.length) {
      const citations = await this.deps.repoApi.resolveArtifactCitations({
        knowledgeSpace: request.knowledgeSpace,
        artifactIds: artifactCandidates.map((item) => item.candidateId),
        limitPerArtifact: 2
      });
      grounded.push(
        ...citations.map((item) => ({
          candidateId: item.artifact_id,
          groundedFrom: "artifact" as const,
          evidenceId: item.citation_id,
          evidenceType: "citation" as const,
          evidenceFamily: item.citation_family,
          documentId: item.document_id,
          repoId: item.repo_id,
          repo: item.repo,
          branch: item.branch,
          path: item.path,
          sourceUrl: item.source_url,
          repoSourceUrl: item.repo_source_url,
          commitSha: item.commit_sha,
          title: item.title,
          headingPath: item.heading_path,
          snippet: item.snippet,
          buildVersion: item.build_version,
          knowledgeSpace: item.knowledge_space,
          sourceFamily: item.source_family,
          supportMetadata: artifactCandidates.find((candidate) => candidate.candidateId === item.artifact_id)?.supportMetadata,
          docMetadata: item.doc_metadata_json ?? undefined,
          sourceCandidateType: "artifact" as const
        }))
      );
    }

    grounded.push(...directCandidates.map(mapDirectCandidateToEvidence).filter((item): item is HybridGroundedEvidence => Boolean(item)));
    return grounded;
  }
}
