import assert from "node:assert/strict";
import { test } from "node:test";
import { env } from "../../config/env.js";
import type { SearchReference, SupportCaseFrame } from "./types.js";
import {
  DefaultHybridEvidenceGate,
  HybridRetrievalRuntime,
  buildHybridRetrievalRequest
} from "./hybrid-retrieval.js";
import { DefaultHybridRetrievalProvider } from "./hybrid-retrieval-provider.js";
import type {
  HybridFusedCandidate,
  HybridGroundedEvidence,
  HybridRetrievalProvider,
  HybridRetrievalRequest,
  HybridRecallCandidate
} from "./hybrid-retrieval-types.js";
import { SearchOrchestrator } from "./search-orchestrator.js";

function createCaseFrame(overrides: Partial<SupportCaseFrame> = {}): SupportCaseFrame {
  return {
    goal: "configure github callback",
    symptom: "page not found after oauth callback",
    object: "redirect uri",
    action_type: "configure",
    deployment_model: "shared",
    product_area: "integrations",
    constraints: [],
    missing_critical_info: [],
    retrieval_queries: ["github callback 404"],
    required_doc_kinds: ["deployment_runbook"],
    question_type: "troubleshooting",
    ...overrides
  };
}

function createCandidate(input: Partial<HybridRecallCandidate> & Pick<HybridRecallCandidate, "channel" | "candidateId">): HybridRecallCandidate {
  return {
    channel: input.channel,
    candidateId: input.candidateId,
    candidateType: input.candidateType ?? "memory",
    candidateFamily: input.candidateFamily ?? "troubleshooting_pattern",
    retrievalAbstractionId: input.retrievalAbstractionId ?? input.candidateId,
    rawScore: input.rawScore ?? 0.5,
    buildVersion: input.buildVersion ?? "build-v1",
    knowledgeSpace: input.knowledgeSpace ?? "support-local",
    repoId: input.repoId ?? "repo-1",
    repo: input.repo ?? "BangWork/docs-com",
    branch: input.branch ?? "main",
    sourceDocumentId: input.sourceDocumentId ?? "doc-callback",
    title: input.title ?? input.candidateId,
    path: input.path ?? "docs/callback.md",
    headingPath: input.headingPath ?? "OAuth > Callback",
    snippet: input.snippet ?? "Callback redirects must match the configured redirect URI.",
    sourceUrl: input.sourceUrl ?? "https://docs.ones.com/open-docs/callback",
    repoSourceUrl: input.repoSourceUrl ?? "https://github.com/BangWork/docs-com/blob/main/docs/callback.md",
    commitSha: input.commitSha ?? "abc1234",
    docKind: input.docKind ?? "troubleshooting",
    objectType: input.objectType ?? "redirect uri",
    productArea: input.productArea ?? "integrations",
    deploymentModel: input.deploymentModel ?? "shared",
    citationCandidateIds: input.citationCandidateIds ?? [],
    matchedFields: input.matchedFields ?? [],
    matchMetadata: input.matchMetadata ?? {},
    citationAvailability: input.citationAvailability ?? "linked",
    supportMetadata: input.supportMetadata ?? { evidence_kind: "troubleshooting", product_area: "integrations" },
    chunkMetadata: input.chunkMetadata,
    docMetadata: input.docMetadata,
    degradedParser: input.degradedParser ?? false
  };
}

function createFusedCandidate(
  input: Partial<HybridFusedCandidate> & Pick<HybridFusedCandidate, "channel" | "candidateId">
): HybridFusedCandidate {
  return {
    ...createCandidate(input),
    rawChannelScores: input.rawChannelScores ?? { [input.channel]: input.rawScore ?? 0.5 },
    channelRanks: input.channelRanks ?? { [input.channel]: 1 },
    fusionScore: input.fusionScore ?? 0.8,
    rerankScore: input.rerankScore ?? 0.8,
    channelAgreement: input.channelAgreement ?? 1
  };
}

