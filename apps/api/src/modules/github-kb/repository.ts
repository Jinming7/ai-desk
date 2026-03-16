import { v4 as uuidv4 } from "uuid";
import { pool } from "../../db/client.js";
import type { KbDocument, KbSyncJobStatus, RepoRegistration, RetrievalHit, SyncCheckpoint, SyncJob } from "./types.js";

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
    return existing.rows[0];
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
      `WITH due AS (
        SELECT id
        FROM kb_sync_jobs
        WHERE status = 'queued'
          AND next_run_at <= NOW()
        ORDER BY attempts ASC, next_run_at ASC, created_at DESC
        LIMIT $1
        FOR UPDATE SKIP LOCKED
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
  title: string;
  sourceUrl: string;
  repoSourceUrl: string;
  publicSourceUrl: string | null;
  commitSha: string;
  contentHash: string;
  content: string;
  metadata: Record<string, unknown>;
}): Promise<KbDocument> {
  const docKey = `${input.repoId}:${input.path}`;
  const result = await pool.query<KbDocument>(
    `INSERT INTO kb_documents (
      id, repo_id, doc_key, branch, path, title, source_url, repo_source_url, public_source_url,
      commit_sha, content_hash, content, metadata_json, is_active
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,true)
    ON CONFLICT (repo_id, branch, path)
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
      toJson(input.metadata)
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
  commitSha: string;
  headingPath: string;
  ordinal: number;
  content: string;
  contentHash: string;
  tokenCount: number;
  metadata: Record<string, unknown>;
  embedding: string;
  embeddingModel: string;
  embeddingVersion: string;
}): Promise<void> {
  await pool.query(
    `INSERT INTO kb_chunks (
      id, doc_id, repo_id, branch, path, commit_sha, heading_path, ordinal,
      content, content_hash, token_count, metadata_json,
      embedding, embedding_model, embedding_version,
      lexical_content, search_vector, confidence_hint, is_active
    ) VALUES (
      $1,$2,$3,$4,$5,$6,$7,$8,
      $9,$10,$11,$12::jsonb,
      $13::vector,$14,$15,
      $9,to_tsvector('english', $9),0.0,true
    )
    ON CONFLICT (id)
    DO UPDATE SET
      doc_id = EXCLUDED.doc_id,
      repo_id = EXCLUDED.repo_id,
      branch = EXCLUDED.branch,
      path = EXCLUDED.path,
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
  const parts: string[] = ["chunk.is_active = true", "doc.is_active = true"];
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
      LEFT(chunk.content, 400) AS snippet,
      (1 - (chunk.embedding <=> $${vectorParam}::vector))::text AS vector_score
     FROM kb_chunks chunk
     INNER JOIN kb_documents doc ON doc.id = chunk.doc_id
     INNER JOIN kb_repo_registrations reg ON reg.id = chunk.repo_id
     WHERE ${where.clause}
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
    vectorScore: Number(row.vector_score)
  }));
}

export async function searchKeywordCandidates(input: {
  repoId?: string;
  branch?: string;
  query: string;
  limit: number;
}): Promise<RetrievalHit[]> {
  const hasCjk = /[\u3400-\u9FBF]/.test(input.query);
  const where = buildWhereClause({ repoId: input.repoId, branch: input.branch });
  const queryParam = where.values.length + 1;
  const limitParam = where.values.length + 2;

  if (hasCjk) {
    const splitTokens = input.query
      .toLowerCase()
      .split(/[\s,，。！？!?.:/_-]+/)
      .map((token) => token.trim())
      .filter(Boolean);
    const expandedTokens = new Set<string>();
    for (const token of splitTokens) {
      expandedTokens.add(token);
      if (/[\u3400-\u9FBF]/.test(token) && token.length >= 3) {
        for (let i = 0; i < token.length - 1; i += 1) {
          expandedTokens.add(token.slice(i, i + 2));
        }
      }
    }
    const tokens = [...expandedTokens].slice(0, 8);
    if (tokens.length === 0) {
      return [];
    }
    const likeValues = tokens.map((token) => `%${token}%`);
    const likeParams: string[] = [];
    for (let i = 0; i < likeValues.length; i += 1) {
      likeParams.push(`$${queryParam + i}`);
    }
    const limitPlaceholder = queryParam + likeValues.length;
    const tokenOr = likeParams.map((param) => `chunk.path ILIKE ${param} OR doc.title ILIKE ${param} OR chunk.content ILIKE ${param}`).join(" OR ");
    const scoreExpr = likeParams
      .map(
        (param) =>
          `(CASE WHEN doc.title ILIKE ${param} THEN 1.8 ELSE 0 END + CASE WHEN chunk.path ILIKE ${param} THEN 1.4 ELSE 0 END + CASE WHEN chunk.content ILIKE ${param} THEN 1.0 ELSE 0 END)`
      )
      .join(" + ");
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
        LEFT(chunk.content, 400) AS snippet,
        (${scoreExpr})::text AS lexical_score
       FROM kb_chunks chunk
       INNER JOIN kb_documents doc ON doc.id = chunk.doc_id
       INNER JOIN kb_repo_registrations reg ON reg.id = chunk.repo_id
       WHERE ${where.clause}
         AND (${tokenOr})
       ORDER BY (${scoreExpr}) DESC, chunk.updated_at DESC
       LIMIT $${limitPlaceholder}`,
      [...where.values, ...likeValues, input.limit]
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
      lexicalScore: Number(row.lexical_score)
    }));
  }

  const tokens = input.query
    .toLowerCase()
    .split(/[\s,，。！？!?.:/_-]+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2)
    .slice(0, 8);
  const likeValues = tokens.map((token) => `%${token}%`);
  const tokenBase = queryParam + 1;
  const tokenParams: string[] = [];
  for (let i = 0; i < likeValues.length; i += 1) {
    tokenParams.push(`$${tokenBase + i}`);
  }
  const limitPlaceholder = tokenBase + likeValues.length;
  const tokenOr = tokenParams.length
    ? tokenParams.map((param) => `chunk.path ILIKE ${param} OR doc.title ILIKE ${param} OR chunk.content ILIKE ${param}`).join(" OR ")
    : "false";
  const tokenScore = tokenParams.length
    ? tokenParams
        .map(
          (param) =>
            `(CASE WHEN doc.title ILIKE ${param} THEN 0.35 ELSE 0 END + CASE WHEN chunk.path ILIKE ${param} THEN 0.28 ELSE 0 END + CASE WHEN chunk.content ILIKE ${param} THEN 0.22 ELSE 0 END)`
        )
        .join(" + ")
    : "0";

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
      COALESCE(
        NULLIF(ts_headline('english', chunk.content, websearch_to_tsquery('english', $${queryParam}), 'MaxWords=40, MinWords=15'), ''),
        LEFT(chunk.content, 400)
      ) AS snippet,
      (
        ts_rank_cd(chunk.search_vector, websearch_to_tsquery('english', $${queryParam}))
        + ${tokenScore}
      )::text AS lexical_score
     FROM kb_chunks chunk
     INNER JOIN kb_documents doc ON doc.id = chunk.doc_id
     INNER JOIN kb_repo_registrations reg ON reg.id = chunk.repo_id
     WHERE ${where.clause}
       AND (
         chunk.search_vector @@ websearch_to_tsquery('english', $${queryParam})
         OR (${tokenOr})
       )
     ORDER BY (
       ts_rank_cd(chunk.search_vector, websearch_to_tsquery('english', $${queryParam}))
       + ${tokenScore}
     ) DESC
     LIMIT $${limitPlaceholder}`,
    [...where.values, input.query, ...likeValues, input.limit]
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
    lexicalScore: Number(row.lexical_score)
  }));
}

export async function listCandidateDocumentsForFallback(input: {
  repoId?: string;
  branch?: string;
  query: string;
  limit: number;
}): Promise<Array<{ repoId: string; path: string; sourceUrl: string; repoSourceUrl: string; title: string; commitSha: string; branch: string; repo: string }>> {
  const conditions: string[] = ["doc.is_active = true"];
  const values: unknown[] = [];

  if (input.repoId) {
    values.push(input.repoId);
    conditions.push(`doc.repo_id = $${values.length}`);
  }
  if (input.branch) {
    values.push(input.branch);
    conditions.push(`doc.branch = $${values.length}`);
  }

  values.push(`%${input.query}%`);
  const queryParam = values.length;
  values.push(input.limit);
  const limitParam = values.length;

  const result = await pool.query<{
    repo_id: string;
    path: string;
    source_url: string;
    repo_source_url: string;
    title: string;
    commit_sha: string;
    branch: string;
    repo: string;
  }>(
    `SELECT
      doc.repo_id,
      doc.path,
      doc.source_url,
      doc.repo_source_url,
      doc.title,
      doc.commit_sha,
      doc.branch,
      reg.repo_owner || '/' || reg.repo_name AS repo
     FROM kb_documents doc
     INNER JOIN kb_repo_registrations reg ON reg.id = doc.repo_id
     WHERE ${conditions.join(" AND ")}
       AND (doc.title ILIKE $${queryParam} OR doc.path ILIKE $${queryParam} OR doc.content ILIKE $${queryParam})
     ORDER BY doc.updated_at DESC
     LIMIT $${limitParam}`,
    values
  );

  return result.rows.map((row) => ({
    repoId: row.repo_id,
    path: row.path,
    sourceUrl: row.source_url,
    repoSourceUrl: row.repo_source_url,
    title: row.title,
    commitSha: row.commit_sha,
    branch: row.branch,
    repo: row.repo
  }));
}

export async function getDocumentByPath(repoId: string, branch: string, path: string): Promise<KbDocument | null> {
  const result = await pool.query<KbDocument>(
    `SELECT * FROM kb_documents WHERE repo_id = $1 AND branch = $2 AND path = $3 LIMIT 1`,
    [repoId, branch, path]
  );
  return result.rows[0] ?? null;
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
