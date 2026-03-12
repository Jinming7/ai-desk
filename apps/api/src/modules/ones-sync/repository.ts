import { v4 as uuidv4 } from "uuid";
import { pool } from "../../db/client.js";

export interface OnesSyncConfigRecord {
  id: string;
  profile_name: string;
  base_url: string;
  auth_type: "bearer" | "header";
  auth_header: string;
  auth_secret_encrypted: string;
  system_auth_secret_encrypted: string | null;
  create_ticket_path: string;
  list_projects_path: string;
  list_ticket_types_path: string;
  list_fields_path_template: string;
  timeout_ms: number;
  retries: number;
  data_source_mode: "ones_primary" | "local_mirror";
  ones_project_key: string | null;
  ones_team_id: string | null;
  schema_hash: string | null;
  schema_synced_at: string | null;
  endpoint_templates_json: Record<string, unknown>;
  allowed_ticket_type_keys: string[];
  status_mapping_json: Record<string, unknown>;
  workflow_mapping_json: Record<string, unknown>;
  config_version?: number;
  publish_state?: "draft" | "published";
  publish_checks_json?: Record<string, unknown>;
  change_reason?: string | null;
  rolled_back_from?: string | null;
  is_active: boolean;
  updated_by: string;
  updated_at: string;
  created_at: string;
}

let hasConfigVersionColumnCache: boolean | null = null;
let hasSystemAuthSecretColumnCache: boolean | null = null;

async function hasConfigVersionColumn(): Promise<boolean> {
  if (hasConfigVersionColumnCache !== null) return hasConfigVersionColumnCache;
  const result = await pool.query<{ exists: boolean }>(
    `SELECT EXISTS (
      SELECT 1
      FROM information_schema.columns
      WHERE table_name = 'ones_sync_config'
        AND column_name = 'config_version'
    ) AS exists`
  );
  hasConfigVersionColumnCache = Boolean(result.rows[0]?.exists);
  return hasConfigVersionColumnCache;
}

async function hasSystemAuthSecretColumn(): Promise<boolean> {
  if (hasSystemAuthSecretColumnCache !== null) return hasSystemAuthSecretColumnCache;
  const result = await pool.query<{ exists: boolean }>(
    `SELECT EXISTS (
      SELECT 1
      FROM information_schema.columns
      WHERE table_name = 'ones_sync_config'
        AND column_name = 'system_auth_secret_encrypted'
    ) AS exists`
  );
  hasSystemAuthSecretColumnCache = Boolean(result.rows[0]?.exists);
  return hasSystemAuthSecretColumnCache;
}

export interface OnesTicketTypeCacheRecord {
  id: string;
  type_key: string;
  type_name: string;
  fields_json: unknown[];
  source_json: Record<string, unknown>;
  synced_at: string;
  updated_at: string;
}

export interface OnesFieldMappingRecord {
  id: string;
  ticket_type_key: string;
  flow: "create" | "update" | "transition" | "comment";
  version: number;
  status: "draft" | "active";
  mapping_json: unknown[];
  validation_json: Record<string, unknown>;
  created_by: string;
  created_at: string;
  activated_at: string | null;
}

export interface OnesProjectIssueTypeConfigRecord {
  id: string;
  project_key: string;
  issue_type_key: string;
  issue_type_name: string;
  enabled_for_customer: boolean;
  field_schema_json: unknown[];
  status_mapping_json: Record<string, unknown>;
  metadata_json: Record<string, unknown>;
  updated_by: string;
  created_at: string;
  updated_at: string;
}

export async function getActiveConfig(): Promise<OnesSyncConfigRecord | null> {
  const result = await pool.query<OnesSyncConfigRecord>(
    "SELECT * FROM ones_sync_config WHERE is_active = true ORDER BY updated_at DESC LIMIT 1"
  );
  if (result.rows[0]) return result.rows[0];

  // Self-heal: if no active config exists, promote latest row to active.
  const fallback = await pool.query<OnesSyncConfigRecord>(
    "SELECT * FROM ones_sync_config ORDER BY updated_at DESC LIMIT 1"
  );
  const row = fallback.rows[0];
  if (!row) return null;
  await pool.query("UPDATE ones_sync_config SET is_active = true WHERE id = $1", [row.id]);
  return { ...row, is_active: true };
}