function createEvidence(input: Partial<HybridGroundedEvidence> & Pick<HybridGroundedEvidence, "candidateId" | "documentId">): HybridGroundedEvidence {
  return {
    candidateId: input.candidateId,
    groundedFrom: input.groundedFrom ?? "memory",
    evidenceId: input.evidenceId ?? `${input.candidateId}:citation`,
    evidenceType: input.evidenceType ?? "citation",
    evidenceFamily: input.evidenceFamily ?? "doc_chunk",
    documentId: input.documentId,
    repoId: input.repoId ?? "repo-1",
    repo: input.repo ?? "BangWork/docs-com",
    branch: input.branch ?? "main",
    path: input.path ?? "docs/callback.md",
    sourceUrl: input.sourceUrl ?? "https://docs.ones.com/open-docs/callback",
    repoSourceUrl: input.repoSourceUrl ?? "https://github.com/BangWork/docs-com/blob/main/docs/callback.md",
    commitSha: input.commitSha ?? "abc1234",
    title: input.title ?? "Callback Troubleshooting",
    headingPath: input.headingPath ?? "OAuth > Callback",
    snippet: input.snippet ?? "The redirect URI configured in the integration must exactly match the callback request.",
    buildVersion: input.buildVersion ?? "build-v1",
    knowledgeSpace: input.knowledgeSpace ?? "support-local",
    sourceFamily: input.sourceFamily ?? "doc_page",
    supportMetadata: input.supportMetadata ?? { evidence_kind: "troubleshooting", product_area: "integrations" },
    chunkMetadata: input.chunkMetadata,
    docMetadata: input.docMetadata,
    sourceCandidateType: input.sourceCandidateType ?? "memory"
  };
}

test("buildHybridRetrievalRequest normalizes rewrites and required object types conservatively", () => {
  const request = buildHybridRetrievalRequest({
    query: "GitHub callback 404 page not found",
    rewrites: ["oauth redirect uri mismatch", "GitHub callback 404 page not found"],
    answerLanguage: "en",
    caseFrame: createCaseFrame(),
    conversationHistory: [
      { role: "user", content: "GitHub callback 404 page not found" },
      { role: "assistant", content: "Please share the redirect URI." }
    ],
    repoId: "repo-1",
    branch: "main",
    knowledgeSpace: "support-local",
    topK: 6
  });

  assert.deepEqual(request.rewrites, [
    "GitHub callback 404 page not found",
    "oauth redirect uri mismatch",
    "page not found after oauth callback",
    "configure github callback"
  ]);
  assert.equal(request.requiredDocKinds.includes("deployment_runbook"), true);
  assert.equal(request.requiredObjectTypes.includes("redirect uri"), true);
  assert.equal(request.supportSignals.pageTexts.includes("page not found"), true);
  assert.match(request.conversationContextSummary, /redirect URI/i);
});

test("hybrid runtime fuses multi-channel recall, reranks, and returns grounded evidence", async () => {
  const provider: HybridRetrievalProvider = {
    async resolvePublication() {
      return {
        knowledgeSpace: "support-local",
        repoId: "repo-1",
        branch: "main",
        publishedBuildVersion: "build-v1"
      };
    },
    async recallExactSignal() {
      return [
        createCandidate({
          channel: "exact_signal",
          candidateId: "memory-callback",
          matchedFields: ["redirect_uri", "page_text"],
          rawScore: 0.98
        })
      ];
    },
    async recallSparseMemory() {
      return [
        createCandidate({
          channel: "sparse_memory",
          candidateId: "memory-callback",
          rawScore: 0.88
        }),
        createCandidate({
          channel: "sparse_memory",
          candidateId: "memory-generic",
          rawScore: 0.42,
          title: "Generic OAuth troubleshooting"
        })
      ];
    },
    async recallSparseCitation() {
      return [
        createCandidate({
          channel: "sparse_citation",
          candidateId: "citation-callback",
          candidateType: "citation",
          candidateFamily: "doc_chunk",
          retrievalAbstractionId: "citation-callback",
          rawScore: 0.8
        })
      ];
    },
    async recallDenseCitation() {
      return [
        createCandidate({
          channel: "dense_citation",
          candidateId: "citation-callback",
          candidateType: "citation",
          candidateFamily: "doc_chunk",
          retrievalAbstractionId: "citation-callback",
          rawScore: 0.76
        })
      ];
    },
    async recallStructuredArtifact() {
      return [
        createCandidate({
          channel: "structured_artifact",
          candidateId: "artifact-callback-route",
          candidateType: "artifact",
          candidateFamily: "config_surface",
          retrievalAbstractionId: "artifact-callback-route",
          rawScore: 0.72,
          docKind: "deployment_runbook"
        })
      ];
    },
    async recallRelationExpansion(_request, _publication, seededCandidates) {
      assert.equal(seededCandidates.some((item) => item.candidateId === "memory-callback"), true);
      return [
        createCandidate({
          channel: "relation_expansion",
          candidateId: "memory-callback-related",
          rawScore: 0.33,
          title: "Related callback dependency"
        })
      ];
    },
    async groundCandidates(_request, _publication, candidates) {
      assert.equal(candidates.length >= 2, true);
      return [
        createEvidence({
          candidateId: "memory-callback",
          documentId: "doc-callback"
        }),
        createEvidence({
          candidateId: "artifact-callback-route",
          documentId: "doc-config",
          groundedFrom: "artifact",
          evidenceFamily: "config_snippet",
          sourceCandidateType: "artifact",
          path: "deploy-docs/oauth-config.md"
        })
      ];
    }
  };

  const runtime = new HybridRetrievalRuntime(provider);
  const result = await runtime.retrieve(
    buildHybridRetrievalRequest({
      query: "GitHub callback 404 page not found",
      rewrites: [],
      answerLanguage: "en",
      caseFrame: createCaseFrame(),
      conversationHistory: [],
      repoId: "repo-1",
      branch: "main",
      knowledgeSpace: "support-local",
      topK: 6
    })
  );

  assert.equal(result.retrievalStatus, "grounded");
  assert.equal(result.references.length, 2);
  assert.equal(result.references[0]?.path, "docs/callback.md");
  assert.equal(result.diagnostics.publication?.publishedBuildVersion, "build-v1");
  assert.equal(result.diagnostics.perChannelCounts.exact_signal, 1);
  assert.equal(result.diagnostics.perChannelCounts.structured_artifact, 1);
  assert.equal(result.diagnostics.rerankTopIds[0], "memory-callback");
});

