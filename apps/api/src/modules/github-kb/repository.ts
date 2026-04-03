import { v4 as uuidv4 } from "uuid";
import { pool } from "../../db/client.js";
import { chunkFullSyncManifestItems } from "./full-sync-manifest-batching.js";
import type {
  KbBuild,
  KbBuildStatus,
  KbBuildValidationResult,
  KbCitationUnit,
  KbCodeSymbol,
  KbConfigSurface,
  KbDocument,
  KbFullSyncShardKey,
  KbIngestLease,
  KbKnowledgeSpace,
  KbOpenApiOperation,
  KbManifestBuildStatus,
  KbPublication,
  KbRequestedFromEnv,
  KbSchemaObject,
  KbServingVersion,
  KbSyncJobStatus,
  KbSyncManifestItem,
  KbSyncRun,
  KbSyncRunShard,
  KbTestBehavior,
  RepoRegistration,
  RetrievalHit,
  SyncCheckpoint,
  SyncJob
} from "./types.js";

function toJson(value: unknown): string {
  return JSON.stringify(value ?? {});
}

function normalizeKnowledgeSpace(value: string | null | undefined): KbKnowledgeSpace {
  const normalized = String(value ?? "").trim();
  if (
    normalized === "support-prod" ||
    normalized === "support-preview" ||
    normalized === "support-local" ||
    normalized === "support-shadow" ||
    normalized === "support-eval"
  ) {
    return normalized;
  }
  return "support-local";
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
  knowledgeSpace?: KbKnowledgeSpace;
  buildVersion?: string;
  prefixes: string[];
}): Promise<Array<{ prefix: string; total: number; active: number }>> {
  const prefixes = input.prefixes.map((item) => String(item ?? "").trim()).filter(Boolean);
  if (!prefixes.length) return [];

  const branch = input.branch?.trim() || null;
  const knowledgeSpace = normalizeKnowledgeSpace(input.knowledgeSpace);
  const buildVersion = input.buildVersion?.trim() || null;
  const result = await pool.query<{ prefix: string; total: string; active: string }>(
    `WITH prefixes(prefix) AS (
       SELECT UNNEST($3::text[])
     )
     SELECT
       prefixes.prefix,
       COUNT(doc.id)::text AS total,
       COUNT(doc.id)::text AS active
     FROM prefixes
     LEFT JOIN kb_documents doc
       ON doc.repo_id = $1
      AND ($2::text IS NULL OR doc.branch = $2)
      AND doc.path LIKE prefixes.prefix || '%'
      AND doc.knowledge_space = $4
      AND (
        ($5::text IS NOT NULL AND doc.build_version = $5)
        OR (
          $5::text IS NULL
          AND EXISTS (
            SELECT 1
            FROM kb_publications pub
            WHERE pub.knowledge_space = $4
              AND pub.repo_id = doc.repo_id
              AND pub.branch = doc.branch
              AND pub.published_build_version = doc.build_version
          )
        )
      )
     GROUP BY prefixes.prefix
     ORDER BY prefixes.prefix`,
    [input.repoId, branch, prefixes, knowledgeSpace, buildVersion]
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

export async function getBuildById(buildId: string): Promise<KbBuild | null> {
  const result = await pool.query<KbBuild>(`SELECT * FROM kb_builds WHERE id = $1 LIMIT 1`, [buildId]);
  return result.rows[0] ?? null;
}

export async function getBuildByVersion(input: {
  knowledgeSpace: KbKnowledgeSpace;
  repoId: string;
  branch: string;
  buildVersion: string;
}): Promise<KbBuild | null> {
  const result = await pool.query<KbBuild>(
    `SELECT *
     FROM kb_builds
     WHERE knowledge_space = $1
       AND repo_id = $2
       AND branch = $3
       AND build_version = $4
     LIMIT 1`,
    [input.knowledgeSpace, input.repoId, input.branch, input.buildVersion]
  );
  return result.rows[0] ?? null;
}

export async function listRecentBuildsForScope(input: {
  knowledgeSpace: KbKnowledgeSpace;
  repoId: string;
  branch: string;
  limit?: number;
  excludeBuildVersion?: string;
}): Promise<KbBuild[]> {
  const values: unknown[] = [input.knowledgeSpace, input.repoId, input.branch];
  const clauses = ["knowledge_space = $1", "repo_id = $2", "branch = $3"];
  if (input.excludeBuildVersion) {
    values.push(input.excludeBuildVersion);
    clauses.push(`build_version <> $${values.length}`);
  }
  values.push(Math.max(1, Math.min(input.limit ?? 10, 50)));
  const result = await pool.query<KbBuild>(
    `SELECT *
     FROM kb_builds
     WHERE ${clauses.join(" AND ")}
     ORDER BY updated_at DESC, created_at DESC
     LIMIT $${values.length}`,
    values
  );
  return result.rows;
}

export async function ensureBuild(input: {
  knowledgeSpace: KbKnowledgeSpace;
  repoId: string;
  branch: string;
  buildVersion: string;
  targetHead: string;
  buildKind: KbBuild["build_kind"];
  requestedBy: string;
  requestedFromEnv: KbRequestedFromEnv;
  sourceSnapshotTotal?: number;
}): Promise<KbBuild> {
  const result = await pool.query<KbBuild>(
    `INSERT INTO kb_builds (
      id, knowledge_space, repo_id, branch, build_version, target_head, build_kind,
      requested_by, requested_from_env, status, source_snapshot_total, started_at
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'building',$10,NOW())
    ON CONFLICT (knowledge_space, repo_id, branch, build_version)
    DO UPDATE SET
      target_head = EXCLUDED.target_head,
      build_kind = EXCLUDED.build_kind,
      requested_by = EXCLUDED.requested_by,
      requested_from_env = EXCLUDED.requested_from_env,
      source_snapshot_total = GREATEST(kb_builds.source_snapshot_total, EXCLUDED.source_snapshot_total),
      started_at = COALESCE(kb_builds.started_at, NOW()),
      updated_at = NOW()
    RETURNING *`,
    [
      uuidv4(),
      input.knowledgeSpace,
      input.repoId,
      input.branch,
      input.buildVersion,
      input.targetHead,
      input.buildKind,
      input.requestedBy,
      input.requestedFromEnv,
      Math.max(0, input.sourceSnapshotTotal ?? 0)
    ]
  );
  return result.rows[0];
}

export async function updateBuildArtifactCounts(input: {
  knowledgeSpace: KbKnowledgeSpace;
  repoId: string;
  branch: string;
  buildVersion: string;
}): Promise<KbBuild | null> {
  const result = await pool.query<KbBuild>(
    `WITH stats AS (
       SELECT
         COALESCE((SELECT COUNT(*) FROM kb_documents WHERE knowledge_space = $1 AND repo_id = $2 AND branch = $3 AND build_version = $4), 0) AS documents_built,
         COALESCE((SELECT COUNT(*) FROM kb_chunks WHERE knowledge_space = $1 AND repo_id = $2 AND branch = $3 AND build_version = $4), 0) AS chunks_built,
         COALESCE((SELECT COUNT(*) FROM kb_memory_entries WHERE knowledge_space = $1 AND repo_id = $2 AND branch = $3 AND build_version = $4), 0) AS memory_entries_built,
         COALESCE((
           SELECT COUNT(*)
           FROM kb_chunks
           WHERE knowledge_space = $1
             AND repo_id = $2
             AND branch = $3
             AND build_version = $4
             AND embedding IS NOT NULL
         ), 0) AS embeddings_built
     )
     UPDATE kb_builds AS build
     SET documents_built = stats.documents_built,
         chunks_built = stats.chunks_built,
         memory_entries_built = stats.memory_entries_built,
         embeddings_built = stats.embeddings_built,
         updated_at = NOW()
     FROM stats
     WHERE build.knowledge_space = $1
       AND build.repo_id = $2
       AND build.branch = $3
       AND build.build_version = $4
     RETURNING build.*`,
    [input.knowledgeSpace, input.repoId, input.branch, input.buildVersion]
  );
  return result.rows[0] ?? null;
}

export async function updateBuildStatus(input: {
  buildId: string;
  status: KbBuildStatus;
  validationPassed?: boolean;
  validationSummary?: Record<string, unknown>;
  errorMessage?: string | null;
  finished?: boolean;
}): Promise<KbBuild | null> {
  const result = await pool.query<KbBuild>(
    `UPDATE kb_builds
     SET status = $2,
         validation_passed = COALESCE($3, validation_passed),
         validation_summary_json = CASE WHEN $4::jsonb IS NULL THEN validation_summary_json ELSE $4::jsonb END,
         error_message = COALESCE($5, error_message),
         finished_at = CASE WHEN $6 THEN NOW() ELSE finished_at END,
         updated_at = NOW()
     WHERE id = $1
     RETURNING *`,
    [input.buildId, input.status, input.validationPassed ?? null, input.validationSummary ? toJson(input.validationSummary) : null, input.errorMessage ?? null, input.finished ?? false]
  );
  return result.rows[0] ?? null;
}

export async function replaceBuildValidationResults(input: {
  buildId: string;
  results: Array<{
    validationKind: string;
    passed: boolean;
    severity: KbBuildValidationResult["severity"];
    summary: string;
    details?: Record<string, unknown>;
  }>;
}): Promise<KbBuildValidationResult[]> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`DELETE FROM kb_build_validation_results WHERE build_id = $1`, [input.buildId]);
    const rows: KbBuildValidationResult[] = [];
    for (const item of input.results) {
      const result = await client.query<KbBuildValidationResult>(
        `INSERT INTO kb_build_validation_results (
          id, build_id, validation_kind, passed, severity, summary, details_json
        ) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)
        RETURNING *`,
        [uuidv4(), input.buildId, item.validationKind, item.passed, item.severity, item.summary, toJson(item.details ?? {})]
      );
      rows.push(result.rows[0]);
    }
    await client.query("COMMIT");
    return rows;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function listBuildValidationResults(buildId: string): Promise<KbBuildValidationResult[]> {
  const result = await pool.query<KbBuildValidationResult>(
    `SELECT *
     FROM kb_build_validation_results
     WHERE build_id = $1
     ORDER BY created_at ASC`,
    [buildId]
  );
  return result.rows;
}

export async function getPublication(input: {
  knowledgeSpace: KbKnowledgeSpace;
  repoId: string;
  branch: string;
}): Promise<KbPublication | null> {
  const result = await pool.query<KbPublication>(
    `SELECT *
     FROM kb_publications
     WHERE knowledge_space = $1
       AND repo_id = $2
       AND branch = $3
     LIMIT 1`,
    [input.knowledgeSpace, input.repoId, input.branch]
  );
  return result.rows[0] ?? null;
}

export async function listPublications(input?: {
  knowledgeSpace?: KbKnowledgeSpace;
  repoId?: string;
  branch?: string;
}): Promise<KbPublication[]> {
  const clauses: string[] = [];
  const values: unknown[] = [];
  if (input?.knowledgeSpace) {
    values.push(input.knowledgeSpace);
    clauses.push(`knowledge_space = $${values.length}`);
  }
  if (input?.repoId) {
    values.push(input.repoId);
    clauses.push(`repo_id = $${values.length}`);
  }
  if (input?.branch) {
    values.push(input.branch);
    clauses.push(`branch = $${values.length}`);
  }
  const result = await pool.query<KbPublication>(
    `SELECT *
     FROM kb_publications
     WHERE ${clauses.length ? clauses.join(" AND ") : "TRUE"}
     ORDER BY published_at DESC`,
    values
  );
  return result.rows;
}

export async function countPublications(input?: {
  knowledgeSpace?: KbKnowledgeSpace;
  repoId?: string;
  branch?: string;
}): Promise<number> {
  const clauses: string[] = [];
  const values: unknown[] = [];
  if (input?.knowledgeSpace) {
    values.push(input.knowledgeSpace);
    clauses.push(`knowledge_space = $${values.length}`);
  }
  if (input?.repoId) {
    values.push(input.repoId);
    clauses.push(`repo_id = $${values.length}`);
  }
  if (input?.branch) {
    values.push(input.branch);
    clauses.push(`branch = $${values.length}`);
  }
  const result = await pool.query<{ total: string }>(
    `SELECT COUNT(*)::text AS total
     FROM kb_publications
     WHERE ${clauses.length ? clauses.join(" AND ") : "TRUE"}`,
    values
  );
  return Number(result.rows[0]?.total ?? "0");
}

export async function upsertPublication(input: {
  knowledgeSpace: KbKnowledgeSpace;
  repoId: string;
  branch: string;
  publishedBuildVersion: string;
  publishedHead: string;
  publishedBy: string;
  publishedFromEnv: KbRequestedFromEnv;
}): Promise<KbPublication> {
  const result = await pool.query<KbPublication>(
    `INSERT INTO kb_publications (
      knowledge_space, repo_id, branch, published_build_version, published_head,
      published_by, published_from_env, published_at, updated_at
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,NOW(),NOW())
    ON CONFLICT (knowledge_space, repo_id, branch)
    DO UPDATE SET
      published_build_version = EXCLUDED.published_build_version,
      published_head = EXCLUDED.published_head,
      published_by = EXCLUDED.published_by,
      published_from_env = EXCLUDED.published_from_env,
      published_at = NOW(),
      updated_at = NOW()
    RETURNING *`,
    [
      input.knowledgeSpace,
      input.repoId,
      input.branch,
      input.publishedBuildVersion,
      input.publishedHead,
      input.publishedBy,
      input.publishedFromEnv
    ]
  );
  return result.rows[0];
}

export async function acquireIngestLease(input: {
  leaseKey: string;
  ownerId: string;
  ownerEnv: KbRequestedFromEnv;
  ttlSeconds: number;
  metadata?: Record<string, unknown>;
}): Promise<KbIngestLease> {
  const result = await pool.query<KbIngestLease>(
    `INSERT INTO kb_ingest_leases (
      lease_key, owner_id, owner_env, expires_at, metadata_json, updated_at
    ) VALUES ($1,$2,$3,NOW() + ($4::int * INTERVAL '1 second'),$5::jsonb,NOW())
    ON CONFLICT (lease_key)
    DO UPDATE SET
      owner_id = EXCLUDED.owner_id,
      owner_env = EXCLUDED.owner_env,
      expires_at = EXCLUDED.expires_at,
      metadata_json = EXCLUDED.metadata_json,
      updated_at = NOW()
    WHERE kb_ingest_leases.expires_at <= NOW() OR kb_ingest_leases.owner_id = EXCLUDED.owner_id
    RETURNING *`,
    [input.leaseKey, input.ownerId, input.ownerEnv, Math.max(30, Math.floor(input.ttlSeconds)), toJson(input.metadata ?? {})]
  );
  if (!result.rowCount) {
    throw new Error(`Lease is already held: ${input.leaseKey}`);
  }
  return result.rows[0];
}

export async function releaseIngestLease(leaseKey: string, ownerId?: string): Promise<void> {
  if (ownerId) {
    await pool.query(`DELETE FROM kb_ingest_leases WHERE lease_key = $1 AND owner_id = $2`, [leaseKey, ownerId]);
    return;
  }
  await pool.query(`DELETE FROM kb_ingest_leases WHERE lease_key = $1`, [leaseKey]);
}

export async function getBuildValidationSnapshot(input: {
  knowledgeSpace: KbKnowledgeSpace;
  repoId: string;
  branch: string;
  buildVersion: string;
}): Promise<{
  duplicatePaths: number;
  orphanChunks: number;
  crossBuildMemorySources: number;
  missingChunkDocuments: number;
  totalDocuments: number;
  totalChunks: number;
  totalMemoryEntries: number;
}> {
  const result = await pool.query<{
    duplicate_paths: string;
    orphan_chunks: string;
    cross_build_memory_sources: string;
    missing_chunk_documents: string;
    total_documents: string;
    total_chunks: string;
    total_memory_entries: string;
  }>(
    `SELECT
       (
         SELECT COUNT(*)::text
         FROM (
           SELECT path
           FROM kb_documents
           WHERE knowledge_space = $1
             AND repo_id = $2
             AND branch = $3
             AND build_version = $4
           GROUP BY path
           HAVING COUNT(*) > 1
         ) dup
       ) AS duplicate_paths,
       (
         SELECT COUNT(*)::text
         FROM kb_chunks chunk
         LEFT JOIN kb_documents doc
           ON doc.id = chunk.doc_id
          AND doc.knowledge_space = chunk.knowledge_space
          AND doc.build_version = chunk.build_version
         WHERE chunk.knowledge_space = $1
           AND chunk.repo_id = $2
           AND chunk.branch = $3
           AND chunk.build_version = $4
           AND doc.id IS NULL
       ) AS orphan_chunks,
       (
         SELECT COUNT(*)::text
         FROM kb_memory_sources src
         INNER JOIN kb_memory_entries entry ON entry.id = src.memory_id
         INNER JOIN kb_chunks chunk ON chunk.id = src.chunk_id
         WHERE entry.knowledge_space = $1
           AND entry.repo_id = $2
           AND entry.branch = $3
           AND entry.build_version = $4
           AND (
             chunk.knowledge_space <> entry.knowledge_space
             OR chunk.build_version <> entry.build_version
           )
       ) AS cross_build_memory_sources,
       (
         SELECT COUNT(*)::text
         FROM kb_chunks chunk
         LEFT JOIN kb_documents doc ON doc.id = chunk.doc_id
         WHERE chunk.knowledge_space = $1
           AND chunk.repo_id = $2
           AND chunk.branch = $3
           AND chunk.build_version = $4
           AND (doc.id IS NULL OR doc.build_version <> chunk.build_version OR doc.knowledge_space <> chunk.knowledge_space)
       ) AS missing_chunk_documents,
       (
         SELECT COUNT(*)::text
         FROM kb_documents
         WHERE knowledge_space = $1
           AND repo_id = $2
           AND branch = $3
           AND build_version = $4
       ) AS total_documents,
       (
         SELECT COUNT(*)::text
         FROM kb_chunks
         WHERE knowledge_space = $1
           AND repo_id = $2
           AND branch = $3
           AND build_version = $4
       ) AS total_chunks,
       (
         SELECT COUNT(*)::text
         FROM kb_memory_entries
         WHERE knowledge_space = $1
           AND repo_id = $2
           AND branch = $3
           AND build_version = $4
       ) AS total_memory_entries`,
    [input.knowledgeSpace, input.repoId, input.branch, input.buildVersion]
  );
  const row = result.rows[0];
  return {
    duplicatePaths: Number(row?.duplicate_paths ?? "0"),
    orphanChunks: Number(row?.orphan_chunks ?? "0"),
    crossBuildMemorySources: Number(row?.cross_build_memory_sources ?? "0"),
    missingChunkDocuments: Number(row?.missing_chunk_documents ?? "0"),
    totalDocuments: Number(row?.total_documents ?? "0"),
    totalChunks: Number(row?.total_chunks ?? "0"),
    totalMemoryEntries: Number(row?.total_memory_entries ?? "0")
  };
}

export async function getBuildArtifactSummary(input: {
  knowledgeSpace: KbKnowledgeSpace;
  repoId: string;
  branch: string;
  buildVersion: string;
}): Promise<{
  artifactCountsByFamily: Record<string, number>;
  parserDegradation: {
    totalDocuments: number;
    degradedDocuments: number;
    degradedFamilies: Record<string, number>;
  };
  embeddingSummary: {
    chunkEmbeddings: { total: number; ready: number; missing: number };
    citationEmbeddings: { total: number; ready: number; missing: number };
  };
}> {
  const docRows = await pool.query<{ family: string | null; total: string; degraded: string }>(
    `SELECT
       NULLIF(metadata_json->>'sourceFamily', '') AS family,
       COUNT(*)::text AS total,
       COUNT(*) FILTER (WHERE COALESCE(metadata_json->>'sourceFamilyQuality', 'canonical') <> 'canonical')::text AS degraded
     FROM kb_documents
     WHERE knowledge_space = $1
       AND repo_id = $2
       AND branch = $3
       AND build_version = $4
     GROUP BY NULLIF(metadata_json->>'sourceFamily', '')`,
    [input.knowledgeSpace, input.repoId, input.branch, input.buildVersion]
  );

  const counts = {
    doc_page: 0,
    runbook_file: 0,
    openapi_spec: 0,
    code_file: 0,
    config_file: 0,
    schema_file: 0,
    test_file: 0,
    openapi_operations: 0,
    code_symbols: 0,
    config_surfaces: 0,
    schema_objects: 0,
    test_behaviors: 0,
    citation_units: 0,
    chunks: 0,
    memory_entries: 0
  } as Record<string, number>;

  let degradedDocuments = 0;
  const degradedFamilies: Record<string, number> = {};
  for (const row of docRows.rows) {
    const family = row.family ?? "unknown";
    counts[family] = Number(row.total);
    const degraded = Number(row.degraded);
    degradedDocuments += degraded;
    if (degraded > 0) degradedFamilies[family] = degraded;
  }

  const scalarCounts = await pool.query<{
    openapi_operations: string;
    code_symbols: string;
    config_surfaces: string;
    schema_objects: string;
    test_behaviors: string;
    citation_units: string;
    chunks: string;
    memory_entries: string;
  }>(
    `SELECT
       (SELECT COUNT(*)::text FROM kb_openapi_operations WHERE knowledge_space = $1 AND repo_id = $2 AND branch = $3 AND build_version = $4) AS openapi_operations,
       (SELECT COUNT(*)::text FROM kb_code_symbols WHERE knowledge_space = $1 AND repo_id = $2 AND branch = $3 AND build_version = $4) AS code_symbols,
       (SELECT COUNT(*)::text FROM kb_config_surfaces WHERE knowledge_space = $1 AND repo_id = $2 AND branch = $3 AND build_version = $4) AS config_surfaces,
       (SELECT COUNT(*)::text FROM kb_schema_objects WHERE knowledge_space = $1 AND repo_id = $2 AND branch = $3 AND build_version = $4) AS schema_objects,
       (SELECT COUNT(*)::text FROM kb_test_behaviors WHERE knowledge_space = $1 AND repo_id = $2 AND branch = $3 AND build_version = $4) AS test_behaviors,
       (SELECT COUNT(*)::text FROM kb_citation_units WHERE knowledge_space = $1 AND repo_id = $2 AND branch = $3 AND build_version = $4) AS citation_units,
       (SELECT COUNT(*)::text FROM kb_chunks WHERE knowledge_space = $1 AND repo_id = $2 AND branch = $3 AND build_version = $4) AS chunks,
       (SELECT COUNT(*)::text FROM kb_memory_entries WHERE knowledge_space = $1 AND repo_id = $2 AND branch = $3 AND build_version = $4) AS memory_entries`,
    [input.knowledgeSpace, input.repoId, input.branch, input.buildVersion]
  );

  const scalar = scalarCounts.rows[0];
  counts.openapi_operations = Number(scalar?.openapi_operations ?? "0");
  counts.code_symbols = Number(scalar?.code_symbols ?? "0");
  counts.config_surfaces = Number(scalar?.config_surfaces ?? "0");
  counts.schema_objects = Number(scalar?.schema_objects ?? "0");
  counts.test_behaviors = Number(scalar?.test_behaviors ?? "0");
  counts.citation_units = Number(scalar?.citation_units ?? "0");
  counts.chunks = Number(scalar?.chunks ?? "0");
  counts.memory_entries = Number(scalar?.memory_entries ?? "0");

  const embeddingCounts = await pool.query<{
    chunk_total: string;
    chunk_ready: string;
    citation_total: string;
    citation_ready: string;
  }>(
    `SELECT
       (SELECT COUNT(*)::text FROM kb_chunks WHERE knowledge_space = $1 AND repo_id = $2 AND branch = $3 AND build_version = $4) AS chunk_total,
       (SELECT COUNT(*)::text FROM kb_chunks WHERE knowledge_space = $1 AND repo_id = $2 AND branch = $3 AND build_version = $4 AND embedding IS NOT NULL) AS chunk_ready,
       (SELECT COUNT(*)::text
          FROM kb_citation_units
         WHERE knowledge_space = $1
           AND repo_id = $2
           AND branch = $3
           AND build_version = $4
           AND COALESCE(metadata_json->>'embeddingTarget', 'disabled') = 'selected') AS citation_total,
       (SELECT COUNT(*)::text
          FROM kb_citation_units
         WHERE knowledge_space = $1
           AND repo_id = $2
           AND branch = $3
           AND build_version = $4
           AND COALESCE(metadata_json->>'embeddingTarget', 'disabled') = 'selected'
           AND embedding IS NOT NULL) AS citation_ready`,
    [input.knowledgeSpace, input.repoId, input.branch, input.buildVersion]
  );
  const embeddings = embeddingCounts.rows[0];
  const chunkTotal = Number(embeddings?.chunk_total ?? "0");
  const chunkReady = Number(embeddings?.chunk_ready ?? "0");
  const citationTotal = Number(embeddings?.citation_total ?? "0");
  const citationReady = Number(embeddings?.citation_ready ?? "0");

  return {
    artifactCountsByFamily: counts,
    parserDegradation: {
      totalDocuments: docRows.rows.reduce((sum, row) => sum + Number(row.total), 0),
      degradedDocuments,
      degradedFamilies
    },
    embeddingSummary: {
      chunkEmbeddings: {
        total: chunkTotal,
        ready: chunkReady,
        missing: Math.max(0, chunkTotal - chunkReady)
      },
      citationEmbeddings: {
        total: citationTotal,
        ready: citationReady,
        missing: Math.max(0, citationTotal - citationReady)
      }
    }
  };
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
  knowledgeSpace?: KbKnowledgeSpace;
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
  const knowledgeSpace = normalizeKnowledgeSpace(input.knowledgeSpace);
  const docKey = `${knowledgeSpace}:${input.repoId}:${input.path}:${buildVersion}`;
  const result = await pool.query<KbDocument>(
    `INSERT INTO kb_documents (
      id, repo_id, knowledge_space, doc_key, branch, path, title, source_url, repo_source_url, public_source_url,
      commit_sha, content_hash, content, metadata_json, build_version, is_active
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb,$15,true)
    ON CONFLICT (knowledge_space, repo_id, branch, path, build_version)
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
      knowledgeSpace,
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

export async function deactivateDocumentsMissingFromSnapshot(
  repoId: string,
  branch: string,
  knowledgeSpace: KbKnowledgeSpace,
  activePaths: string[]
): Promise<number> {
  const result = await pool.query<{ count: string }>(
    `UPDATE kb_documents
     SET is_active = false, updated_at = NOW()
     WHERE repo_id = $1
       AND branch = $2
       AND knowledge_space = $3
       AND is_active = true
       AND NOT (path = ANY($4::text[]))
     RETURNING 1`,
    [repoId, branch, knowledgeSpace, activePaths.length ? activePaths : ["__none__"]]
  );
  return result.rowCount ?? 0;
}

export async function deactivateDocumentByPath(
  repoId: string,
  branch: string,
  knowledgeSpace: KbKnowledgeSpace,
  path: string
): Promise<void> {
  await pool.query(
    `UPDATE kb_documents
     SET is_active = false, updated_at = NOW()
     WHERE repo_id = $1 AND branch = $2 AND knowledge_space = $3 AND path = $4`,
    [repoId, branch, knowledgeSpace, path]
  );

  await pool.query(
    `UPDATE kb_chunks
     SET is_active = false, updated_at = NOW()
     WHERE repo_id = $1 AND branch = $2 AND knowledge_space = $3 AND path = $4`,
    [repoId, branch, knowledgeSpace, path]
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
  knowledgeSpace?: KbKnowledgeSpace;
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
  const knowledgeSpace = normalizeKnowledgeSpace(input.knowledgeSpace);
  await pool.query(
    `INSERT INTO kb_chunks (
      id, doc_id, repo_id, knowledge_space, branch, path, build_version, commit_sha, heading_path, ordinal,
      content, content_hash, token_count, metadata_json,
      embedding, embedding_model, embedding_version,
      lexical_content, search_vector, confidence_hint, is_active
    ) VALUES (
      $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,
      $11,$12,$13,$14::jsonb,
      $15::vector,$16,$17,
      $11,to_tsvector('english', $11),0.0,true
    )
    ON CONFLICT (id)
    DO UPDATE SET
      doc_id = EXCLUDED.doc_id,
      repo_id = EXCLUDED.repo_id,
      knowledge_space = EXCLUDED.knowledge_space,
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
      knowledgeSpace,
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

export async function deleteKnowledgeArtifactsForDocument(input: {
  sourceDocId: string;
  knowledgeSpace: KbKnowledgeSpace;
  buildVersion: string;
}): Promise<void> {
  await pool.query(
    `DELETE FROM kb_memory_citations mc
     USING kb_citation_units cu
     WHERE cu.id = mc.citation_id
       AND cu.source_doc_id = $1
       AND cu.knowledge_space = $2
       AND cu.build_version = $3`,
    [input.sourceDocId, input.knowledgeSpace, input.buildVersion]
  );
  await pool.query(
    `DELETE FROM kb_citation_units
     WHERE source_doc_id = $1
       AND knowledge_space = $2
       AND build_version = $3`,
    [input.sourceDocId, input.knowledgeSpace, input.buildVersion]
  );
  await pool.query(
    `DELETE FROM kb_openapi_operations
     WHERE source_doc_id = $1
       AND knowledge_space = $2
       AND build_version = $3`,
    [input.sourceDocId, input.knowledgeSpace, input.buildVersion]
  );
  await pool.query(
    `DELETE FROM kb_code_symbols
     WHERE source_doc_id = $1
       AND knowledge_space = $2
       AND build_version = $3`,
    [input.sourceDocId, input.knowledgeSpace, input.buildVersion]
  );
  await pool.query(
    `DELETE FROM kb_config_surfaces
     WHERE source_doc_id = $1
       AND knowledge_space = $2
       AND build_version = $3`,
    [input.sourceDocId, input.knowledgeSpace, input.buildVersion]
  );
  await pool.query(
    `DELETE FROM kb_schema_objects
     WHERE source_doc_id = $1
       AND knowledge_space = $2
       AND build_version = $3`,
    [input.sourceDocId, input.knowledgeSpace, input.buildVersion]
  );
  await pool.query(
    `DELETE FROM kb_test_behaviors
     WHERE source_doc_id = $1
       AND knowledge_space = $2
       AND build_version = $3`,
    [input.sourceDocId, input.knowledgeSpace, input.buildVersion]
  );
}

export async function upsertOpenApiOperation(input: {
  id: string;
  knowledgeSpace: KbKnowledgeSpace;
  repoId: string;
  branch: string;
  buildVersion: string;
  sourceDocId: string;
  path: string;
  method: string;
  routePath: string;
  operationId: string | null;
  summary: string | null;
  description: string | null;
  requestSchema: Record<string, unknown>;
  responseSchema: Record<string, unknown>;
  authScopes: string[];
  tags: string[];
  errorShapes: Record<string, unknown>;
  sourceLocation: Record<string, unknown>;
  metadata: Record<string, unknown>;
}): Promise<KbOpenApiOperation> {
  const result = await pool.query<KbOpenApiOperation>(
    `INSERT INTO kb_openapi_operations (
      id, knowledge_space, repo_id, branch, build_version, source_doc_id, path, method, route_path,
      operation_id, summary, description, request_schema_json, response_schema_json, auth_scopes,
      tags, error_shapes_json, source_location_json, metadata_json
    ) VALUES (
      $1,$2,$3,$4,$5,$6,$7,$8,$9,
      $10,$11,$12,$13::jsonb,$14::jsonb,$15::text[],
      $16::text[],$17::jsonb,$18::jsonb,$19::jsonb
    )
    ON CONFLICT (id)
    DO UPDATE SET
      knowledge_space = EXCLUDED.knowledge_space,
      repo_id = EXCLUDED.repo_id,
      branch = EXCLUDED.branch,
      build_version = EXCLUDED.build_version,
      source_doc_id = EXCLUDED.source_doc_id,
      path = EXCLUDED.path,
      method = EXCLUDED.method,
      route_path = EXCLUDED.route_path,
      operation_id = EXCLUDED.operation_id,
      summary = EXCLUDED.summary,
      description = EXCLUDED.description,
      request_schema_json = EXCLUDED.request_schema_json,
      response_schema_json = EXCLUDED.response_schema_json,
      auth_scopes = EXCLUDED.auth_scopes,
      tags = EXCLUDED.tags,
      error_shapes_json = EXCLUDED.error_shapes_json,
      source_location_json = EXCLUDED.source_location_json,
      metadata_json = EXCLUDED.metadata_json,
      updated_at = NOW()
    RETURNING *`,
    [
      input.id,
      input.knowledgeSpace,
      input.repoId,
      input.branch,
      input.buildVersion,
      input.sourceDocId,
      input.path,
      input.method,
      input.routePath,
      input.operationId,
      input.summary,
      input.description,
      toJson(input.requestSchema),
      toJson(input.responseSchema),
      input.authScopes,
      input.tags,
      toJson(input.errorShapes),
      toJson(input.sourceLocation),
      toJson(input.metadata)
    ]
  );
  return result.rows[0];
}

export async function upsertCodeSymbol(input: {
  id: string;
  knowledgeSpace: KbKnowledgeSpace;
  repoId: string;
  branch: string;
  buildVersion: string;
  sourceDocId: string;
  path: string;
  language: string;
  symbolKind: string;
  symbolName: string;
  qualifiedName: string;
  parentSymbol: string | null;
  startLine: number;
  endLine: number;
  signatureText: string;
  docComment: string | null;
  bodySummary: string | null;
  dependencyRefs: Record<string, unknown>;
  metadata: Record<string, unknown>;
}): Promise<KbCodeSymbol> {
  const result = await pool.query<KbCodeSymbol>(
    `INSERT INTO kb_code_symbols (
      id, knowledge_space, repo_id, branch, build_version, source_doc_id, path, language,
      symbol_kind, symbol_name, qualified_name, parent_symbol, start_line, end_line,
      signature_text, doc_comment, body_summary, dependency_refs_json, metadata_json
    ) VALUES (
      $1,$2,$3,$4,$5,$6,$7,$8,
      $9,$10,$11,$12,$13,$14,
      $15,$16,$17,$18::jsonb,$19::jsonb
    )
    ON CONFLICT (id)
    DO UPDATE SET
      knowledge_space = EXCLUDED.knowledge_space,
      repo_id = EXCLUDED.repo_id,
      branch = EXCLUDED.branch,
      build_version = EXCLUDED.build_version,
      source_doc_id = EXCLUDED.source_doc_id,
      path = EXCLUDED.path,
      language = EXCLUDED.language,
      symbol_kind = EXCLUDED.symbol_kind,
      symbol_name = EXCLUDED.symbol_name,
      qualified_name = EXCLUDED.qualified_name,
      parent_symbol = EXCLUDED.parent_symbol,
      start_line = EXCLUDED.start_line,
      end_line = EXCLUDED.end_line,
      signature_text = EXCLUDED.signature_text,
      doc_comment = EXCLUDED.doc_comment,
      body_summary = EXCLUDED.body_summary,
      dependency_refs_json = EXCLUDED.dependency_refs_json,
      metadata_json = EXCLUDED.metadata_json,
      updated_at = NOW()
    RETURNING *`,
    [
      input.id,
      input.knowledgeSpace,
      input.repoId,
      input.branch,
      input.buildVersion,
      input.sourceDocId,
      input.path,
      input.language,
      input.symbolKind,
      input.symbolName,
      input.qualifiedName,
      input.parentSymbol,
      input.startLine,
      input.endLine,
      input.signatureText,
      input.docComment,
      input.bodySummary,
      toJson(input.dependencyRefs),
      toJson(input.metadata)
    ]
  );
  return result.rows[0];
}

export async function upsertConfigSurface(input: {
  id: string;
  knowledgeSpace: KbKnowledgeSpace;
  repoId: string;
  branch: string;
  buildVersion: string;
  sourceDocId: string;
  path: string;
  configKind: string;
  configKey: string;
  normalizedKey: string;
  defaultValue: string | null;
  description: string | null;
  requiredFor: Record<string, unknown>;
  relatedComponents: Record<string, unknown>;
  sourceLocation: Record<string, unknown>;
  metadata: Record<string, unknown>;
}): Promise<KbConfigSurface> {
  const result = await pool.query<KbConfigSurface>(
    `INSERT INTO kb_config_surfaces (
      id, knowledge_space, repo_id, branch, build_version, source_doc_id, path, config_kind,
      config_key, normalized_key, default_value, description, required_for_json,
      related_components_json, source_location_json, metadata_json
    ) VALUES (
      $1,$2,$3,$4,$5,$6,$7,$8,
      $9,$10,$11,$12,$13::jsonb,
      $14::jsonb,$15::jsonb,$16::jsonb
    )
    ON CONFLICT (id)
    DO UPDATE SET
      knowledge_space = EXCLUDED.knowledge_space,
      repo_id = EXCLUDED.repo_id,
      branch = EXCLUDED.branch,
      build_version = EXCLUDED.build_version,
      source_doc_id = EXCLUDED.source_doc_id,
      path = EXCLUDED.path,
      config_kind = EXCLUDED.config_kind,
      config_key = EXCLUDED.config_key,
      normalized_key = EXCLUDED.normalized_key,
      default_value = EXCLUDED.default_value,
      description = EXCLUDED.description,
      required_for_json = EXCLUDED.required_for_json,
      related_components_json = EXCLUDED.related_components_json,
      source_location_json = EXCLUDED.source_location_json,
      metadata_json = EXCLUDED.metadata_json,
      updated_at = NOW()
    RETURNING *`,
    [
      input.id,
      input.knowledgeSpace,
      input.repoId,
      input.branch,
      input.buildVersion,
      input.sourceDocId,
      input.path,
      input.configKind,
      input.configKey,
      input.normalizedKey,
      input.defaultValue,
      input.description,
      toJson(input.requiredFor),
      toJson(input.relatedComponents),
      toJson(input.sourceLocation),
      toJson(input.metadata)
    ]
  );
  return result.rows[0];
}

export async function upsertSchemaObject(input: {
  id: string;
  knowledgeSpace: KbKnowledgeSpace;
  repoId: string;
  branch: string;
  buildVersion: string;
  sourceDocId: string;
  path: string;
  objectKind: string;
  schemaName: string | null;
  objectName: string;
  normalizedName: string;
  definitionSummary: string;
  relatedTables: Record<string, unknown>;
  sourceLocation: Record<string, unknown>;
  metadata: Record<string, unknown>;
}): Promise<KbSchemaObject> {
  const result = await pool.query<KbSchemaObject>(
    `INSERT INTO kb_schema_objects (
      id, knowledge_space, repo_id, branch, build_version, source_doc_id, path, object_kind,
      schema_name, object_name, normalized_name, definition_summary, related_tables_json,
      source_location_json, metadata_json
    ) VALUES (
      $1,$2,$3,$4,$5,$6,$7,$8,
      $9,$10,$11,$12,$13::jsonb,
      $14::jsonb,$15::jsonb
    )
    ON CONFLICT (id)
    DO UPDATE SET
      knowledge_space = EXCLUDED.knowledge_space,
      repo_id = EXCLUDED.repo_id,
      branch = EXCLUDED.branch,
      build_version = EXCLUDED.build_version,
      source_doc_id = EXCLUDED.source_doc_id,
      path = EXCLUDED.path,
      object_kind = EXCLUDED.object_kind,
      schema_name = EXCLUDED.schema_name,
      object_name = EXCLUDED.object_name,
      normalized_name = EXCLUDED.normalized_name,
      definition_summary = EXCLUDED.definition_summary,
      related_tables_json = EXCLUDED.related_tables_json,
      source_location_json = EXCLUDED.source_location_json,
      metadata_json = EXCLUDED.metadata_json,
      updated_at = NOW()
    RETURNING *`,
    [
      input.id,
      input.knowledgeSpace,
      input.repoId,
      input.branch,
      input.buildVersion,
      input.sourceDocId,
      input.path,
      input.objectKind,
      input.schemaName,
      input.objectName,
      input.normalizedName,
      input.definitionSummary,
      toJson(input.relatedTables),
      toJson(input.sourceLocation),
      toJson(input.metadata)
    ]
  );
  return result.rows[0];
}

export async function upsertTestBehavior(input: {
  id: string;
  knowledgeSpace: KbKnowledgeSpace;
  repoId: string;
  branch: string;
  buildVersion: string;
  sourceDocId: string;
  path: string;
  behaviorKey: string;
  title: string;
  summary: string;
  assertions: Record<string, unknown>;
  signals: Record<string, unknown>;
  sourceLocation: Record<string, unknown>;
  metadata: Record<string, unknown>;
}): Promise<KbTestBehavior> {
  const result = await pool.query<KbTestBehavior>(
    `INSERT INTO kb_test_behaviors (
      id, knowledge_space, repo_id, branch, build_version, source_doc_id, path, behavior_key,
      title, summary, assertions_json, signals_json, source_location_json, metadata_json
    ) VALUES (
      $1,$2,$3,$4,$5,$6,$7,$8,
      $9,$10,$11::jsonb,$12::jsonb,$13::jsonb,$14::jsonb
    )
    ON CONFLICT (id)
    DO UPDATE SET
      knowledge_space = EXCLUDED.knowledge_space,
      repo_id = EXCLUDED.repo_id,
      branch = EXCLUDED.branch,
      build_version = EXCLUDED.build_version,
      source_doc_id = EXCLUDED.source_doc_id,
      path = EXCLUDED.path,
      behavior_key = EXCLUDED.behavior_key,
      title = EXCLUDED.title,
      summary = EXCLUDED.summary,
      assertions_json = EXCLUDED.assertions_json,
      signals_json = EXCLUDED.signals_json,
      source_location_json = EXCLUDED.source_location_json,
      metadata_json = EXCLUDED.metadata_json,
      updated_at = NOW()
    RETURNING *`,
    [
      input.id,
      input.knowledgeSpace,
      input.repoId,
      input.branch,
      input.buildVersion,
      input.sourceDocId,
      input.path,
      input.behaviorKey,
      input.title,
      input.summary,
      toJson(input.assertions),
      toJson(input.signals),
      toJson(input.sourceLocation),
      toJson(input.metadata)
    ]
  );
  return result.rows[0];
}

export async function upsertCitationUnit(input: {
  id: string;
  knowledgeSpace: KbKnowledgeSpace;
  repoId: string;
  branch: string;
  buildVersion: string;
  sourceDocId: string;
  citationFamily: string;
  sourceFamily: string;
  sourceArtifactType: string;
  sourceArtifactId: string | null;
  citationKey: string;
  path: string;
  title: string;
  headingPath: string | null;
  snippetText: string;
  sourceLocation: Record<string, unknown>;
  authority: Record<string, unknown>;
  metadata: Record<string, unknown>;
  embedding: string | null;
  embeddingModel: string | null;
  embeddingVersion: string | null;
}): Promise<KbCitationUnit> {
  const result = await pool.query<KbCitationUnit>(
    `INSERT INTO kb_citation_units (
      id, knowledge_space, repo_id, branch, build_version, source_doc_id, citation_family, source_family,
      source_artifact_type, source_artifact_id, citation_key, path, title, heading_path, snippet_text,
      source_location_json, authority_json, metadata_json, embedding, embedding_model, embedding_version
    ) VALUES (
      $1,$2,$3,$4,$5,$6,$7,$8,
      $9,$10::uuid,$11,$12,$13,$14,$15,
      $16::jsonb,$17::jsonb,$18::jsonb,$19::vector,$20,$21
    )
    ON CONFLICT (id)
    DO UPDATE SET
      knowledge_space = EXCLUDED.knowledge_space,
      repo_id = EXCLUDED.repo_id,
      branch = EXCLUDED.branch,
      build_version = EXCLUDED.build_version,
      source_doc_id = EXCLUDED.source_doc_id,
      citation_family = EXCLUDED.citation_family,
      source_family = EXCLUDED.source_family,
      source_artifact_type = EXCLUDED.source_artifact_type,
      source_artifact_id = EXCLUDED.source_artifact_id,
      citation_key = EXCLUDED.citation_key,
      path = EXCLUDED.path,
      title = EXCLUDED.title,
      heading_path = EXCLUDED.heading_path,
      snippet_text = EXCLUDED.snippet_text,
      source_location_json = EXCLUDED.source_location_json,
      authority_json = EXCLUDED.authority_json,
      metadata_json = EXCLUDED.metadata_json,
      embedding = EXCLUDED.embedding,
      embedding_model = EXCLUDED.embedding_model,
      embedding_version = EXCLUDED.embedding_version,
      updated_at = NOW()
    RETURNING *`,
    [
      input.id,
      input.knowledgeSpace,
      input.repoId,
      input.branch,
      input.buildVersion,
      input.sourceDocId,
      input.citationFamily,
      input.sourceFamily,
      input.sourceArtifactType,
      input.sourceArtifactId,
      input.citationKey,
      input.path,
      input.title,
      input.headingPath,
      input.snippetText,
      toJson(input.sourceLocation),
      toJson(input.authority),
      toJson(input.metadata),
      input.embedding,
      input.embeddingModel,
      input.embeddingVersion
    ]
  );
  return result.rows[0];
}

function buildWhereClause(filters: { repoId?: string; branch?: string; knowledgeSpace: KbKnowledgeSpace }) {
  const parts: string[] = [];
  const values: unknown[] = [filters.knowledgeSpace];
  parts.push(`pub.knowledge_space = $1`);
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
  knowledgeSpace: KbKnowledgeSpace;
  repoId?: string;
  branch?: string;
  vectorLiteral: string;
  embeddingModel?: string;
  limit: number;
}): Promise<RetrievalHit[]> {
  const where = buildWhereClause({ repoId: input.repoId, branch: input.branch, knowledgeSpace: input.knowledgeSpace });
  const modelParam = input.embeddingModel ? where.values.length + 1 : null;
  const vectorParam = where.values.length + (input.embeddingModel ? 2 : 1);
  const limitParam = where.values.length + (input.embeddingModel ? 3 : 2);
  const embeddingModelFilter = modelParam ? `AND chunk.embedding_model = $${modelParam}` : "";
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
    build_version: string;
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
      chunk.build_version::text,
      doc.title,
      chunk.heading_path,
      LEFT(chunk.content, 2400) AS snippet,
      (1 - (chunk.embedding <=> $${vectorParam}::vector))::text AS vector_score,
     chunk.metadata_json AS chunk_metadata_json,
      doc.metadata_json AS doc_metadata_json
     FROM kb_chunks chunk
     INNER JOIN kb_documents doc ON doc.id = chunk.doc_id
     INNER JOIN kb_repo_registrations reg ON reg.id = chunk.repo_id
     INNER JOIN kb_publications pub
       ON pub.repo_id = chunk.repo_id
      AND pub.branch = chunk.branch
     WHERE ${where.clause || "TRUE"}
       AND chunk.knowledge_space = pub.knowledge_space
       AND doc.knowledge_space = pub.knowledge_space
       AND chunk.build_version = pub.published_build_version
       AND doc.build_version = pub.published_build_version
       AND chunk.embedding IS NOT NULL
       ${embeddingModelFilter}
     ORDER BY chunk.embedding <=> $${vectorParam}::vector
     LIMIT $${limitParam}`,
    [...where.values, ...(input.embeddingModel ? [input.embeddingModel] : []), input.vectorLiteral, input.limit]
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
    docMetadata: { build_version: row.build_version, ...(row.doc_metadata_json ?? {}) },
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
  knowledgeSpace: KbKnowledgeSpace;
  repoId?: string;
  branch?: string;
  query: string;
  limit: number;
}): Promise<RetrievalHit[]> {
  const hasCjk = /[\u3400-\u9FBF]/.test(input.query);
  const where = buildWhereClause({ repoId: input.repoId, branch: input.branch, knowledgeSpace: input.knowledgeSpace });
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
    build_version: string;
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
      chunk.build_version::text,
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
     INNER JOIN kb_publications pub
       ON pub.repo_id = chunk.repo_id
      AND pub.branch = chunk.branch
     WHERE ${where.clause || "TRUE"}
      AND chunk.knowledge_space = pub.knowledge_space
      AND doc.knowledge_space = pub.knowledge_space
      AND chunk.build_version = pub.published_build_version
      AND doc.build_version = pub.published_build_version
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
    docMetadata: { build_version: row.build_version, ...(row.doc_metadata_json ?? {}) },
    supportMetadata:
      ((row.chunk_metadata_json ?? {}) as Record<string, unknown>).supportEvidence as Record<string, unknown> | undefined ??
      ((row.doc_metadata_json ?? {}) as Record<string, unknown>).supportEvidence as Record<string, unknown> | undefined
  }));
}

export async function listCandidateDocumentsForFallback(input: {
  knowledgeSpace: KbKnowledgeSpace;
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
     INNER JOIN kb_publications pub
       ON pub.repo_id = doc.repo_id
      AND pub.branch = doc.branch
     WHERE ${conditions.length ? conditions.join(" AND ") : "TRUE"}
       AND pub.knowledge_space = $${limitParam + 1}
       AND doc.knowledge_space = pub.knowledge_space
       AND doc.build_version = pub.published_build_version
       AND (${tokenOr})
     ORDER BY (${tokenScore}) DESC, doc.updated_at DESC
     LIMIT $${limitParam}`,
    [...values, ...likeValues, input.limit, input.knowledgeSpace]
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

export async function searchStructuredArtifactCandidates(input: {
  knowledgeSpace: KbKnowledgeSpace;
  repoId?: string;
  branch?: string;
  query: string;
  likeTerms: string[];
  exactTerms?: string[];
  limit: number;
  exactOnly?: boolean;
}): Promise<
  Array<{
    artifact_id: string;
    artifact_family: string;
    build_version: string;
    title: string;
    path: string;
    heading_path: string | null;
    snippet: string;
    source_url: string;
    repo_source_url: string;
    commit_sha: string;
    repo: string;
    branch: string;
    product_area: string | null;
    deployment_model: string | null;
    doc_kind: string | null;
    object_type: string | null;
    support_metadata_json: Record<string, unknown> | null;
    score: number;
  }>
> {
  const likeTerms = [...new Set(input.likeTerms.filter(Boolean))];
  const exactTerms = [...new Set((input.exactTerms ?? []).filter(Boolean))];
  if (!likeTerms.length && !exactTerms.length) return [];

  const conditions: string[] = ["pub.knowledge_space = $1"];
  const values: unknown[] = [input.knowledgeSpace];
  if (input.repoId) {
    values.push(input.repoId);
    conditions.push(`doc.repo_id = $${values.length}`);
  }
  if (input.branch) {
    values.push(input.branch);
    conditions.push(`doc.branch = $${values.length}`);
  }

  const queryParam = values.push(input.query);
  const likeParam = values.push(likeTerms.map((item) => `%${item}%`));
  const exactParam = values.push(exactTerms);
  const limitParam = values.push(input.limit);
  const exactOnlyFilter = input.exactOnly ? " AND exact_score > 0 " : "";

  const result = await pool.query<{
    artifact_id: string;
    artifact_family: string;
    build_version: string;
    title: string;
    path: string;
    heading_path: string | null;
    snippet: string;
    source_url: string;
    repo_source_url: string;
    commit_sha: string;
    repo: string;
    branch: string;
    product_area: string | null;
    deployment_model: string | null;
    doc_kind: string | null;
    object_type: string | null;
    support_metadata_json: Record<string, unknown> | null;
    exact_score: string;
    fuzzy_score: string;
  }>(
    `WITH artifact_hits AS (
      SELECT
        op.id::text AS artifact_id,
        'api_operation'::text AS artifact_family,
        op.build_version,
        COALESCE(op.summary, op.operation_id, op.route_path) AS title,
        doc.path,
        NULL::text AS heading_path,
        LEFT(TRIM(CONCAT_WS(' ', op.method, op.route_path, op.operation_id, op.summary, op.description)), 1200) AS snippet,
        doc.source_url,
        doc.repo_source_url,
        doc.commit_sha,
        reg.repo_owner || '/' || reg.repo_name AS repo,
        doc.branch,
        'openapi'::text AS product_area,
        NULL::text AS deployment_model,
        'openapi/api'::text AS doc_kind,
        op.route_path AS object_type,
        (doc.metadata_json -> 'supportEvidence')::jsonb AS support_metadata_json,
        (
          CASE WHEN op.method = ANY($${exactParam}::text[]) THEN 0.9 ELSE 0 END +
          CASE WHEN op.route_path = ANY($${exactParam}::text[]) THEN 1 ELSE 0 END +
          CASE WHEN COALESCE(op.operation_id, '') = ANY($${exactParam}::text[]) THEN 0.95 ELSE 0 END +
          CASE WHEN op.route_path ILIKE ANY($${likeParam}::text[]) THEN 0.7 ELSE 0 END +
          CASE WHEN COALESCE(op.operation_id, '') ILIKE ANY($${likeParam}::text[]) THEN 0.55 ELSE 0 END
        )::text AS exact_score,
        GREATEST(
          similarity(TRIM(CONCAT_WS(' ', op.method, op.route_path, op.operation_id, op.summary, op.description)), $${queryParam}),
          CASE WHEN COALESCE(op.summary, '') ILIKE ANY($${likeParam}::text[]) THEN 0.45 ELSE 0 END
        )::text AS fuzzy_score
      FROM kb_openapi_operations op
      INNER JOIN kb_documents doc ON doc.id = op.source_doc_id
      INNER JOIN kb_repo_registrations reg ON reg.id = doc.repo_id
      INNER JOIN kb_publications pub ON pub.repo_id = doc.repo_id AND pub.branch = doc.branch
      WHERE ${conditions.join(" AND ")}
        AND op.knowledge_space = pub.knowledge_space
        AND doc.knowledge_space = pub.knowledge_space
        AND op.build_version = pub.published_build_version
        AND doc.build_version = pub.published_build_version
        AND (
          op.method = ANY($${exactParam}::text[])
          OR op.route_path = ANY($${exactParam}::text[])
          OR COALESCE(op.operation_id, '') = ANY($${exactParam}::text[])
          OR op.route_path ILIKE ANY($${likeParam}::text[])
          OR COALESCE(op.operation_id, '') ILIKE ANY($${likeParam}::text[])
          OR COALESCE(op.summary, '') ILIKE ANY($${likeParam}::text[])
          OR similarity(TRIM(CONCAT_WS(' ', op.method, op.route_path, op.operation_id, op.summary, op.description)), $${queryParam}) >= 0.14
        )
      UNION ALL
      SELECT
        cfg.id::text AS artifact_id,
        'config_surface'::text AS artifact_family,
        cfg.build_version,
        cfg.config_key AS title,
        doc.path,
        NULL::text AS heading_path,
        LEFT(TRIM(CONCAT_WS(' ', cfg.config_key, cfg.normalized_key, cfg.description, cfg.default_value)), 1200) AS snippet,
        doc.source_url,
        doc.repo_source_url,
        doc.commit_sha,
        reg.repo_owner || '/' || reg.repo_name AS repo,
        doc.branch,
        COALESCE((doc.metadata_json -> 'supportEvidence' ->> 'product_area'), 'deployment') AS product_area,
        (doc.metadata_json -> 'supportEvidence' ->> 'deployment_model') AS deployment_model,
        'deployment_runbook'::text AS doc_kind,
        cfg.normalized_key AS object_type,
        (doc.metadata_json -> 'supportEvidence')::jsonb AS support_metadata_json,
        (
          CASE WHEN cfg.normalized_key = ANY($${exactParam}::text[]) THEN 1 ELSE 0 END +
          CASE WHEN cfg.config_key = ANY($${exactParam}::text[]) THEN 0.95 ELSE 0 END +
          CASE WHEN cfg.normalized_key ILIKE ANY($${likeParam}::text[]) THEN 0.72 ELSE 0 END +
          CASE WHEN cfg.config_key ILIKE ANY($${likeParam}::text[]) THEN 0.6 ELSE 0 END
        )::text AS exact_score,
        GREATEST(
          similarity(TRIM(CONCAT_WS(' ', cfg.config_key, cfg.normalized_key, cfg.description, cfg.default_value)), $${queryParam}),
          CASE WHEN COALESCE(cfg.description, '') ILIKE ANY($${likeParam}::text[]) THEN 0.42 ELSE 0 END
        )::text AS fuzzy_score
      FROM kb_config_surfaces cfg
      INNER JOIN kb_documents doc ON doc.id = cfg.source_doc_id
      INNER JOIN kb_repo_registrations reg ON reg.id = doc.repo_id
      INNER JOIN kb_publications pub ON pub.repo_id = doc.repo_id AND pub.branch = doc.branch
      WHERE ${conditions.join(" AND ")}
        AND cfg.knowledge_space = pub.knowledge_space
        AND doc.knowledge_space = pub.knowledge_space
        AND cfg.build_version = pub.published_build_version
        AND doc.build_version = pub.published_build_version
        AND (
          cfg.normalized_key = ANY($${exactParam}::text[])
          OR cfg.config_key = ANY($${exactParam}::text[])
          OR cfg.normalized_key ILIKE ANY($${likeParam}::text[])
          OR cfg.config_key ILIKE ANY($${likeParam}::text[])
          OR COALESCE(cfg.description, '') ILIKE ANY($${likeParam}::text[])
          OR similarity(TRIM(CONCAT_WS(' ', cfg.config_key, cfg.normalized_key, cfg.description, cfg.default_value)), $${queryParam}) >= 0.14
        )
      UNION ALL
      SELECT
        sym.id::text AS artifact_id,
        'code_symbol'::text AS artifact_family,
        sym.build_version,
        COALESCE(sym.qualified_name, sym.symbol_name) AS title,
        doc.path,
        CONCAT('L', sym.start_line, '-L', sym.end_line) AS heading_path,
        LEFT(TRIM(CONCAT_WS(' ', sym.symbol_name, sym.qualified_name, sym.signature_text, sym.body_summary, sym.doc_comment)), 1200) AS snippet,
        doc.source_url,
        doc.repo_source_url,
        doc.commit_sha,
        reg.repo_owner || '/' || reg.repo_name AS repo,
        doc.branch,
        COALESCE((doc.metadata_json -> 'supportEvidence' ->> 'product_area'), 'general') AS product_area,
        (doc.metadata_json -> 'supportEvidence' ->> 'deployment_model') AS deployment_model,
        COALESCE((doc.metadata_json -> 'supportEvidence' ->> 'doc_kind'), 'troubleshooting') AS doc_kind,
        sym.symbol_name AS object_type,
        (doc.metadata_json -> 'supportEvidence')::jsonb AS support_metadata_json,
        (
          CASE WHEN sym.symbol_name = ANY($${exactParam}::text[]) THEN 1 ELSE 0 END +
          CASE WHEN sym.qualified_name = ANY($${exactParam}::text[]) THEN 0.95 ELSE 0 END +
          CASE WHEN sym.symbol_name ILIKE ANY($${likeParam}::text[]) THEN 0.7 ELSE 0 END +
          CASE WHEN sym.qualified_name ILIKE ANY($${likeParam}::text[]) THEN 0.64 ELSE 0 END
        )::text AS exact_score,
        GREATEST(
          similarity(TRIM(CONCAT_WS(' ', sym.symbol_name, sym.qualified_name, sym.signature_text, sym.body_summary, sym.doc_comment)), $${queryParam}),
          CASE WHEN COALESCE(sym.body_summary, '') ILIKE ANY($${likeParam}::text[]) THEN 0.36 ELSE 0 END
        )::text AS fuzzy_score
      FROM kb_code_symbols sym
      INNER JOIN kb_documents doc ON doc.id = sym.source_doc_id
      INNER JOIN kb_repo_registrations reg ON reg.id = doc.repo_id
      INNER JOIN kb_publications pub ON pub.repo_id = doc.repo_id AND pub.branch = doc.branch
      WHERE ${conditions.join(" AND ")}
        AND sym.knowledge_space = pub.knowledge_space
        AND doc.knowledge_space = pub.knowledge_space
        AND sym.build_version = pub.published_build_version
        AND doc.build_version = pub.published_build_version
        AND (
          sym.symbol_name = ANY($${exactParam}::text[])
          OR sym.qualified_name = ANY($${exactParam}::text[])
          OR sym.symbol_name ILIKE ANY($${likeParam}::text[])
          OR sym.qualified_name ILIKE ANY($${likeParam}::text[])
          OR similarity(TRIM(CONCAT_WS(' ', sym.symbol_name, sym.qualified_name, sym.signature_text, sym.body_summary, sym.doc_comment)), $${queryParam}) >= 0.14
        )
      UNION ALL
      SELECT
        sch.id::text AS artifact_id,
        'schema_object'::text AS artifact_family,
        sch.build_version,
        sch.object_name AS title,
        doc.path,
        NULL::text AS heading_path,
        LEFT(TRIM(CONCAT_WS(' ', sch.object_name, sch.normalized_name, sch.definition_summary)), 1200) AS snippet,
        doc.source_url,
        doc.repo_source_url,
        doc.commit_sha,
        reg.repo_owner || '/' || reg.repo_name AS repo,
        doc.branch,
        COALESCE((doc.metadata_json -> 'supportEvidence' ->> 'product_area'), 'general') AS product_area,
        (doc.metadata_json -> 'supportEvidence' ->> 'deployment_model') AS deployment_model,
        COALESCE((doc.metadata_json -> 'supportEvidence' ->> 'doc_kind'), 'troubleshooting') AS doc_kind,
        sch.normalized_name AS object_type,
        (doc.metadata_json -> 'supportEvidence')::jsonb AS support_metadata_json,
        (
          CASE WHEN sch.normalized_name = ANY($${exactParam}::text[]) THEN 1 ELSE 0 END +
          CASE WHEN sch.object_name = ANY($${exactParam}::text[]) THEN 0.95 ELSE 0 END +
          CASE WHEN sch.normalized_name ILIKE ANY($${likeParam}::text[]) THEN 0.72 ELSE 0 END +
          CASE WHEN sch.object_name ILIKE ANY($${likeParam}::text[]) THEN 0.6 ELSE 0 END
        )::text AS exact_score,
        GREATEST(
          similarity(TRIM(CONCAT_WS(' ', sch.object_name, sch.normalized_name, sch.definition_summary)), $${queryParam}),
          CASE WHEN sch.definition_summary ILIKE ANY($${likeParam}::text[]) THEN 0.42 ELSE 0 END
        )::text AS fuzzy_score
      FROM kb_schema_objects sch
      INNER JOIN kb_documents doc ON doc.id = sch.source_doc_id
      INNER JOIN kb_repo_registrations reg ON reg.id = doc.repo_id
      INNER JOIN kb_publications pub ON pub.repo_id = doc.repo_id AND pub.branch = doc.branch
      WHERE ${conditions.join(" AND ")}
        AND sch.knowledge_space = pub.knowledge_space
        AND doc.knowledge_space = pub.knowledge_space
        AND sch.build_version = pub.published_build_version
        AND doc.build_version = pub.published_build_version
        AND (
          sch.normalized_name = ANY($${exactParam}::text[])
          OR sch.object_name = ANY($${exactParam}::text[])
          OR sch.normalized_name ILIKE ANY($${likeParam}::text[])
          OR sch.object_name ILIKE ANY($${likeParam}::text[])
          OR sch.definition_summary ILIKE ANY($${likeParam}::text[])
          OR similarity(TRIM(CONCAT_WS(' ', sch.object_name, sch.normalized_name, sch.definition_summary)), $${queryParam}) >= 0.14
        )
      UNION ALL
      SELECT
        beh.id::text AS artifact_id,
        'test_behavior'::text AS artifact_family,
        beh.build_version,
        beh.title,
        doc.path,
        NULL::text AS heading_path,
        LEFT(TRIM(CONCAT_WS(' ', beh.behavior_key, beh.title, beh.summary)), 1200) AS snippet,
        doc.source_url,
        doc.repo_source_url,
        doc.commit_sha,
        reg.repo_owner || '/' || reg.repo_name AS repo,
        doc.branch,
        COALESCE((doc.metadata_json -> 'supportEvidence' ->> 'product_area'), 'general') AS product_area,
        (doc.metadata_json -> 'supportEvidence' ->> 'deployment_model') AS deployment_model,
        COALESCE((doc.metadata_json -> 'supportEvidence' ->> 'doc_kind'), 'troubleshooting') AS doc_kind,
        beh.behavior_key AS object_type,
        (doc.metadata_json -> 'supportEvidence')::jsonb AS support_metadata_json,
        (
          CASE WHEN beh.behavior_key = ANY($${exactParam}::text[]) THEN 1 ELSE 0 END +
          CASE WHEN beh.title = ANY($${exactParam}::text[]) THEN 0.9 ELSE 0 END +
          CASE WHEN beh.behavior_key ILIKE ANY($${likeParam}::text[]) THEN 0.68 ELSE 0 END +
          CASE WHEN beh.title ILIKE ANY($${likeParam}::text[]) THEN 0.58 ELSE 0 END
        )::text AS exact_score,
        GREATEST(
          similarity(TRIM(CONCAT_WS(' ', beh.behavior_key, beh.title, beh.summary)), $${queryParam}),
          CASE WHEN beh.summary ILIKE ANY($${likeParam}::text[]) THEN 0.42 ELSE 0 END
        )::text AS fuzzy_score
      FROM kb_test_behaviors beh
      INNER JOIN kb_documents doc ON doc.id = beh.source_doc_id
      INNER JOIN kb_repo_registrations reg ON reg.id = doc.repo_id
      INNER JOIN kb_publications pub ON pub.repo_id = doc.repo_id AND pub.branch = doc.branch
      WHERE ${conditions.join(" AND ")}
        AND beh.knowledge_space = pub.knowledge_space
        AND doc.knowledge_space = pub.knowledge_space
        AND beh.build_version = pub.published_build_version
        AND doc.build_version = pub.published_build_version
        AND (
          beh.behavior_key = ANY($${exactParam}::text[])
          OR beh.title = ANY($${exactParam}::text[])
          OR beh.behavior_key ILIKE ANY($${likeParam}::text[])
          OR beh.title ILIKE ANY($${likeParam}::text[])
          OR beh.summary ILIKE ANY($${likeParam}::text[])
          OR similarity(TRIM(CONCAT_WS(' ', beh.behavior_key, beh.title, beh.summary)), $${queryParam}) >= 0.14
        )
    )
    SELECT *
    FROM artifact_hits
    WHERE (exact_score::numeric > 0 OR fuzzy_score::numeric > 0)${exactOnlyFilter}
    ORDER BY (exact_score::numeric * 0.72 + fuzzy_score::numeric * 0.28) DESC, title ASC
    LIMIT $${limitParam}`,
    values
  );

  return result.rows.map((row) => ({
    ...row,
    score: Number(row.exact_score) * 0.72 + Number(row.fuzzy_score) * 0.28
  }));
}

export async function resolveArtifactCitations(input: {
  knowledgeSpace: KbKnowledgeSpace;
  artifactIds: string[];
  limitPerArtifact: number;
}): Promise<
  Array<{
    artifact_id: string;
    citation_id: string;
    document_id: string;
    repo_id: string;
    repo: string;
    branch: string;
    path: string;
    source_url: string;
    repo_source_url: string;
    commit_sha: string;
    title: string;
    heading_path: string | null;
    snippet: string;
    build_version: string;
    knowledge_space: KbKnowledgeSpace;
    citation_family: string;
    source_family: string;
    citation_metadata_json: Record<string, unknown> | null;
    doc_metadata_json: Record<string, unknown> | null;
  }>
> {
  const artifactIds = [...new Set(input.artifactIds.filter(Boolean))];
  if (!artifactIds.length) return [];
  const result = await pool.query<{
    artifact_id: string;
    citation_id: string;
    document_id: string;
    repo_id: string;
    repo: string;
    branch: string;
    path: string;
    source_url: string;
    repo_source_url: string;
    commit_sha: string;
    title: string;
    heading_path: string | null;
    snippet: string;
    build_version: string;
    knowledge_space: KbKnowledgeSpace;
    citation_family: string;
    source_family: string;
    citation_metadata_json: Record<string, unknown> | null;
    doc_metadata_json: Record<string, unknown> | null;
    rn: string;
  }>(
    `WITH ranked AS (
      SELECT
        cu.source_artifact_id::text AS artifact_id,
        cu.id::text AS citation_id,
        COALESCE(cu.source_artifact_id::text, cu.id::text) AS document_id,
        doc.repo_id,
        reg.repo_owner || '/' || reg.repo_name AS repo,
        doc.branch,
        cu.path,
        doc.source_url,
        doc.repo_source_url,
        doc.commit_sha,
        cu.title,
        cu.heading_path,
        cu.snippet_text AS snippet,
        cu.build_version,
        cu.knowledge_space,
        cu.citation_family,
        cu.source_family,
        cu.metadata_json AS citation_metadata_json,
        doc.metadata_json AS doc_metadata_json,
        ROW_NUMBER() OVER (PARTITION BY cu.source_artifact_id ORDER BY cu.updated_at DESC) AS rn
      FROM kb_citation_units cu
      INNER JOIN kb_documents doc ON doc.id = cu.source_doc_id
      INNER JOIN kb_repo_registrations reg ON reg.id = doc.repo_id
      INNER JOIN kb_publications pub ON pub.repo_id = doc.repo_id AND pub.branch = doc.branch
      WHERE cu.source_artifact_id::text = ANY($1::text[])
        AND pub.knowledge_space = $2
        AND cu.knowledge_space = pub.knowledge_space
        AND doc.knowledge_space = pub.knowledge_space
        AND cu.build_version = pub.published_build_version
        AND doc.build_version = pub.published_build_version
    )
    SELECT * FROM ranked WHERE rn <= $3`,
    [artifactIds, input.knowledgeSpace, input.limitPerArtifact]
  );

  return result.rows;
}

export async function getDocumentByPath(
  repoId: string,
  branch: string,
  path: string,
  knowledgeSpace: KbKnowledgeSpace
): Promise<KbDocument | null> {
  const result = await pool.query<KbDocument>(
    `SELECT doc.*
     FROM kb_documents doc
     INNER JOIN kb_publications pub
       ON pub.repo_id = doc.repo_id
      AND pub.branch = doc.branch
     WHERE doc.repo_id = $1
       AND doc.branch = $2
       AND doc.path = $3
       AND pub.knowledge_space = $4
       AND doc.knowledge_space = pub.knowledge_space
       AND doc.build_version = pub.published_build_version
     ORDER BY doc.updated_at DESC
     LIMIT 1`,
    [repoId, branch, path, knowledgeSpace]
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
    shardKey: KbFullSyncShardKey | null;
    sourceFamily?: KbSyncManifestItem["source_family"];
    contentChecksum?: string | null;
    sourceAcquisitionMode?: KbSyncManifestItem["source_acquisition_mode"];
    blobSha: string;
    sizeBytes: number;
    needsRebuild: boolean;
    reuseReason?: string | null;
    skipReason?: string | null;
    buildStatus?: KbManifestBuildStatus;
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
      const totalDocs = input.manifestItems.filter((item) => item.shardKey === shardKey && item.buildStatus !== "skipped").length;
      const shardResult = await client.query<KbSyncRunShard>(
        `INSERT INTO kb_sync_run_shards (
          id, run_id, repo_id, branch, shard_key, prefix, total_docs, status
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,'queued')
        RETURNING *`,
        [uuidv4(), run.id, input.repoId, input.branch, shardKey, shardPrefixes[shardKey], totalDocs]
      );
      shards.push(shardResult.rows[0]);
    }

    for (const manifestBatch of chunkFullSyncManifestItems(input.manifestItems)) {
      const values: unknown[] = [];
      const valuePlaceholders = manifestBatch.map((item, batchIndex) => {
        const offset = batchIndex * 16;
        values.push(
          uuidv4(),
          run.id,
          input.repoId,
          input.branch,
          input.targetHead,
          item.path,
          item.shardKey,
          item.sourceFamily ?? null,
          item.contentChecksum ?? null,
          item.sourceAcquisitionMode ?? "remote",
          item.blobSha,
          item.sizeBytes,
          item.needsRebuild,
          item.reuseReason ?? null,
          item.skipReason ?? null,
          item.buildStatus ?? "pending"
        );

        return `($${offset + 1},$${offset + 2},$${offset + 3},$${offset + 4},$${offset + 5},$${offset + 6},$${offset + 7},$${offset + 8},$${offset + 9},$${offset + 10},$${offset + 11},$${offset + 12},$${offset + 13},$${offset + 14},$${offset + 15},$${offset + 16})`;
      });

      await client.query(
        `INSERT INTO kb_sync_manifest_items (
          id, run_id, repo_id, branch, target_head, path, shard_key, source_family,
          content_checksum, source_acquisition_mode, blob_sha, size_bytes,
          needs_rebuild, reuse_reason, skip_reason, build_status
        ) VALUES ${valuePlaceholders.join(",")}`,
        values
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
    { pending: 0, reused: 0, rebuilt: 0, failed: 0, skipped: 0 }
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
  publicationMode: "build_only" | "publish_inline";
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

    if (input.publicationMode === "publish_inline") {
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
    }

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
