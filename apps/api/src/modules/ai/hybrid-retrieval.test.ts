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

test("buildHybridRetrievalRequest keeps deployment object types narrow instead of promoting rewrite phrases", () => {
  const request = buildHybridRetrievalRequest({
    query: "ONES 支持哪些 Linux 发行版？",
    rewrites: ["supported operating systems", "deployment environment requirements"],
    answerLanguage: "zh",
    caseFrame: createCaseFrame({
      goal: "confirm supported linux distributions",
      symptom: "confirm supported linux distributions",
      object: "linux distributions",
      action_type: "capability_confirmation",
      deployment_model: "private_deployment",
      product_area: "deployment",
      retrieval_queries: ["supported operating systems", "deployment environment requirements"],
      required_doc_kinds: ["deployment_runbook", "product_guide", "rules"],
      question_type: "capability_confirmation"
    }),
    conversationHistory: [],
    repoId: "repo-1",
    branch: "main",
    knowledgeSpace: "support-local",
    topK: 6
  });

  assert.equal(request.requiredObjectTypes.includes("linux distributions"), true);
  assert.equal(request.requiredObjectTypes.includes("supported operating systems"), false);
  assert.equal(request.requiredObjectTypes.includes("deployment environment requirements"), false);
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

test("hybrid runtime rejects off-policy grounded evidence for strict deployment capability questions", async () => {
  const genericMemory = createCandidate({
    channel: "sparse_memory",
    candidateId: "memory-generic-requirements",
    rawScore: 0.98,
    title: "Requirements",
    path: "open-docs/docs/abilities/web-sdk/fetch-app.mdx",
    headingPath: "ONES.fetchApp > Requirements",
    snippet: "| ONES | v6.88.0+ |",
    productArea: "general",
    deploymentModel: "shared",
    docKind: "deployment_runbook",
    supportMetadata: {
      evidence_kind: "capability",
      product_area: "general",
      deployment_model: "shared",
      doc_kind: "deployment_runbook"
    }
  });
  const deploymentCitation = createCandidate({
    channel: "sparse_citation",
    candidateId: "citation-linux-os",
    candidateType: "citation",
    candidateFamily: "doc_chunk",
    retrievalAbstractionId: "citation-linux-os",
    rawScore: 0.62,
    title: "ONES 私有部署环境要求",
    path: "deploy-docs/prepare/deployment-requirements.md",
    headingPath: "ONES 私有部署环境要求 > 操作系统要求",
    snippet: "支持64位 Ubuntu 18/20/24、64位 Red Hat 8.0及以上等操作系统；不再支持CentOS7系列。",
    productArea: "deployment",
    deploymentModel: "private_deployment",
    docKind: "product_guide",
    supportMetadata: {
      evidence_kind: "capability",
      product_area: "deployment",
      deployment_model: "private_deployment",
      doc_kind: "product_guide"
    }
  });

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
      return [genericMemory];
    },
    async recallSparseCitation() {
      return [deploymentCitation];
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
          candidateId: genericMemory.candidateId,
          documentId: "doc-generic-requirements",
          title: genericMemory.title,
          path: genericMemory.path,
          headingPath: genericMemory.headingPath,
          snippet: genericMemory.snippet,
          supportMetadata: genericMemory.supportMetadata,
          buildVersion: "build-v1"
        }),
        createEvidence({
          candidateId: deploymentCitation.candidateId,
          groundedFrom: "citation",
          documentId: "doc-linux-os",
          title: deploymentCitation.title,
          path: deploymentCitation.path,
          headingPath: deploymentCitation.headingPath,
          snippet: deploymentCitation.snippet,
          supportMetadata: deploymentCitation.supportMetadata,
          buildVersion: "build-v1",
          sourceCandidateType: "citation"
        })
      ];
    }
  };

  const runtime = new HybridRetrievalRuntime(provider);
  const result = await runtime.retrieve(
    buildHybridRetrievalRequest({
      query: "ONES 支持哪些 Linux 发行版？",
      rewrites: ["supported operating systems", "deployment requirements"],
      answerLanguage: "zh",
      caseFrame: createCaseFrame({
        goal: "confirm supported linux distributions",
        symptom: "confirm supported linux distributions",
        object: "linux distributions",
        action_type: "capability_confirmation",
        deployment_model: "private_deployment",
        product_area: "deployment",
        retrieval_queries: ["supported operating systems", "deployment requirements"],
        required_doc_kinds: ["deployment_runbook", "product_guide", "rules"],
        question_type: "capability_confirmation"
      }),
      conversationHistory: [],
      repoId: "repo-1",
      branch: "main",
      knowledgeSpace: "support-local",
      topK: 4
    })
  );

  assert.equal(result.retrievalStatus, "grounded");
  assert.equal(result.references.length > 0, true);
  assert.equal(result.references[0]?.path, "deploy-docs/prepare/deployment-requirements.md");
  assert.equal(
    result.references.some((item) => item.path === "open-docs/docs/abilities/web-sdk/fetch-app.mdx"),
    false
  );
});

