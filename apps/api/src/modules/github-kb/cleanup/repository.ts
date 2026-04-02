import { pool } from "../../../db/client.js";
import type { KbBuild, KbKnowledgeSpace } from "../types.js";
import type { CleanupLegacyDuplicateCounts, CleanupOrphanedChildCounts, CleanupTableCounts } from "./classifier.js";

export async function listBuilds(input?: {
  repoId?: string;
  branch?: string;
  knowledgeSpace?: KbKnowledgeSpace;
}): Promise<KbBuild[]> {
  const clauses: string[] = [];
  const values: unknown[] = [];
  if (input?.repoId) {
    values.push(input.repoId);
    clauses.push(`repo_id = $${values.length}`);
  }
  if (input?.branch) {
    values.push(input.branch);
    clauses.push(`branch = $${values.length}`);
  }
  if (input?.knowledgeSpace) {
    values.push(input.knowledgeSpace);
    clauses.push(`knowledge_space = $${values.length}`);
  }

  const result = await pool.query<KbBuild>(
    `SELECT *
     FROM kb_builds
     WHERE ${clauses.length ? clauses.join(" AND ") : "TRUE"}
     ORDER BY knowledge_space ASC, repo_id ASC, branch ASC, updated_at DESC, created_at DESC`,
    values
  );
  return result.rows;
}

export async function getBuildScopedTableCounts(input: {
  knowledgeSpace: KbKnowledgeSpace;
  repoId: string;
  branch: string;
  buildVersion: string;
}): Promise<CleanupTableCounts> {
  const result = await pool.query<Record<keyof CleanupTableCounts, string>>(
    `WITH build_memory AS (
       SELECT id
       FROM kb_memory_entries
       WHERE knowledge_space = $1
         AND repo_id = $2
         AND branch = $3
         AND build_version = $4
     ), build_relations AS (
       SELECT DISTINCT rel.id
       FROM kb_memory_relations rel
       INNER JOIN kb_memory_entries src ON src.id = rel.from_memory_id
       INNER JOIN kb_memory_entries dst ON dst.id = rel.to_memory_id
       WHERE (src.knowledge_space = $1 AND src.repo_id = $2 AND src.branch = $3 AND src.build_version = $4)
          OR (dst.knowledge_space = $1 AND dst.repo_id = $2 AND dst.branch = $3 AND dst.build_version = $4)
     )
     SELECT
       (SELECT COUNT(*)::text FROM kb_documents WHERE knowledge_space = $1 AND repo_id = $2 AND branch = $3 AND build_version = $4) AS kb_documents,
       (SELECT COUNT(*)::text FROM kb_chunks WHERE knowledge_space = $1 AND repo_id = $2 AND branch = $3 AND build_version = $4) AS kb_chunks,
       (SELECT COUNT(*)::text FROM kb_memory_entries WHERE knowledge_space = $1 AND repo_id = $2 AND branch = $3 AND build_version = $4) AS kb_memory_entries,
       (SELECT COUNT(*)::text FROM kb_memory_sources WHERE memory_id IN (SELECT id FROM build_memory)) AS kb_memory_sources,
       (SELECT COUNT(*)::text FROM kb_memory_aliases WHERE memory_id IN (SELECT id FROM build_memory)) AS kb_memory_aliases,
       (SELECT COUNT(*)::text FROM kb_memory_signals WHERE memory_id IN (SELECT id FROM build_memory)) AS kb_memory_signals,
       (SELECT COUNT(*)::text FROM build_relations) AS kb_memory_relations,
       (SELECT COUNT(*)::text FROM kb_memory_profiles WHERE knowledge_space = $1 AND repo_id = $2 AND branch = $3 AND build_version = $4) AS kb_memory_profiles,
       (SELECT COUNT(*)::text FROM kb_memory_citations WHERE memory_id IN (SELECT id FROM build_memory)) AS kb_memory_citations,
       (SELECT COUNT(*)::text FROM kb_openapi_operations WHERE knowledge_space = $1 AND repo_id = $2 AND branch = $3 AND build_version = $4) AS kb_openapi_operations,
       (SELECT COUNT(*)::text FROM kb_code_symbols WHERE knowledge_space = $1 AND repo_id = $2 AND branch = $3 AND build_version = $4) AS kb_code_symbols,
       (SELECT COUNT(*)::text FROM kb_config_surfaces WHERE knowledge_space = $1 AND repo_id = $2 AND branch = $3 AND build_version = $4) AS kb_config_surfaces,
       (SELECT COUNT(*)::text FROM kb_schema_objects WHERE knowledge_space = $1 AND repo_id = $2 AND branch = $3 AND build_version = $4) AS kb_schema_objects,
       (SELECT COUNT(*)::text FROM kb_test_behaviors WHERE knowledge_space = $1 AND repo_id = $2 AND branch = $3 AND build_version = $4) AS kb_test_behaviors,
       (SELECT COUNT(*)::text FROM kb_citation_units WHERE knowledge_space = $1 AND repo_id = $2 AND branch = $3 AND build_version = $4) AS kb_citation_units`,
    [input.knowledgeSpace, input.repoId, input.branch, input.buildVersion]
  );

  const row = result.rows[0];
  return {
    kb_documents: Number(row?.kb_documents ?? "0"),
    kb_chunks: Number(row?.kb_chunks ?? "0"),
    kb_memory_entries: Number(row?.kb_memory_entries ?? "0"),
    kb_memory_sources: Number(row?.kb_memory_sources ?? "0"),
    kb_memory_aliases: Number(row?.kb_memory_aliases ?? "0"),
    kb_memory_signals: Number(row?.kb_memory_signals ?? "0"),
    kb_memory_relations: Number(row?.kb_memory_relations ?? "0"),
    kb_memory_profiles: Number(row?.kb_memory_profiles ?? "0"),
    kb_memory_citations: Number(row?.kb_memory_citations ?? "0"),
    kb_openapi_operations: Number(row?.kb_openapi_operations ?? "0"),
    kb_code_symbols: Number(row?.kb_code_symbols ?? "0"),
    kb_config_surfaces: Number(row?.kb_config_surfaces ?? "0"),
    kb_schema_objects: Number(row?.kb_schema_objects ?? "0"),
    kb_test_behaviors: Number(row?.kb_test_behaviors ?? "0"),
    kb_citation_units: Number(row?.kb_citation_units ?? "0")
  };
}

