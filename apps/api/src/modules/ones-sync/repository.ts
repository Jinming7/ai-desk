import { v4 as uuidv4 } from "uuid";
import { pool } from "../../db/client.js";

export interface OnesSyncConfigRecord {
  id: string;
  profile_name: string;
  base_url: string;
  auth_type: "bearer" | "header";
  auth_header: string;
  auth_secret_encrypted: string;
  create_ticket_path: string;
  list_projects_path: string;
  list_ticket_types_path: string;
  list_fields_path_template: string;
  timeout_ms: number;
  retries: number;
  data_source_mode: "ones_primary" | "local_mirror";
  ones_project_key: string | null;
  schema_hash: string | null;
  schema_synced_at: string | null;
  is_active: boolean;
  updated_by: string;
  updated_at: string;
  created_at: string;
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

export async function getActiveConfig(): Promise<OnesSyncConfigRecord | null> {
  const result = await pool.query<OnesSyncConfigRecord>(
    "SELECT * FROM ones_sync_config WHERE is_active = true ORDER BY updated_at DESC LIMIT 1"
  );
  return result.rows[0] ?? null;
}

export async function upsertActiveConfig(input: {
  profileName: string;
  baseUrl: string;
  authType: "bearer" | "header";
  authHeader: string;
  authSecretEncrypted: string;
  createTicketPath: string;
  listProjectsPath: string;
  listTicketTypesPath: string;
  listFieldsPathTemplate: string;
  timeoutMs: number;
  retries: number;
  dataSourceMode: "ones_primary" | "local_mirror";
  onesProjectKey?: string | null;
  schemaHash?: string | null;
  schemaSyncedAt?: string | null;
  updatedBy: string;
}): Promise<OnesSyncConfigRecord> {
  await pool.query("UPDATE ones_sync_config SET is_active = false WHERE is_active = true");
  const id = uuidv4();
  const result = await pool.query<OnesSyncConfigRecord>(
    `INSERT INTO ones_sync_config (
      id, profile_name, base_url, auth_type, auth_header, auth_secret_encrypted,
      create_ticket_path, list_projects_path, list_ticket_types_path, list_fields_path_template,
      timeout_ms, retries, data_source_mode, ones_project_key, schema_hash, schema_synced_at, is_active, updated_by
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,true,$17)
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
      input.schemaHash ?? null,
      input.schemaSyncedAt ?? null,
      input.updatedBy
    ]
  );
  return result.rows[0];
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
