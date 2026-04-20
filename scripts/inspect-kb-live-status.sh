#!/bin/bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
DEFAULT_REPO_ID="c9e3e3df-989b-4a01-9b41-b6bc5a6fcffc"
REPO_ID="${1:-${KB_REPO_ID:-$DEFAULT_REPO_ID}}"
ENV_CANDIDATES=("$ROOT_DIR/.env")

if [ -L "$ROOT_DIR/node_modules" ]; then
  SHARED_NODE_MODULES="$(readlink "$ROOT_DIR/node_modules")"
  ENV_CANDIDATES+=("$(cd "$(dirname "$SHARED_NODE_MODULES")" && pwd)/.env")
fi

if ! command -v psql >/dev/null 2>&1; then
  echo "psql is required" >&2
  exit 1
fi

if [ -z "${DATABASE_URL:-}" ]; then
  for env_file in "${ENV_CANDIDATES[@]}"; do
    if [ -f "$env_file" ]; then
      set -a
      # shellcheck disable=SC1090
      source "$env_file" >/dev/null 2>&1
      set +a
      break
    fi
  done
fi

if [ -z "${DATABASE_URL:-}" ]; then
  echo "DATABASE_URL is not set and no candidate .env file could provide it" >&2
  exit 1
fi

export PGAPPNAME="inspect-kb-live-status"

psql "$DATABASE_URL" -q -X -v ON_ERROR_STOP=1 -v repo_id="$REPO_ID" <<'SQL'
\pset tuples_only on
\pset format unaligned
\pset pager off

BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;