export async function getBuildLegacyDuplicateCounts(input: {
  knowledgeSpace: KbKnowledgeSpace;
  repoId: string;
  branch: string;
  buildVersion: string;
}): Promise<CleanupLegacyDuplicateCounts> {
  const result = await pool.query<Record<keyof CleanupLegacyDuplicateCounts, string>>(
    `SELECT
       (
         SELECT COUNT(*)::text
         FROM kb_documents doc
         WHERE doc.knowledge_space = $1
           AND doc.repo_id = $2
           AND doc.branch = $3
           AND doc.build_version = $4
           AND doc.is_active = true
           AND EXISTS (
             SELECT 1
             FROM kb_documents other
             WHERE other.knowledge_space = doc.knowledge_space
               AND other.repo_id = doc.repo_id
               AND other.branch = doc.branch
               AND other.path = doc.path
               AND other.build_version <> doc.build_version
               AND other.is_active = true
           )
       ) AS kb_documents,
       (
         SELECT COUNT(*)::text
         FROM kb_chunks chunk
         WHERE chunk.knowledge_space = $1
           AND chunk.repo_id = $2
           AND chunk.branch = $3
           AND chunk.build_version = $4
           AND chunk.is_active = true
           AND EXISTS (
             SELECT 1
             FROM kb_chunks other
             WHERE other.knowledge_space = chunk.knowledge_space
               AND other.repo_id = chunk.repo_id
               AND other.branch = chunk.branch
               AND other.path = chunk.path
               AND other.heading_path = chunk.heading_path
               AND other.ordinal = chunk.ordinal
               AND other.build_version <> chunk.build_version
               AND other.is_active = true
           )
       ) AS kb_chunks,
       (
         SELECT COUNT(*)::text
         FROM kb_memory_entries entry
         WHERE entry.knowledge_space = $1
           AND entry.repo_id = $2
           AND entry.branch = $3
           AND entry.build_version = $4
           AND entry.status = 'active'
           AND EXISTS (
             SELECT 1
             FROM kb_memory_entries other
             WHERE other.knowledge_space = entry.knowledge_space
               AND other.repo_id = entry.repo_id
               AND other.branch = entry.branch
               AND other.path = entry.path
               AND other.memory_kind = entry.memory_kind
               AND other.canonical_claim = entry.canonical_claim
               AND other.build_version <> entry.build_version
               AND other.status = 'active'
           )
       ) AS kb_memory_entries,
       (
         SELECT COUNT(*)::text
         FROM kb_memory_profiles profile
         WHERE profile.knowledge_space = $1
           AND profile.repo_id = $2
           AND profile.branch = $3
           AND profile.build_version = $4
           AND profile.is_active = true
           AND EXISTS (
             SELECT 1
             FROM kb_memory_profiles other
             WHERE other.knowledge_space = profile.knowledge_space
               AND other.repo_id = profile.repo_id
               AND other.branch = profile.branch
               AND other.profile_key = profile.profile_key
               AND other.build_version <> profile.build_version
               AND other.is_active = true
           )
       ) AS kb_memory_profiles`,
    [input.knowledgeSpace, input.repoId, input.branch, input.buildVersion]
  );

  const row = result.rows[0];
  return {
    kb_documents: Number(row?.kb_documents ?? "0"),
    kb_chunks: Number(row?.kb_chunks ?? "0"),
    kb_memory_entries: Number(row?.kb_memory_entries ?? "0"),
    kb_memory_profiles: Number(row?.kb_memory_profiles ?? "0")
  };
}