test("hybrid evidence gate marks strict deployment questions insufficient when grounded evidence is off-policy", () => {
  const gate = new DefaultHybridEvidenceGate();
  const result = gate.evaluate({
    groundedEvidence: [
      createEvidence({
        candidateId: "memory-generic-requirements",
        documentId: "doc-generic-requirements",
        title: "Requirements",
        path: "open-docs/docs/abilities/web-sdk/fetch-app.mdx",
        headingPath: "ONES.fetchApp > Requirements",
        supportMetadata: {
          evidence_kind: "capability",
          product_area: "general",
          deployment_model: "shared",
          doc_kind: "deployment_runbook"
        },
        buildVersion: "build-v1"
      })
    ],
    topCandidates: [
      createFusedCandidate({
        channel: "sparse_memory",
        candidateId: "memory-generic-requirements",
        rawScore: 0.98,
        title: "Requirements",
        path: "open-docs/docs/abilities/web-sdk/fetch-app.mdx",
        headingPath: "ONES.fetchApp > Requirements",
        productArea: "general",
        deploymentModel: "shared",
        docKind: "deployment_runbook",
        supportMetadata: {
          evidence_kind: "capability",
          product_area: "general",
          deployment_model: "shared",
          doc_kind: "deployment_runbook"
        }
      })
    ],
    publishedBuildVersion: "build-v1",
    caseFrame: createCaseFrame({
      goal: "confirm supported linux distributions",
      symptom: "confirm supported linux distributions",
      object: "linux distributions",
      action_type: "capability_confirmation",
      deployment_model: "private_deployment",
      product_area: "deployment",
      retrieval_queries: ["supported operating systems", "deployment requirements"],
      required_doc_kinds: ["deployment_runbook", "product_guide", "rules"],
      question_type: "capability_confirmation"
    })
  });

  assert.equal(result.verdict, "insufficient");
  assert.equal(result.reasons.includes("no_strict_policy_grounding"), true);
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

test("preview runtime defaults hybrid retrieval on when the raw env flag is unset", async () => {
  const originalVercelEnv = process.env.VERCEL_ENV;
  const originalRawFlag = process.env.FEATURE_SUPPORT_AGENT_HYBRID_RETRIEVAL;
  const originalEnvFlag = env.FEATURE_SUPPORT_AGENT_HYBRID_RETRIEVAL;
  let called = 0;

  const hybridRuntime = {
    async retrieve(request: HybridRetrievalRequest) {
      called += 1;
      return {
        query: request.query,
        references: [
          {
            documentId: "doc-preview-default",
            evidenceId: "chunk-preview-default",
            title: "Preview Default Hybrid",
            snippet: "Preview should default hybrid retrieval on when the explicit flag is absent.",
            sourceUrl: "https://docs.ones.com/open-docs/preview-hybrid-default",
            repoSourceUrl: "https://github.com/BangWork/docs-com/blob/main/docs/preview-hybrid-default.md",
            repo: "BangWork/docs-com",
            branch: "main",
            path: "docs/preview-hybrid-default.md",
            commitSha: "abc1234",
            headingPath: "Preview > Hybrid",
            score: 0.91,
            retrievedAt: new Date().toISOString(),
            supportMetadata: {
              authority: "canonical_visible",
              source_type: "github_kb",
              evidence_kind: "product_guide",
              product_area: "general"
            }
          }
        ],
        confidence: 0.91,
        retrievalStatus: "grounded" as const,
        unresolvedReasonCode: null,
        diagnostics: {
          publication: {
            knowledgeSpace: "support-preview",
            repoId: "repo-1",
            branch: "main",
            publishedBuildVersion: "build-preview"
          },
          rewrites: request.rewrites,
          requiredObjectTypes: request.requiredObjectTypes,
          perChannelCounts: {
            exact_signal: 0,
            sparse_memory: 1,
            sparse_citation: 0,
            dense_citation: 0,
            structured_artifact: 0,
            relation_expansion: 0
          },
          channelTopIds: { sparse_memory: ["doc-preview-default"] },
          fusionTopIds: ["doc-preview-default"],
          rerankTopIds: ["doc-preview-default"],
          groundingSuccessRate: 1,
          evidenceGate: new DefaultHybridEvidenceGate().evaluate({
            groundedEvidence: [
              createEvidence({
                candidateId: "doc-preview-default",
                documentId: "doc-preview-default",
                knowledgeSpace: "support-preview"
              })
            ],
            topCandidates: [],
            publishedBuildVersion: "build-preview",
            caseFrame: createCaseFrame({ product_area: "general" })
          }),
          finalConfidence: 0.91
        }
      };
    }
  };

  try {
    process.env.VERCEL_ENV = "preview";
    delete process.env.FEATURE_SUPPORT_AGENT_HYBRID_RETRIEVAL;
    env.FEATURE_SUPPORT_AGENT_HYBRID_RETRIEVAL = false;

    const orchestrator = new SearchOrchestrator({} as never, hybridRuntime as never);
    const result = await orchestrator.collectEvidence({
      queries: ["Which Linux distributions are officially supported?"],
      idempotencyKey: "preview-default-hybrid-runtime",
      answerLanguage: "en",
      caseFrame: createCaseFrame({ product_area: "deployment", object: "linux distributions" }),
      repoId: "repo-1",
      branch: "main"
    });

    assert.equal(called, 1);
    assert.equal(result.retrievalStatus, "grounded");
    assert.equal(result.references[0]?.documentId, "doc-preview-default");
  } finally {
    if (originalVercelEnv === undefined) delete process.env.VERCEL_ENV;
    else process.env.VERCEL_ENV = originalVercelEnv;
    if (originalRawFlag === undefined) delete process.env.FEATURE_SUPPORT_AGENT_HYBRID_RETRIEVAL;
    else process.env.FEATURE_SUPPORT_AGENT_HYBRID_RETRIEVAL = originalRawFlag;
    env.FEATURE_SUPPORT_AGENT_HYBRID_RETRIEVAL = originalEnvFlag;
  }
});

test("search orchestrator keeps hybrid retrieval on even when legacy false flags are present", async () => {
  const originalVercelEnv = process.env.VERCEL_ENV;
  const originalRawFlag = process.env.FEATURE_SUPPORT_AGENT_HYBRID_RETRIEVAL;
  const originalEnvFlag = env.FEATURE_SUPPORT_AGENT_HYBRID_RETRIEVAL;
  let hybridCalled = 0;
  let fallbackCalled = 0;

  const hybridRuntime = {
    async retrieve(request: HybridRetrievalRequest) {
      hybridCalled += 1;
      return {
        query: request.query,
        references: [
          {
            documentId: "doc-production-hybrid",
            evidenceId: "chunk-production-hybrid",
            title: "Production Hybrid Runtime",
            snippet: "Legacy false flags must not disable the hybrid retrieval runtime path.",
            sourceUrl: "https://docs.ones.com/open-docs/production-hybrid-runtime",
            repoSourceUrl: "https://github.com/BangWork/docs-com/blob/main/docs/production-hybrid-runtime.md",
            repo: "BangWork/docs-com",
            branch: "main",
            path: "docs/production-hybrid-runtime.md",
            commitSha: "prod1234",
            headingPath: "Production > Hybrid",
            score: 0.93,
            retrievedAt: new Date().toISOString(),
            supportMetadata: {
              authority: "canonical_visible",
              source_type: "github_kb",
              evidence_kind: "product_guide",
              product_area: "deployment"
            }
          }
        ],
        confidence: 0.93,
        retrievalStatus: "grounded" as const,
        unresolvedReasonCode: null,
        diagnostics: {
          publication: {
            knowledgeSpace: "support-prod",
            repoId: "repo-1",
            branch: "main",
            publishedBuildVersion: "build-prod"
          },
          rewrites: request.rewrites,
          requiredObjectTypes: request.requiredObjectTypes,
          perChannelCounts: {
            exact_signal: 0,
            sparse_memory: 1,
            sparse_citation: 0,
            dense_citation: 0,
            structured_artifact: 0,
            relation_expansion: 0
          },
          channelTopIds: { sparse_memory: ["doc-production-hybrid"] },
          fusionTopIds: ["doc-production-hybrid"],
          rerankTopIds: ["doc-production-hybrid"],
          groundingSuccessRate: 1,
          evidenceGate: new DefaultHybridEvidenceGate().evaluate({
            groundedEvidence: [
              createEvidence({
                candidateId: "doc-production-hybrid",
                documentId: "doc-production-hybrid",
                knowledgeSpace: "support-prod"
              })
            ],
            topCandidates: [],
            publishedBuildVersion: "build-prod",
            caseFrame: createCaseFrame({ product_area: "deployment" })
          }),
          finalConfidence: 0.93
        }
      };
    }
  };

  const adapter = {
    async searchKnowledge() {
      fallbackCalled += 1;
      return {
        hits: [],
        confidence: 0
      };
    }
  };

  try {
    process.env.VERCEL_ENV = "production";
    process.env.FEATURE_SUPPORT_AGENT_HYBRID_RETRIEVAL = "false";
    env.FEATURE_SUPPORT_AGENT_HYBRID_RETRIEVAL = false;

    const orchestrator = new SearchOrchestrator(adapter as never, hybridRuntime as never);
    const result = await orchestrator.collectEvidence({
      queries: ["Which Linux distributions are officially supported?"],
      idempotencyKey: "production-hybrid-runtime",
      answerLanguage: "en",
      caseFrame: createCaseFrame({ product_area: "deployment", object: "linux distributions" }),
      repoId: "repo-1",
      branch: "main"
    });

    assert.equal(hybridCalled, 1);
    assert.equal(fallbackCalled, 0);
    assert.equal(result.retrievalStatus, "grounded");
    assert.equal(result.references[0]?.documentId, "doc-production-hybrid");
  } finally {
    if (originalVercelEnv === undefined) delete process.env.VERCEL_ENV;
    else process.env.VERCEL_ENV = originalVercelEnv;
    if (originalRawFlag === undefined) delete process.env.FEATURE_SUPPORT_AGENT_HYBRID_RETRIEVAL;
    else process.env.FEATURE_SUPPORT_AGENT_HYBRID_RETRIEVAL = originalRawFlag;
    env.FEATURE_SUPPORT_AGENT_HYBRID_RETRIEVAL = originalEnvFlag;
  }
});

test("hybrid runtime skips dense citation and relation expansion in minimal runtime budget mode", async () => {
  let denseCalls = 0;
  let relationCalls = 0;

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
          candidateId: "memory-linux-support",
          title: "Linux Support Matrix",
          path: "deploy-docs/requirements.md",
          productArea: "deployment",
          deploymentModel: "private_deployment",
          objectType: "linux distributions",
          supportMetadata: {
            evidence_kind: "constraint",
            product_area: "deployment",
            deployment_model: "private_deployment",
            doc_kind: "deployment_runbook"
          }
        })
      ];
    },
    async recallSparseMemory() {
      return [];
    },
    async recallSparseCitation() {
      return [];
    },
    async recallDenseCitation() {
      denseCalls += 1;
      return [];
    },
    async recallStructuredArtifact() {
      return [];
    },
    async recallRelationExpansion() {
      relationCalls += 1;
      return [];
    },
    async groundCandidates() {
      return [
        createEvidence({
          candidateId: "memory-linux-support",
          documentId: "doc-linux-support",
          title: "Linux Support Matrix",
          path: "deploy-docs/requirements.md",
          headingPath: "操作系统要求",
          supportMetadata: {
            evidence_kind: "constraint",
            product_area: "deployment",
            deployment_model: "private_deployment",
            doc_kind: "deployment_runbook"
          }
        })
      ];
    }
  };

  const request = buildHybridRetrievalRequest({
    query: "ONES 支持哪些 Linux 发行版？",
    rewrites: ["supported operating systems", "deployment environment requirements"],
    answerLanguage: "zh",
    caseFrame: createCaseFrame({
      goal: "confirm supported linux distributions",
      symptom: "confirm supported linux distributions",
      object: "linux distributions",
      action_type: "capability_confirmation",
      deployment_model: "private_deployment",
      product_area: "deployment",
      retrieval_queries: ["supported operating systems", "deployment environment requirements"],
      required_doc_kinds: ["deployment_runbook", "product_guide", "rules"],
      question_type: "capability_confirmation"
    }),
    conversationHistory: [],
    repoId: "repo-1",
    branch: "main",
    knowledgeSpace: "support-local",
    topK: 6
  }) as HybridRetrievalRequest & {
    runtimeBudget?: {
      mode?: "minimal" | "tight" | "full";
      remainingMs?: number;
      deadlineAtMs?: number;
    };
  };
  request.runtimeBudget = {
    mode: "minimal",
    remainingMs: 1_200,
    deadlineAtMs: Date.now() + 1_200
  };

  const runtime = new HybridRetrievalRuntime(provider);
  const result = await runtime.retrieve(request);

  assert.equal(result.retrievalStatus, "grounded");
  assert.equal(result.references[0]?.documentId, "doc-linux-support");
  assert.equal(denseCalls, 0);
  assert.equal(relationCalls, 0);
});