\echo [Summary]
WITH target_repo AS (
  SELECT *
  FROM kb_repo_registrations
  WHERE id = :'repo_id'
),
latest_run AS (
  SELECT *
  FROM kb_sync_runs
  WHERE repo_id = (SELECT id FROM target_repo)
  ORDER BY started_at DESC NULLS LAST
  LIMIT 1
),
latest_build AS (
  SELECT *
  FROM kb_builds
  WHERE repo_id = (SELECT id FROM target_repo)
  ORDER BY updated_at DESC
  LIMIT 1
),
manifest_stats AS (
  SELECT
    COUNT(*) FILTER (WHERE build_status IN ('rebuilt', 'reused', 'skipped')) AS processed_total,
    COUNT(*) FILTER (WHERE build_status IN ('rebuilt', 'reused')) AS effective_done,
    COUNT(*) FILTER (WHERE build_status <> 'skipped') AS effective_total,
    COUNT(*) FILTER (WHERE build_status = 'skipped') AS skipped_total,
    COUNT(*) FILTER (WHERE build_status = 'pending') AS pending_total,
    COUNT(*) FILTER (WHERE build_status = 'failed') AS failed_total,
    COUNT(*) AS item_total
  FROM kb_sync_manifest_items
  WHERE run_id = (SELECT id FROM latest_run)
),
validation_stats AS (
  SELECT
    COUNT(*) AS total_checks,
    COUNT(*) FILTER (WHERE NOT passed AND severity = 'error') AS failed_errors,
    COUNT(*) FILTER (WHERE NOT passed AND severity = 'warn') AS failed_warnings,
    COUNT(*) FILTER (WHERE severity = 'warn') AS warning_checks
  FROM kb_build_validation_results
  WHERE build_id = (SELECT id FROM latest_build)
),
artifact_counts AS (
  SELECT
    (SELECT COUNT(*) FROM kb_documents d, latest_build b
      WHERE d.knowledge_space = b.knowledge_space
        AND d.repo_id = b.repo_id
        AND d.branch = b.branch
        AND d.build_version = b.build_version) AS docs_count,
    (SELECT COUNT(*) FROM kb_chunks c, latest_build b
      WHERE c.knowledge_space = b.knowledge_space
        AND c.repo_id = b.repo_id
        AND c.branch = b.branch
        AND c.build_version = b.build_version) AS chunks_count,
    (SELECT COUNT(*) FROM kb_memory_entries m, latest_build b
      WHERE m.knowledge_space = b.knowledge_space
        AND m.repo_id = b.repo_id
        AND m.branch = b.branch
        AND m.build_version = b.build_version) AS memory_count,
    (SELECT COUNT(*) FROM kb_openapi_operations o, latest_build b
      WHERE o.knowledge_space = b.knowledge_space
        AND o.repo_id = b.repo_id
        AND o.branch = b.branch
        AND o.build_version = b.build_version) AS openapi_count,
    (SELECT COUNT(*) FROM kb_code_symbols s, latest_build b
      WHERE s.knowledge_space = b.knowledge_space
        AND s.repo_id = b.repo_id
        AND s.branch = b.branch
        AND s.build_version = b.build_version) AS code_count,
    (SELECT COUNT(*) FROM kb_config_surfaces c, latest_build b
      WHERE c.knowledge_space = b.knowledge_space
        AND c.repo_id = b.repo_id
        AND c.branch = b.branch
        AND c.build_version = b.build_version) AS config_count,
    (SELECT COUNT(*) FROM kb_schema_objects s, latest_build b
      WHERE s.knowledge_space = b.knowledge_space
        AND s.repo_id = b.repo_id
        AND s.branch = b.branch
        AND s.build_version = b.build_version) AS schema_count,
    (SELECT COUNT(*) FROM kb_test_behaviors t, latest_build b
      WHERE t.knowledge_space = b.knowledge_space
        AND t.repo_id = b.repo_id
        AND t.branch = b.branch
        AND t.build_version = b.build_version) AS test_count
),
publication_stats AS (
  SELECT COUNT(*) AS publication_count
  FROM kb_publications
  WHERE repo_id = (SELECT id FROM target_repo)
),
serving_stats AS (
  SELECT COUNT(*) AS serving_count
  FROM kb_serving_versions
  WHERE repo_id = (SELECT id FROM target_repo)
),
open_docs_shard AS (
  SELECT
    shard_key,
    status,
    total_docs,
    completed_docs,
    reusable_docs,
    rebuilt_docs,
    failed_docs,
    next_cursor,
    last_heartbeat_at
  FROM kb_sync_run_shards
  WHERE run_id = (SELECT id FROM latest_run)
    AND shard_key = 'open-docs'
)
SELECT label || E'\t' || value
FROM (
  SELECT 1 AS ord, 'repo_id' AS label, COALESCE((SELECT id::text FROM target_repo), 'null') AS value
  UNION ALL
  SELECT 2, 'repo_url', COALESCE((SELECT repo_url FROM target_repo), 'null')
  UNION ALL
  SELECT 3, 'repo_branch', COALESCE((SELECT default_branch FROM target_repo), 'null')
  UNION ALL
  SELECT 4, 'latest_run_id', COALESCE((SELECT id::text FROM latest_run), 'null')
  UNION ALL
  SELECT 5, 'run_status', COALESCE((SELECT status FROM latest_run), 'null')
  UNION ALL
  SELECT 6, 'latest_build_id', COALESCE((SELECT id::text FROM latest_build), 'null')
  UNION ALL
  SELECT 7, 'build_status', COALESCE((SELECT status FROM latest_build), 'null')
  UNION ALL
  SELECT 8, 'knowledge_space', COALESCE((SELECT knowledge_space FROM latest_build), 'null')
  UNION ALL
  SELECT 9, 'build_version', COALESCE((SELECT build_version FROM latest_build), 'null')
  UNION ALL
  SELECT 10, 'target_head', COALESCE((SELECT target_head FROM latest_build), 'null')
  UNION ALL
  SELECT 11, '【处理进度】', COALESCE((SELECT processed_total::text || '/' || item_total::text FROM manifest_stats), '0/0')
  UNION ALL
  SELECT 12, '【有效产物进度】', COALESCE((SELECT effective_done::text || '/' || effective_total::text FROM manifest_stats), '0/0')
  UNION ALL
  SELECT 13, '【已同步数】', COALESCE((SELECT effective_done::text FROM manifest_stats), '0')
  UNION ALL
  SELECT 14, '【总数】', COALESCE((SELECT item_total::text FROM manifest_stats), '0')
  UNION ALL
  SELECT 15, '【跳过】', COALESCE((SELECT skipped_total::text FROM manifest_stats), '0')
  UNION ALL
  SELECT 16, '【待处理】', COALESCE((SELECT pending_total::text FROM manifest_stats), '0')
  UNION ALL
  SELECT 17, '【失败】', COALESCE((SELECT failed_total::text FROM manifest_stats), '0')
  UNION ALL
  SELECT 18, 'validation_total', COALESCE((SELECT total_checks::text FROM validation_stats), '0')
  UNION ALL
  SELECT 19, 'validation_failed_errors', COALESCE((SELECT failed_errors::text FROM validation_stats), '0')
  UNION ALL
  SELECT 20, 'validation_failed_warnings', COALESCE((SELECT failed_warnings::text FROM validation_stats), '0')
  UNION ALL
  SELECT 21, 'validation_warning_checks', COALESCE((SELECT warning_checks::text FROM validation_stats), '0')
  UNION ALL
  SELECT 22, 'docs/chunks/memory',
    COALESCE((SELECT docs_count::text || ' / ' || chunks_count::text || ' / ' || memory_count::text FROM artifact_counts), '0 / 0 / 0')
  UNION ALL
  SELECT 23, 'structured_artifacts',
    COALESCE((
      SELECT
        'openapi=' || openapi_count::text ||
        ', code=' || code_count::text ||
        ', config=' || config_count::text ||
        ', schema=' || schema_count::text ||
        ', test=' || test_count::text
      FROM artifact_counts
    ), 'openapi=0, code=0, config=0, schema=0, test=0')
  UNION ALL
  SELECT 24, 'publications', COALESCE((SELECT publication_count::text FROM publication_stats), '0')
  UNION ALL
  SELECT 25, 'serving_versions', COALESCE((SELECT serving_count::text FROM serving_stats), '0')
  UNION ALL
  SELECT 26, 'open_docs_shard',
    COALESCE((
      SELECT
        shard_key || ':' || status || ':' || completed_docs::text || '/' || total_docs::text ||
        ':rebuilt=' || rebuilt_docs::text ||
        ':reused=' || reusable_docs::text ||
        ':failed=' || failed_docs::text ||
        ':cursor=' || COALESCE(next_cursor, '') ||
        ':heartbeat=' || COALESCE(last_heartbeat_at::text, '')
      FROM open_docs_shard
    ), 'null')
) AS rows
ORDER BY ord;

