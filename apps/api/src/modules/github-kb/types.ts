export type KbSyncMode = "full" | "incremental" | "reindex";
export type KbSyncSource = "manual" | "webhook" | "polling" | "system";
export type KbSyncJobStatus = "queued" | "running" | "succeeded" | "failed" | "dead_letter";
export type RetrievalProfile = "search" | "agent";
export type KbFullSyncRunStatus = "planned" | "running" | "finalizing" | "succeeded" | "failed" | "cancelled";
export type KbFullSyncShardStatus = "planned" | "queued" | "running" | "succeeded" | "failed";
export type KbFullSyncShardKey = "deploy-docs" | "docs" | "open-docs";
export type KbManifestBuildStatus = "pending" | "reused" | "rebuilt" | "failed";
export type KbKnowledgeSpace = "support-prod" | "support-preview" | "support-local" | "support-shadow" | "support-eval";
export type KbRequestedFromEnv = "local" | "preview" | "prod" | "operator";
export type KbBuildKind = "full" | "incremental" | "repair" | "reindex";
export type KbBuildStatus = "building" | "built" | "validated" | "published" | "failed" | "abandoned" | "superseded";
export type KbValidationSeverity = "info" | "warn" | "error";
export type KbSourceFamily =
  | "doc_page"
  | "openapi_spec"
  | "code_file"
  | "config_file"
  | "schema_file"
  | "test_file"
  | "runbook_file";
export type KbArtifactQuality = "canonical" | "degraded";
export type KbCitationFamily =
  | "doc_chunk"
  | "openapi_operation_span"
  | "code_symbol_span"
  | "config_snippet"
  | "sql_snippet"
  | "test_snippet";
export type KbCodeSymbolKind =
  | "module"
  | "class"
  | "function"
  | "method"
  | "interface"
  | "type"
  | "enum"
  | "constant"
  | "exported_utility";