test("collectEvidence enforces the remaining runtime deadline around hybrid retrieval", async () => {
  const originalFlag = env.FEATURE_SUPPORT_AGENT_HYBRID_RETRIEVAL;
  let called = 0;

  const hybridRuntime = {
    async retrieve(request: HybridRetrievalRequest) {
      called += 1;
      await new Promise((resolve) => setTimeout(resolve, 600));
      return {
        query: request.query,
        references: [
          {
            documentId: "doc-late",
            evidenceId: "chunk-late",
            title: "Late Result",
            snippet: "This result should be discarded when the runtime budget is exhausted.",
            sourceUrl: "https://docs.ones.com/open-docs/late-result",
            repoSourceUrl: "https://github.com/BangWork/docs-com/blob/main/docs/late-result.md",
            repo: "BangWork/docs-com",
            branch: "main",
            path: "docs/late-result.md",
            commitSha: "abc1234",
            headingPath: "Late > Result",
            score: 0.88,
            retrievedAt: new Date().toISOString(),
            supportMetadata: {
              authority: "canonical_visible",
              source_type: "github_kb",
              evidence_kind: "product_guide",
              product_area: "general"
            }
          }
        ],
        confidence: 0.88,
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
          perChannelCounts: {},
          channelTopIds: {},
          fusionTopIds: [],
          rerankTopIds: [],
          groundingSuccessRate: 1,
          evidenceGate: {
            verdict: "grounded" as const,
            reasons: [],
            evidenceFamilies: ["doc_chunk"]
          },
          finalConfidence: 0.88
        }
      };
    }
  };

  try {
    env.FEATURE_SUPPORT_AGENT_HYBRID_RETRIEVAL = true;
    const orchestrator = new SearchOrchestrator({} as never, hybridRuntime as never);
    const startedAt = Date.now();

    await assert.rejects(
      orchestrator.collectEvidence({
        queries: ["GitHub callback 404 page not found"],
        idempotencyKey: "hybrid-runtime-deadline",
        answerLanguage: "en",
        caseFrame: createCaseFrame(),
        runtime: {
          deliveryMode: "interactive",
          overallTimeoutMs: 180,
          requestStartedAtMs: Date.now() - 30
        }
      }),
      /budget|timeout/i
    );

    assert.equal(called, 1);
    assert.equal(Date.now() - startedAt < 450, true);
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

test("memory-grounded chunks prefer chunk support evidence over stale memory alias metadata", async () => {
  const provider = new DefaultHybridRetrievalProvider({
    memoryRepoApi: {
      async resolveMemorySourcesToCitations() {
        return [];
      },
      async resolveMemorySourcesToChunks() {
        return [
          {
            memoryId: "memory-linux",
            chunkId: "chunk-linux",
            documentId: "doc-linux",
            repoId: "repo-1",
            repo: "BangWork/docs-com",
            branch: "main",
            path: "deploy-docs/prepare/deployment-requirements.md",
            sourceUrl: "https://docs.ones.com/zh-Hans/deploy/prepare/deployment-requirements",
            repoSourceUrl: "https://github.com/BangWork/docs-com/blob/main/deploy-docs/prepare/deployment-requirements.md",
            commitSha: "abc1234",
            title: "Linux server requirements",
            headingPath: "Linux server requirements",
            snippet: "ONES self-hosted deployment supports Ubuntu 18/20/24 and Red Hat 8+.",
            sourceScore: 0.91,
            memoryMetadata: {
              product_area: "wiki",
              evidence_kind: "constraint",
              deployment_model: "private_deployment",
              memory_kind: "troubleshooting_pattern",
              memory_source: "alias"
            },
            chunkMetadata: {
              supportEvidence: {
                product_area: "deployment",
                evidence_kind: "capability",
                deployment_model: "private_deployment"
              }
            },
            docMetadata: {
              supportEvidence: {
                product_area: "general",
                evidence_kind: "procedure",
                deployment_model: "shared"
              }
            }
          }
        ];
      }
    }
  });
  const request = buildHybridRetrievalRequest({
    query: "Which Linux distributions are officially supported?",
    answerLanguage: "en",
    caseFrame: createCaseFrame({ product_area: "deployment", object: "linux distributions" }),
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
        channel: "sparse_memory",
        candidateId: "memory-linux",
        candidateType: "memory",
        productArea: "wiki",
        deploymentModel: "private_deployment",
        docKind: "troubleshooting"
      })
    ]
  );

  assert.equal(grounded[0]?.supportMetadata?.product_area, "deployment");
  assert.equal(grounded[0]?.supportMetadata?.evidence_kind, "capability");
  assert.equal(grounded[0]?.supportMetadata?.deployment_model, "private_deployment");
  assert.equal(grounded[0]?.supportMetadata?.memory_kind, "troubleshooting_pattern");
  assert.equal(grounded[0]?.supportMetadata?.memory_source, "alias");
});

