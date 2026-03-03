import { z } from "zod";
import { env } from "../../config/env.js";
import { decryptSecret, encryptSecret, maskSecret } from "../../utils/crypto.js";
import * as repo from "./repository.js";

const configInputSchema = z.object({
  profileName: z.string().min(1).default("default"),
  baseUrl: z.string().url(),
  authType: z.enum(["bearer", "header"]).default("bearer"),
  authHeader: z.string().min(1).default("Authorization"),
  authSecret: z.string().min(1),
  createTicketPath: z.string().min(1),
  listTicketTypesPath: z.string().min(1),
  listFieldsPathTemplate: z.string().min(1),
  timeoutMs: z.coerce.number().int().positive().max(60000).default(12000),
  retries: z.coerce.number().int().min(0).max(3).default(1),
  actor: z.string().min(1).default("internal_operator")
});

const mappingRowSchema = z.object({
  source: z.string().min(1),
  target: z.string().min(1),
  transform: z.enum(["none", "concat", "enumMap", "dateFormat", "constant", "fallback"]).default("none"),
  transformConfig: z.record(z.string(), z.any()).default({}),
  requiredPolicy: z.enum(["hard_fail", "default_value"]).default("hard_fail")
});

const saveMappingSchema = z.object({
  ticketTypeKey: z.string().min(1),
  flow: z.enum(["create", "update"]),
  mappings: z.array(mappingRowSchema).min(1),
  actor: z.string().min(1).default("internal_operator")
});

const publishSchema = z.object({
  mappingId: z.string().uuid(),
  actor: z.string().min(1).default("internal_operator")
});

const rollbackSchema = z.object({
  ticketTypeKey: z.string().min(1),
  flow: z.enum(["create", "update"]),
  actor: z.string().min(1).default("internal_operator")
});

function withPath(baseUrl: string, path: string) {
  const normalizedBase = baseUrl.replace(/\/$/, "");
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  return `${normalizedBase}${normalizedPath}`;
}

function buildAuthHeaders(config: repo.OnesSyncConfigRecord, token: string): Record<string, string> {
  if (config.auth_type === "bearer") {
    return {
      [config.auth_header]: token.startsWith("Bearer ") ? token : `Bearer ${token}`
    };
  }
  return { [config.auth_header]: token };
}

async function onesFetch(config: repo.OnesSyncConfigRecord, path: string, init?: RequestInit) {
  const token = decryptSecret(config.auth_secret_encrypted);
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...buildAuthHeaders(config, token),
    ...(init?.headers as Record<string, string> | undefined)
  };
  const url = withPath(config.base_url, path);

  let lastError: Error | null = null;
  for (let attempt = 0; attempt <= config.retries; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.timeout_ms);
    try {
      const response = await fetch(url, { ...init, headers, signal: controller.signal });
      clearTimeout(timer);
      if (!response.ok) {
        const body = await response.text();
        throw new Error(`ONES ${response.status}: ${body || "request failed"}`);
      }
      return response;
    } catch (error) {
      clearTimeout(timer);
      lastError = error as Error;
    }
  }
  throw lastError ?? new Error("ONES request failed");
}

function parseTicketTypes(raw: unknown): Array<{ key: string; name: string; source: Record<string, unknown> }> {
  if (Array.isArray(raw)) {
    return raw
      .map((row) => row as Record<string, unknown>)
      .map((row) => ({
        key: String(row.key ?? row.id ?? row.uuid ?? ""),
        name: String(row.name ?? row.title ?? row.key ?? row.id ?? ""),
        source: row
      }))
      .filter((row) => row.key.length > 0);
  }
  const envelope = raw as Record<string, unknown>;
  const list = envelope.ticketTypes ?? envelope.types ?? envelope.data;
  return parseTicketTypes(list);
}

function parseFields(raw: unknown): unknown[] {
  if (Array.isArray(raw)) return raw;
  const envelope = raw as Record<string, unknown>;
  const list = envelope.fields ?? envelope.data ?? [];
  return Array.isArray(list) ? list : [];
}

function resolveSource(path: string, context: Record<string, unknown>): unknown {
  const normalized = path.replace(/^ticket\./, "").replace(/^customer\./, "customer.");
  const keys = normalized.split(".");
  let current: unknown = context;
  for (const key of keys) {
    if (current && typeof current === "object" && key in (current as Record<string, unknown>)) {
      current = (current as Record<string, unknown>)[key];
    } else {
      return undefined;
    }
  }
  return current;
}

function applyTransform(
  sourceValue: unknown,
  transform: z.infer<typeof mappingRowSchema>["transform"],
  config: Record<string, unknown>
) {
  if (transform === "constant") return config.value ?? "";
  if (transform === "fallback") return sourceValue ?? config.default ?? "";
  if (transform === "concat") {
    const prefix = String(config.prefix ?? "");
    const suffix = String(config.suffix ?? "");
    return `${prefix}${String(sourceValue ?? "")}${suffix}`;
  }
  if (transform === "dateFormat") {
    const value = sourceValue ? new Date(String(sourceValue)) : null;
    if (!value || Number.isNaN(value.getTime())) return config.default ?? "";
    return value.toISOString();
  }
  if (transform === "enumMap") {
    const map = (config.map ?? {}) as Record<string, unknown>;
    const key = String(sourceValue ?? "");
    return map[key] ?? config.default ?? sourceValue ?? "";
  }
  return sourceValue;
}