export async function upsertActiveConfig(input: {
  profileName: string;
  baseUrl: string;
  authType: "bearer" | "header";
  authHeader: string;
  authSecretEncrypted: string;
  systemAuthSecretEncrypted?: string | null;
  createTicketPath: string;
  listProjectsPath: string;
  listTicketTypesPath: string;
  listFieldsPathTemplate: string;
  timeoutMs: number;
  retries: number;
  dataSourceMode: "ones_primary" | "local_mirror";
  onesProjectKey?: string | null;
  onesTeamId?: string | null;
  schemaHash?: string | null;
  schemaSyncedAt?: string | null;
  endpointTemplates?: Record<string, unknown>;
  allowedTicketTypeKeys?: string[];
  statusMapping?: Record<string, unknown>;
  workflowMapping?: Record<string, unknown>;
  publishState?: "draft" | "published";
  publishChecks?: Record<string, unknown>;
  changeReason?: string | null;
  rolledBackFrom?: string | null;
  updatedBy: string;
}): Promise<OnesSyncConfigRecord> {
  const hasEnhancedColumns = await hasConfigVersionColumn();
  const hasSystemSecretColumn = await hasSystemAuthSecretColumn();
  const client = await pool.connect();
  let nextVersion = 1;
  try {
    await client.query("BEGIN");
    if (hasEnhancedColumns) {
      const currentVersion = await client.query<{ version: number }>("SELECT COALESCE(MAX(config_version), 0) AS version FROM ones_sync_config");
      nextVersion = (currentVersion.rows[0]?.version ?? 0) + 1;
    }
    await client.query("UPDATE ones_sync_config SET is_active = false WHERE is_active = true");
    const id = uuidv4();
    const result = hasEnhancedColumns
      ? hasSystemSecretColumn
        ? await client.query<OnesSyncConfigRecord>(
        `INSERT INTO ones_sync_config (
          id, profile_name, base_url, auth_type, auth_header, auth_secret_encrypted,
          system_auth_secret_encrypted,
          create_ticket_path, list_projects_path, list_ticket_types_path, list_fields_path_template,
          timeout_ms, retries, data_source_mode, ones_project_key, ones_team_id, schema_hash, schema_synced_at,
          endpoint_templates_json, allowed_ticket_type_keys, status_mapping_json, workflow_mapping_json,
          config_version, publish_state, publish_checks_json, change_reason, rolled_back_from, is_active, updated_by
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19::jsonb,$20::jsonb,$21::jsonb,$22::jsonb,$23,$24,$25::jsonb,$26,$27,true,$28)
        RETURNING *`,
        [
          id,
          input.profileName,
          input.baseUrl,
          input.authType,
          input.authHeader,
          input.authSecretEncrypted,
          input.systemAuthSecretEncrypted ?? null,
          input.createTicketPath,
          input.listProjectsPath,
          input.listTicketTypesPath,
          input.listFieldsPathTemplate,
          input.timeoutMs,
          input.retries,
          input.dataSourceMode,
          input.onesProjectKey ?? null,
          input.onesTeamId ?? null,
          input.schemaHash ?? null,
          input.schemaSyncedAt ?? null,
          JSON.stringify(input.endpointTemplates ?? {}),
          JSON.stringify(input.allowedTicketTypeKeys ?? []),
          JSON.stringify(input.statusMapping ?? {}),
          JSON.stringify(input.workflowMapping ?? {}),
          nextVersion,
          input.publishState ?? "draft",
          JSON.stringify(input.publishChecks ?? {}),
          input.changeReason ?? null,
          input.rolledBackFrom ?? null,
          input.updatedBy
        ]
      )
        : await client.query<OnesSyncConfigRecord>(
        `INSERT INTO ones_sync_config (
          id, profile_name, base_url, auth_type, auth_header, auth_secret_encrypted,
          create_ticket_path, list_projects_path, list_ticket_types_path, list_fields_path_template,
          timeout_ms, retries, data_source_mode, ones_project_key, ones_team_id, schema_hash, schema_synced_at,
          endpoint_templates_json, allowed_ticket_type_keys, status_mapping_json, workflow_mapping_json,
          config_version, publish_state, publish_checks_json, change_reason, rolled_back_from, is_active, updated_by
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18::jsonb,$19::jsonb,$20::jsonb,$21::jsonb,$22,$23,$24::jsonb,$25,$26,true,$27)
        RETURNING *`,
        [
          id,
          input.profileName,
          input.baseUrl,
          input.authType,
          input.authHeader,
          input.authSecretEncrypted,
          input.createTicketPath,
          input.listProjectsPath,
          input.listTicketTypesPath,
          input.listFieldsPathTemplate,
          input.timeoutMs,
          input.retries,
          input.dataSourceMode,
          input.onesProjectKey ?? null,
          input.onesTeamId ?? null,
          input.schemaHash ?? null,
          input.schemaSyncedAt ?? null,
          JSON.stringify(input.endpointTemplates ?? {}),
          JSON.stringify(input.allowedTicketTypeKeys ?? []),
          JSON.stringify(input.statusMapping ?? {}),
          JSON.stringify(input.workflowMapping ?? {}),
          nextVersion,
          input.publishState ?? "draft",
          JSON.stringify(input.publishChecks ?? {}),
          input.changeReason ?? null,
          input.rolledBackFrom ?? null,
          input.updatedBy
        ]
      )
      : hasSystemSecretColumn
        ? await client.query<OnesSyncConfigRecord>(
        `INSERT INTO ones_sync_config (
          id, profile_name, base_url, auth_type, auth_header, auth_secret_encrypted,
          system_auth_secret_encrypted,
          create_ticket_path, list_projects_path, list_ticket_types_path, list_fields_path_template,
          timeout_ms, retries, data_source_mode, ones_project_key, ones_team_id, schema_hash, schema_synced_at,
          is_active, updated_by
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,true,$19)
        RETURNING *`,
        [
          id,
          input.profileName,
          input.baseUrl,
          input.authType,
          input.authHeader,
          input.authSecretEncrypted,
          input.systemAuthSecretEncrypted ?? null,
          input.createTicketPath,
          input.listProjectsPath,
          input.listTicketTypesPath,
          input.listFieldsPathTemplate,
          input.timeoutMs,
          input.retries,
          input.dataSourceMode,
          input.onesProjectKey ?? null,
          input.onesTeamId ?? null,
          input.schemaHash ?? null,
          input.schemaSyncedAt ?? null,
          input.updatedBy
        ]
      )
        : await client.query<OnesSyncConfigRecord>(
        `INSERT INTO ones_sync_config (
          id, profile_name, base_url, auth_type, auth_header, auth_secret_encrypted,
          create_ticket_path, list_projects_path, list_ticket_types_path, list_fields_path_template,
          timeout_ms, retries, data_source_mode, ones_project_key, ones_team_id, schema_hash, schema_synced_at,
          is_active, updated_by
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,true,$18)
        RETURNING *`,
        [
          id,
          input.profileName,
          input.baseUrl,
          input.authType,
          input.authHeader,
          input.authSecretEncrypted,
          input.createTicketPath,
          input.listProjectsPath,
          input.listTicketTypesPath,
          input.listFieldsPathTemplate,
          input.timeoutMs,
          input.retries,
          input.dataSourceMode,
          input.onesProjectKey ?? null,
          input.onesTeamId ?? null,
          input.schemaHash ?? null,
          input.schemaSyncedAt ?? null,
          input.updatedBy
        ]
      );
    await client.query("COMMIT");
    return result.rows[0];
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function getConfigById(id: string): Promise<OnesSyncConfigRecord | null> {
  const result = await pool.query<OnesSyncConfigRecord>("SELECT * FROM ones_sync_config WHERE id = $1 LIMIT 1", [id]);
  return result.rows[0] ?? null;
}

export async function listConfigHistory(limit = 20): Promise<OnesSyncConfigRecord[]> {
  const hasEnhancedColumns = await hasConfigVersionColumn();
  const result = await pool.query<OnesSyncConfigRecord>(
    hasEnhancedColumns
      ? "SELECT * FROM ones_sync_config ORDER BY config_version DESC, updated_at DESC LIMIT $1"
      : "SELECT * FROM ones_sync_config ORDER BY updated_at DESC LIMIT $1",
    [limit]
  );
  return result.rows;
}

export async function upsertTicketTypeCache(rows: Array<{ key: string; name: string; fields: unknown[]; source: Record<string, unknown> }>) {
  for (const row of rows) {
    await pool.query(
      `INSERT INTO ones_ticket_type_cache (id, type_key, type_name, fields_json, source_json, synced_at, updated_at)
       VALUES ($1,$2,$3,$4::jsonb,$5::jsonb,NOW(),NOW())
       ON CONFLICT (type_key) DO UPDATE
       SET type_name = EXCLUDED.type_name,
           fields_json = EXCLUDED.fields_json,
           source_json = EXCLUDED.source_json,
           synced_at = NOW(),
           updated_at = NOW()`,
      [uuidv4(), row.key, row.name, JSON.stringify(row.fields), JSON.stringify(row.source)]
    );
  }
}

export async function listTicketTypeCache(): Promise<OnesTicketTypeCacheRecord[]> {
  const result = await pool.query<OnesTicketTypeCacheRecord>(
    "SELECT * FROM ones_ticket_type_cache ORDER BY type_name ASC"
  );
  return result.rows;
}

export async function getTicketTypeCacheByKey(typeKey: string): Promise<OnesTicketTypeCacheRecord | null> {
  const result = await pool.query<OnesTicketTypeCacheRecord>(
    "SELECT * FROM ones_ticket_type_cache WHERE type_key = $1 LIMIT 1",
    [typeKey]
  );
  return result.rows[0] ?? null;
}

export async function getLatestMapping(ticketTypeKey: string, flow: "create" | "update" | "transition" | "comment", status: "draft" | "active") {
  const result = await pool.query<OnesFieldMappingRecord>(
    `SELECT * FROM ones_field_mappings
     WHERE ticket_type_key = $1 AND flow = $2 AND status = $3
     ORDER BY version DESC LIMIT 1`,
    [ticketTypeKey, flow, status]
  );
  return result.rows[0] ?? null;
}

export async function listMappings(ticketTypeKey: string, flow: "create" | "update" | "transition" | "comment"): Promise<OnesFieldMappingRecord[]> {
  const result = await pool.query<OnesFieldMappingRecord>(
    "SELECT * FROM ones_field_mappings WHERE ticket_type_key = $1 AND flow = $2 ORDER BY version DESC",
    [ticketTypeKey, flow]
  );
  return result.rows;
}

export async function saveDraftMapping(input: {
  ticketTypeKey: string;
  flow: "create" | "update" | "transition" | "comment";
  mapping: unknown[];
  validation: Record<string, unknown>;
  createdBy: string;
}): Promise<OnesFieldMappingRecord> {
  const current = await getLatestMapping(input.ticketTypeKey, input.flow, "draft");
  const active = await getLatestMapping(input.ticketTypeKey, input.flow, "active");
  const nextVersion = Math.max(current?.version ?? 0, active?.version ?? 0) + 1;

  const result = await pool.query<OnesFieldMappingRecord>(
    `INSERT INTO ones_field_mappings
     (id, ticket_type_key, flow, version, status, mapping_json, validation_json, created_by)
     VALUES ($1,$2,$3,$4,'draft',$5::jsonb,$6::jsonb,$7)
     RETURNING *`,
    [uuidv4(), input.ticketTypeKey, input.flow, nextVersion, JSON.stringify(input.mapping), JSON.stringify(input.validation), input.createdBy]
  );
  return result.rows[0];
}

export async function activateMapping(mappingId: string): Promise<OnesFieldMappingRecord> {
  const current = await pool.query<OnesFieldMappingRecord>("SELECT * FROM ones_field_mappings WHERE id = $1 LIMIT 1", [mappingId]);
  if (!current.rowCount) {
    throw new Error("Mapping not found");
  }
  const row = current.rows[0];
  await pool.query(
    `UPDATE ones_field_mappings SET status = 'draft'
     WHERE ticket_type_key = $1 AND flow = $2 AND status = 'active'`,
    [row.ticket_type_key, row.flow]
  );
  const result = await pool.query<OnesFieldMappingRecord>(
    "UPDATE ones_field_mappings SET status = 'active', activated_at = NOW() WHERE id = $1 RETURNING *",
    [mappingId]
  );
  return result.rows[0];
}

export async function rollbackActiveMapping(ticketTypeKey: string, flow: "create" | "update" | "transition" | "comment"): Promise<OnesFieldMappingRecord> {
  const rows = await listMappings(ticketTypeKey, flow);
  const currentActive = rows.find((r) => r.status === "active");
  const previous = rows.filter((r) => r.status === "active" || r.activated_at).sort((a, b) => b.version - a.version)[1];
  if (!currentActive || !previous) {
    throw new Error("No previous mapping to rollback");
  }
  await pool.query("UPDATE ones_field_mappings SET status = 'draft' WHERE id = $1", [currentActive.id]);
  const result = await pool.query<OnesFieldMappingRecord>(
    "UPDATE ones_field_mappings SET status = 'active', activated_at = NOW() WHERE id = $1 RETURNING *",
    [previous.id]
  );
  return result.rows[0];
}

export async function listProjectIssueTypeConfigs(projectKey: string): Promise<OnesProjectIssueTypeConfigRecord[]> {
  const result = await pool.query<OnesProjectIssueTypeConfigRecord>(
    `SELECT * FROM ones_project_issue_type_configs
     WHERE project_key = $1
     ORDER BY issue_type_name ASC, updated_at DESC`,
    [projectKey]
  );
  return result.rows;
}

export async function getProjectIssueTypeConfig(projectKey: string, issueTypeKey: string): Promise<OnesProjectIssueTypeConfigRecord | null> {
  const result = await pool.query<OnesProjectIssueTypeConfigRecord>(
    `SELECT * FROM ones_project_issue_type_configs
     WHERE project_key = $1 AND issue_type_key = $2
     LIMIT 1`,
    [projectKey, issueTypeKey]
  );
  return result.rows[0] ?? null;
}

export async function upsertProjectIssueTypeConfig(input: {
  projectKey: string;
  issueTypeKey: string;
  issueTypeName: string;
  enabledForCustomer?: boolean;
  fieldSchema?: unknown[];
  statusMapping?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  updatedBy: string;
}): Promise<OnesProjectIssueTypeConfigRecord> {
  const result = await pool.query<OnesProjectIssueTypeConfigRecord>(
    `INSERT INTO ones_project_issue_type_configs (
      id, project_key, issue_type_key, issue_type_name, enabled_for_customer,
      field_schema_json, status_mapping_json, metadata_json, updated_by
    ) VALUES (
      $1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8::jsonb,$9
    )
    ON CONFLICT (project_key, issue_type_key) DO UPDATE SET
      issue_type_name = EXCLUDED.issue_type_name,
      enabled_for_customer = COALESCE($10, ones_project_issue_type_configs.enabled_for_customer),
      field_schema_json = COALESCE($11::jsonb, ones_project_issue_type_configs.field_schema_json),
      status_mapping_json = COALESCE($12::jsonb, ones_project_issue_type_configs.status_mapping_json),
      metadata_json = COALESCE($13::jsonb, ones_project_issue_type_configs.metadata_json),
      updated_by = EXCLUDED.updated_by,
      updated_at = NOW()
    RETURNING *`,
    [
      uuidv4(),
      input.projectKey,
      input.issueTypeKey,
      input.issueTypeName,
      input.enabledForCustomer ?? false,
      JSON.stringify(input.fieldSchema ?? []),
      JSON.stringify(input.statusMapping ?? {}),
      JSON.stringify(input.metadata ?? {}),
      input.updatedBy,
      input.enabledForCustomer ?? null,
      input.fieldSchema ? JSON.stringify(input.fieldSchema) : null,
      input.statusMapping ? JSON.stringify(input.statusMapping) : null,
      input.metadata ? JSON.stringify(input.metadata) : null
    ]
  );
  return result.rows[0];
}

export async function upsertDiscoveredIssueTypes(input: {
  projectKey: string;
  issueTypes: Array<{ key: string; name: string; metadata?: Record<string, unknown> }>;
  updatedBy: string;
}): Promise<OnesProjectIssueTypeConfigRecord[]> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const keys = input.issueTypes.map((row) => row.key);

    if (keys.length === 0) {
      await client.query("DELETE FROM ones_project_issue_type_configs WHERE project_key = $1", [input.projectKey]);
      await client.query("COMMIT");
      return [];
    }

    await client.query(
      "DELETE FROM ones_project_issue_type_configs WHERE project_key = $1 AND NOT (issue_type_key = ANY($2::text[]))",
      [input.projectKey, keys]
    );

    const rows: OnesProjectIssueTypeConfigRecord[] = [];
    for (const row of input.issueTypes) {
      const result = await client.query<OnesProjectIssueTypeConfigRecord>(
        `INSERT INTO ones_project_issue_type_configs (
          id, project_key, issue_type_key, issue_type_name, enabled_for_customer, metadata_json, updated_by
        ) VALUES ($1,$2,$3,$4,FALSE,$5::jsonb,$6)
        ON CONFLICT (project_key, issue_type_key) DO UPDATE SET
          issue_type_name = EXCLUDED.issue_type_name,
          metadata_json = EXCLUDED.metadata_json,
          updated_by = EXCLUDED.updated_by,
          updated_at = NOW()
        RETURNING *`,
        [uuidv4(), input.projectKey, row.key, row.name, JSON.stringify(row.metadata ?? {}), input.updatedBy]
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

export async function addOnesSyncAudit(input: {
  actor: string;
  scope: string;
  eventType: string;
  payload: Record<string, unknown>;
}) {
  await pool.query(
    "INSERT INTO ones_sync_audit_logs (id, actor, scope, event_type, payload) VALUES ($1,$2,$3,$4,$5::jsonb)",
    [uuidv4(), input.actor, input.scope, input.eventType, JSON.stringify(input.payload)]
  );
}

export interface OnesWebhookEventRecord {
  id: string;
  external_event_id: string;
  event_type: string;
  ones_ticket_key: string | null;
  payload: Record<string, unknown>;
  signature: string | null;
  status: "received" | "processed" | "failed";
  error: string | null;
  retries: number;
  trace_id: string | null;
  received_at: string;
  processed_at: string | null;
}

export async function insertWebhookEvent(input: {
  externalEventId: string;
  eventType: string;
  onesTicketKey?: string | null;
  payload: Record<string, unknown>;
  signature?: string;
  traceId?: string;
}) {
  const result = await pool.query<OnesWebhookEventRecord>(
    `INSERT INTO ones_webhook_events (
      id, external_event_id, event_type, ones_ticket_key, payload, signature, status, trace_id
    ) VALUES ($1,$2,$3,$4,$5::jsonb,$6,'received',$7)
    ON CONFLICT (external_event_id, event_type, ones_ticket_key) DO UPDATE SET
      payload = EXCLUDED.payload
    RETURNING *`,
    [uuidv4(), input.externalEventId, input.eventType, input.onesTicketKey ?? null, JSON.stringify(input.payload), input.signature ?? null, input.traceId ?? null]
  );
  return result.rows[0];
}

export async function markWebhookProcessed(id: string) {
  await pool.query("UPDATE ones_webhook_events SET status = 'processed', processed_at = NOW(), error = NULL WHERE id = $1", [id]);
}

export async function markWebhookFailed(id: string, error: string) {
  await pool.query("UPDATE ones_webhook_events SET status = 'failed', retries = retries + 1, error = $2 WHERE id = $1", [id, error]);
}

export async function listFailedWebhookEvents(limit = 50): Promise<OnesWebhookEventRecord[]> {
  const result = await pool.query<OnesWebhookEventRecord>(
    "SELECT * FROM ones_webhook_events WHERE status = 'failed' ORDER BY received_at DESC LIMIT $1",
    [limit]
  );
  return result.rows;
}