test("memory-grounded citations prefer citation metadata over stale memory alias metadata", async () => {
  const provider = new DefaultHybridRetrievalProvider({
    memoryRepoApi: {
      async resolveMemorySourcesToCitations() {
        return [
          {
            memoryId: "memory-linux",
            citationId: "citation-linux",
            documentId: "doc-linux",
            repoId: "repo-1",
            repo: "BangWork/docs-com",
            branch: "main",
            path: "deploy-docs/prepare/deployment-requirements.md",
            sourceUrl: "https://docs.ones.com/zh-Hans/deploy/prepare/deployment-requirements",
            repoSourceUrl: "https://github.com/BangWork/docs-com/blob/main/deploy-docs/prepare/deployment-requirements.md",
            commitSha: "abc1234",
            title: "Linux server requirements",
            headingPath: "Linux server requirements",
            snippet: "ONES self-hosted deployment supports Ubuntu 18/20/24 and Red Hat 8+.",
            sourceScore: 0.92,
            citationFamily: "doc_chunk",
            sourceFamily: "doc_page",
            citationMetadata: {
              product_area: "deployment",
              evidence_kind: "capability",
              deployment_model: "private_deployment"
            },
            docMetadata: {
              supportEvidence: {
                product_area: "general",
                evidence_kind: "procedure",
                deployment_model: "shared"
              }
            },
            memoryMetadata: {
              product_area: "wiki",
              evidence_kind: "constraint",
              deployment_model: "private_deployment",
              memory_kind: "troubleshooting_pattern",
              memory_source: "alias"
            }
          }
        ];
      },
      async resolveMemorySourcesToChunks() {
        return [];
      }
    }
  });
  const request = buildHybridRetrievalRequest({
    query: "Which Linux distributions are officially supported?",
    answerLanguage: "en",
    caseFrame: createCaseFrame({ product_area: "deployment", object: "linux distributions" }),
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
        channel: "sparse_memory",
        candidateId: "memory-linux",
        candidateType: "memory",
        productArea: "wiki",
        deploymentModel: "private_deployment",
        docKind: "troubleshooting"
      })
    ]
  );

  assert.equal(grounded[0]?.supportMetadata?.product_area, "deployment");
  assert.equal(grounded[0]?.supportMetadata?.evidence_kind, "capability");
  assert.equal(grounded[0]?.supportMetadata?.deployment_model, "private_deployment");
  assert.equal(grounded[0]?.supportMetadata?.memory_kind, "troubleshooting_pattern");
  assert.equal(grounded[0]?.supportMetadata?.memory_source, "alias");
  assert.equal(grounded[0]?.supportMetadata?.citation_family, "doc_chunk");
  assert.equal(grounded[0]?.supportMetadata?.source_family, "doc_page");
});

