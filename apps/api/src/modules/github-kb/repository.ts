import { v4 as uuidv4 } from "uuid";
import { pool } from "../../db/client.js";
import type {
  KbDocument,
  KbFullSyncShardKey,
  KbManifestBuildStatus,
  KbServingVersion,
  KbSyncJobStatus,
  KbSyncManifestItem,
  KbSyncRun,
  KbSyncRunShard,
  RepoRegistration,
  RetrievalHit,
  SyncCheckpoint,
  SyncJob
} from "./types.js";

function toJson(value: unknown): string {
  return JSON.stringify(value ?? {});
}

export async function upsertRepoRegistration(input: {
  repoOwner: string;
  repoName: string;
  repoUrl: string;
  publicBaseUrl?: string;
  defaultBranch: string;
  includePaths: string[];
  excludePaths: string[];
  pollingIntervalSeconds: number;
  createdBy: string;
}): Promise<RepoRegistration> {
  const existing = await pool.query<RepoRegistration>(
    `SELECT * FROM kb_repo_registrations WHERE repo_owner = $1 AND repo_name = $2 AND default_branch = $3 LIMIT 1`,
    [input.repoOwner, input.repoName, input.defaultBranch]
  );

  if (existing.rowCount) {
    const result = await pool.query<RepoRegistration>(
      `UPDATE kb_repo_registrations
       SET repo_url = $1,
           public_base_url = $2,
           include_paths = $3::text[],
           exclude_paths = $4::text[],
           polling_interval_seconds = $5,
           is_active = true,
           updated_by = $6,
           updated_at = NOW()
       WHERE id = $7
       RETURNING *`,
      [
        input.repoUrl,
        input.publicBaseUrl ?? null,
        input.includePaths,
        input.excludePaths,
        input.pollingIntervalSeconds,
        input.createdBy,
        existing.rows[0].id
      ]
    );
    return result.rows[0];
  }

  const result = await pool.query<RepoRegistration>(
      `INSERT INTO kb_repo_registrations (
      id, repo_owner, repo_name, repo_url, public_base_url, default_branch, include_paths, exclude_paths,
      polling_interval_seconds, created_by, updated_by
    ) VALUES ($1,$2,$3,$4,$5,$6,$7::text[],$8::text[],$9,$10,$10)
    RETURNING *`,
    [
      uuidv4(),
      input.repoOwner,
      input.repoName,
      input.repoUrl,
      input.publicBaseUrl ?? null,
      input.defaultBranch,
      input.includePaths,
      input.excludePaths,
      input.pollingIntervalSeconds,
      input.createdBy
    ]
  );
  return result.rows[0];
}

export async function setRepoValidation(repoId: string, errorMessage: string | null): Promise<void> {
  await pool.query(
    `UPDATE kb_repo_registrations
     SET last_validated_at = NOW(),
         last_validation_error = $2,
         updated_at = NOW()
     WHERE id = $1`,
    [repoId, errorMessage]
  );
}

export async function updateRepoDefaultBranch(repoId: string, branch: string, actor = "system"): Promise<void> {
  await pool.query(
    `UPDATE kb_repo_registrations
     SET default_branch = $2,
         updated_by = $3,
         updated_at = NOW()
     WHERE id = $1`,
    [repoId, branch, actor]
  );
}

export async function deactivateRepoRegistration(repoId: string, actor = "system"): Promise<void> {
  await pool.query(
    `UPDATE kb_repo_registrations
     SET is_active = false,
         updated_by = $2,
         updated_at = NOW()
     WHERE id = $1`,
    [repoId, actor]
  );
}

export async function deactivateOtherRepoRegistrations(repoOwner: string, repoName: string, keepRepoId: string): Promise<void> {
  await pool.query(
    `UPDATE kb_repo_registrations
     SET is_active = false,
         updated_at = NOW()
     WHERE repo_owner = $1
       AND repo_name = $2
       AND id <> $3
       AND is_active = true`,
    [repoOwner, repoName, keepRepoId]
  );
}

export async function listActiveRepoRegistrations(): Promise<RepoRegistration[]> {
  const result = await pool.query<RepoRegistration>(
    `SELECT * FROM kb_repo_registrations WHERE is_active = true ORDER BY updated_at DESC`
  );
  return result.rows;
}

export async function countDocumentsByPathPrefixes(input: {
  repoId: string;
  branch?: string;
  prefixes: string[];
}): Promise<Array<{ prefix: string; total: number; active: number }>> {
  const prefixes = input.prefixes.map((item) => String(item ?? "").trim()).filter(Boolean);
  if (!prefixes.length) return [];

  const branch = input.branch?.trim() || null;
  const result = await pool.query<{ prefix: string; total: string; active: string }>(
    `WITH prefixes(prefix) AS (
       SELECT UNNEST($3::text[])
     ),
     serving AS (
       SELECT active_build_version
       FROM kb_serving_versions
       WHERE repo_id = $1
         AND ($2::text IS NULL OR branch = $2)
       ORDER BY updated_at DESC
       LIMIT 1
     )
     SELECT
       prefixes.prefix,
       COUNT(doc.id)::text AS total,
       COUNT(doc.id) FILTER (WHERE doc.is_active = true)::text AS active
     FROM prefixes
     LEFT JOIN kb_documents doc
       ON doc.repo_id = $1
      AND ($2::text IS NULL OR doc.branch = $2)
      AND doc.path LIKE prefixes.prefix || '%'
      AND (
        ((SELECT active_build_version FROM serving) IS NOT NULL AND doc.build_version = (SELECT active_build_version FROM serving))
        OR ((SELECT active_build_version FROM serving) IS NULL AND doc.is_active = true)
      )
     GROUP BY prefixes.prefix
     ORDER BY prefixes.prefix`,
    [input.repoId, branch, prefixes]
  );

  return result.rows.map((row) => ({
    prefix: row.prefix,
    total: Number(row.total),
    active: Number(row.active)
  }));
}

export async function getRepoRegistrationById(repoId: string): Promise<RepoRegistration | null> {
  const result = await pool.query<RepoRegistration>(`SELECT * FROM kb_repo_registrations WHERE id = $1 LIMIT 1`, [repoId]);
  return result.rows[0] ?? null;
}