test("hybrid runtime evidence gate blocks memory-only answers without grounding", async () => {
  const provider: HybridRetrievalProvider = {
    async resolvePublication() {
      return {
        knowledgeSpace: "support-local",
        repoId: "repo-1",
        branch: "main",
        publishedBuildVersion: "build-v1"
      };
    },
    async recallExactSignal() {
      return [createCandidate({ channel: "exact_signal", candidateId: "memory-only", rawScore: 0.95 })];
    },
    async recallSparseMemory() {
      return [];
    },
    async recallSparseCitation() {
      return [];
    },
    async recallDenseCitation() {
      return [];
    },
    async recallStructuredArtifact() {
      return [];
    },
    async recallRelationExpansion() {
      return [];
    },
    async groundCandidates() {
      return [];
    }
  };

  const runtime = new HybridRetrievalRuntime(provider);
  const result = await runtime.retrieve(
    buildHybridRetrievalRequest({
      query: "What does this memory summary mean?",
      rewrites: [],
      answerLanguage: "en",
      caseFrame: createCaseFrame(),
      conversationHistory: [],
      repoId: "repo-1",
      branch: "main",
      knowledgeSpace: "support-local",
      topK: 4
    })
  );

  assert.equal(result.retrievalStatus, "no_results");
  assert.equal(result.references.length, 0);
  assert.equal(result.diagnostics.evidenceGate.verdict, "insufficient");
  assert.equal(result.diagnostics.evidenceGate.reasons.includes("no_grounded_citation"), true);
});

test("hybrid runtime rejects cross-build evidence during grounding", async () => {
  const provider: HybridRetrievalProvider = {
    async resolvePublication() {
      return {
        knowledgeSpace: "support-local",
        repoId: "repo-1",
        branch: "main",
        publishedBuildVersion: "build-v1"
      };
    },
    async recallExactSignal() {
      return [createCandidate({ channel: "exact_signal", candidateId: "memory-callback", rawScore: 0.95 })];
    },
    async recallSparseMemory() {
      return [];
    },
    async recallSparseCitation() {
      return [];
    },
    async recallDenseCitation() {
      return [];
    },
    async recallStructuredArtifact() {
      return [];
    },
    async recallRelationExpansion() {
      return [];
    },
    async groundCandidates() {
      return [
        createEvidence({
          candidateId: "memory-callback",
          documentId: "doc-callback",
          buildVersion: "build-v2"
        })
      ];
    }
  };

  const runtime = new HybridRetrievalRuntime(provider);
  const result = await runtime.retrieve(
    buildHybridRetrievalRequest({
      query: "GitHub callback 404 page not found",
      rewrites: [],
      answerLanguage: "en",
      caseFrame: createCaseFrame(),
      conversationHistory: [],
      repoId: "repo-1",
      branch: "main",
      knowledgeSpace: "support-local",
      topK: 4
    })
  );

  assert.equal(result.retrievalStatus, "no_results");
  assert.equal(result.references.length, 0);
  assert.equal(result.diagnostics.evidenceGate.reasons.includes("cross_build_evidence"), true);
});