test("memory-grounded citations prefer nested chunk support evidence over raw citation metadata", async () => {
  const provider = new DefaultHybridRetrievalProvider({
    memoryRepoApi: {
      async resolveMemorySourcesToCitations() {
        return [
          {
            memoryId: "memory-linux",
            citationId: "citation-linux",
            documentId: "doc-linux",
            repoId: "repo-1",
            repo: "BangWork/docs-com",
            branch: "main",
            path: "deploy-docs/prepare/deployment-flow.md",
            sourceUrl: "https://docs.ones.com/zh-Hans/deploy/prepare/deployment-flow",
            repoSourceUrl: "https://github.com/BangWork/docs-com/blob/main/deploy-docs/prepare/deployment-flow.md",
            commitSha: "abc1234",
            title: "ONES 私有部署说明",
            headingPath: "ONES 私有部署说明",
            snippet: "Linux server requirements are documented in the deployment requirements chapter.",
            sourceScore: 0.92,
            citationFamily: "doc_chunk",
            sourceFamily: "runbook_file",
            citationMetadata: {
              product_area: "wiki",
              evidence_kind: "constraint",
              deployment_model: "private_deployment",
              chunk_id: "chunk-linux",
              chunk_metadata: {
                supportEvidence: {
                  product_area: "deployment",
                  evidence_kind: "capability",
                  deployment_model: "private_deployment",
                  applies_to: ["private_deployment", "deployment"]
                }
              }
            },
            docMetadata: {
              supportEvidence: {
                product_area: "general",
                evidence_kind: "procedure",
                deployment_model: "shared"
              }
            },
            memoryMetadata: {
              product_area: "wiki",
              evidence_kind: "constraint",
              deployment_model: "private_deployment",
              memory_kind: "troubleshooting_pattern",
              memory_source: "memory_entry"
            }
          }
        ];
      },
      async resolveMemorySourcesToChunks() {
        return [];
      }
    }
  });
  const request = buildHybridRetrievalRequest({
    query: "Which Linux distributions are officially supported?",
    answerLanguage: "en",
    caseFrame: createCaseFrame({ product_area: "deployment", object: "linux distributions" }),
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
        channel: "sparse_memory",
        candidateId: "memory-linux",
        candidateType: "memory",
        productArea: "wiki",
        deploymentModel: "private_deployment",
        docKind: "troubleshooting"
      })
    ]
  );

  assert.equal(grounded[0]?.supportMetadata?.product_area, "deployment");
  assert.equal(grounded[0]?.supportMetadata?.evidence_kind, "capability");
  assert.equal(grounded[0]?.supportMetadata?.deployment_model, "private_deployment");
  assert.deepEqual(grounded[0]?.supportMetadata?.applies_to, ["private_deployment", "deployment"]);
  assert.equal(grounded[0]?.supportMetadata?.memory_kind, "troubleshooting_pattern");
  assert.equal(grounded[0]?.supportMetadata?.citation_family, "doc_chunk");
  assert.equal(grounded[0]?.supportMetadata?.source_family, "runbook_file");
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
    [...result.references]
      .map((item) => ({
        documentId: item.documentId,
        evidenceId: item.evidenceId,
        headingPath: item.headingPath
      }))
      .sort((left, right) => String(left.headingPath).localeCompare(String(right.headingPath))),
    [
      {
        documentId: "doc-callback",
        evidenceId: "chunk-callback-step",
        headingPath: "OAuth > Callback"
      },
      {
        documentId: "doc-callback",
        evidenceId: "chunk-callback-root",
        headingPath: "ROOT"
      }
    ].sort((left, right) => String(left.headingPath).localeCompare(String(right.headingPath)))
  );
});