export async function findActiveRepoByOwnerNameBranch(
  owner: string,
  name: string,
  branch: string
): Promise<RepoRegistration | null> {
  const result = await pool.query<RepoRegistration>(
    `SELECT *
     FROM kb_repo_registrations
     WHERE repo_owner = $1 AND repo_name = $2 AND default_branch = $3 AND is_active = true
     LIMIT 1`,
    [owner, name, branch]
  );
  return result.rows[0] ?? null;
}

export async function getCheckpoint(repoId: string, branch: string): Promise<SyncCheckpoint | null> {
  const result = await pool.query<SyncCheckpoint>(
    `SELECT * FROM kb_sync_checkpoints WHERE repo_id = $1 AND branch = $2 LIMIT 1`,
    [repoId, branch]
  );
  return result.rows[0] ?? null;
}

export async function upsertCheckpoint(input: {
  repoId: string;
  branch: string;
  lastSyncedCommitSha: string;
  fullSync: boolean;
}): Promise<void> {
  await pool.query(
    `INSERT INTO kb_sync_checkpoints (
      repo_id, branch, last_synced_commit_sha, last_synced_at,
      last_full_synced_commit_sha, last_full_synced_at
    ) VALUES ($1,$2,$3,NOW(),CASE WHEN $4 THEN $3 ELSE NULL END,CASE WHEN $4 THEN NOW() ELSE NULL END)
    ON CONFLICT (repo_id, branch)
    DO UPDATE SET
      last_synced_commit_sha = EXCLUDED.last_synced_commit_sha,
      last_synced_at = NOW(),
      last_full_synced_commit_sha = CASE WHEN $4 THEN EXCLUDED.last_synced_commit_sha ELSE kb_sync_checkpoints.last_full_synced_commit_sha END,
      last_full_synced_at = CASE WHEN $4 THEN NOW() ELSE kb_sync_checkpoints.last_full_synced_at END,
      updated_at = NOW()`,
    [input.repoId, input.branch, input.lastSyncedCommitSha, input.fullSync]
  );
}

export async function enqueueSyncJob(input: {
  repoId: string;
  branch: string;
  syncMode: "full" | "incremental" | "reindex";
  source: "manual" | "webhook" | "polling" | "system";
  idempotencyKey: string;
  beforeCommitSha?: string;
  afterCommitSha?: string;
  payload?: Record<string, unknown>;
}): Promise<SyncJob> {
  const existing = await pool.query<SyncJob>(`SELECT * FROM kb_sync_jobs WHERE idempotency_key = $1 LIMIT 1`, [input.idempotencyKey]);
  if (existing.rowCount) {
    const job = existing.rows[0];
    if (job.status === "dead_letter") {
      const revived = await pool.query<SyncJob>(
        `UPDATE kb_sync_jobs
         SET repo_id = $2,
             branch = $3,
             sync_mode = $4,
             source = $5,
             status = 'queued',
             attempts = 0,
             before_commit_sha = $6,
             after_commit_sha = $7,
             payload_json = $8::jsonb,
             error_message = NULL,
             started_at = NULL,
             finished_at = NULL,
             next_run_at = NOW(),
             updated_at = NOW()
         WHERE id = $1
         RETURNING *`,
        [
          job.id,
          input.repoId,
          input.branch,
          input.syncMode,
          input.source,
          input.beforeCommitSha ?? null,
          input.afterCommitSha ?? null,
          toJson(input.payload ?? {})
        ]
      );
      return revived.rows[0];
    }
    return job;
  }

  const result = await pool.query<SyncJob>(
    `INSERT INTO kb_sync_jobs (
      id, repo_id, branch, sync_mode, source, status, idempotency_key,
      before_commit_sha, after_commit_sha, payload_json
    ) VALUES ($1,$2,$3,$4,$5,'queued',$6,$7,$8,$9::jsonb)
    RETURNING *`,
    [
      uuidv4(),
      input.repoId,
      input.branch,
      input.syncMode,
      input.source,
      input.idempotencyKey,
      input.beforeCommitSha ?? null,
      input.afterCommitSha ?? null,
      toJson(input.payload ?? {})
    ]
  );
  return result.rows[0];
}

export async function claimDueSyncJobs(limit: number): Promise<SyncJob[]> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await client.query<SyncJob>(
      `WITH ranked AS (
        SELECT
          job.id,
          ROW_NUMBER() OVER (
            PARTITION BY CASE
              WHEN job.sync_mode = 'full'
                AND job.payload_json ? 'runId'
                AND job.payload_json ? 'shardKey'
              THEN CONCAT('full-run-shard:', job.payload_json->>'runId', ':', job.payload_json->>'shardKey')
              ELSE CONCAT('job:', job.id::text)
            END
            ORDER BY job.attempts ASC, job.next_run_at ASC, job.created_at DESC
          ) AS claim_rank
        FROM kb_sync_jobs AS job
        WHERE job.status = 'queued'
          AND job.next_run_at <= NOW()
      ), due AS (
        SELECT job.id
        FROM kb_sync_jobs AS job
        INNER JOIN ranked ON ranked.id = job.id
        WHERE ranked.claim_rank = 1
        ORDER BY job.attempts ASC, job.next_run_at ASC, job.created_at DESC
        LIMIT $1
        FOR UPDATE OF job SKIP LOCKED
      )
      UPDATE kb_sync_jobs AS job
      SET status = 'running', started_at = NOW(), updated_at = NOW()
      FROM due
      WHERE job.id = due.id
      RETURNING job.*`,
      [limit]
    );
    await client.query("COMMIT");
    return result.rows;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function requeueStaleRunningJobs(maxAgeMinutes: number): Promise<number> {
  const normalizedMinutes = Number.isFinite(maxAgeMinutes) ? Math.max(1, Math.floor(maxAgeMinutes)) : 15;
  const result = await pool.query<{ id: string }>(
    `UPDATE kb_sync_jobs
     SET status = 'queued',
         error_message = COALESCE(NULLIF(error_message, ''), 'stale running job requeued automatically'),
         started_at = NULL,
         next_run_at = NOW(),
         updated_at = NOW()
     WHERE status = 'running'
       AND updated_at < NOW() - ($1::int * INTERVAL '1 minute')
     RETURNING id`,
    [normalizedMinutes]
  );
  return result.rowCount ?? 0;
}

