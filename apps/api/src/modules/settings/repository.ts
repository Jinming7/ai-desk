import { pool } from "../../db/client.js";

export interface AiAgentModeSetting {
  enabled: boolean;
  updatedBy: string;
  updatedAt: string;
}

export async function getAiAgentMode(): Promise<AiAgentModeSetting> {
  const result = await pool.query<{
    value_json: { enabled?: boolean };
    updated_by: string;
    updated_at: string;
  }>("SELECT value_json, updated_by, updated_at FROM system_settings WHERE key = 'ai_agent_enabled' LIMIT 1");

  if (!result.rowCount) {
    return { enabled: true, updatedBy: "system", updatedAt: new Date().toISOString() };
  }

  const row = result.rows[0];
  return {
    enabled: Boolean(row.value_json?.enabled),
    updatedBy: row.updated_by,
    updatedAt: row.updated_at
  };
}

export async function setAiAgentMode(enabled: boolean, updatedBy: string): Promise<AiAgentModeSetting> {
  const result = await pool.query<{
    value_json: { enabled?: boolean };
    updated_by: string;
    updated_at: string;
  }>(
    `INSERT INTO system_settings(key, value_json, updated_by)
     VALUES ('ai_agent_enabled', $1::jsonb, $2)
     ON CONFLICT (key) DO UPDATE
       SET value_json = EXCLUDED.value_json,
           updated_by = EXCLUDED.updated_by,
           updated_at = NOW()
     RETURNING value_json, updated_by, updated_at`,
    [JSON.stringify({ enabled }), updatedBy]
  );

  return {
    enabled: Boolean(result.rows[0].value_json?.enabled),
    updatedBy: result.rows[0].updated_by,
    updatedAt: result.rows[0].updated_at
  };
}