test("hybrid runtime prefers heading-specific grounded evidence over root-level page intros from the same document", async () => {
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
      return [
        createCandidate({
          channel: "sparse_memory",
          candidateId: "memory-root",
          rawScore: 0.95,
          title: "ONES 私有部署环境要求",
          path: "deploy-docs/prepare/deployment-requirements.md",
          headingPath: "ROOT",
          productArea: "deployment",
          deploymentModel: "private_deployment",
          supportMetadata: {
            product_area: "deployment",
            deployment_model: "private_deployment",
            evidence_kind: "capability"
          }
        })
      ];
    },
    async recallSparseCitation() {
      return [
        createCandidate({
          channel: "sparse_citation",
          candidateId: "chunk-specific",
          candidateType: "chunk",
          rawScore: 0.72,
          sourceDocumentId: "doc-deploy",
          title: "ONES 私有部署环境要求",
          path: "deploy-docs/prepare/deployment-requirements.md",
          headingPath: "操作系统要求",
          snippet: "支持 64 位 Ubuntu 18/20/24、64 位 Red Hat 8.0 及以上，不再支持 CentOS 7。",
          productArea: "deployment",
          deploymentModel: "private_deployment",
          supportMetadata: {
            product_area: "deployment",
            deployment_model: "private_deployment",
            evidence_kind: "capability"
          }
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
          candidateId: "memory-root",
          documentId: "doc-deploy",
          title: "ONES 私有部署环境要求",
          path: "deploy-docs/prepare/deployment-requirements.md",
          headingPath: "ROOT",
          snippet: "本文描述在私有部署 ONES(K3s版本)前所需准备的系统环境要求，可配合部署说明阅读。",
          supportMetadata: {
            product_area: "deployment",
            deployment_model: "private_deployment",
            evidence_kind: "capability"
          }
        }),
        createEvidence({
          candidateId: "chunk-specific",
          documentId: "doc-deploy",
          groundedFrom: "chunk",
          evidenceType: "chunk",
          sourceCandidateType: "chunk",
          title: "ONES 私有部署环境要求",
          path: "deploy-docs/prepare/deployment-requirements.md",
          headingPath: "操作系统要求",
          snippet: "支持 64 位 Ubuntu 18/20/24、64 位 Red Hat 8.0 及以上，不再支持 CentOS 7。",
          supportMetadata: {
            product_area: "deployment",
            deployment_model: "private_deployment",
            evidence_kind: "capability"
          }
        })
      ];
    }
  };

  const runtime = new HybridRetrievalRuntime(provider);
  const result = await runtime.retrieve(
    buildHybridRetrievalRequest({
      query: "ONES 支持哪些 Linux 发行版？",
      rewrites: ["ONES Linux 发行版 支持", "操作系统要求"],
      answerLanguage: "zh",
      caseFrame: createCaseFrame({
        goal: "confirm supported linux distributions",
        symptom: "confirm supported linux distributions",
        object: "linux distributions",
        action_type: "capability_confirmation",
        deployment_model: "private_deployment",
        product_area: "deployment",
        retrieval_queries: ["ONES Linux 发行版 支持", "操作系统要求"],
        required_doc_kinds: ["deployment_runbook", "product_guide", "rules"],
        question_type: "capability_confirmation"
      }),
      conversationHistory: [],
      repoId: "repo-1",
      branch: "main",
      knowledgeSpace: "support-local",
      topK: 2
    })
  );

  assert.equal(result.retrievalStatus, "grounded");
  assert.equal(result.references[0]?.headingPath, "操作系统要求");
  assert.doesNotMatch(result.references[0]?.snippet ?? "", /可配合部署说明阅读/);
});