\echo [Document Families In Latest Build]
WITH latest_build AS (
  SELECT *
  FROM kb_builds
  WHERE repo_id = :'repo_id'
  ORDER BY updated_at DESC
  LIMIT 1
),
family_counts AS (
  SELECT
    COALESCE(NULLIF(d.metadata_json->>'sourceFamily', ''), 'unknown') AS family,
    COUNT(*) AS total
  FROM kb_documents d, latest_build b
  WHERE d.knowledge_space = b.knowledge_space
    AND d.repo_id = b.repo_id
    AND d.branch = b.branch
    AND d.build_version = b.build_version
  GROUP BY 1
)
SELECT family || E'\t' || total::text
FROM family_counts
ORDER BY family;

\echo [Manifest Pending By Family]
WITH latest_run AS (
  SELECT *
  FROM kb_sync_runs
  WHERE repo_id = :'repo_id'
  ORDER BY started_at DESC NULLS LAST
  LIMIT 1
),
pending_counts AS (
  SELECT
    COALESCE(source_family, 'unknown') AS family,
    COUNT(*) AS total
  FROM kb_sync_manifest_items
  WHERE run_id = (SELECT id FROM latest_run)
    AND build_status = 'pending'
  GROUP BY 1
)
SELECT family || E'\t' || total::text
FROM pending_counts
ORDER BY family;

\echo [Validation Results]
WITH latest_build AS (
  SELECT *
  FROM kb_builds
  WHERE repo_id = :'repo_id'
  ORDER BY updated_at DESC
  LIMIT 1
),
rows AS (
  SELECT
    validation_kind,
    severity,
    passed,
    summary
  FROM kb_build_validation_results
  WHERE build_id = (SELECT id FROM latest_build)
  ORDER BY severity DESC, validation_kind
)
SELECT validation_kind || E'\t' || severity || E'\t' || passed::text || E'\t' || summary
FROM rows;
WITH latest_build AS (
  SELECT *
  FROM kb_builds
  WHERE repo_id = :'repo_id'
  ORDER BY updated_at DESC
  LIMIT 1
),
rows AS (
  SELECT
    validation_kind,
    severity,
    passed,
    summary
  FROM kb_build_validation_results
  WHERE build_id = (SELECT id FROM latest_build)
)
SELECT 'none' || E'\t' || 'none' || E'\t' || 'true' || E'\t' || 'no validation rows'
WHERE NOT EXISTS (SELECT 1 FROM rows);

\echo [Publications]
WITH rows AS (
  SELECT
    knowledge_space,
    published_build_version,
    published_head,
    published_from_env,
    published_at
  FROM kb_publications
  WHERE repo_id = :'repo_id'
  ORDER BY knowledge_space, published_at DESC
)
SELECT knowledge_space || E'\t' || published_build_version || E'\t' || published_head || E'\t' || published_from_env || E'\t' || published_at::text
FROM rows;
WITH rows AS (
  SELECT
    knowledge_space,
    published_build_version,
    published_head,
    published_from_env,
    published_at
  FROM kb_publications
  WHERE repo_id = :'repo_id'
)
SELECT 'none' || E'\t' || 'none' || E'\t' || 'none' || E'\t' || 'none' || E'\t' || 'none'
WHERE NOT EXISTS (SELECT 1 FROM rows);

\echo [Serving Versions]
WITH rows AS (
  SELECT
    repo_id,
    branch,
    active_build_version,
    active_head,
    activated_at
  FROM kb_serving_versions
  WHERE repo_id = :'repo_id'
  ORDER BY branch
)
SELECT repo_id::text || E'\t' || branch || E'\t' || active_build_version || E'\t' || active_head || E'\t' || activated_at::text
FROM rows;
WITH rows AS (
  SELECT
    repo_id,
    branch,
    active_build_version,
    active_head,
    activated_at
  FROM kb_serving_versions
  WHERE repo_id = :'repo_id'
)
SELECT 'none' || E'\t' || 'none' || E'\t' || 'none' || E'\t' || 'none' || E'\t' || 'none'
WHERE NOT EXISTS (SELECT 1 FROM rows);

COMMIT;
SQL
