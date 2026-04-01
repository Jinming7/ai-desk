export type KbSyncMode = "full" | "incremental" | "reindex";
export type KbSyncSource = "manual" | "webhook" | "polling" | "system";
export type KbSyncJobStatus = "queued" | "running" | "succeeded" | "failed" | "dead_letter";
export type RetrievalProfile = "search" | "agent";
export type KbFullSyncRunStatus = "planned" | "running" | "finalizing" | "succeeded" | "failed" | "cancelled";
export type KbFullSyncShardStatus = "planned" | "queued" | "running" | "succeeded" | "failed";
export type KbFullSyncShardKey = "deploy-docs" | "docs" | "open-docs";
export type KbManifestBuildStatus = "pending" | "reused" | "rebuilt" | "failed";

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