export interface RepoRegistration {
  id: string;
  repo_owner: string;
  repo_name: string;
  repo_url: string;
  public_base_url: string | null;
  default_branch: string;
  include_paths: string[];
  exclude_paths: string[];
  polling_interval_seconds: number;
  auth_mode: string;
  is_active: boolean;
  last_validated_at: string | null;
  last_validation_error: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export interface SyncCheckpoint {
  repo_id: string;
  branch: string;
  last_synced_commit_sha: string | null;
  last_synced_at: string | null;
  last_full_synced_commit_sha: string | null;
  last_full_synced_at: string | null;
}

export interface SyncJob {
  id: string;
  repo_id: string;
  branch: string;
  sync_mode: KbSyncMode;
  source: KbSyncSource;
  status: KbSyncJobStatus;
  idempotency_key: string;
  before_commit_sha: string | null;
  after_commit_sha: string | null;
  payload_json: Record<string, unknown>;
  attempts: number;
  max_attempts: number;
  next_run_at: string;
  started_at: string | null;
  finished_at: string | null;
  error_message: string | null;
  created_at: string;
  updated_at: string;
}

export interface KbDocument {
  id: string;
  repo_id: string;
  knowledge_space: KbKnowledgeSpace;
  doc_key: string;
  branch: string;
  path: string;
  build_version: string;
  title: string;
  source_url: string;
  repo_source_url: string;
  public_source_url: string | null;
  commit_sha: string;
  content_hash: string;
  content: string;
  metadata_json: Record<string, unknown>;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface KbChunk {
  id: string;
  doc_id: string;
  repo_id: string;
  knowledge_space: KbKnowledgeSpace;
  branch: string;
  path: string;
  build_version: string;
  commit_sha: string;
  heading_path: string;
  ordinal: number;
  content: string;
  content_hash: string;
  token_count: number;
  metadata_json: Record<string, unknown>;
  embedding: string | null;
  embedding_model: string | null;
  embedding_version: string | null;
  lexical_content: string;
  confidence_hint: number;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface KbOpenApiOperation {
  id: string;
  knowledge_space: KbKnowledgeSpace;
  repo_id: string;
  branch: string;
  build_version: string;
  source_doc_id: string;
  path: string;
  method: string;
  route_path: string;
  operation_id: string | null;
  summary: string | null;
  description: string | null;
  request_schema_json: Record<string, unknown>;
  response_schema_json: Record<string, unknown>;
  auth_scopes: string[];
  tags: string[];
  error_shapes_json: Record<string, unknown>;
  source_location_json: Record<string, unknown>;
  metadata_json: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface KbCodeSymbol {
  id: string;
  knowledge_space: KbKnowledgeSpace;
  repo_id: string;
  branch: string;
  build_version: string;
  source_doc_id: string;
  path: string;
  language: string;
  symbol_kind: KbCodeSymbolKind;
  symbol_name: string;
  qualified_name: string;
  parent_symbol: string | null;
  start_line: number;
  end_line: number;
  signature_text: string;
  doc_comment: string | null;
  body_summary: string | null;
  dependency_refs_json: Record<string, unknown>;
  metadata_json: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface KbConfigSurface {
  id: string;
  knowledge_space: KbKnowledgeSpace;
  repo_id: string;
  branch: string;
  build_version: string;
  source_doc_id: string;
  path: string;
  config_kind: string;
  config_key: string;
  normalized_key: string;
  default_value: string | null;
  description: string | null;
  required_for_json: Record<string, unknown>;
  related_components_json: Record<string, unknown>;
  source_location_json: Record<string, unknown>;
  metadata_json: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface KbSchemaObject {
  id: string;
  knowledge_space: KbKnowledgeSpace;
  repo_id: string;
  branch: string;
  build_version: string;
  source_doc_id: string;
  path: string;
  object_kind: string;
  schema_name: string | null;
  object_name: string;
  normalized_name: string;
  definition_summary: string;
  related_tables_json: Record<string, unknown>;
  source_location_json: Record<string, unknown>;
  metadata_json: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface KbTestBehavior {
  id: string;
  knowledge_space: KbKnowledgeSpace;
  repo_id: string;
  branch: string;
  build_version: string;
  source_doc_id: string;
  path: string;
  behavior_key: string;
  title: string;
  summary: string;
  assertions_json: Record<string, unknown>;
  signals_json: Record<string, unknown>;
  source_location_json: Record<string, unknown>;
  metadata_json: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface KbCitationUnit {
  id: string;
  knowledge_space: KbKnowledgeSpace;
  repo_id: string;
  branch: string;
  build_version: string;
  source_doc_id: string;
  citation_family: KbCitationFamily;
  source_family: KbSourceFamily;
  source_artifact_type: string;
  source_artifact_id: string | null;
  citation_key: string;
  path: string;
  title: string;
  heading_path: string | null;
  snippet_text: string;
  source_location_json: Record<string, unknown>;
  authority_json: Record<string, unknown>;
  metadata_json: Record<string, unknown>;
  embedding: string | null;
  embedding_model: string | null;
  embedding_version: string | null;
  created_at: string;
  updated_at: string;
}

export interface ParsedSection {
  headingPath: string;
  title: string;
  content: string;
  order: number;
}

export interface ChunkDraft {
  id: string;
  headingPath: string;
  ordinal: number;
  content: string;
  contentHash: string;
  tokenCount: number;
  metadata: Record<string, unknown>;
}

export interface RetrievalHit {
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
  score: number;
  vectorScore?: number;
  lexicalScore?: number;
  rankSignals?: Record<string, number>;
  supportMetadata?: Record<string, unknown>;
  chunkMetadata?: Record<string, unknown>;
  docMetadata?: Record<string, unknown>;
}

export interface RetrievalResponse {
  query: string;
  profile: RetrievalProfile;
  answerLanguage?: "zh" | "en";
  answer?: string;
  resolvedQueries?: string[];
  confidence: number;
  fallbackUsed: boolean;
  hits: RetrievalHit[];
  debug?: {
    vectorCandidates: number;
    keywordCandidates: number;
    mergedCandidates: number;
    memoryCandidates?: Record<string, number>;
    rewrittenQueries?: string[];
    extractedSignals?: Record<string, unknown>;
    topMemoryReasons?: Array<Record<string, unknown>>;
  };
}

export interface GitHubTreeFile {
  path: string;
  sha: string;
  size: number;
  type: "blob";
}

export interface KbServingVersion {
  repo_id: string;
  branch: string;
  active_build_version: string;
  active_head: string;
  activated_at: string;
  updated_at: string;
}

export interface KbBuild {
  id: string;
  knowledge_space: KbKnowledgeSpace;
  repo_id: string;
  branch: string;
  build_version: string;
  target_head: string;
  build_kind: KbBuildKind;
  requested_by: string;
  requested_from_env: KbRequestedFromEnv;
  status: KbBuildStatus;
  source_snapshot_total: number;
  documents_built: number;
  chunks_built: number;
  memory_entries_built: number;
  embeddings_built: number;
  validation_passed: boolean;
  validation_summary_json: Record<string, unknown>;
  error_message: string | null;
  started_at: string | null;
  finished_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface KbPublication {
  knowledge_space: KbKnowledgeSpace;
  repo_id: string;
  branch: string;
  published_build_version: string;
  published_head: string;
  published_by: string;
  published_from_env: KbRequestedFromEnv;
  published_at: string;
  updated_at: string;
}

export interface KbBuildValidationResult {
  id: string;
  build_id: string;
  validation_kind: string;
  passed: boolean;
  severity: KbValidationSeverity;
  summary: string;
  details_json: Record<string, unknown>;
  created_at: string;
}

export interface KbIngestLease {
  lease_key: string;
  owner_id: string;
  owner_env: string;
  expires_at: string;
  metadata_json: Record<string, unknown>;
  updated_at: string;
}

export interface KbSyncRun {
  id: string;
  repo_id: string;
  branch: string;
  sync_mode: "full";
  target_head: string;
  source_snapshot_total: number;
  status: KbFullSyncRunStatus;
  requested_by: string;
  run_reason: string | null;
  started_at: string | null;
  finished_at: string | null;
  error_message: string | null;
  created_at: string;
  updated_at: string;
}

export interface KbSyncRunShard {
  id: string;
  run_id: string;
  repo_id: string;
  branch: string;
  shard_key: KbFullSyncShardKey;
  prefix: string;
  total_docs: number;
  completed_docs: number;
  reusable_docs: number;
  rebuilt_docs: number;
  failed_docs: number;
  next_cursor: string | null;
  status: KbFullSyncShardStatus;
  started_at: string | null;
  finished_at: string | null;
  last_heartbeat_at: string | null;
  error_message: string | null;
  created_at: string;
  updated_at: string;
}

export interface KbSyncManifestItem {
  id: string;
  run_id: string;
  repo_id: string;
  branch: string;
  target_head: string;
  path: string;
  shard_key: KbFullSyncShardKey;
  blob_sha: string;
  size_bytes: number;
  needs_rebuild: boolean;
  reuse_reason: string | null;
  build_status: KbManifestBuildStatus;
  error_message: string | null;
  created_at: string;
  updated_at: string;
}

export interface CompareFile {
  filename: string;
  status: "added" | "modified" | "removed" | "renamed";
  previous_filename?: string;
  sha?: string;
}

export interface GitHubReadValidation {
  ok: boolean;
  scopes: string[];
  message: string;
}