export async function getBuildOrphanedChildCounts(input: {
  knowledgeSpace: KbKnowledgeSpace;
  repoId: string;
  branch: string;
  buildVersion: string;
}): Promise<CleanupOrphanedChildCounts> {
  const result = await pool.query<{ kb_memory_sources: string; kb_memory_citations: string; kb_memory_relations: string }>(
    `WITH build_memory AS (
       SELECT id, knowledge_space, build_version
       FROM kb_memory_entries
       WHERE knowledge_space = $1
         AND repo_id = $2
         AND branch = $3
         AND build_version = $4
     )
     SELECT
       (
         SELECT COUNT(*)::text
         FROM kb_memory_sources src
         INNER JOIN build_memory entry ON entry.id = src.memory_id
         LEFT JOIN kb_documents doc ON doc.id = src.doc_id
         LEFT JOIN kb_chunks chunk ON chunk.id = src.chunk_id
         WHERE doc.id IS NULL
            OR chunk.id IS NULL
            OR doc.knowledge_space <> entry.knowledge_space
            OR chunk.knowledge_space <> entry.knowledge_space
            OR doc.build_version <> entry.build_version
            OR chunk.build_version <> entry.build_version
       ) AS kb_memory_sources,
       (
         SELECT COUNT(*)::text
         FROM kb_memory_citations mc
         INNER JOIN build_memory entry ON entry.id = mc.memory_id
         LEFT JOIN kb_citation_units citation ON citation.id = mc.citation_id
         WHERE citation.id IS NULL
            OR citation.knowledge_space <> entry.knowledge_space
            OR citation.build_version <> entry.build_version
       ) AS kb_memory_citations,
       (
         SELECT COUNT(*)::text
         FROM kb_memory_relations rel
         INNER JOIN kb_memory_entries src ON src.id = rel.from_memory_id
         INNER JOIN kb_memory_entries dst ON dst.id = rel.to_memory_id
         WHERE (
             src.knowledge_space = $1
             AND src.repo_id = $2
             AND src.branch = $3
             AND src.build_version = $4
           ) OR (
             dst.knowledge_space = $1
             AND dst.repo_id = $2
             AND dst.branch = $3
             AND dst.build_version = $4
           )
           AND (
             src.knowledge_space <> dst.knowledge_space
             OR src.build_version <> dst.build_version
           )
       ) AS kb_memory_relations`,
    [input.knowledgeSpace, input.repoId, input.branch, input.buildVersion]
  );

  const row = result.rows[0];
  const kbMemorySources = Number(row?.kb_memory_sources ?? "0");
  const kbMemoryCitations = Number(row?.kb_memory_citations ?? "0");
  const kbMemoryRelations = Number(row?.kb_memory_relations ?? "0");
  return {
    kb_memory_sources: kbMemorySources,
    kb_memory_citations: kbMemoryCitations,
    kb_memory_relations: kbMemoryRelations,
    total: kbMemorySources + kbMemoryCitations + kbMemoryRelations
  };
}