function buildPayloadFromMapping(
  mapping: Array<z.infer<typeof mappingRowSchema>>,
  context: Record<string, unknown>
): { payload: Record<string, unknown>; errors: string[] } {
  const payload: Record<string, unknown> = {};
  const errors: string[] = [];
  for (const row of mapping) {
    const source = resolveSource(row.source, context);
    const transformed = applyTransform(source, row.transform, row.transformConfig);
    const hasValue = transformed !== undefined && transformed !== null && String(transformed).length > 0;
    if (!hasValue && row.requiredPolicy === "hard_fail") {
      errors.push(`Missing value for source ${row.source} -> target ${row.target}`);
      continue;
    }
    payload[row.target] = hasValue ? transformed : row.transformConfig.default ?? "";
  }
  return { payload, errors };
}

export async function getConfig() {
  const config = await repo.getActiveConfig();
  if (!config) {
    return null;
  }
  return {
    id: config.id,
    profileName: config.profile_name,
    baseUrl: config.base_url,
    authType: config.auth_type,
    authHeader: config.auth_header,
    authSecretMasked: maskSecret(decryptSecret(config.auth_secret_encrypted)),
    createTicketPath: config.create_ticket_path,
    listTicketTypesPath: config.list_ticket_types_path,
    listFieldsPathTemplate: config.list_fields_path_template,
    timeoutMs: config.timeout_ms,
    retries: config.retries,
    updatedBy: config.updated_by,
    updatedAt: config.updated_at
  };
}

export async function upsertConfig(input: unknown) {
  const parsed = configInputSchema.parse(input);
  const saved = await repo.upsertActiveConfig({
    profileName: parsed.profileName,
    baseUrl: parsed.baseUrl,
    authType: parsed.authType,
    authHeader: parsed.authHeader,
    authSecretEncrypted: encryptSecret(parsed.authSecret),
    createTicketPath: parsed.createTicketPath,
    listTicketTypesPath: parsed.listTicketTypesPath,
    listFieldsPathTemplate: parsed.listFieldsPathTemplate,
    timeoutMs: parsed.timeoutMs,
    retries: parsed.retries,
    updatedBy: parsed.actor
  });
  await repo.addOnesSyncAudit({
    actor: parsed.actor,
    scope: "config",
    eventType: "config_updated",
    payload: { profileName: parsed.profileName, baseUrl: parsed.baseUrl }
  });
  return {
    id: saved.id,
    profileName: saved.profile_name,
    baseUrl: saved.base_url,
    authType: saved.auth_type,
    authHeader: saved.auth_header,
    authSecretMasked: maskSecret(parsed.authSecret),
    createTicketPath: saved.create_ticket_path,
    listTicketTypesPath: saved.list_ticket_types_path,
    listFieldsPathTemplate: saved.list_fields_path_template,
    timeoutMs: saved.timeout_ms,
    retries: saved.retries,
    updatedBy: saved.updated_by,
    updatedAt: saved.updated_at
  };
}

export async function discoverTicketTypes(actor = "internal_operator") {
  const config = await repo.getActiveConfig();
  if (!config) {
    throw new Error("ONES sync config not set");
  }
  const typesRaw = await onesFetch(config, config.list_ticket_types_path).then((res) => res.json());
  const ticketTypes = parseTicketTypes(typesRaw);
  const rows: Array<{ key: string; name: string; fields: unknown[]; source: Record<string, unknown> }> = [];

  for (const type of ticketTypes) {
    const fieldsPath = config.list_fields_path_template.replace("{ticketTypeKey}", encodeURIComponent(type.key));
    let fields: unknown[] = [];
    try {
      const fieldsRaw = await onesFetch(config, fieldsPath).then((res) => res.json());
      fields = parseFields(fieldsRaw);
    } catch {
      fields = [];
    }
    rows.push({ key: type.key, name: type.name, fields, source: type.source });
  }
  await repo.upsertTicketTypeCache(rows);
  await repo.addOnesSyncAudit({
    actor,
    scope: "ticket_types",
    eventType: "discover_ticket_types",
    payload: { count: rows.length }
  });
  return rows;
}

export async function listTicketTypes() {
  const rows = await repo.listTicketTypeCache();
  return rows.map((row) => ({
    key: row.type_key,
    name: row.type_name,
    fields: row.fields_json,
    syncedAt: row.synced_at
  }));
}