test("hybrid request receives repo/branch when available", async () => {
  const originalFlag = env.FEATURE_SUPPORT_AGENT_HYBRID_RETRIEVAL;
  env.FEATURE_SUPPORT_AGENT_HYBRID_RETRIEVAL = true;
  let called = 0;

  const hybridRuntime = {
    async retrieve(request: HybridRetrievalRequest) {
      called += 1;
      assert.equal(request.query, "GitHub callback 404 page not found");
      assert.equal(request.repoId, "repo-42");
      assert.equal(request.branch, "release/support");
      const references: SearchReference[] = [
        {
          documentId: "doc-callback",
          evidenceId: "chunk-callback",
          title: "Callback Troubleshooting",
          snippet: "The redirect URI configured in the integration must exactly match the callback request.",
          sourceUrl: "https://docs.ones.com/open-docs/callback",
          repoSourceUrl: "https://github.com/BangWork/docs-com/blob/main/docs/callback.md",
          repo: "BangWork/docs-com",
          branch: "main",
          path: "docs/callback.md",
          commitSha: "abc1234",
          headingPath: "OAuth > Callback",
          score: 0.92,
          retrievedAt: new Date().toISOString(),
          supportMetadata: {
            authority: "canonical_visible",
            source_type: "github_kb",
            evidence_kind: "troubleshooting",
            product_area: "integrations"
          }
        }
      ];
      return {
        query: request.query,
        references,
        confidence: 0.92,
        retrievalStatus: "grounded" as const,
        unresolvedReasonCode: null,
        diagnostics: {
          publication: {
            knowledgeSpace: "support-local",
            repoId: "repo-1",
            branch: "main",
            publishedBuildVersion: "build-v1"
          },
          rewrites: request.rewrites,
          requiredObjectTypes: request.requiredObjectTypes,
          perChannelCounts: {
            exact_signal: 1,
            sparse_memory: 0,
            sparse_citation: 0,
            dense_citation: 0,
            structured_artifact: 0,
            relation_expansion: 0
          },
          channelTopIds: { exact_signal: ["doc-callback"] },
          fusionTopIds: ["doc-callback"],
          rerankTopIds: ["doc-callback"],
          groundingSuccessRate: 1,
          evidenceGate: new DefaultHybridEvidenceGate().evaluate({
            groundedEvidence: [
              createEvidence({
                candidateId: "doc-callback",
                documentId: "doc-callback"
              })
            ],
            topCandidates: [],
            publishedBuildVersion: "build-v1",
            caseFrame: createCaseFrame()
          }),
          finalConfidence: 0.92
        }
      };
    }
  };

  try {
    const orchestrator = new SearchOrchestrator({} as never, hybridRuntime as never);
    const result = await orchestrator.collectEvidence({
      queries: ["GitHub callback 404 page not found"],
      idempotencyKey: "hybrid-runtime-test",
      answerLanguage: "en",
      caseFrame: createCaseFrame(),
      repoId: "repo-42",
      branch: "release/support"
    });

    assert.equal(called, 1);
    assert.equal(result.retrievalStatus, "grounded");
    assert.equal(result.references[0]?.documentId, "doc-callback");
  } finally {
    env.FEATURE_SUPPORT_AGENT_HYBRID_RETRIEVAL = originalFlag;
  }
});

test("resolvePublication uses scoped publication instead of ambiguous space-wide fallback", async () => {
  let getPublicationCalls = 0;
  let listPublicationCalls = 0;
  const provider = new DefaultHybridRetrievalProvider({
    repoApi: {
      async getPublication(input) {
        getPublicationCalls += 1;
        assert.equal(input.knowledgeSpace, "support-local");
        assert.equal(input.repoId, "repo-42");
        assert.equal(input.branch, "release/support");
        return {
          knowledge_space: "support-local",
          repo_id: "repo-42",
          branch: "release/support",
          published_build_version: "build-scoped",
          published_head: "head-sha",
          published_by: "test",
          published_from_env: "local",
          published_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        };
      },
      async listPublications() {
        listPublicationCalls += 1;
        return [];
      }
    }
  });

  const publication = await provider.resolvePublication(
    buildHybridRetrievalRequest({
      query: "GitHub callback 404 page not found",
      answerLanguage: "en",
      caseFrame: createCaseFrame(),
      conversationHistory: [],
      repoId: "repo-42",
      branch: "release/support",
      knowledgeSpace: "support-local",
      topK: 4
    })
  );

  assert.equal(getPublicationCalls, 1);
  assert.equal(listPublicationCalls, 0);
  assert.equal(publication?.repoId, "repo-42");
  assert.equal(publication?.branch, "release/support");
  assert.equal(publication?.publishedBuildVersion, "build-scoped");
});