export async function markSyncJobSucceeded(jobId: string): Promise<void> {
  await pool.query(
    `UPDATE kb_sync_jobs
     SET status = 'succeeded', finished_at = NOW(), error_message = NULL, updated_at = NOW()
     WHERE id = $1`,
    [jobId]
  );
}

export async function markSyncJobFailed(job: SyncJob, errorMessage: string): Promise<KbSyncJobStatus> {
  const attempts = job.attempts + 1;
  if (attempts >= job.max_attempts) {
    await pool.query(
      `UPDATE kb_sync_jobs
       SET status = 'dead_letter', attempts = $2, error_message = $3, finished_at = NOW(), updated_at = NOW()
       WHERE id = $1`,
      [job.id, attempts, errorMessage.slice(0, 4000)]
    );
    return "dead_letter";
  }

  const backoffSeconds = Math.min(300, Math.pow(2, attempts) * 5);
  await pool.query(
    `UPDATE kb_sync_jobs
     SET status = 'queued',
         attempts = $2,
         error_message = $3,
         next_run_at = NOW() + ($4::int * INTERVAL '1 second'),
         updated_at = NOW()
     WHERE id = $1`,
    [job.id, attempts, errorMessage.slice(0, 4000), backoffSeconds]
  );
  return "failed";
}

export async function listRecentSyncJobs(limit = 50): Promise<SyncJob[]> {
  const result = await pool.query<SyncJob>(
    `SELECT * FROM kb_sync_jobs ORDER BY created_at DESC LIMIT $1`,
    [limit]
  );
  return result.rows;
}

export async function upsertDocument(input: {
  repoId: string;
  branch: string;
  path: string;
  buildVersion?: string;
  title: string;
  sourceUrl: string;
  repoSourceUrl: string;
  publicSourceUrl: string | null;
  commitSha: string;
  contentHash: string;
  content: string;
  metadata: Record<string, unknown>;
}): Promise<KbDocument> {
  const buildVersion = input.buildVersion?.trim() || input.commitSha;
  const docKey = `${input.repoId}:${input.path}:${buildVersion}`;
  const result = await pool.query<KbDocument>(
    `INSERT INTO kb_documents (
      id, repo_id, doc_key, branch, path, title, source_url, repo_source_url, public_source_url,
      commit_sha, content_hash, content, metadata_json, build_version, is_active
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14,true)
    ON CONFLICT (repo_id, branch, path, build_version)
    DO UPDATE SET
      doc_key = EXCLUDED.doc_key,
      title = EXCLUDED.title,
      source_url = EXCLUDED.source_url,
      repo_source_url = EXCLUDED.repo_source_url,
      public_source_url = EXCLUDED.public_source_url,
      commit_sha = EXCLUDED.commit_sha,
      content_hash = EXCLUDED.content_hash,
      content = EXCLUDED.content,
      metadata_json = EXCLUDED.metadata_json,
      is_active = true,
      updated_at = NOW()
    RETURNING *`,
    [
      uuidv4(),
      input.repoId,
      docKey,
      input.branch,
      input.path,
      input.title,
      input.sourceUrl,
      input.repoSourceUrl,
      input.publicSourceUrl,
      input.commitSha,
      input.contentHash,
      input.content,
      toJson(input.metadata),
      buildVersion
    ]
  );
  return result.rows[0];
}

export async function deactivateDocumentsMissingFromSnapshot(repoId: string, branch: string, activePaths: string[]): Promise<number> {
  const result = await pool.query<{ count: string }>(
    `UPDATE kb_documents
     SET is_active = false, updated_at = NOW()
     WHERE repo_id = $1
       AND branch = $2
       AND is_active = true
       AND NOT (path = ANY($3::text[]))
     RETURNING 1`,
    [repoId, branch, activePaths.length ? activePaths : ["__none__"]]
  );
  return result.rowCount ?? 0;
}

export async function deactivateDocumentByPath(repoId: string, branch: string, path: string): Promise<void> {
  await pool.query(
    `UPDATE kb_documents
     SET is_active = false, updated_at = NOW()
     WHERE repo_id = $1 AND branch = $2 AND path = $3`,
    [repoId, branch, path]
  );

  await pool.query(
    `UPDATE kb_chunks
     SET is_active = false, updated_at = NOW()
     WHERE repo_id = $1 AND branch = $2 AND path = $3`,
    [repoId, branch, path]
  );
}

export async function deactivateChunksByDocument(docId: string): Promise<void> {
  await pool.query(
    `UPDATE kb_chunks
     SET is_active = false, updated_at = NOW()
     WHERE doc_id = $1`,
    [docId]
  );
}

export async function upsertChunk(input: {
  id: string;
  docId: string;
  repoId: string;
  branch: string;
  path: string;
  buildVersion?: string;
  commitSha: string;
  headingPath: string;
  ordinal: number;
  content: string;
  contentHash: string;
  tokenCount: number;
  metadata: Record<string, unknown>;
  embedding: string | null;
  embeddingModel: string | null;
  embeddingVersion: string | null;
}): Promise<void> {
  const buildVersion = input.buildVersion?.trim() || input.commitSha;
  await pool.query(
    `INSERT INTO kb_chunks (
      id, doc_id, repo_id, branch, path, build_version, commit_sha, heading_path, ordinal,
      content, content_hash, token_count, metadata_json,
      embedding, embedding_model, embedding_version,
      lexical_content, search_vector, confidence_hint, is_active
    ) VALUES (
      $1,$2,$3,$4,$5,$6,$7,$8,$9,
      $10,$11,$12,$13::jsonb,
      $14::vector,$15,$16,
      $10,to_tsvector('english', $10),0.0,true
    )
    ON CONFLICT (id)
    DO UPDATE SET
      doc_id = EXCLUDED.doc_id,
      repo_id = EXCLUDED.repo_id,
      branch = EXCLUDED.branch,
      path = EXCLUDED.path,
      build_version = EXCLUDED.build_version,
      commit_sha = EXCLUDED.commit_sha,
      heading_path = EXCLUDED.heading_path,
      ordinal = EXCLUDED.ordinal,
      content = EXCLUDED.content,
      content_hash = EXCLUDED.content_hash,
      token_count = EXCLUDED.token_count,
      metadata_json = EXCLUDED.metadata_json,
      embedding = EXCLUDED.embedding,
      embedding_model = EXCLUDED.embedding_model,
      embedding_version = EXCLUDED.embedding_version,
      lexical_content = EXCLUDED.lexical_content,
      search_vector = EXCLUDED.search_vector,
      is_active = true,
      updated_at = NOW()`,
    [
      input.id,
      input.docId,
      input.repoId,
      input.branch,
      input.path,
      buildVersion,
      input.commitSha,
      input.headingPath,
      input.ordinal,
      input.content,
      input.contentHash,
      input.tokenCount,
      toJson(input.metadata),
      input.embedding,
      input.embeddingModel,
      input.embeddingVersion
    ]
  );
}