export async function saveDraftMapping(input: unknown) {
  const parsed = saveMappingSchema.parse(input);
  const validation = validateMappingRows(parsed.mappings);
  const saved = await repo.saveDraftMapping({
    ticketTypeKey: parsed.ticketTypeKey,
    flow: parsed.flow,
    mapping: parsed.mappings,
    validation,
    createdBy: parsed.actor
  });
  await repo.addOnesSyncAudit({
    actor: parsed.actor,
    scope: "mapping",
    eventType: "mapping_draft_saved",
    payload: { ticketTypeKey: parsed.ticketTypeKey, flow: parsed.flow, version: saved.version }
  });
  return saved;
}

export async function listMappings(ticketTypeKey: string, flow: "create" | "update") {
  return repo.listMappings(ticketTypeKey, flow);
}

export function validateMappingRows(rows: Array<z.infer<typeof mappingRowSchema>>) {
  const errors: string[] = [];
  const seenTargets = new Set<string>();
  for (const row of rows) {
    if (seenTargets.has(row.target)) {
      errors.push(`Duplicate target field: ${row.target}`);
    }
    seenTargets.add(row.target);
  }
  return {
    valid: errors.length === 0,
    errors
  };
}

export async function dryRunMapping(input: {
  ticketTypeKey: string;
  flow: "create" | "update";
  mappings: Array<z.infer<typeof mappingRowSchema>>;
  sampleContext: Record<string, unknown>;
}) {
  const mappingValidation = validateMappingRows(input.mappings);
  if (!mappingValidation.valid) {
    return { valid: false, errors: mappingValidation.errors, payload: {} };
  }
  const built = buildPayloadFromMapping(input.mappings, input.sampleContext);
  return {
    valid: built.errors.length === 0,
    errors: built.errors,
    payload: built.payload
  };
}

export async function publishMapping(input: unknown) {
  const parsed = publishSchema.parse(input);
  const active = await repo.activateMapping(parsed.mappingId);
  await repo.addOnesSyncAudit({
    actor: parsed.actor,
    scope: "mapping",
    eventType: "mapping_published",
    payload: { mappingId: parsed.mappingId, ticketTypeKey: active.ticket_type_key, flow: active.flow, version: active.version }
  });
  return active;
}

export async function rollbackMapping(input: unknown) {
  const parsed = rollbackSchema.parse(input);
  const active = await repo.rollbackActiveMapping(parsed.ticketTypeKey, parsed.flow);
  await repo.addOnesSyncAudit({
    actor: parsed.actor,
    scope: "mapping",
    eventType: "mapping_rolled_back",
    payload: { ticketTypeKey: parsed.ticketTypeKey, flow: parsed.flow, version: active.version }
  });
  return active;
}

export async function createOnesTicket(input: {
  ticketTypeKey: string;
  context: Record<string, unknown>;
}): Promise<{ key: string; raw: Record<string, unknown> }> {
  const config = await repo.getActiveConfig();
  if (!config) {
    throw new Error("ONES sync config not set");
  }
  const activeMapping = await repo.getLatestMapping(input.ticketTypeKey, "create", "active");
  const mappingRows = (activeMapping?.mapping_json ?? []) as Array<z.infer<typeof mappingRowSchema>>;
  const fallbackMapping: Array<z.infer<typeof mappingRowSchema>> = [
    { source: "title", target: "title", transform: "none", transformConfig: {}, requiredPolicy: "hard_fail" },
    { source: "description", target: "description", transform: "none", transformConfig: {}, requiredPolicy: "hard_fail" },
    { source: "customer.name", target: "requester_name", transform: "none", transformConfig: {}, requiredPolicy: "default_value" }
  ];
  const built = buildPayloadFromMapping(mappingRows.length ? mappingRows : fallbackMapping, input.context);
  if (built.errors.length) {
    throw new Error(`ONES mapping validation failed: ${built.errors.join("; ")}`);
  }

  const requestBody = {
    ticketTypeKey: input.ticketTypeKey,
    fields: built.payload
  };
  const raw = await onesFetch(config, config.create_ticket_path, {
    method: "POST",
    body: JSON.stringify(requestBody)
  }).then((res) => res.json()) as Record<string, unknown>;

  const key = String(raw.key ?? raw.ticketKey ?? raw.id ?? "");
  if (!key) {
    throw new Error("ONES create ticket response missing key");
  }
  return { key, raw };
}

export async function bootstrapDefaultConfigIfMissing() {
  const existing = await repo.getActiveConfig();
  if (existing) return;
  await repo.upsertActiveConfig({
    profileName: "default",
    baseUrl: env.ONES_SYNC_DEFAULT_BASE_URL,
    authType: "bearer",
    authHeader: "Authorization",
    authSecretEncrypted: encryptSecret(""),
    createTicketPath: env.ONES_SYNC_DEFAULT_CREATE_TICKET_PATH,
    listTicketTypesPath: env.ONES_SYNC_DEFAULT_TICKET_TYPES_PATH,
    listFieldsPathTemplate: env.ONES_SYNC_DEFAULT_FIELDS_PATH_TEMPLATE,
    timeoutMs: 12000,
    retries: 1,
    updatedBy: "bootstrap"
  });
}
