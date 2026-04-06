import { v4 as uuidv4 } from "uuid";
import { pool } from "../../db/client.js";
import type {
  KbMemoryEntry,
  MemoryAliasDraft,
  MemoryCaseFrame,
  MemoryCitationDraft,
  MemoryEntryDraft,
  MemoryProfileDraft,
  MemoryProfileHit,
  MemoryRelationDraft,
  MemoryRelationHit,
  MemoryRetrievalHit,
  MemorySignalDraft,
  MemorySourceCitationHit,
  MemorySourceChunkHit,
  MemorySourceDraft
} from "./memory-types.js";
import type { KbKnowledgeSpace } from "./types.js";

function toJson(value: unknown): string {
  return JSON.stringify(value ?? {});
}

function clampScore(value: number): number {
  return Math.max(0, Math.min(1, value));
}

export function attachBuildVersionToDocMetadata(
  buildVersion: string,
  metadata: Record<string, unknown> | null | undefined
): Record<string, unknown> {
  return {
    build_version: buildVersion,
    ...(metadata ?? {})
  };
}

function normalizeSignalRows(input: Array<{ signalType?: string; value: string }>): Array<{ signalType: string | null; value: string }> {
  const deduped = new Map<string, { signalType: string | null; value: string }>();
  for (const item of input) {
    const value = String(item.value ?? "").trim();
    if (!value) continue;
    const signalType = String(item.signalType ?? "").trim() || null;
    const key = `${signalType ?? "*"}::${value.toLowerCase()}`;
    if (!deduped.has(key)) deduped.set(key, { signalType, value });
  }
  return [...deduped.values()];
}

function buildMemoryWhere(filters: { repoId?: string; branch?: string; knowledgeSpace: KbKnowledgeSpace }) {
  const clauses = [
    `pub.knowledge_space = $1`,
    `entry.knowledge_space = ${EFFECTIVE_BUILD_SPACE_SQL}`,
    `entry.status = 'active'`,
    `entry.build_version = ${EFFECTIVE_BUILD_VERSION_SQL}`
  ];
  const values: unknown[] = [filters.knowledgeSpace];
  if (filters.repoId) {
    values.push(filters.repoId);
    clauses.push(`entry.repo_id = $${values.length}`);
  }
  if (filters.branch) {
    values.push(filters.branch);
    clauses.push(`entry.branch = $${values.length}`);
  }
  return { clause: clauses.join(" AND "), values };
}

const EFFECTIVE_PUBLISHED_BUILD_JOIN = `
    INNER JOIN kb_builds published_build
      ON published_build.knowledge_space = pub.knowledge_space
     AND published_build.repo_id = pub.repo_id
     AND published_build.branch = pub.branch
     AND published_build.build_version = pub.published_build_version
    LEFT JOIN kb_builds effective_build
      ON effective_build.id = published_build.promoted_from_build_id`;

const EFFECTIVE_BUILD_SPACE_SQL = `COALESCE(effective_build.knowledge_space, published_build.knowledge_space)`;
const EFFECTIVE_BUILD_VERSION_SQL = `COALESCE(effective_build.build_version, published_build.build_version)`;

export async function upsertMemoryEntry(input: MemoryEntryDraft): Promise<KbMemoryEntry> {
  const result = await pool.query<KbMemoryEntry>(
    `INSERT INTO kb_memory_entries (
      id, repo_id, knowledge_space, branch, doc_id, path, memory_kind, title, canonical_claim, summary,
      product_area, doc_kind, action_type, deployment_model, object_type,
      is_static, is_latest, status, build_version, metadata_json, search_text, search_vector
    ) VALUES (
      $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,
      $11,$12,$13,$14,$15,
      $16,true,'active',$17,$18::jsonb,$19,to_tsvector('english', $19)
    )
    ON CONFLICT (id)
    DO UPDATE SET
      repo_id = EXCLUDED.repo_id,
      knowledge_space = EXCLUDED.knowledge_space,
      branch = EXCLUDED.branch,
      doc_id = EXCLUDED.doc_id,
      path = EXCLUDED.path,
      memory_kind = EXCLUDED.memory_kind,
      title = EXCLUDED.title,
      canonical_claim = EXCLUDED.canonical_claim,
      summary = EXCLUDED.summary,
      product_area = EXCLUDED.product_area,
      doc_kind = EXCLUDED.doc_kind,
      action_type = EXCLUDED.action_type,
      deployment_model = EXCLUDED.deployment_model,
      object_type = EXCLUDED.object_type,
      is_static = EXCLUDED.is_static,
      is_latest = true,
      status = 'active',
      build_version = EXCLUDED.build_version,
      metadata_json = EXCLUDED.metadata_json,
      search_text = EXCLUDED.search_text,
      search_vector = EXCLUDED.search_vector,
      updated_at = NOW()
    RETURNING *`,
    [
      input.id,
      input.repo_id,
      input.knowledge_space,
      input.branch,
      input.doc_id,
      input.path,
      input.memory_kind,
      input.title,
      input.canonical_claim,
      input.summary,
      input.product_area,
      input.doc_kind,
      input.action_type,
      input.deployment_model,
      input.object_type,
      input.is_static,
      input.build_version,
      toJson(input.metadata_json),
      input.search_text
    ]
  );
  return result.rows[0];
}