function buildWhereClause(filters: { repoId?: string; branch?: string }) {
  const parts: string[] = [];
  const values: unknown[] = [];
  if (filters.repoId) {
    values.push(filters.repoId);
    parts.push(`chunk.repo_id = $${values.length}`);
  }
  if (filters.branch) {
    values.push(filters.branch);
    parts.push(`chunk.branch = $${values.length}`);
  }
  return { clause: parts.join(" AND "), values };
}

export async function searchVectorCandidates(input: {
  repoId?: string;
  branch?: string;
  vectorLiteral: string;
  limit: number;
}): Promise<RetrievalHit[]> {
  const where = buildWhereClause({ repoId: input.repoId, branch: input.branch });
  const vectorParam = where.values.length + 1;
  const limitParam = where.values.length + 2;
  const result = await pool.query<{
    chunk_id: string;
    document_id: string;
    repo_id: string;
    repo: string;
    branch: string;
    path: string;
    source_url: string;
    repo_source_url: string;
    commit_sha: string;
    title: string;
    heading_path: string;
    snippet: string;
    vector_score: string;
    chunk_metadata_json: Record<string, unknown> | null;
    doc_metadata_json: Record<string, unknown> | null;
  }>(
    `SELECT
      chunk.id AS chunk_id,
      doc.id AS document_id,
      chunk.repo_id,
      reg.repo_owner || '/' || reg.repo_name AS repo,
      chunk.branch,
      chunk.path,
      doc.source_url,
      doc.repo_source_url,
      chunk.commit_sha,
      doc.title,
      chunk.heading_path,
      LEFT(chunk.content, 2400) AS snippet,
      (1 - (chunk.embedding <=> $${vectorParam}::vector))::text AS vector_score,
     chunk.metadata_json AS chunk_metadata_json,
      doc.metadata_json AS doc_metadata_json
     FROM kb_chunks chunk
     INNER JOIN kb_documents doc ON doc.id = chunk.doc_id
     INNER JOIN kb_repo_registrations reg ON reg.id = chunk.repo_id
     LEFT JOIN kb_serving_versions sv ON sv.repo_id = chunk.repo_id AND sv.branch = chunk.branch
     WHERE ${where.clause || "TRUE"}
       AND (
         (sv.active_build_version IS NOT NULL AND chunk.build_version = sv.active_build_version AND doc.build_version = sv.active_build_version)
         OR (sv.active_build_version IS NULL AND chunk.is_active = true AND doc.is_active = true)
       )
       AND chunk.embedding IS NOT NULL
     ORDER BY chunk.embedding <=> $${vectorParam}::vector
     LIMIT $${limitParam}`,
    [...where.values, input.vectorLiteral, input.limit]
  );

  return result.rows.map((row) => ({
    chunkId: row.chunk_id,
    documentId: row.document_id,
    repoId: row.repo_id,
    repo: row.repo,
    branch: row.branch,
    path: row.path,
    sourceUrl: row.source_url,
    repoSourceUrl: row.repo_source_url,
    commitSha: row.commit_sha,
    title: row.title,
    headingPath: row.heading_path,
    snippet: row.snippet,
    score: Number(row.vector_score),
    vectorScore: Number(row.vector_score),
    chunkMetadata: row.chunk_metadata_json ?? undefined,
    docMetadata: row.doc_metadata_json ?? undefined,
    supportMetadata:
      ((row.chunk_metadata_json ?? {}) as Record<string, unknown>).supportEvidence as Record<string, unknown> | undefined ??
      ((row.doc_metadata_json ?? {}) as Record<string, unknown>).supportEvidence as Record<string, unknown> | undefined
  }));
}