test("hybrid runtime keeps deploy-docs requirements chunks when metadata is degraded and generic deployment intros also exist", async () => {
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
      return [
        createCandidate({
          channel: "sparse_memory",
          candidateId: "memory-root",
          candidateType: "memory",
          candidateFamily: "concept",
          rawScore: 0.93,
          title: "ONES 私有部署环境要求",
          path: "deploy-docs/prepare/deployment-requirements.md",
          snippet: "本文描述在私有部署 ONES(K3s版本)前所需准备的系统环境要求，可配合部署说明阅读。",
          productArea: "deployment",
          deploymentModel: "private_deployment",
          supportMetadata: {
            product_area: "deployment",
            deployment_model: "private_deployment",
            evidence_kind: "capability"
          }
        })
      ];
    },
    async recallSparseCitation() {
      return [];
    },
    async recallDenseCitation() {
      return [
        createCandidate({
          channel: "dense_citation",
          candidateId: "chunk-specific",
          candidateType: "chunk",
          rawScore: 0.77,
          sourceDocumentId: "doc-quick-start",
          title: "1. 准备服务器",
          path: "deploy-docs/quick-start/requirements.mdx",
          headingPath: "3. 操作系统要求",
          snippet: "只支持 Linux 4.* 以上内核的操作系统，支持 64 位 Ubuntu 18/20/24、64 位 Red Hat 8.0 及以上，不再支持 CentOS 7 系列。",
          productArea: "general",
          deploymentModel: "shared",
          supportMetadata: {
            product_area: "general",
            deployment_model: "shared",
            evidence_kind: "capability"
          }
        })
      ];
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
          candidateId: "memory-root",
          documentId: "doc-deploy",
          title: "ONES 私有部署环境要求",
          path: "deploy-docs/prepare/deployment-requirements.md",
          headingPath: "ROOT",
          snippet: "本文描述在私有部署 ONES(K3s版本)前所需准备的系统环境要求，可配合部署说明阅读。",
          supportMetadata: {
            product_area: "deployment",
            deployment_model: "private_deployment",
            evidence_kind: "capability"
          }
        }),
        createEvidence({
          candidateId: "chunk-specific",
          groundedFrom: "chunk",
          evidenceType: "chunk",
          sourceCandidateType: "chunk",
          documentId: "doc-quick-start",
          title: "1. 准备服务器",
          path: "deploy-docs/quick-start/requirements.mdx",
          headingPath: "3. 操作系统要求",
          snippet: "只支持 Linux 4.* 以上内核的操作系统，支持 64 位 Ubuntu 18/20/24、64 位 Red Hat 8.0 及以上，不再支持 CentOS 7 系列。",
          supportMetadata: {
            product_area: "general",
            deployment_model: "shared",
            evidence_kind: "capability"
          }
        })
      ];
    }
  };

  const runtime = new HybridRetrievalRuntime(provider);
  const result = await runtime.retrieve(
    buildHybridRetrievalRequest({
      query: "ONES 支持哪些 Linux 发行版？",
      rewrites: ["ONES Linux 发行版 支持", "操作系统要求"],
      answerLanguage: "zh",
      caseFrame: createCaseFrame({
        goal: "confirm supported linux distributions",
        symptom: "confirm supported linux distributions",
        object: "linux distributions",
        action_type: "capability_confirmation",
        deployment_model: "private_deployment",
        product_area: "deployment",
        retrieval_queries: ["ONES Linux 发行版 支持", "操作系统要求"],
        required_doc_kinds: ["deployment_runbook", "product_guide", "rules"],
        question_type: "capability_confirmation"
      }),
      conversationHistory: [],
      repoId: "repo-1",
      branch: "main",
      knowledgeSpace: "support-local",
      topK: 2
    })
  );

  assert.equal(result.retrievalStatus, "grounded");
  assert.equal(result.references[0]?.path, "deploy-docs/quick-start/requirements.mdx");
  assert.equal(result.references[0]?.headingPath, "3. 操作系统要求");
  assert.match(result.references[0]?.snippet ?? "", /Ubuntu 18\/20\/24/);
});
