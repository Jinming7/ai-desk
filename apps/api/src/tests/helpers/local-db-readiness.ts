import type { Pool } from "pg";

export type LocalDbReadiness =
  | { kind: "ready" }
  | { kind: "blocked"; reason: "db_unavailable" | "schema_unavailable" | "unsafe_database"; detail: string };

const DEFAULT_REQUIRED_TABLES = [
  "kb_repo_registrations",
  "kb_builds",
  "kb_publications",
  "kb_sync_checkpoints",
  "kb_build_validation_results"
] as const;

export async function probeLocalDbReadiness(input: {
  pool: Pick<Pool, "query">;
  databaseUrl: string;
  isSafeTestDatabaseUrl: (value: string) => boolean;
  requiredTables?: string[];
}): Promise<LocalDbReadiness> {
  if (!input.isSafeTestDatabaseUrl(input.databaseUrl)) {
    return {
      kind: "blocked",
      reason: "unsafe_database",
      detail: `Refusing to run DB-backed tests against non-local database: ${input.databaseUrl}`
    };
  }

  try {
    await input.pool.query("SELECT 1");
  } catch (error) {
    return {
      kind: "blocked",
      reason: "db_unavailable",
      detail: error instanceof Error ? error.message : String(error)
    };
  }

  const requiredTables = input.requiredTables ?? [...DEFAULT_REQUIRED_TABLES];
  const placeholders = requiredTables.map((_, index) => `$${index + 1}`).join(", ");
  try {
    const result = await input.pool.query<{ table_name: string }>(
      `SELECT table_name
         FROM information_schema.tables
        WHERE table_schema = 'public'
          AND table_name IN (${placeholders})`,
      requiredTables
    );
    const available = new Set(result.rows.map((row) => row.table_name));
    const missing = requiredTables.filter((table) => !available.has(table));
    if (missing.length > 0) {
      return {
        kind: "blocked",
        reason: "schema_unavailable",
        detail: `missing tables: ${missing.join(", ")}`
      };
    }
  } catch (error) {
    return {
      kind: "blocked",
      reason: "schema_unavailable",
      detail: error instanceof Error ? error.message : String(error)
    };
  }

  return { kind: "ready" };
}

export function formatLocalDbBlockedMessage(suiteName: string, readiness: Extract<LocalDbReadiness, { kind: "blocked" }>): string {
  return `${suiteName} blocked: ${readiness.reason} (${readiness.detail})`;
}
