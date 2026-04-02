import type { KbKnowledgeSpace } from "../github-kb/types.js";
import type { SupportExactSignals } from "../github-kb/memory-types.js";
import type { SearchReference, SupportCaseFrame } from "./types.js";

export type HybridRecallChannel =
  | "exact_signal"
  | "sparse_memory"
  | "sparse_citation"
  | "dense_citation"
  | "structured_artifact"
  | "relation_expansion";

export type HybridCandidateType = "memory" | "artifact" | "citation" | "chunk";

export interface HybridPublication {
  knowledgeSpace: KbKnowledgeSpace;
  repoId?: string;
  repo?: string;
  branch?: string;
  publishedBuildVersion: string;
}

export interface HybridRetrievalRequest {
  query: string;
  rewrites: string[];
  caseFrame?: SupportCaseFrame;
  requiredDocKinds: string[];
  requiredObjectTypes: string[];
  supportSignals: SupportExactSignals;
  answerLanguage: "zh" | "en";
  conversationContextSummary: string;
  repoId?: string;
  branch?: string;
  knowledgeSpace: KbKnowledgeSpace;
  topK: number;
}

export interface HybridRecallCandidate {
  channel: HybridRecallChannel;
  candidateId: string;
  candidateType: HybridCandidateType;
  candidateFamily: string;
  retrievalAbstractionId: string;
  rawScore: number;
  buildVersion: string;
  knowledgeSpace: KbKnowledgeSpace;
  repoId?: string;
  repo?: string;
  branch?: string;
  sourceDocumentId?: string;
  title: string;
  path: string;
  headingPath?: string | null;
  snippet?: string;
  sourceUrl?: string;
  repoSourceUrl?: string;
  commitSha?: string;
  docKind?: string | null;
  objectType?: string | null;
  productArea?: string | null;
  deploymentModel?: string | null;
  citationCandidateIds: string[];
  matchedFields: string[];
  matchMetadata: Record<string, unknown>;
  citationAvailability: "linked" | "available" | "none";
  supportMetadata?: Record<string, unknown>;
  chunkMetadata?: Record<string, unknown>;
  docMetadata?: Record<string, unknown>;
  degradedParser?: boolean;
}

export interface HybridFusedCandidate extends HybridRecallCandidate {
  rawChannelScores: Partial<Record<HybridRecallChannel, number>>;
  channelRanks: Partial<Record<HybridRecallChannel, number>>;
  fusionScore: number;
  rerankScore: number;
  channelAgreement: number;
}

export interface HybridGroundedEvidence {
  candidateId: string;
  groundedFrom: HybridCandidateType;
  evidenceId: string;
  evidenceType: "citation" | "chunk";
  evidenceFamily: string;
  documentId: string;
  repoId: string;
  repo: string;
  branch: string;
  path: string;
  sourceUrl: string;
  repoSourceUrl?: string;
  commitSha?: string;
  title: string;
  headingPath?: string | null;
  snippet: string;
  buildVersion: string;
  knowledgeSpace: KbKnowledgeSpace;
  sourceFamily: string;
  supportMetadata?: Record<string, unknown>;
  chunkMetadata?: Record<string, unknown>;
  docMetadata?: Record<string, unknown>;
  sourceCandidateType: HybridCandidateType;
}

export interface HybridEvidenceGateInput {
  groundedEvidence: HybridGroundedEvidence[];
  topCandidates: HybridFusedCandidate[];
  publishedBuildVersion: string;
  caseFrame?: SupportCaseFrame;
}

export interface HybridEvidenceGateResult {
  verdict: "grounded" | "insufficient" | "kb_unavailable";
  reasons: string[];
  evidenceFamilies: string[];
}

export interface HybridRetrievalDiagnostics {
  publication: HybridPublication | null;
  rewrites: string[];
  requiredObjectTypes: string[];
  perChannelCounts: Partial<Record<HybridRecallChannel, number>>;
  channelTopIds: Partial<Record<HybridRecallChannel, string[]>>;
  fusionTopIds: string[];
  rerankTopIds: string[];
  groundingSuccessRate: number;
  evidenceGate: HybridEvidenceGateResult;
  finalConfidence: number;
}

export interface HybridRetrievalResult {
  query: string;
  references: SearchReference[];
  confidence: number;
  retrievalStatus: "grounded" | "no_results" | "kb_unavailable";
  unresolvedReasonCode: "NO_MATCHING_KB" | "LOW_CONFIDENCE" | "KB_RETRIEVAL_UNAVAILABLE" | null;
  diagnostics: HybridRetrievalDiagnostics;
}

export interface HybridRetrievalProvider {
  resolvePublication(request: HybridRetrievalRequest): Promise<HybridPublication | null>;
  recallExactSignal(request: HybridRetrievalRequest, publication: HybridPublication): Promise<HybridRecallCandidate[]>;
  recallSparseMemory(request: HybridRetrievalRequest, publication: HybridPublication): Promise<HybridRecallCandidate[]>;
  recallSparseCitation(request: HybridRetrievalRequest, publication: HybridPublication): Promise<HybridRecallCandidate[]>;
  recallDenseCitation(request: HybridRetrievalRequest, publication: HybridPublication): Promise<HybridRecallCandidate[]>;
  recallStructuredArtifact(request: HybridRetrievalRequest, publication: HybridPublication): Promise<HybridRecallCandidate[]>;
  recallRelationExpansion(
    request: HybridRetrievalRequest,
    publication: HybridPublication,
    seededCandidates: HybridFusedCandidate[]
  ): Promise<HybridRecallCandidate[]>;
  groundCandidates(
    request: HybridRetrievalRequest,
    publication: HybridPublication,
    candidates: HybridFusedCandidate[]
  ): Promise<HybridGroundedEvidence[]>;
}