export async function replaceMemoryAliases(memoryId: string, aliases: MemoryAliasDraft[]): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [memoryId]);
    await client.query(`DELETE FROM kb_memory_aliases WHERE memory_id = $1`, [memoryId]);
    for (const alias of aliases) {
      await client.query(
        `INSERT INTO kb_memory_aliases (id, memory_id, alias, alias_type, weight, metadata_json)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb)
         ON CONFLICT (memory_id, alias, alias_type)
         DO UPDATE SET
           weight = EXCLUDED.weight,
           metadata_json = EXCLUDED.metadata_json`,
        [uuidv4(), memoryId, alias.alias, alias.alias_type, alias.weight, toJson(alias.metadata_json ?? {})]
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function replaceMemorySignals(memoryId: string, signals: MemorySignalDraft[]): Promise<void> {
  await pool.query(`DELETE FROM kb_memory_signals WHERE memory_id = $1`, [memoryId]);
  for (const signal of signals) {
    await pool.query(
      `INSERT INTO kb_memory_signals (id, memory_id, signal_type, signal_value, weight, metadata_json)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb)
       ON CONFLICT (memory_id, signal_type, signal_value)
       DO UPDATE SET
         weight = GREATEST(kb_memory_signals.weight, EXCLUDED.weight),
         metadata_json = EXCLUDED.metadata_json`,
      [uuidv4(), memoryId, signal.signal_type, signal.signal_value, signal.weight, toJson(signal.metadata_json ?? {})]
    );
  }
}

export async function replaceMemorySources(memoryId: string, sources: MemorySourceDraft[]): Promise<void> {
  await pool.query(`DELETE FROM kb_memory_sources WHERE memory_id = $1`, [memoryId]);
  for (const source of sources) {
    await pool.query(
      `INSERT INTO kb_memory_sources (memory_id, doc_id, chunk_id, heading_path, source_score, source_metadata_json)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb)
       ON CONFLICT (memory_id, chunk_id)
       DO UPDATE SET
         doc_id = EXCLUDED.doc_id,
         heading_path = EXCLUDED.heading_path,
         source_score = GREATEST(kb_memory_sources.source_score, EXCLUDED.source_score),
         source_metadata_json = EXCLUDED.source_metadata_json`,
      [memoryId, source.doc_id, source.chunk_id, source.heading_path, source.source_score, toJson(source.source_metadata_json ?? {})]
    );
  }
}

export async function replaceMemoryCitations(memoryId: string, citations: MemoryCitationDraft[]): Promise<void> {
  await pool.query(`DELETE FROM kb_memory_citations WHERE memory_id = $1`, [memoryId]);
  for (const citation of citations) {
    await pool.query(
      `INSERT INTO kb_memory_citations (memory_id, citation_id, source_score, source_metadata_json)
       VALUES ($1, $2, $3, $4::jsonb)
       ON CONFLICT (memory_id, citation_id)
       DO UPDATE SET
         source_score = GREATEST(kb_memory_citations.source_score, EXCLUDED.source_score),
         source_metadata_json = EXCLUDED.source_metadata_json`,
      [memoryId, citation.citation_id, citation.source_score, toJson(citation.source_metadata_json ?? {})]
    );
  }
}

export async function deactivateMemoryArtifactsByDocument(docId: string): Promise<void> {
  await pool.query(
    `DELETE FROM kb_memory_entries
     WHERE doc_id = $1
       AND status = 'inactive'`,
    [docId]
  );
}

export async function deleteBuildScopedMemoryEntriesForDocument(docId: string, buildVersion: string): Promise<void> {
  await pool.query(
    `DELETE FROM kb_memory_entries
     WHERE doc_id = $1
       AND build_version = $2`,
    [docId, buildVersion]
  );
}

export async function markPriorBuildVersionInactive(repoId: string, branch: string, path: string, keepBuildVersion: string): Promise<void> {
  await pool.query(
    `UPDATE kb_memory_entries
     SET status = 'inactive',
         is_latest = false,
         updated_at = NOW()
     WHERE repo_id = $1
       AND branch = $2
       AND path = $3
       AND build_version <> $4
       AND status = 'active'`,
    [repoId, branch, path, keepBuildVersion]
  );

  await pool.query(
    `UPDATE kb_memory_entries
     SET is_latest = true,
         status = 'active',
         updated_at = NOW()
     WHERE repo_id = $1
       AND branch = $2
       AND path = $3
       AND build_version = $4`,
    [repoId, branch, path, keepBuildVersion]
  );
}

export async function searchMemoryEntries(input: {
  knowledgeSpace: KbKnowledgeSpace;
  repoId?: string;
  branch?: string;
  query: string;
  limit: number;
}): Promise<MemoryRetrievalHit[]> {
  const where = buildMemoryWhere(input);
  const queryParam = where.values.length + 1;
  const likeParam = where.values.length + 2;
  const limitParam = where.values.length + 3;
  const result = await pool.query<{
    memory_id: string;
    doc_id: string;
    path: string;
    title: string | null;
    canonical_claim: string;
    summary: string;
    memory_kind: KbMemoryEntry["memory_kind"];
    product_area: string;
    doc_kind: string;
    action_type: string | null;
    deployment_model: string | null;
    object_type: string | null;
    build_version: string;
    updated_at: string;
    canonical_score: string;
    summary_score: string;
    heading_title_score: string;
    lexical_score: string;
  }>(
    `SELECT
      entry.id AS memory_id,
      entry.doc_id,
      entry.path,
      entry.title,
      entry.canonical_claim,
      entry.summary,
      entry.memory_kind,
      entry.product_area,
      entry.doc_kind,
      entry.action_type,
      entry.deployment_model,
      entry.object_type,
      entry.build_version,
      entry.updated_at::text,
      GREATEST(
        similarity(entry.canonical_claim, $${queryParam}),
        CASE WHEN entry.canonical_claim ILIKE $${likeParam} THEN 0.98 ELSE 0 END
      )::text AS canonical_score,
      GREATEST(
        similarity(entry.summary, $${queryParam}),
        CASE WHEN entry.summary ILIKE $${likeParam} THEN 0.92 ELSE 0 END
      )::text AS summary_score,
      GREATEST(
        similarity(COALESCE(entry.title, '') || ' ' || entry.path, $${queryParam}),
        CASE WHEN COALESCE(entry.title, '') ILIKE $${likeParam} OR entry.path ILIKE $${likeParam} THEN 0.9 ELSE 0 END
      )::text AS heading_title_score,
      COALESCE(ts_rank_cd(entry.search_vector, websearch_to_tsquery('english', $${queryParam})), 0)::text AS lexical_score
    FROM kb_memory_entries entry
    INNER JOIN kb_publications pub
      ON pub.repo_id = entry.repo_id
     AND pub.branch = entry.branch
    ${EFFECTIVE_PUBLISHED_BUILD_JOIN}
    WHERE ${where.clause}
      AND (
        entry.search_vector @@ websearch_to_tsquery('english', $${queryParam})
        OR similarity(entry.canonical_claim, $${queryParam}) >= 0.18
        OR similarity(entry.summary, $${queryParam}) >= 0.16
        OR similarity(COALESCE(entry.title, '') || ' ' || entry.path, $${queryParam}) >= 0.16
        OR entry.canonical_claim ILIKE $${likeParam}
        OR entry.summary ILIKE $${likeParam}
        OR COALESCE(entry.title, '') ILIKE $${likeParam}
        OR entry.path ILIKE $${likeParam}
      )
    ORDER BY
      GREATEST(
        similarity(entry.canonical_claim, $${queryParam}),
        similarity(entry.summary, $${queryParam}),
        similarity(COALESCE(entry.title, '') || ' ' || entry.path, $${queryParam}),
        COALESCE(ts_rank_cd(entry.search_vector, websearch_to_tsquery('english', $${queryParam})), 0)
      ) DESC,
      entry.updated_at DESC
    LIMIT $${limitParam}`,
    [...where.values, input.query, `%${input.query}%`, input.limit]
  );

  return result.rows.map((row) => {
    const canonical = clampScore(Number(row.canonical_score));
    const summary = clampScore(Number(row.summary_score));
    const headingTitle = clampScore(Number(row.heading_title_score));
    const lexical = clampScore(Number(row.lexical_score));
    const score = clampScore(canonical * 0.5 + summary * 0.25 + headingTitle * 0.15 + lexical * 0.1);
    return {
      memoryId: row.memory_id,
      docId: row.doc_id,
      path: row.path,
      title: row.title,
      canonicalClaim: row.canonical_claim,
      summary: row.summary,
      memoryKind: row.memory_kind,
      productArea: row.product_area,
      docKind: row.doc_kind,
      actionType: row.action_type,
      deploymentModel: row.deployment_model,
      objectType: row.object_type,
      score,
      source: "memory_entry",
      buildVersion: row.build_version,
      updatedAt: row.updated_at,
      metadata: {
        canonicalClaimScore: canonical,
        summaryScore: summary,
        headingTitleScore: headingTitle,
        lexicalScore: lexical
      }
    };
  });
}

export async function searchMemoryAliases(input: {
  knowledgeSpace: KbKnowledgeSpace;
  repoId?: string;
  branch?: string;
  query: string;
  limit: number;
}): Promise<MemoryRetrievalHit[]> {
  const where = buildMemoryWhere(input);
  const queryParam = where.values.length + 1;
  const likeParam = where.values.length + 2;
  const limitParam = where.values.length + 3;
  const result = await pool.query<{
    memory_id: string;
    doc_id: string;
    path: string;
    title: string | null;
    canonical_claim: string;
    summary: string;
    memory_kind: KbMemoryEntry["memory_kind"];
    product_area: string;
    doc_kind: string;
    action_type: string | null;
    deployment_model: string | null;
    object_type: string | null;
    build_version: string;
    updated_at: string;
    alias: string;
    alias_type: string;
    alias_score: string;
    weight: string;
  }>(
    `SELECT
      entry.id AS memory_id,
      entry.doc_id,
      entry.path,
      entry.title,
      entry.canonical_claim,
      entry.summary,
      entry.memory_kind,
      entry.product_area,
      entry.doc_kind,
      entry.action_type,
      entry.deployment_model,
      entry.object_type,
      entry.build_version,
      entry.updated_at::text,
      alias.alias,
      alias.alias_type,
      GREATEST(
        similarity(alias.alias, $${queryParam}),
        CASE WHEN LOWER(alias.alias) = LOWER($${queryParam}) THEN 1 ELSE 0 END,
        CASE WHEN alias.alias ILIKE $${likeParam} THEN 0.96 ELSE 0 END
      )::text AS alias_score,
      alias.weight::text
    FROM kb_memory_aliases alias
    INNER JOIN kb_memory_entries entry ON entry.id = alias.memory_id
    INNER JOIN kb_publications pub
      ON pub.repo_id = entry.repo_id
     AND pub.branch = entry.branch
    ${EFFECTIVE_PUBLISHED_BUILD_JOIN}
    WHERE ${where.clause}
      AND (
        similarity(alias.alias, $${queryParam}) >= 0.2
        OR alias.alias ILIKE $${likeParam}
        OR LOWER(alias.alias) = LOWER($${queryParam})
      )
    ORDER BY
      GREATEST(
        similarity(alias.alias, $${queryParam}),
        CASE WHEN LOWER(alias.alias) = LOWER($${queryParam}) THEN 1 ELSE 0 END,
        CASE WHEN alias.alias ILIKE $${likeParam} THEN 0.96 ELSE 0 END
      ) DESC,
      alias.weight DESC
    LIMIT $${limitParam}`,
    [...where.values, input.query, `%${input.query}%`, input.limit]
  );

  return result.rows.map((row) => {
    const aliasScore = clampScore(Number(row.alias_score));
    const weight = clampScore(Number(row.weight));
    return {
      memoryId: row.memory_id,
      docId: row.doc_id,
      path: row.path,
      title: row.title,
      canonicalClaim: row.canonical_claim,
      summary: row.summary,
      memoryKind: row.memory_kind,
      productArea: row.product_area,
      docKind: row.doc_kind,
      actionType: row.action_type,
      deploymentModel: row.deployment_model,
      objectType: row.object_type,
      score: clampScore(aliasScore * 0.82 + weight * 0.18),
      source: "alias",
      buildVersion: row.build_version,
      updatedAt: row.updated_at,
      metadata: {
        alias: row.alias,
        aliasType: row.alias_type,
        aliasMatchScore: aliasScore,
        aliasWeight: weight
      }
    };
  });
}

export async function searchMemorySignals(input: {
  knowledgeSpace: KbKnowledgeSpace;
  repoId?: string;
  branch?: string;
  signals: Array<{ signalType?: string; value: string }>;
  limit: number;
}): Promise<MemoryRetrievalHit[]> {
  const rows = normalizeSignalRows(input.signals);
  if (!rows.length) return [];

  const where = buildMemoryWhere(input);
  const queryValues: unknown[] = [...where.values];
  const signalTypeValues = rows.map((item) => item.signalType);
  const signalValueValues = rows.map((item) => item.value);
  const typesParam = queryValues.push(signalTypeValues);
  const valuesParam = queryValues.push(signalValueValues);
  const limitParam = queryValues.push(input.limit);

  const result = await pool.query<{
    memory_id: string;
    doc_id: string;
    path: string;
    title: string | null;
    canonical_claim: string;
    summary: string;
    memory_kind: KbMemoryEntry["memory_kind"];
    product_area: string;
    doc_kind: string;
    action_type: string | null;
    deployment_model: string | null;
    object_type: string | null;
    build_version: string;
    updated_at: string;
    signal_type: string;
    signal_value: string;
    signal_score: string;
    weight: string;
  }>(
    `WITH input_signals AS (
      SELECT UNNEST($${typesParam}::text[]) AS signal_type, UNNEST($${valuesParam}::text[]) AS signal_value
    )
    SELECT
      entry.id AS memory_id,
      entry.doc_id,
      entry.path,
      entry.title,
      entry.canonical_claim,
      entry.summary,
      entry.memory_kind,
      entry.product_area,
      entry.doc_kind,
      entry.action_type,
      entry.deployment_model,
      entry.object_type,
      entry.build_version,
      entry.updated_at::text,
      signal.signal_type,
      signal.signal_value,
      GREATEST(
        CASE WHEN LOWER(signal.signal_value) = LOWER(input_signals.signal_value) THEN 1 ELSE 0 END,
        CASE WHEN input_signals.signal_type IS NOT NULL AND signal.signal_type = input_signals.signal_type AND signal.signal_value ILIKE '%' || input_signals.signal_value || '%' THEN 0.96 ELSE 0 END,
        similarity(signal.signal_value, input_signals.signal_value)
      )::text AS signal_score,
      signal.weight::text
    FROM input_signals
    INNER JOIN kb_memory_signals signal
      ON (
        (input_signals.signal_type IS NULL OR signal.signal_type = input_signals.signal_type)
        AND (
          LOWER(signal.signal_value) = LOWER(input_signals.signal_value)
          OR signal.signal_value ILIKE '%' || input_signals.signal_value || '%'
          OR similarity(signal.signal_value, input_signals.signal_value) >= 0.2
        )
      )
    INNER JOIN kb_memory_entries entry ON entry.id = signal.memory_id
    INNER JOIN kb_publications pub
      ON pub.repo_id = entry.repo_id
     AND pub.branch = entry.branch
    ${EFFECTIVE_PUBLISHED_BUILD_JOIN}
    WHERE ${where.clause}
    ORDER BY
      GREATEST(
        CASE WHEN LOWER(signal.signal_value) = LOWER(input_signals.signal_value) THEN 1 ELSE 0 END,
        CASE WHEN input_signals.signal_type IS NOT NULL AND signal.signal_type = input_signals.signal_type AND signal.signal_value ILIKE '%' || input_signals.signal_value || '%' THEN 0.96 ELSE 0 END,
        similarity(signal.signal_value, input_signals.signal_value)
      ) DESC,
      signal.weight DESC
    LIMIT $${limitParam}`,
    queryValues
  );

  return result.rows.map((row) => {
    const signalScore = clampScore(Number(row.signal_score));
    const weight = clampScore(Number(row.weight));
    return {
      memoryId: row.memory_id,
      docId: row.doc_id,
      path: row.path,
      title: row.title,
      canonicalClaim: row.canonical_claim,
      summary: row.summary,
      memoryKind: row.memory_kind,
      productArea: row.product_area,
      docKind: row.doc_kind,
      actionType: row.action_type,
      deploymentModel: row.deployment_model,
      objectType: row.object_type,
      score: clampScore(signalScore * 0.88 + weight * 0.12),
      source: "signal",
      buildVersion: row.build_version,
      updatedAt: row.updated_at,
      metadata: {
        signalType: row.signal_type,
        signalValue: row.signal_value,
        exactSignalScore: signalScore,
        signalWeight: weight
      }
    };
  });
}

export async function searchMemoryProfiles(input: {
  knowledgeSpace: KbKnowledgeSpace;
  repoId?: string;
  branch?: string;
  query: string;
  caseFrame?: MemoryCaseFrame;
  limit: number;
}): Promise<MemoryProfileHit[]> {
  const conditions = [
    `pub.knowledge_space = $1`,
    `profile.knowledge_space = ${EFFECTIVE_BUILD_SPACE_SQL}`,
    `profile.build_version = ${EFFECTIVE_BUILD_VERSION_SQL}`
  ];
  const values: unknown[] = [input.knowledgeSpace];
  if (input.repoId) {
    values.push(input.repoId);
    conditions.push(`profile.repo_id = $${values.length}`);
  }
  if (input.branch) {
    values.push(input.branch);
    conditions.push(`profile.branch = $${values.length}`);
  }
  values.push(input.query);
  const queryParam = values.length;
  values.push(`%${input.query}%`);
  const likeParam = values.length;
  values.push(input.caseFrame?.product_area ?? "");
  const productAreaParam = values.length;
  values.push(input.caseFrame?.object ?? "");
  const objectParam = values.length;
  values.push(input.limit);
  const limitParam = values.length;

  const result = await pool.query<{
    id: string;
    profile_key: string;
    profile_kind: string;
    title: string;
    static_summary: string;
    dynamic_summary: string | null;
    score: string;
  }>(
    `SELECT
      profile.id,
      profile.profile_key,
      profile.profile_kind,
      profile.title,
      profile.static_summary,
      profile.dynamic_summary,
      (
        GREATEST(
          similarity(profile.title, $${queryParam}),
          similarity(profile.static_summary, $${queryParam}),
          CASE WHEN profile.title ILIKE $${likeParam} THEN 0.94 ELSE 0 END
        )
        + CASE WHEN $${productAreaParam} <> '' AND profile.profile_key ILIKE '%' || $${productAreaParam} || '%' THEN 0.25 ELSE 0 END
        + CASE WHEN $${objectParam} <> '' AND profile.profile_key ILIKE '%' || $${objectParam} || '%' THEN 0.15 ELSE 0 END
      )::text AS score
    FROM kb_memory_profiles profile
    INNER JOIN kb_publications pub
      ON pub.repo_id = profile.repo_id
     AND pub.branch = profile.branch
    ${EFFECTIVE_PUBLISHED_BUILD_JOIN}
    WHERE ${conditions.join(" AND ")}
      AND (
        similarity(profile.title, $${queryParam}) >= 0.16
        OR similarity(profile.static_summary, $${queryParam}) >= 0.14
        OR profile.title ILIKE $${likeParam}
        OR profile.profile_key ILIKE $${likeParam}
      )
    ORDER BY score DESC, profile.updated_at DESC
    LIMIT $${limitParam}`,
    values
  );

  return result.rows.map((row) => ({
    profileId: row.id,
    profileKey: row.profile_key,
    profileKind: row.profile_kind,
    title: row.title,
    staticSummary: row.static_summary,
    dynamicSummary: row.dynamic_summary,
    score: clampScore(Number(row.score))
  }));
}

export async function expandMemoryRelations(input: {
  knowledgeSpace: KbKnowledgeSpace;
  memoryIds: string[];
  limitPerMemory: number;
}): Promise<MemoryRelationHit[]> {
  const memoryIds = [...new Set(input.memoryIds.filter(Boolean))];
  if (!memoryIds.length) return [];

  const result = await pool.query<{
    via_memory_id: string;
    relation_type: "updates" | "extends" | "derives";
    relation_weight: string;
    memory_id: string;
    doc_id: string;
    path: string;
    title: string | null;
    canonical_claim: string;
    summary: string;
    memory_kind: KbMemoryEntry["memory_kind"];
    product_area: string;
    doc_kind: string;
    action_type: string | null;
    deployment_model: string | null;
    object_type: string | null;
    build_version: string;
    updated_at: string;
  }>(
    `WITH ranked AS (
      SELECT
        rel.from_memory_id AS via_memory_id,
        rel.relation_type,
        rel.weight::text AS relation_weight,
        target.id AS memory_id,
        target.doc_id,
        target.path,
        target.title,
        target.canonical_claim,
        target.summary,
        target.memory_kind,
        target.product_area,
        target.doc_kind,
        target.action_type,
        target.deployment_model,
        target.object_type,
        target.build_version,
        target.updated_at::text,
        ROW_NUMBER() OVER (PARTITION BY rel.from_memory_id ORDER BY rel.weight DESC, target.updated_at DESC) AS rn
      FROM kb_memory_relations rel
      INNER JOIN kb_memory_entries target
        ON target.id = rel.to_memory_id
      INNER JOIN kb_publications pub
        ON pub.repo_id = target.repo_id
       AND pub.branch = target.branch
       AND pub.knowledge_space = $2
      ${EFFECTIVE_PUBLISHED_BUILD_JOIN}
      WHERE rel.from_memory_id = ANY($1::uuid[])
        AND target.knowledge_space = ${EFFECTIVE_BUILD_SPACE_SQL}
        AND target.status = 'active'
        AND target.build_version = ${EFFECTIVE_BUILD_VERSION_SQL}
    )
    SELECT * FROM ranked WHERE rn <= $3`,
    [memoryIds, input.knowledgeSpace, input.limitPerMemory]
  );

  return result.rows.map((row) => ({
    memoryId: row.memory_id,
    docId: row.doc_id,
    path: row.path,
    title: row.title,
    canonicalClaim: row.canonical_claim,
    summary: row.summary,
    memoryKind: row.memory_kind,
    productArea: row.product_area,
    docKind: row.doc_kind,
    actionType: row.action_type,
    deploymentModel: row.deployment_model,
    objectType: row.object_type,
    score: clampScore(Number(row.relation_weight)),
    source: "relation",
    buildVersion: row.build_version,
    updatedAt: row.updated_at,
    relationType: row.relation_type,
    relationWeight: clampScore(Number(row.relation_weight)),
    viaMemoryId: row.via_memory_id,
    metadata: {
      relationType: row.relation_type
    }
  }));
}

export async function resolveMemorySourcesToChunks(input: {
  knowledgeSpace: KbKnowledgeSpace;
  memoryIds: string[];
  limitPerMemory: number;
}): Promise<MemorySourceChunkHit[]> {
  const memoryIds = [...new Set(input.memoryIds.filter(Boolean))];
  if (!memoryIds.length) return [];
  const result = await pool.query<{
    memory_id: string;
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
    source_score: string;
    chunk_metadata_json: Record<string, unknown> | null;
    doc_metadata_json: Record<string, unknown> | null;
    memory_metadata_json: Record<string, unknown> | null;
    rn: string;
  }>(
    `WITH ranked AS (
      SELECT
        src.memory_id,
        chunk.id AS chunk_id,
        doc.id AS document_id,
        doc.repo_id,
        reg.repo_owner || '/' || reg.repo_name AS repo,
        doc.branch,
        doc.path,
        doc.source_url,
        doc.repo_source_url,
        doc.commit_sha,
        doc.build_version::text,
        doc.title,
        chunk.heading_path,
        LEFT(chunk.content, 2400) AS snippet,
        src.source_score::text,
        chunk.metadata_json AS chunk_metadata_json,
        doc.metadata_json AS doc_metadata_json,
        entry.metadata_json AS memory_metadata_json,
        ROW_NUMBER() OVER (PARTITION BY src.memory_id ORDER BY src.source_score DESC, chunk.ordinal ASC) AS rn
      FROM kb_memory_sources src
      INNER JOIN kb_memory_entries entry ON entry.id = src.memory_id
      INNER JOIN kb_chunks chunk ON chunk.id = src.chunk_id
      INNER JOIN kb_documents doc ON doc.id = chunk.doc_id
      INNER JOIN kb_repo_registrations reg ON reg.id = doc.repo_id
      INNER JOIN kb_publications pub
        ON pub.repo_id = doc.repo_id
       AND pub.branch = doc.branch
      ${EFFECTIVE_PUBLISHED_BUILD_JOIN}
      WHERE src.memory_id = ANY($1::uuid[])
        AND pub.knowledge_space = $2
        AND entry.knowledge_space = ${EFFECTIVE_BUILD_SPACE_SQL}
        AND chunk.knowledge_space = ${EFFECTIVE_BUILD_SPACE_SQL}
        AND doc.knowledge_space = ${EFFECTIVE_BUILD_SPACE_SQL}
        AND entry.status = 'active'
        AND entry.build_version = ${EFFECTIVE_BUILD_VERSION_SQL}
        AND chunk.build_version = ${EFFECTIVE_BUILD_VERSION_SQL}
        AND doc.build_version = ${EFFECTIVE_BUILD_VERSION_SQL}
    )
    SELECT * FROM ranked WHERE rn <= $3`,
    [memoryIds, input.knowledgeSpace, input.limitPerMemory]
  );

  return result.rows.map((row) => ({
    memoryId: row.memory_id,
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
    sourceScore: Number(row.source_score),
    chunkMetadata: row.chunk_metadata_json ?? undefined,
    docMetadata: attachBuildVersionToDocMetadata(row.build_version, row.doc_metadata_json),
    memoryMetadata: row.memory_metadata_json ?? undefined
  }));
}

export async function resolveMemorySourcesToCitations(input: {
  knowledgeSpace: KbKnowledgeSpace;
  memoryIds: string[];
  limitPerMemory: number;
}): Promise<MemorySourceCitationHit[]> {
  const memoryIds = [...new Set(input.memoryIds.filter(Boolean))];
  if (!memoryIds.length) return [];
  const result = await pool.query<{
    memory_id: string;
    citation_id: string;
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
    heading_path: string | null;
    snippet: string;
    source_score: string;
    citation_family: string;
    source_family: string;
    citation_metadata_json: Record<string, unknown> | null;
    doc_metadata_json: Record<string, unknown> | null;
    memory_metadata_json: Record<string, unknown> | null;
    rn: string;
  }>(
    `WITH ranked AS (
      SELECT
        mc.memory_id,
        cu.id AS citation_id,
        COALESCE(cu.source_artifact_id::text, cu.id::text) AS document_id,
        doc.repo_id,
        reg.repo_owner || '/' || reg.repo_name AS repo,
        doc.branch,
        cu.path,
        doc.source_url,
        doc.repo_source_url,
        doc.commit_sha,
        doc.build_version::text,
        cu.title,
        cu.heading_path,
        cu.snippet_text AS snippet,
        mc.source_score::text,
        cu.citation_family,
        cu.source_family,
        cu.metadata_json AS citation_metadata_json,
        doc.metadata_json AS doc_metadata_json,
        entry.metadata_json AS memory_metadata_json,
        ROW_NUMBER() OVER (PARTITION BY mc.memory_id ORDER BY mc.source_score DESC, cu.updated_at DESC) AS rn
      FROM kb_memory_citations mc
      INNER JOIN kb_memory_entries entry ON entry.id = mc.memory_id
      INNER JOIN kb_citation_units cu ON cu.id = mc.citation_id
      INNER JOIN kb_documents doc ON doc.id = cu.source_doc_id
      INNER JOIN kb_repo_registrations reg ON reg.id = doc.repo_id
      INNER JOIN kb_publications pub
        ON pub.repo_id = doc.repo_id
       AND pub.branch = doc.branch
      ${EFFECTIVE_PUBLISHED_BUILD_JOIN}
      WHERE mc.memory_id = ANY($1::uuid[])
        AND pub.knowledge_space = $2
        AND entry.knowledge_space = ${EFFECTIVE_BUILD_SPACE_SQL}
        AND cu.knowledge_space = ${EFFECTIVE_BUILD_SPACE_SQL}
        AND doc.knowledge_space = ${EFFECTIVE_BUILD_SPACE_SQL}
        AND entry.status = 'active'
        AND entry.build_version = ${EFFECTIVE_BUILD_VERSION_SQL}
        AND cu.build_version = ${EFFECTIVE_BUILD_VERSION_SQL}
        AND doc.build_version = ${EFFECTIVE_BUILD_VERSION_SQL}
    )
    SELECT * FROM ranked WHERE rn <= $3`,
    [memoryIds, input.knowledgeSpace, input.limitPerMemory]
  );

  return result.rows.map((row) => ({
    memoryId: row.memory_id,
    citationId: row.citation_id,
    documentId: row.document_id,
    repoId: row.repo_id,
    repo: row.repo,
    branch: row.branch,
    path: row.path,
    sourceUrl: row.source_url,
    repoSourceUrl: row.repo_source_url,
    commitSha: row.commit_sha,
    title: row.title,
    headingPath: row.heading_path ?? "ROOT",
    snippet: row.snippet,
    sourceScore: Number(row.source_score),
    citationFamily: row.citation_family,
    sourceFamily: row.source_family,
    citationMetadata: row.citation_metadata_json ?? undefined,
    docMetadata: attachBuildVersionToDocMetadata(row.build_version, row.doc_metadata_json),
    memoryMetadata: row.memory_metadata_json ?? undefined
  }));
}

export async function listActiveMemoryEntriesForScope(input: {
  knowledgeSpace: KbKnowledgeSpace;
  repoId: string;
  branch: string;
  path?: string;
  productArea?: string;
  buildVersion?: string;
  limit?: number;
}): Promise<KbMemoryEntry[]> {
  const clauses = ["repo_id = $1", "knowledge_space = $2", "branch = $3", "status = 'active'"];
  const values: unknown[] = [input.repoId, input.knowledgeSpace, input.branch];
  if (input.path) {
    values.push(input.path);
    clauses.push(`path = $${values.length}`);
  }
  if (input.productArea) {
    values.push(input.productArea);
    clauses.push(`product_area = $${values.length}`);
  }
  if (input.buildVersion) {
    values.push(input.buildVersion);
    clauses.push(`build_version = $${values.length}`);
  } else {
    clauses.push("is_latest = true");
  }
  values.push(input.limit ?? 200);
  const limitParam = values.length;
  const result = await pool.query<KbMemoryEntry>(
    `SELECT *
     FROM kb_memory_entries
     WHERE ${clauses.join(" AND ")}
     ORDER BY updated_at DESC
     LIMIT $${limitParam}`,
    values
  );
  return result.rows;
}

export async function replaceRelationsForMemoryIds(memoryIds: string[], relations: MemoryRelationDraft[]): Promise<void> {
  const uniqueIds = [...new Set(memoryIds.filter(Boolean))];
  if (uniqueIds.length) {
    await pool.query(
      `DELETE FROM kb_memory_relations
       WHERE from_memory_id = ANY($1::uuid[]) OR to_memory_id = ANY($1::uuid[])`,
      [uniqueIds]
    );
  }
  for (const relation of relations) {
    await pool.query(
      `INSERT INTO kb_memory_relations (id, from_memory_id, to_memory_id, relation_type, weight, metadata_json)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb)
       ON CONFLICT (id)
       DO UPDATE SET
         from_memory_id = EXCLUDED.from_memory_id,
         to_memory_id = EXCLUDED.to_memory_id,
         relation_type = EXCLUDED.relation_type,
         weight = EXCLUDED.weight,
         metadata_json = EXCLUDED.metadata_json`,
      [relation.id, relation.from_memory_id, relation.to_memory_id, relation.relation_type, relation.weight, toJson(relation.metadata_json ?? {})]
    );
  }
}

export async function upsertMemoryProfiles(profiles: MemoryProfileDraft[]): Promise<void> {
  for (const profile of profiles) {
    await pool.query(
      `INSERT INTO kb_memory_profiles (
        id, repo_id, knowledge_space, branch, profile_key, profile_kind, title,
        static_summary, dynamic_summary, build_version, metadata_json, is_active
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,true)
      ON CONFLICT (repo_id, branch, profile_key, build_version)
      DO UPDATE SET
        knowledge_space = EXCLUDED.knowledge_space,
        profile_kind = EXCLUDED.profile_kind,
        title = EXCLUDED.title,
        static_summary = EXCLUDED.static_summary,
        dynamic_summary = EXCLUDED.dynamic_summary,
        metadata_json = EXCLUDED.metadata_json,
        is_active = true,
        updated_at = NOW()`,
      [
        profile.id,
        profile.repo_id,
        profile.knowledge_space,
        profile.branch,
        profile.profile_key,
        profile.profile_kind,
        profile.title,
        profile.static_summary,
        profile.dynamic_summary ?? null,
        profile.build_version,
        toJson(profile.metadata_json ?? {})
      ]
    );
  }
}

export async function deactivatePriorProfiles(repoId: string, branch: string, activeBuildVersion: string, activeKeys: string[]): Promise<void> {
  await pool.query(
    `UPDATE kb_memory_profiles
     SET is_active = false,
         updated_at = NOW()
     WHERE repo_id = $1
       AND branch = $2
       AND (
         build_version <> $3
         OR NOT (profile_key = ANY($4::text[]))
       )`,
    [repoId, branch, activeBuildVersion, activeKeys.length ? activeKeys : ["__none__"]]
  );
}