function uniqueStrings(input: Array<string | undefined | null>, limit = 24): string[] {
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

function tokenizeRetrievalTerms(query: string): string[] {
  const normalized = query.replace(/\s+/g, " ").trim().toLowerCase();
  if (!normalized) return [];

  const asciiTokens = [...normalized.matchAll(/[a-z0-9][a-z0-9._/-]{1,}/g)]
    .map((match) => match[0])
    .filter((token) => token.length >= 2);
  const cjkRuns = [...normalized.matchAll(/[\u3400-\u9FBF]{2,}/g)].map((match) => match[0]);
  const cjkTokens: string[] = [];

  for (const run of cjkRuns) {
    cjkTokens.push(run);
    if (run.length <= 4) continue;
    for (let size = 3; size >= 2; size -= 1) {
      for (let index = 0; index <= run.length - size && cjkTokens.length < 32; index += 1) {
        cjkTokens.push(run.slice(index, index + size));
      }
    }
  }

  return uniqueStrings([...asciiTokens, ...cjkTokens], 24);
}

export async function searchKeywordCandidates(input: {
  repoId?: string;
  branch?: string;
  query: string;
  limit: number;
}): Promise<RetrievalHit[]> {
  const hasCjk = /[\u3400-\u9FBF]/.test(input.query);
  const where = buildWhereClause({ repoId: input.repoId, branch: input.branch });
  const tokens = tokenizeRetrievalTerms(input.query).slice(0, 10);
  if (!tokens.length) return [];
  const likeValues = tokens.map((token) => `%${token}%`);
  const queryParam = hasCjk ? null : where.values.length + 1;
  const tokenBase = queryParam === null ? where.values.length + 1 : queryParam + 1;
  const tokenParams: string[] = [];
  for (let i = 0; i < likeValues.length; i += 1) {
    tokenParams.push(`$${tokenBase + i}`);
  }
  const limitPlaceholder = tokenBase + likeValues.length;
  const tokenOr = tokenParams
    .map((param) => `chunk.path ILIKE ${param} OR doc.title ILIKE ${param} OR chunk.heading_path ILIKE ${param} OR chunk.content ILIKE ${param}`)
    .join(" OR ");
  const tokenScore = tokenParams
    .map(
      (param) =>
        `(CASE WHEN doc.title ILIKE ${param} THEN 1.8 ELSE 0 END + CASE WHEN chunk.heading_path ILIKE ${param} THEN 1.5 ELSE 0 END + CASE WHEN chunk.path ILIKE ${param} THEN 1.15 ELSE 0 END + CASE WHEN chunk.content ILIKE ${param} THEN 0.22 ELSE 0 END)`
    )
    .join(" + ");
  const ordinalBoost = "CASE WHEN chunk.ordinal <= 3 THEN 0.9 WHEN chunk.ordinal <= 6 THEN 0.35 ELSE 0 END";

  const result = await pool.query<{
    chunk_id: string;
    document_id: string;
    repo_id: string;
    repo: string;
    branch: string;
    path: string;
    source_url: string;
    repo_source_url: string;
    commit_sha: string;
    title: string;
    heading_path: string;
    snippet: string;
    lexical_score: string;
    chunk_metadata_json: Record<string, unknown> | null;
    doc_metadata_json: Record<string, unknown> | null;
  }>(
    `SELECT
      chunk.id AS chunk_id,
      doc.id AS document_id,
      chunk.repo_id,
      reg.repo_owner || '/' || reg.repo_name AS repo,
      chunk.branch,
      chunk.path,
      doc.source_url,
      doc.repo_source_url,
      chunk.commit_sha,
      doc.title,
      chunk.heading_path,
      ${
        hasCjk
          ? `LEFT(chunk.content, 2400) AS snippet,`
          : `COALESCE(
        NULLIF(ts_headline('english', chunk.content, websearch_to_tsquery('english', $${queryParam ?? 0}), 'MaxWords=60, MinWords=20'), ''),
        LEFT(chunk.content, 800)
      ) AS snippet,`
      }
      (
        ${hasCjk ? "0" : `ts_rank_cd(chunk.search_vector, websearch_to_tsquery('english', $${queryParam ?? 0})) + `}
        ${tokenScore}
        + ${ordinalBoost}
      )::text AS lexical_score,
     chunk.metadata_json AS chunk_metadata_json,
      doc.metadata_json AS doc_metadata_json
     FROM kb_chunks chunk
     INNER JOIN kb_documents doc ON doc.id = chunk.doc_id
     INNER JOIN kb_repo_registrations reg ON reg.id = chunk.repo_id
     LEFT JOIN kb_serving_versions sv ON sv.repo_id = chunk.repo_id AND sv.branch = chunk.branch
     WHERE ${where.clause || "TRUE"}
      AND (
         (sv.active_build_version IS NOT NULL AND chunk.build_version = sv.active_build_version AND doc.build_version = sv.active_build_version)
         OR (sv.active_build_version IS NULL AND chunk.is_active = true AND doc.is_active = true)
       )
      AND (
         ${hasCjk ? "FALSE" : `chunk.search_vector @@ websearch_to_tsquery('english', $${queryParam ?? 0})`}
         OR (${tokenOr})
       )
     ORDER BY (
       ${hasCjk ? "0" : `ts_rank_cd(chunk.search_vector, websearch_to_tsquery('english', $${queryParam ?? 0})) + `}
       ${tokenScore}
       + ${ordinalBoost}
     ) DESC, chunk.ordinal ASC, chunk.updated_at DESC
     LIMIT $${limitPlaceholder}`,
    hasCjk ? [...where.values, ...likeValues, input.limit] : [...where.values, input.query, ...likeValues, input.limit]
  );

  return result.rows.map((row) => ({
    chunkId: row.chunk_id,
    documentId: row.document_id,
    repoId: row.repo_id,
    repo: row.repo,
    branch: row.branch,
    path: row.path,
    sourceUrl: row.source_url,
    repoSourceUrl: row.repo_source_url,
    commitSha: row.commit_sha,
    title: row.title,
    headingPath: row.heading_path,
    snippet: row.snippet || row.title,
    score: Number(row.lexical_score),
    lexicalScore: Number(row.lexical_score),
    chunkMetadata: row.chunk_metadata_json ?? undefined,
    docMetadata: row.doc_metadata_json ?? undefined,
    supportMetadata:
      ((row.chunk_metadata_json ?? {}) as Record<string, unknown>).supportEvidence as Record<string, unknown> | undefined ??
      ((row.doc_metadata_json ?? {}) as Record<string, unknown>).supportEvidence as Record<string, unknown> | undefined
  }));
}

export async function listCandidateDocumentsForFallback(input: {
  repoId?: string;
  branch?: string;
  query: string;
  limit: number;
}): Promise<Array<{ repoId: string; path: string; sourceUrl: string; repoSourceUrl: string; title: string; commitSha: string; branch: string; repo: string; content: string }>> {
  const conditions: string[] = [];
  const values: unknown[] = [];
  const tokens = tokenizeRetrievalTerms(input.query).slice(0, 8);

  if (input.repoId) {
    values.push(input.repoId);
    conditions.push(`doc.repo_id = $${values.length}`);
  }
  if (input.branch) {
    values.push(input.branch);
    conditions.push(`doc.branch = $${values.length}`);
  }

  if (!tokens.length) return [];
  const likeValues = tokens.map((token) => `%${token}%`);
  const queryParam = values.length + 1;
  const tokenParams: string[] = [];
  for (let i = 0; i < likeValues.length; i += 1) {
    tokenParams.push(`$${queryParam + i}`);
  }
  const tokenOr = tokenParams.map((param) => `doc.title ILIKE ${param} OR doc.path ILIKE ${param} OR doc.content ILIKE ${param}`).join(" OR ");
  const tokenScore = tokenParams
    .map(
      (param) =>
        `(CASE WHEN doc.title ILIKE ${param} THEN 2.2 ELSE 0 END + CASE WHEN doc.path ILIKE ${param} THEN 1.4 ELSE 0 END + CASE WHEN doc.content ILIKE ${param} THEN 0.18 ELSE 0 END)`
    )
    .join(" + ");
  const limitParam = queryParam + likeValues.length;

  const result = await pool.query<{
    repo_id: string;
    path: string;
    source_url: string;
    repo_source_url: string;
    title: string;
    commit_sha: string;
    branch: string;
    repo: string;
    content: string;
  }>(
    `SELECT
      doc.repo_id,
      doc.path,
      doc.source_url,
      doc.repo_source_url,
      doc.title,
      doc.commit_sha,
     doc.branch,
      reg.repo_owner || '/' || reg.repo_name AS repo,
      LEFT(doc.content, 2000) AS content
     FROM kb_documents doc
     INNER JOIN kb_repo_registrations reg ON reg.id = doc.repo_id
     LEFT JOIN kb_serving_versions sv ON sv.repo_id = doc.repo_id AND sv.branch = doc.branch
     WHERE ${conditions.length ? conditions.join(" AND ") : "TRUE"}
       AND (
         (sv.active_build_version IS NOT NULL AND doc.build_version = sv.active_build_version)
         OR (sv.active_build_version IS NULL AND doc.is_active = true)
       )
       AND (${tokenOr})
     ORDER BY (${tokenScore}) DESC, doc.updated_at DESC
     LIMIT $${limitParam}`,
    [...values, ...likeValues, input.limit]
  );

  return result.rows.map((row) => ({
    repoId: row.repo_id,
    path: row.path,
    sourceUrl: row.source_url,
    repoSourceUrl: row.repo_source_url,
    title: row.title,
    commitSha: row.commit_sha,
    branch: row.branch,
    repo: row.repo,
    content: row.content
  }));
}

export async function getDocumentByPath(repoId: string, branch: string, path: string): Promise<KbDocument | null> {
  const result = await pool.query<KbDocument>(
    `SELECT doc.*
     FROM kb_documents doc
     LEFT JOIN kb_serving_versions sv ON sv.repo_id = doc.repo_id AND sv.branch = doc.branch
     WHERE doc.repo_id = $1
       AND doc.branch = $2
       AND doc.path = $3
       AND (
         (sv.active_build_version IS NOT NULL AND doc.build_version = sv.active_build_version)
         OR (sv.active_build_version IS NULL AND doc.is_active = true)
       )
     ORDER BY doc.updated_at DESC
     LIMIT 1`,
    [repoId, branch, path]
  );
  return result.rows[0] ?? null;
}

export async function getServingVersion(repoId: string, branch: string): Promise<KbServingVersion | null> {
  const result = await pool.query<KbServingVersion>(
    `SELECT *
     FROM kb_serving_versions
     WHERE repo_id = $1 AND branch = $2
     LIMIT 1`,
    [repoId, branch]
  );
  return result.rows[0] ?? null;
}

export async function upsertServingVersion(input: {
  repoId: string;
  branch: string;
  activeBuildVersion: string;
  activeHead: string;
}): Promise<KbServingVersion> {
  const result = await pool.query<KbServingVersion>(
    `INSERT INTO kb_serving_versions (
      repo_id, branch, active_build_version, active_head, activated_at, updated_at
    ) VALUES ($1,$2,$3,$4,NOW(),NOW())
    ON CONFLICT (repo_id, branch)
    DO UPDATE SET
      active_build_version = EXCLUDED.active_build_version,
      active_head = EXCLUDED.active_head,
      activated_at = NOW(),
      updated_at = NOW()
    RETURNING *`,
    [input.repoId, input.branch, input.activeBuildVersion, input.activeHead]
  );
  return result.rows[0];
}

export async function findActiveFullSyncRun(repoId: string, branch: string): Promise<KbSyncRun | null> {
  const result = await pool.query<KbSyncRun>(
    `SELECT *
     FROM kb_sync_runs
     WHERE repo_id = $1
       AND branch = $2
       AND sync_mode = 'full'
       AND status IN ('planned', 'running', 'finalizing')
     ORDER BY created_at DESC
     LIMIT 1`,
    [repoId, branch]
  );
  return result.rows[0] ?? null;
}

export async function getSyncRun(runId: string): Promise<KbSyncRun | null> {
  const result = await pool.query<KbSyncRun>(`SELECT * FROM kb_sync_runs WHERE id = $1 LIMIT 1`, [runId]);
  return result.rows[0] ?? null;
}

export async function listSyncRunShards(runId: string): Promise<KbSyncRunShard[]> {
  const result = await pool.query<KbSyncRunShard>(
    `SELECT *
     FROM kb_sync_run_shards
     WHERE run_id = $1
     ORDER BY shard_key ASC`,
    [runId]
  );
  return result.rows;
}

export async function getSyncRunShard(runId: string, shardKey: KbFullSyncShardKey): Promise<KbSyncRunShard | null> {
  const result = await pool.query<KbSyncRunShard>(
    `SELECT *
     FROM kb_sync_run_shards
     WHERE run_id = $1 AND shard_key = $2
     LIMIT 1`,
    [runId, shardKey]
  );
  return result.rows[0] ?? null;
}

export async function listSyncRunManifest(runId: string, limit = 500): Promise<KbSyncManifestItem[]> {
  const result = await pool.query<KbSyncManifestItem>(
    `SELECT *
     FROM kb_sync_manifest_items
     WHERE run_id = $1
     ORDER BY path ASC
     LIMIT $2`,
    [runId, Math.max(1, limit)]
  );
  return result.rows;
}

export async function createFullSyncRun(input: {
  repoId: string;
  branch: string;
  targetHead: string;
  requestedBy: string;
  runReason?: string;
  sourceSnapshotTotal: number;
  manifestItems: Array<{
    path: string;
    shardKey: KbFullSyncShardKey;
    blobSha: string;
    sizeBytes: number;
    needsRebuild: boolean;
    reuseReason?: string | null;
  }>;
}): Promise<{ run: KbSyncRun; shards: KbSyncRunShard[] }> {
  const shardPrefixes: Record<KbFullSyncShardKey, string> = {
    "deploy-docs": "deploy-docs/",
    docs: "docs/",
    "open-docs": "open-docs/"
  };
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const runResult = await client.query<KbSyncRun>(
      `INSERT INTO kb_sync_runs (
        id, repo_id, branch, sync_mode, target_head, source_snapshot_total, status,
        requested_by, run_reason, started_at
      ) VALUES ($1,$2,$3,'full',$4,$5,'running',$6,$7,NOW())
      RETURNING *`,
      [uuidv4(), input.repoId, input.branch, input.targetHead, input.sourceSnapshotTotal, input.requestedBy, input.runReason ?? null]
    );
    const run = runResult.rows[0];

    const shards: KbSyncRunShard[] = [];
    for (const shardKey of ["deploy-docs", "docs", "open-docs"] as KbFullSyncShardKey[]) {
      const totalDocs = input.manifestItems.filter((item) => item.shardKey === shardKey).length;
      const shardResult = await client.query<KbSyncRunShard>(
        `INSERT INTO kb_sync_run_shards (
          id, run_id, repo_id, branch, shard_key, prefix, total_docs, status
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,'queued')
        RETURNING *`,
        [uuidv4(), run.id, input.repoId, input.branch, shardKey, shardPrefixes[shardKey], totalDocs]
      );
      shards.push(shardResult.rows[0]);
    }

    for (const item of input.manifestItems) {
      await client.query(
        `INSERT INTO kb_sync_manifest_items (
          id, run_id, repo_id, branch, target_head, path, shard_key, blob_sha, size_bytes,
          needs_rebuild, reuse_reason, build_status
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'pending')`,
        [
          uuidv4(),
          run.id,
          input.repoId,
          input.branch,
          input.targetHead,
          item.path,
          item.shardKey,
          item.blobSha,
          item.sizeBytes,
          item.needsRebuild,
          item.reuseReason ?? null
        ]
      );
    }

    await client.query("COMMIT");
    return { run, shards };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function listPendingManifestItemsForShard(input: {
  runId: string;
  shardKey: KbFullSyncShardKey;
  cursor?: string | null;
  limit: number;
}): Promise<KbSyncManifestItem[]> {
  const values: unknown[] = [input.runId, input.shardKey];
  const cursorClause =
    input.cursor && input.cursor.trim()
      ? (() => {
          values.push(input.cursor.trim());
          return `AND path > $${values.length}`;
        })()
      : "";
  values.push(Math.max(1, input.limit));
  const result = await pool.query<KbSyncManifestItem>(
    `SELECT *
     FROM kb_sync_manifest_items
     WHERE run_id = $1
       AND shard_key = $2
       AND build_status = 'pending'
       ${cursorClause}
     ORDER BY path ASC
     LIMIT $${values.length}`,
    values
  );
  return result.rows;
}

export async function updateManifestItemBuildStatus(input: {
  runId: string;
  path: string;
  status: KbManifestBuildStatus;
  errorMessage?: string | null;
}): Promise<void> {
  await pool.query(
    `UPDATE kb_sync_manifest_items
     SET build_status = $3,
         error_message = $4,
         updated_at = NOW()
     WHERE run_id = $1 AND path = $2`,
    [input.runId, input.path, input.status, input.errorMessage ?? null]
  );
}

export async function advanceSyncRunShard(input: {
  runId: string;
  shardKey: KbFullSyncShardKey;
  completedDelta: number;
  reusableDelta: number;
  rebuiltDelta: number;
  failedDelta: number;
  nextCursor?: string | null;
  status: KbSyncRunShard["status"];
  errorMessage?: string | null;
}): Promise<KbSyncRunShard> {
  const result = await pool.query<KbSyncRunShard>(
    `UPDATE kb_sync_run_shards
     SET completed_docs = completed_docs + $3,
         reusable_docs = reusable_docs + $4,
         rebuilt_docs = rebuilt_docs + $5,
         failed_docs = failed_docs + $6,
         next_cursor = $7,
         status = $8,
         error_message = $9,
         started_at = COALESCE(started_at, NOW()),
         finished_at = CASE WHEN $8 IN ('succeeded', 'failed') THEN NOW() ELSE finished_at END,
         last_heartbeat_at = NOW(),
         updated_at = NOW()
     WHERE run_id = $1 AND shard_key = $2
     RETURNING *`,
    [
      input.runId,
      input.shardKey,
      input.completedDelta,
      input.reusableDelta,
      input.rebuiltDelta,
      input.failedDelta,
      input.nextCursor ?? null,
      input.status,
      input.errorMessage ?? null
    ]
  );
  return result.rows[0];
}

export async function heartbeatSyncRunShard(runId: string, shardKey: KbFullSyncShardKey, status: KbSyncRunShard["status"] = "running"): Promise<void> {
  await pool.query(
    `UPDATE kb_sync_run_shards
     SET status = $3,
         started_at = COALESCE(started_at, NOW()),
         last_heartbeat_at = NOW(),
         updated_at = NOW()
     WHERE run_id = $1 AND shard_key = $2`,
    [runId, shardKey, status]
  );
}

export async function getSyncRunManifestSummary(runId: string): Promise<Record<KbManifestBuildStatus, number>> {
  const result = await pool.query<{ build_status: KbManifestBuildStatus; total: string }>(
    `SELECT build_status, COUNT(*)::text AS total
     FROM kb_sync_manifest_items
     WHERE run_id = $1
     GROUP BY build_status`,
    [runId]
  );
  return result.rows.reduce<Record<KbManifestBuildStatus, number>>(
    (acc, row) => {
      acc[row.build_status] = Number(row.total);
      return acc;
    },
    { pending: 0, reused: 0, rebuilt: 0, failed: 0 }
  );
}

export async function markSyncRunFailed(runId: string, errorMessage: string): Promise<void> {
  await pool.query(
    `UPDATE kb_sync_runs
     SET status = 'failed',
         error_message = $2,
         finished_at = NOW(),
         updated_at = NOW()
     WHERE id = $1`,
    [runId, errorMessage.slice(0, 4000)]
  );
}

export async function markSyncRunShardFailed(runId: string, shardKey: KbFullSyncShardKey, errorMessage: string): Promise<void> {
  await pool.query(
    `UPDATE kb_sync_run_shards
     SET status = 'failed',
         error_message = $3,
         failed_docs = failed_docs + 1,
         finished_at = NOW(),
         last_heartbeat_at = NOW(),
         updated_at = NOW()
     WHERE run_id = $1 AND shard_key = $2`,
    [runId, shardKey, errorMessage.slice(0, 4000)]
  );
}

export async function tryStartSyncRunFinalization(runId: string): Promise<KbSyncRun | null> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const shards = await client.query<{ incomplete: string; failed: string }>(
      `SELECT
         COUNT(*) FILTER (WHERE status <> 'succeeded')::text AS incomplete,
         COUNT(*) FILTER (WHERE status = 'failed' OR failed_docs > 0)::text AS failed
       FROM kb_sync_run_shards
       WHERE run_id = $1`,
      [runId]
    );
    if (Number(shards.rows[0]?.incomplete ?? "1") > 0 || Number(shards.rows[0]?.failed ?? "1") > 0) {
      await client.query("ROLLBACK");
      return null;
    }
    const result = await client.query<KbSyncRun>(
      `UPDATE kb_sync_runs
       SET status = 'finalizing',
           updated_at = NOW()
       WHERE id = $1
         AND status = 'running'
       RETURNING *`,
      [runId]
    );
    await client.query("COMMIT");
    return result.rows[0] ?? null;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function finalizeSyncRunSuccess(input: {
  runId: string;
  repoId: string;
  branch: string;
  buildVersion: string;
  targetHead: string;
}): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const manifest = await client.query<{ pending: string; failed: string }>(
      `SELECT
         COUNT(*) FILTER (WHERE build_status = 'pending')::text AS pending,
         COUNT(*) FILTER (WHERE build_status = 'failed')::text AS failed
       FROM kb_sync_manifest_items
       WHERE run_id = $1`,
      [input.runId]
    );
    if (Number(manifest.rows[0]?.pending ?? "1") > 0 || Number(manifest.rows[0]?.failed ?? "1") > 0) {
      throw new Error(`Run ${input.runId} cannot finalize because manifest is incomplete`);
    }

    await client.query(
      `INSERT INTO kb_serving_versions (
        repo_id, branch, active_build_version, active_head, activated_at, updated_at
      ) VALUES ($1,$2,$3,$4,NOW(),NOW())
      ON CONFLICT (repo_id, branch)
      DO UPDATE SET
        active_build_version = EXCLUDED.active_build_version,
        active_head = EXCLUDED.active_head,
        activated_at = NOW(),
        updated_at = NOW()`,
      [input.repoId, input.branch, input.buildVersion, input.targetHead]
    );

    await client.query(
      `INSERT INTO kb_sync_checkpoints (
        repo_id, branch, last_synced_commit_sha, last_synced_at,
        last_full_synced_commit_sha, last_full_synced_at
      ) VALUES ($1,$2,$3,NOW(),$3,NOW())
      ON CONFLICT (repo_id, branch)
      DO UPDATE SET
        last_synced_commit_sha = EXCLUDED.last_synced_commit_sha,
        last_synced_at = NOW(),
        last_full_synced_commit_sha = EXCLUDED.last_full_synced_commit_sha,
        last_full_synced_at = NOW(),
        updated_at = NOW()`,
      [input.repoId, input.branch, input.targetHead]
    );

    await client.query(
      `UPDATE kb_sync_runs
       SET status = 'succeeded',
           finished_at = NOW(),
           error_message = NULL,
           updated_at = NOW()
       WHERE id = $1`,
      [input.runId]
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function markSyncRunFinalizationFailed(runId: string, errorMessage: string): Promise<void> {
  await pool.query(
    `UPDATE kb_sync_runs
     SET status = 'failed',
         error_message = $2,
         finished_at = NOW(),
         updated_at = NOW()
     WHERE id = $1`,
    [runId, errorMessage.slice(0, 4000)]
  );
}

export async function recordMetric(input: {
  repoId?: string;
  metricName: string;
  metricValue: number;
  tags?: Record<string, unknown>;
}): Promise<void> {
  await pool.query(
    `INSERT INTO kb_metrics_events (id, repo_id, metric_name, metric_value, tags_json)
     VALUES ($1,$2,$3,$4,$5::jsonb)`,
    [uuidv4(), input.repoId ?? null, input.metricName, input.metricValue, toJson(input.tags)]
  );
}

export async function aggregateMetricsLast24h(): Promise<Record<string, number>> {
  const result = await pool.query<{ metric_name: string; avg_value: string }>(
    `SELECT metric_name, AVG(metric_value)::text AS avg_value
     FROM kb_metrics_events
     WHERE created_at >= NOW() - INTERVAL '24 hours'
     GROUP BY metric_name`
  );

  return result.rows.reduce<Record<string, number>>((acc, row) => {
    acc[row.metric_name] = Number(row.avg_value);
    return acc;
  }, {});
}

export async function insertWebhookEvent(input: {
  deliveryId: string;
  eventType: string;
  repoFullName: string;
  payload: Record<string, unknown>;
  signature?: string;
}): Promise<void> {
  await pool.query(
    `INSERT INTO kb_github_webhook_events (
      id, delivery_id, event_type, repo_full_name, payload_json, signature, status
    ) VALUES ($1,$2,$3,$4,$5::jsonb,$6,'received')
    ON CONFLICT (delivery_id)
    DO NOTHING`,
    [uuidv4(), input.deliveryId, input.eventType, input.repoFullName, toJson(input.payload), input.signature ?? null]
  );
}

export async function markWebhookEventProcessed(deliveryId: string, status: "processed" | "failed", errorMessage?: string): Promise<void> {
  await pool.query(
    `UPDATE kb_github_webhook_events
     SET status = $2,
         processed_at = NOW(),
         error_message = $3,
         updated_at = NOW()
     WHERE delivery_id = $1`,
    [deliveryId, status, errorMessage ?? null]
  );
}