test("direct chunk/citation grounding keeps correct document identity", async () => {
  const provider = new DefaultHybridRetrievalProvider();
  const request = buildHybridRetrievalRequest({
    query: "GitHub callback 404 page not found",
    answerLanguage: "en",
    caseFrame: createCaseFrame(),
    conversationHistory: [],
    repoId: "repo-1",
    branch: "main",
    knowledgeSpace: "support-local",
    topK: 4
  });

  const grounded = await provider.groundCandidates(
    request,
    {
      knowledgeSpace: "support-local",
      repoId: "repo-1",
      branch: "main",
      publishedBuildVersion: "build-v1"
    },
    [
      createFusedCandidate({
        channel: "sparse_citation",
        candidateId: "chunk-callback",
        candidateType: "chunk",
        sourceDocumentId: "doc-callback",
        title: "Callback Troubleshooting",
        headingPath: "OAuth > Callback"
      }),
      createFusedCandidate({
        channel: "dense_citation",
        candidateId: "citation-callback",
        candidateType: "citation",
        sourceDocumentId: "doc-callback",
        title: "Callback Troubleshooting",
        headingPath: "OAuth > Redirect URI"
      })
    ]
  );

  assert.deepEqual(
    grounded.map((item) => ({
      documentId: item.documentId,
      evidenceId: item.evidenceId,
      evidenceType: item.evidenceType
    })),
    [
      {
        documentId: "doc-callback",
        evidenceId: "chunk-callback",
        evidenceType: "chunk"
      },
      {
        documentId: "doc-callback",
        evidenceId: "citation-callback",
        evidenceType: "citation"
      }
    ]
  );
});

test("hybrid retrieval references remain stable for evidence selection / dedupe", async () => {
  const provider: HybridRetrievalProvider = {
    async resolvePublication() {
      return {
        knowledgeSpace: "support-local",
        repoId: "repo-1",
        branch: "main",
        publishedBuildVersion: "build-v1"
      };
    },
    async recallExactSignal() {
      return [];
    },
    async recallSparseMemory() {
      return [];
    },
    async recallSparseCitation() {
      return [
        createCandidate({
          channel: "sparse_citation",
          candidateId: "chunk-callback-root",
          candidateType: "chunk",
          sourceDocumentId: "doc-callback",
          headingPath: "ROOT",
          rawScore: 0.85
        }),
        createCandidate({
          channel: "sparse_citation",
          candidateId: "chunk-callback-step",
          candidateType: "chunk",
          sourceDocumentId: "doc-callback",
          headingPath: "OAuth > Callback",
          rawScore: 0.84
        })
      ];
    },
    async recallDenseCitation() {
      return [];
    },
    async recallStructuredArtifact() {
      return [];
    },
    async recallRelationExpansion() {
      return [];
    },
    async groundCandidates() {
      return [
        createEvidence({
          candidateId: "chunk-callback-root",
          evidenceId: "chunk-callback-root",
          documentId: "doc-callback",
          groundedFrom: "chunk",
          evidenceType: "chunk",
          sourceCandidateType: "chunk",
          headingPath: "ROOT"
        }),
        createEvidence({
          candidateId: "chunk-callback-step",
          evidenceId: "chunk-callback-step",
          documentId: "doc-callback",
          groundedFrom: "chunk",
          evidenceType: "chunk",
          sourceCandidateType: "chunk",
          headingPath: "OAuth > Callback"
        })
      ];
    }
  };

  const runtime = new HybridRetrievalRuntime(provider);
  const result = await runtime.retrieve(
    buildHybridRetrievalRequest({
      query: "GitHub callback 404 page not found",
      rewrites: [],
      answerLanguage: "en",
      caseFrame: createCaseFrame(),
      conversationHistory: [],
      repoId: "repo-1",
      branch: "main",
      knowledgeSpace: "support-local",
      topK: 4
    })
  );

  assert.equal(result.retrievalStatus, "grounded");
  assert.equal(result.references.length, 2);
  assert.deepEqual(
    result.references.map((item) => ({
      documentId: item.documentId,
      evidenceId: item.evidenceId,
      headingPath: item.headingPath
    })),
    [
      {
        documentId: "doc-callback",
        evidenceId: "chunk-callback-root",
        headingPath: "ROOT"
      },
      {
        documentId: "doc-callback",
        evidenceId: "chunk-callback-step",
        headingPath: "OAuth > Callback"
      }
    ]
  );
});
