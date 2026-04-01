export type KbMemoryKind =
  | "concept"
  | "procedure"
  | "api_operation"
  | "permission_rule"
  | "troubleshooting_pattern"
  | "behavior_rule"
  | "constraint"
  | "ui_surface";

export type KbMemoryRelationType = "updates" | "extends" | "derives";

export type KbMemoryStatus = "active" | "superseded" | "inactive";

export interface KbMemoryEntry {
  id: string;
  repo_id: string;
  branch: string;
  doc_id: string;
  path: string;
  memory_kind: KbMemoryKind;
  title: string | null;
  canonical_claim: string;
  summary: string;
  product_area: string;
  doc_kind: string;
  action_type: string | null;
  deployment_model: string | null;
  object_type: string | null;
  is_static: boolean;
  is_latest: boolean;
  status: KbMemoryStatus;
  build_version: string;
  metadata_json: Record<string, unknown>;
  search_text: string;
  created_at: string;
  updated_at: string;
}

export interface KbMemoryAlias {
  id: string;
  memory_id: string;
  alias: string;
  alias_type: string;
  weight: number;
  metadata_json: Record<string, unknown>;
  created_at: string;
}

export interface KbMemorySignal {
  id: string;
  memory_id: string;
  signal_type: string;
  signal_value: string;
  weight: number;
  metadata_json: Record<string, unknown>;
  created_at: string;
}

export interface KbMemoryProfile {
  id: string;
  repo_id: string;
  branch: string;
  profile_key: string;
  profile_kind: string;
  title: string;
  static_summary: string;
  dynamic_summary: string | null;
  build_version: string;
  metadata_json: Record<string, unknown>;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface MemoryAliasDraft {
  alias: string;
  alias_type: string;
  weight: number;
  metadata_json?: Record<string, unknown>;
}

export interface MemorySignalDraft {
  signal_type: string;
  signal_value: string;
  weight: number;
  metadata_json?: Record<string, unknown>;
}

export interface MemorySourceDraft {
  doc_id: string;
  chunk_id: string;
  heading_path: string;
  source_score: number;
  source_metadata_json?: Record<string, unknown>;
}

export interface MemoryEntryDraft {
  id: string;
  repo_id: string;
  branch: string;
  doc_id: string;
  path: string;
  memory_kind: KbMemoryKind;
  title: string | null;
  canonical_claim: string;
  summary: string;
  product_area: string;
  doc_kind: string;
  action_type: string | null;
  deployment_model: string | null;
  object_type: string | null;
  is_static: boolean;
  build_version: string;
  metadata_json: Record<string, unknown>;
  search_text: string;
  aliases: MemoryAliasDraft[];
  signals: MemorySignalDraft[];
  sources: MemorySourceDraft[];
}

export interface MemoryRelationDraft {
  id: string;
  from_memory_id: string;
  to_memory_id: string;
  relation_type: KbMemoryRelationType;
  weight: number;
  metadata_json?: Record<string, unknown>;
}

export interface MemoryProfileDraft {
  id: string;
  repo_id: string;
  branch: string;
  profile_key: string;
  profile_kind: string;
  title: string;
  static_summary: string;
  dynamic_summary?: string | null;
  build_version: string;
  metadata_json?: Record<string, unknown>;
}

export interface MemoryRetrievalHit {
  memoryId: string;
  docId: string;
  path: string;
  title: string | null;
  canonicalClaim: string;
  summary: string;
  memoryKind: KbMemoryKind;
  productArea: string;
  docKind: string;
  actionType: string | null;
  deploymentModel: string | null;
  objectType: string | null;
  score: number;
  source: "memory_entry" | "alias" | "signal" | "profile" | "relation";
  metadata?: Record<string, unknown>;
  updatedAt?: string;
  buildVersion?: string;
}

export interface MemoryRelationHit extends MemoryRetrievalHit {
  relationType: KbMemoryRelationType;
  relationWeight: number;
  viaMemoryId: string;
}

export interface MemoryProfileHit {
  profileId: string;
  profileKey: string;
  profileKind: string;
  title: string;
  staticSummary: string;
  dynamicSummary: string | null;
  score: number;
  metadata?: Record<string, unknown>;
}

export interface MemorySourceChunkHit {
  memoryId: string;
  chunkId: string;
  documentId: string;
  repoId: string;
  repo: string;
  branch: string;
  path: string;
  sourceUrl: string;
  repoSourceUrl: string;
  commitSha: string;
  title: string;
  headingPath: string;
  snippet: string;
  sourceScore: number;
  chunkMetadata?: Record<string, unknown>;
  docMetadata?: Record<string, unknown>;
  memoryMetadata?: Record<string, unknown>;
}

export interface SupportExactSignals {
  methods: string[];
  apiPaths: string[];
  scopes: string[];
  callbacks: string[];
  redirectUris: string[];
  baseUrls: string[];
  errorCodes: string[];
  errorTexts: string[];
  pageTexts: string[];
  objects: string[];
  actions: string[];
  all: string[];
}

export interface MemoryRetrievalDiagnostics {
  rewrittenQueries: string[];
  extractedSignals: SupportExactSignals;
  candidateCounts: {
    entry: number;
    alias: number;
    signal: number;
    profile: number;
    relation: number;
    grounded: number;
  };
  topMemoryReasons: Array<{
    memoryId: string;
    score: number;
    source: string;
    reasons: string[];
  }>;
}

export interface MemoryCaseFrame {
  question_type?: string;
  product_area?: string;
  action_type?: string;
  deployment_model?: string;
  object?: string;
  required_doc_kinds?: string[];
}
