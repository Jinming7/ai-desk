import { z } from "zod";
import { createHash } from "node:crypto";
import { env } from "../../config/env.js";
import { decryptSecret, encryptSecret, maskSecret } from "../../utils/crypto.js";
import * as repo from "./repository.js";
import * as ticketsRepo from "../tickets/repository.js";

const configInputSchema = z.object({
  profileName: z.string().min(1).default("default"),
  baseUrl: z.string().url(),
  authType: z.enum(["bearer", "header"]).default("bearer"),
  authHeader: z.string().min(1).default("Authorization"),
  authSecret: z.string().min(1).optional(),
  keepExistingSecret: z.coerce.boolean().default(false),
  createTicketPath: z.string().min(1),
  listProjectsPath: z.string().min(1).default("/api/v1/projects"),
  listTicketTypesPath: z.string().min(1),
  listFieldsPathTemplate: z.string().min(1),
  endpointTemplates: z.record(z.string(), z.string()).default({}),
  allowedTicketTypeKeys: z.array(z.string().min(1)).default([]),
  statusMapping: z.record(z.string(), z.string()).default({}),
  workflowMapping: z.record(z.string(), z.string()).default({}),
  publishState: z.enum(["draft", "published"]).default("draft"),
  publishChecks: z.record(z.string(), z.unknown()).default({}),
  changeReason: z.string().max(500).optional(),
  timeoutMs: z.coerce.number().int().positive().max(60000).default(12000),
  retries: z.coerce.number().int().min(0).max(3).default(1),
  dataSourceMode: z.enum(["ones_primary", "local_mirror"]).default("ones_primary"),
  onesProjectKey: z.string().optional(),
  onesTeamId: z.string().optional(),
  actor: z.string().min(1).default("internal_operator")
});

const endpointTemplateDefaults = {
  listProjectsPath: "/project/projects",
  listIssueTypesPath: "/project/issueTypes",
  listIssueFieldsPath: "/project/issueFields",
  listIssueStatusesPath: "/project/issueStatuses",
  listIssuesPath: "/project/issues",
  getIssuePathTemplate: "/project/issues/{issueID}",
  createIssuePath: "/project/issues",
  updateIssuePathTemplate: "/project/issues/{issueID}",
  deleteIssuePathTemplate: "/project/issues/{issueID}",
  listIssueWorkflowsPathTemplate: "/project/issues/{issueID}/workflows",
  executeIssueWorkflowPathTemplate: "/project/issues/{issueID}",
  listCommentsPathTemplate: "/project/issues/{issueID}/comments",
  getCommentPathTemplate: "/project/issues/{issueID}/comments/{commentsID}",
  addCommentPathTemplate: "/project/issues/{issueID}/comments",
  updateCommentPathTemplate: "/project/issues/{issueID}/comments/{commentsID}",
  deleteCommentPathTemplate: "/project/issues/{issueID}/comments/{commentsID}"
} as const;

const mappingRowSchema = z.object({
  source: z.string().min(1),
  target: z.string().min(1),
  transform: z.enum(["none", "concat", "enumMap", "dateFormat", "constant", "fallback"]).default("none"),
  transformConfig: z.record(z.string(), z.any()).default({}),
  requiredPolicy: z.enum(["hard_fail", "default_value"]).default("hard_fail")
});

const saveMappingSchema = z.object({
  ticketTypeKey: z.string().min(1),
  flow: z.enum(["create", "update", "transition", "comment"]),
  mappings: z.array(mappingRowSchema).min(1),
  actor: z.string().min(1).default("internal_operator")
});

const publishSchema = z.object({
  mappingId: z.string().uuid(),
  actor: z.string().min(1).default("internal_operator")
});

const rollbackSchema = z.object({
  ticketTypeKey: z.string().min(1),
  flow: z.enum(["create", "update", "transition", "comment"]),
  actor: z.string().min(1).default("internal_operator")
});

const webhookInputSchema = z.object({
  eventId: z.string().min(1),
  eventType: z.string().min(1),
  ticketKey: z.string().optional(),
  traceId: z.string().optional(),
  payload: z.record(z.string(), z.any()),
  signature: z.string().optional()
});

function withPath(baseUrl: string, path: string) {
  if (/^https?:\/\//i.test(path)) {
    return path;
  }

  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  const base = new URL(baseUrl);
  const basePath = base.pathname.replace(/\/$/, "");
  const baseHasOpenApiPrefix = /\/openapi\/v\d+$/i.test(basePath);
  const shouldInjectOpenApiPrefix = !baseHasOpenApiPrefix && normalizedPath.startsWith("/project/");
  const effectiveBasePath = shouldInjectOpenApiPrefix ? "/openapi/v2" : (basePath || "");
  const finalPath = `${effectiveBasePath}${normalizedPath}`.replace(/\/{2,}/g, "/");
  return `${base.origin}${finalPath}`;
}

function buildAuthHeaders(config: repo.OnesSyncConfigRecord, token: string): Record<string, string> {
  const normalizedToken = token.trim();
  const requiresBearer = config.auth_type === "bearer" || config.auth_header.toLowerCase() === "authorization";
  if (requiresBearer) {
    return {
      [config.auth_header]: normalizedToken.startsWith("Bearer ") ? normalizedToken : `Bearer ${normalizedToken}`
    };
  }
  return { [config.auth_header]: normalizedToken };
}

function buildAuthHeadersFromInput(input: { authType: "bearer" | "header"; authHeader: string; authSecret: string }) {
  const normalizedToken = input.authSecret.trim();
  const requiresBearer = input.authType === "bearer" || input.authHeader.toLowerCase() === "authorization";
  if (requiresBearer) {
    return {
      [input.authHeader]: normalizedToken.startsWith("Bearer ") ? normalizedToken : `Bearer ${normalizedToken}`
    };
  }
  return { [input.authHeader]: normalizedToken };
}

async function onesFetch(config: repo.OnesSyncConfigRecord, path: string, init?: RequestInit) {
  const token = decryptSecret(config.auth_secret_encrypted);
  const headers: Record<string, string> = {
    Accept: "application/json",
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
        const retriable = response.status === 429 || response.status >= 500;
        if (retriable && attempt < config.retries) {
          const backoffMs = Math.min(2000, 200 * Math.pow(2, attempt));
          await new Promise((resolve) => setTimeout(resolve, backoffMs));
          continue;
        }
        throw new Error(`ONES ${response.status}: ${body || "request failed"}`);
      }
      return response;
    } catch (error) {
      clearTimeout(timer);
      lastError = error as Error;
      if (attempt < config.retries) {
        const backoffMs = Math.min(2000, 200 * Math.pow(2, attempt));
        await new Promise((resolve) => setTimeout(resolve, backoffMs));
      }
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

function parseIssueStatuses(raw: unknown): Array<{ key: string; name: string; source: Record<string, unknown> }> {
  if (Array.isArray(raw)) {
    return raw
      .map((row) => row as Record<string, unknown>)
      .map((row) => ({
        key: String(row.key ?? row.id ?? row.statusID ?? row.uuid ?? ""),
        name: String(row.name ?? row.title ?? row.key ?? row.id ?? ""),
        source: row
      }))
      .filter((row) => row.key.length > 0);
  }
  const envelope = raw as Record<string, unknown>;
  const list = envelope.statuses ?? envelope.items ?? envelope.data;
  return parseIssueStatuses(list);
}

function resolveEndpointTemplates(config: repo.OnesSyncConfigRecord): Record<string, string> {
  return {
    ...endpointTemplateDefaults,
    ...(config.endpoint_templates_json ?? {})
  };
}

function resolvePathTemplate(
  rawPath: string,
  ctx: { teamId?: string | null; projectKey?: string | null; ticketTypeKey?: string | null }
) {
  let path = rawPath;
  const hasTeamPlaceholder = path.includes("{team_id}") || path.includes("{teamID}");
  const hasProjectPlaceholder = path.includes("{project_key}") || path.includes("{projectID}");
  if (path.includes("{team_id}")) {
    if (!ctx.teamId) throw new Error("Missing required onesTeamId for path template {team_id}");
    path = path.replaceAll("{team_id}", encodeURIComponent(ctx.teamId));
  }
  if (path.includes("{teamID}")) {
    if (!ctx.teamId) throw new Error("Missing required onesTeamId for path template {teamID}");
    path = path.replaceAll("{teamID}", encodeURIComponent(ctx.teamId));
  }
  if (path.includes("{project_key}")) {
    if (!ctx.projectKey) throw new Error("Missing required onesProjectKey for path template {project_key}");
    path = path.replaceAll("{project_key}", encodeURIComponent(ctx.projectKey));
  }
  if (path.includes("{projectID}")) {
    if (!ctx.projectKey) throw new Error("Missing required onesProjectKey for path template {projectID}");
    path = path.replaceAll("{projectID}", encodeURIComponent(ctx.projectKey));
  }
  if (path.includes("{ticketTypeKey}")) {
    if (!ctx.ticketTypeKey) throw new Error("Missing required ticketTypeKey for path template {ticketTypeKey}");
    path = path.replaceAll("{ticketTypeKey}", encodeURIComponent(ctx.ticketTypeKey));
  }
  if (hasTeamPlaceholder && !ctx.teamId) {
    throw new Error("Missing required onesTeamId for team placeholder");
  }
  if (hasProjectPlaceholder && !ctx.projectKey) {
    throw new Error("Missing required onesProjectKey for project placeholder");
  }
  return path;
}

function parseProjects(raw: unknown): Array<{ key: string; name: string }> {
  if (Array.isArray(raw)) {
    return raw
      .map((row) => row as Record<string, unknown>)
      .map((row) => ({
        key: String(row.key ?? row.uuid ?? row.id ?? ""),
        name: String(row.name ?? row.title ?? row.key ?? row.id ?? "")
      }))
      .filter((row) => row.key);
  }
  const envelope = raw as Record<string, unknown>;
  return parseProjects(envelope.projects ?? envelope.data ?? envelope.items ?? []);
}

function parseProjectDiscoveryPage(raw: unknown): { projects: Array<{ key: string; name: string }>; nextCursor: string | null } {
  const envelope = raw as Record<string, unknown>;
  const data = (envelope.data ?? envelope.result ?? envelope) as Record<string, unknown>;
  const projects = parseProjects(
    data.projects ??
      data.items ??
      data.list ??
      envelope.projects ??
      envelope.items ??
      envelope.list ??
      data
  );
  const cursorCandidate =
    data.nextCursor ??
    data.next_cursor ??
    data.cursor ??
    envelope.nextCursor ??
    envelope.next_cursor ??
    envelope.cursor;
  return {
    projects,
    nextCursor: typeof cursorCandidate === "string" && cursorCandidate.length > 0 ? cursorCandidate : null
  };
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
    listProjectsPath: config.list_projects_path,
    listTicketTypesPath: config.list_ticket_types_path,
    listFieldsPathTemplate: config.list_fields_path_template,
    endpointTemplates: resolveEndpointTemplates(config),
    allowedTicketTypeKeys: config.allowed_ticket_type_keys ?? [],
    statusMapping: config.status_mapping_json ?? {},
    workflowMapping: config.workflow_mapping_json ?? {},
    configVersion: config.config_version ?? 1,
    publishState: config.publish_state ?? "draft",
    publishChecks: config.publish_checks_json ?? {},
    changeReason: config.change_reason,
    rolledBackFrom: config.rolled_back_from,
    timeoutMs: config.timeout_ms,
    retries: config.retries,
    dataSourceMode: config.data_source_mode,
    onesProjectKey: config.ones_project_key,
    onesTeamId: config.ones_team_id,
    schemaHash: config.schema_hash,
    schemaSyncedAt: config.schema_synced_at,
    updatedBy: config.updated_by,
    updatedAt: config.updated_at
  };
}

export async function upsertConfig(input: unknown) {
  const parsed = configInputSchema.parse(input);
  const existing = await repo.getActiveConfig();
  const resolvedSecret =
    parsed.keepExistingSecret && existing
      ? decryptSecret(existing.auth_secret_encrypted)
      : (parsed.authSecret ?? "");
  if (!resolvedSecret) {
    throw new Error("Auth Secret is required when no existing token is available.");
  }
  const saved = await repo.upsertActiveConfig({
    profileName: parsed.profileName,
    baseUrl: parsed.baseUrl,
    authType: parsed.authType,
    authHeader: parsed.authHeader,
    authSecretEncrypted: encryptSecret(resolvedSecret),
    createTicketPath: parsed.createTicketPath,
    listProjectsPath: parsed.listProjectsPath,
    listTicketTypesPath: parsed.listTicketTypesPath,
    listFieldsPathTemplate: parsed.listFieldsPathTemplate,
    endpointTemplates: parsed.endpointTemplates,
    allowedTicketTypeKeys: parsed.allowedTicketTypeKeys,
    statusMapping: parsed.statusMapping,
    workflowMapping: parsed.workflowMapping,
    publishState: parsed.publishState,
    publishChecks: parsed.publishChecks,
    changeReason: parsed.changeReason ?? null,
    timeoutMs: parsed.timeoutMs,
    retries: parsed.retries,
    dataSourceMode: parsed.dataSourceMode,
    onesProjectKey: parsed.onesProjectKey,
    onesTeamId: parsed.onesTeamId,
    updatedBy: parsed.actor
  });
  await repo.addOnesSyncAudit({
    actor: parsed.actor,
    scope: "config",
    eventType: "config_updated",
    payload: {
      profileName: parsed.profileName,
      baseUrl: parsed.baseUrl,
      keepExistingSecret: parsed.keepExistingSecret,
      allowedTicketTypeKeys: parsed.allowedTicketTypeKeys,
      publishState: parsed.publishState,
      changeReason: parsed.changeReason ?? null
    }
  });
  return {
    id: saved.id,
    profileName: saved.profile_name,
    baseUrl: saved.base_url,
    authType: saved.auth_type,
    authHeader: saved.auth_header,
    authSecretMasked: maskSecret(resolvedSecret),
    createTicketPath: saved.create_ticket_path,
    listProjectsPath: saved.list_projects_path,
    listTicketTypesPath: saved.list_ticket_types_path,
    listFieldsPathTemplate: saved.list_fields_path_template,
    endpointTemplates: resolveEndpointTemplates(saved),
    allowedTicketTypeKeys: saved.allowed_ticket_type_keys ?? [],
    statusMapping: saved.status_mapping_json ?? {},
    workflowMapping: saved.workflow_mapping_json ?? {},
    configVersion: saved.config_version ?? 1,
    publishState: saved.publish_state ?? "draft",
    publishChecks: saved.publish_checks_json ?? {},
    changeReason: saved.change_reason,
    rolledBackFrom: saved.rolled_back_from,
    timeoutMs: saved.timeout_ms,
    retries: saved.retries,
    dataSourceMode: saved.data_source_mode,
    onesProjectKey: saved.ones_project_key,
    onesTeamId: saved.ones_team_id,
    schemaHash: saved.schema_hash,
    schemaSyncedAt: saved.schema_synced_at,
    updatedBy: saved.updated_by,
    updatedAt: saved.updated_at
  };
}

export async function discoverTicketTypes(actor = "internal_operator") {
  const config = await repo.getActiveConfig();
  if (!config) {
    throw new Error("ONES sync config not set");
  }
  const endpoints = resolveEndpointTemplates(config);
  const typesPath = resolvePathTemplate(endpoints.listIssueTypesPath ?? config.list_ticket_types_path, {
    teamId: config.ones_team_id,
    projectKey: config.ones_project_key
  });
  const typesRaw = await onesFetch(config, typesPath).then((res) => res.json());
  const ticketTypes = parseTicketTypes(typesRaw);
  const rows: Array<{ key: string; name: string; fields: unknown[]; source: Record<string, unknown> }> = [];

  for (const type of ticketTypes) {
    const fieldsPath = resolvePathTemplate(endpoints.listIssueFieldsPath ?? config.list_fields_path_template, {
      teamId: config.ones_team_id,
      projectKey: config.ones_project_key,
      ticketTypeKey: type.key
    });
    let fields: unknown[] = [];
    try {
      const fieldsRaw = await onesFetch(config, fieldsPath).then((res) => res.json());
      fields = parseFields(fieldsRaw);
    } catch {
      fields = [];
    }
    rows.push({ key: type.key, name: type.name, fields, source: type.source });
  }
  const schemaHash = createHash("sha256").update(JSON.stringify(rows.map((r) => ({ key: r.key, fields: r.fields })))).digest("hex");
  await repo.upsertTicketTypeCache(rows);
  await repo.upsertActiveConfig({
    profileName: config.profile_name,
    baseUrl: config.base_url,
    authType: config.auth_type,
    authHeader: config.auth_header,
    authSecretEncrypted: config.auth_secret_encrypted,
    createTicketPath: config.create_ticket_path,
    listProjectsPath: config.list_projects_path,
    listTicketTypesPath: config.list_ticket_types_path,
    listFieldsPathTemplate: config.list_fields_path_template,
    endpointTemplates: config.endpoint_templates_json ?? {},
    allowedTicketTypeKeys: config.allowed_ticket_type_keys ?? [],
    statusMapping: config.status_mapping_json ?? {},
    workflowMapping: config.workflow_mapping_json ?? {},
    publishState: config.publish_state ?? "draft",
    publishChecks: config.publish_checks_json ?? {},
    changeReason: config.change_reason,
    rolledBackFrom: config.rolled_back_from,
    timeoutMs: config.timeout_ms,
    retries: config.retries,
    dataSourceMode: config.data_source_mode,
    onesProjectKey: config.ones_project_key,
    onesTeamId: config.ones_team_id,
    schemaHash,
    schemaSyncedAt: new Date().toISOString(),
    updatedBy: actor
  });
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

export async function listCustomerTicketTypes() {
  const [rows, config] = await Promise.all([repo.listTicketTypeCache(), repo.getActiveConfig()]);
  const allowed = new Set((config?.allowed_ticket_type_keys ?? []).map(String));
  const filtered = rows.filter((row) => allowed.has(row.type_key));
  return filtered.map((row) => ({
    key: row.type_key,
    name: row.type_name,
    fields: row.fields_json,
    syncedAt: row.synced_at
  }));
}

export async function isCustomerTicketTypeAllowed(ticketTypeKey: string): Promise<boolean> {
  const config = await repo.getActiveConfig();
  const allowed = new Set((config?.allowed_ticket_type_keys ?? []).map(String));
  if (allowed.size === 0) return false;
  return allowed.has(ticketTypeKey);
}

export async function discoverIssueStatuses(input: {
  teamId?: string;
  projectKey?: string;
}) {
  const config = await repo.getActiveConfig();
  if (!config) throw new Error("ONES sync config not set");
  const endpoints = resolveEndpointTemplates(config);
  const path = resolvePathTemplate(endpoints.listIssueStatusesPath ?? "/project/issueStatuses", {
    teamId: input.teamId ?? config.ones_team_id,
    projectKey: input.projectKey ?? config.ones_project_key
  });
  const raw = await onesFetch(config, path).then((res) => res.json());
  return parseIssueStatuses(raw);
}

export async function discoverProjects(input: unknown) {
  const parsed = z.object({
    baseUrl: z.string().url(),
    authType: z.enum(["bearer", "header"]),
    authHeader: z.string().min(1),
    authSecret: z.string().min(1).optional(),
    keepExistingSecret: z.coerce.boolean().default(false),
    teamId: z.string().min(1),
    limit: z.coerce.number().int().positive().max(100).default(50),
    cursor: z.string().optional(),
    listProjectsPath: z.string().min(1).default("/openapi/v2/project/projects"),
    timeoutMs: z.coerce.number().int().positive().max(60000).default(15000)
  }).parse(input);
  const existing = await repo.getActiveConfig();
  const resolvedSecret =
    parsed.keepExistingSecret && existing
      ? decryptSecret(existing.auth_secret_encrypted)
      : (parsed.authSecret ?? "");
  if (!resolvedSecret) {
    throw new Error("Auth Secret is required for project discovery.");
  }

  const headers: Record<string, string> = {
    Accept: "application/json",
    "Content-Type": "application/json",
    ...buildAuthHeadersFromInput({ ...parsed, authSecret: resolvedSecret })
  };
  let requestUrl = "";
  try {
    const pathWithTeam = resolvePathTemplate(parsed.listProjectsPath, { teamId: parsed.teamId });
    const url = new URL(withPath(parsed.baseUrl, pathWithTeam));
    const hasTeamPlaceholder = parsed.listProjectsPath.includes("{team_id}") || parsed.listProjectsPath.includes("{teamID}");
    if (!hasTeamPlaceholder && !url.searchParams.has("team_id") && !url.searchParams.has("teamID")) {
      url.searchParams.set("teamID", parsed.teamId);
    }
    url.searchParams.set("limit", String(parsed.limit));
    if (parsed.cursor) url.searchParams.set("cursor", parsed.cursor);
    requestUrl = url.toString();
    let lastError: Error | null = null;
    for (let attempt = 0; attempt <= 1; attempt += 1) {
      const attemptTimeout = attempt === 0 ? parsed.timeoutMs : Math.min(30000, parsed.timeoutMs * 2);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), attemptTimeout);
      try {
        const res = await fetch(requestUrl, { headers, signal: controller.signal });
        clearTimeout(timer);
        if (!res.ok) {
          throw new Error(`ONES ${res.status}: ${await res.text()}`);
        }
        const raw = await res.json();
        return parseProjectDiscoveryPage(raw);
      } catch (error) {
        clearTimeout(timer);
        lastError = error as Error;
        const message = lastError.message || "";
        const isRetryableNetworkError = message.includes("fetch failed") || message.includes("ConnectTimeoutError") || message.includes("aborted");
        if (!isRetryableNetworkError || attempt === 1) {
          throw lastError;
        }
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }
    throw lastError ?? new Error("discover projects failed");
  } catch (error) {
    const message = error instanceof Error ? error.message : "request failed";
    const cause = error && typeof error === "object" && "cause" in error ? String((error as { cause: unknown }).cause) : "";
    console.error("[ones-sync][discover-projects] failed", {
      requestUrl,
      teamId: parsed.teamId,
      authType: parsed.authType,
      authHeader: parsed.authHeader,
      timeoutMs: parsed.timeoutMs,
      message,
      cause
    });
    throw new Error(`Project discovery failed: ${message}${cause ? ` | cause: ${cause}` : ""}${requestUrl ? ` | url: ${requestUrl}` : ""}`);
  }
}

export async function testEndpoint(input: unknown) {
  const parsed = z.object({
    baseUrl: z.string().url(),
    authType: z.enum(["bearer", "header"]),
    authHeader: z.string().min(1),
    authSecret: z.string().min(1).optional(),
    keepExistingSecret: z.coerce.boolean().default(false),
    method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]).default("GET"),
    path: z.string().min(1),
    body: z.unknown().optional(),
    customHeaders: z.record(z.string(), z.string()).optional(),
    timeoutMs: z.coerce.number().int().positive().max(60000).default(15000)
  }).parse(input);

  const existing = await repo.getActiveConfig();
  const resolvedSecret =
    parsed.keepExistingSecret && existing
      ? decryptSecret(existing.auth_secret_encrypted)
      : (parsed.authSecret ?? "");
  if (!resolvedSecret) {
    throw new Error("Auth Secret is required for endpoint test.");
  }

  const headers: Record<string, string> = {
    Accept: "application/json",
    "Content-Type": "application/json",
    ...buildAuthHeadersFromInput({ authType: parsed.authType, authHeader: parsed.authHeader, authSecret: resolvedSecret }),
    ...(parsed.customHeaders ?? {})
  };

  const url = withPath(parsed.baseUrl, parsed.path);
  const controller = new AbortController();
  const startedAt = Date.now();
  const timer = setTimeout(() => controller.abort(), parsed.timeoutMs);
  try {
    const res = await fetch(url, {
      method: parsed.method,
      headers,
      body: parsed.method === "GET" || parsed.method === "DELETE" ? undefined : JSON.stringify(parsed.body ?? {}),
      signal: controller.signal
    });
    const rawText = await res.text();
    let parsedResponse: unknown = rawText;
    const contentType = res.headers.get("content-type") ?? "";
    const isJsonContentType = contentType.toLowerCase().includes("application/json");
    try {
      parsedResponse = rawText ? JSON.parse(rawText) : {};
    } catch {
      parsedResponse = rawText;
    }
    const looksLikeHtml =
      typeof parsedResponse === "string" &&
      /^\s*<!doctype html/i.test(parsedResponse);
    const isStructuredJson = isJsonContentType && !looksLikeHtml;
    const validationError = isStructuredJson
      ? null
      : `Expected JSON response from API endpoint, but got content-type: ${contentType || "unknown"}`;
    return {
      ok: res.ok && isStructuredJson,
      status: res.status,
      statusText: res.ok && !isStructuredJson ? "Invalid API response" : res.statusText,
      url,
      elapsedMs: Date.now() - startedAt,
      response: parsedResponse,
      error: validationError
    };
  } finally {
    clearTimeout(timer);
  }
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

export async function listMappings(ticketTypeKey: string, flow: "create" | "update" | "transition" | "comment") {
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
  flow: "create" | "update" | "transition" | "comment";
  mappings: Array<z.infer<typeof mappingRowSchema>>;
  sampleContext: Record<string, unknown>;
}) {
  const mappingValidation = validateMappingRows(input.mappings);
  const errors = [...mappingValidation.errors];
  const schema = await repo.getTicketTypeCacheByKey(input.ticketTypeKey);
  if (schema) {
    const fields = (schema.fields_json ?? []) as Array<Record<string, unknown>>;
    const allowed = new Set(fields.map((f) => String(f.key ?? f.id ?? "")).filter(Boolean));
    const required = new Set(
      fields
        .filter((f) => Boolean(f.required ?? false))
        .map((f) => String(f.key ?? f.id ?? ""))
        .filter(Boolean)
    );

    const mappedTargets = new Set(input.mappings.map((m) => m.target));
    for (const target of mappedTargets) {
      if (!allowed.has(target)) {
        errors.push(`Target field not found in ONES schema: ${target}`);
      }
    }
    for (const reqField of required) {
      if (!mappedTargets.has(reqField)) {
        errors.push(`Required ONES field is not mapped: ${reqField}`);
      }
    }
  }

  if (errors.length) {
    return { valid: false, errors, payload: {} };
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

export async function getCatalogStatus() {
  const config = await repo.getActiveConfig();
  const types = await repo.listTicketTypeCache();
  const currentHash = createHash("sha256").update(JSON.stringify(types.map((r) => ({ key: r.type_key, fields: r.fields_json })))).digest("hex");
  const savedHash = config?.schema_hash ?? null;
  return {
    ticketTypeCount: types.length,
    schemaHash: savedHash,
    currentHash,
    driftDetected: Boolean(savedHash && savedHash !== currentHash),
    schemaSyncedAt: config?.schema_synced_at ?? null
  };
}

export async function runPublishPreflight() {
  const config = await repo.getActiveConfig();
  if (!config) {
    return {
      ready: false,
      checks: {
        connection: false,
        endpoints: false,
        whitelist: false,
        mappings: false
      },
      errors: ["ONES sync config not set"]
    };
  }
  const errors: string[] = [];
  const endpoints = resolveEndpointTemplates(config);
  const requiredEndpointKeys = [
    "listProjectsPath",
    "listIssueTypesPath",
    "listIssueFieldsPath",
    "listIssueStatusesPath",
    "createIssuePath",
    "listCommentsPathTemplate",
    "addCommentPathTemplate",
    "updateCommentPathTemplate",
    "deleteCommentPathTemplate"
  ] as const;

  const hasConnection = Boolean(config.base_url && config.auth_secret_encrypted && config.ones_team_id);
  if (!hasConnection) errors.push("Missing base_url/token/team_id connection requirements.");

  const missingEndpoints = requiredEndpointKeys.filter((key) => !String(endpoints[key] ?? "").trim());
  if (missingEndpoints.length) errors.push(`Missing required endpoint templates: ${missingEndpoints.join(", ")}`);

  const whitelist = config.allowed_ticket_type_keys ?? [];
  if (!whitelist.length) errors.push("At least one allowed issue type must be selected for customer portal.");

  let mappingsValid = true;
  for (const typeKey of whitelist) {
    const activeCreate = await repo.getLatestMapping(typeKey, "create", "active");
    if (!activeCreate) {
      mappingsValid = false;
      errors.push(`Missing active create mapping for ticket type ${typeKey}`);
    }
  }

  return {
    ready: errors.length === 0,
    checks: {
      connection: hasConnection,
      endpoints: missingEndpoints.length === 0,
      whitelist: whitelist.length > 0,
      mappings: mappingsValid
    },
    errors
  };
}

export async function publishConfig(actor = "internal_operator", reason?: string) {
  const preflight = await runPublishPreflight();
  if (!preflight.ready) {
    throw new Error(`Preflight failed: ${preflight.errors.join(" | ")}`);
  }
  const active = await repo.getActiveConfig();
  if (!active) throw new Error("ONES sync config not set");
  const saved = await repo.upsertActiveConfig({
    profileName: active.profile_name,
    baseUrl: active.base_url,
    authType: active.auth_type,
    authHeader: active.auth_header,
    authSecretEncrypted: active.auth_secret_encrypted,
    createTicketPath: active.create_ticket_path,
    listProjectsPath: active.list_projects_path,
    listTicketTypesPath: active.list_ticket_types_path,
    listFieldsPathTemplate: active.list_fields_path_template,
    endpointTemplates: active.endpoint_templates_json ?? {},
    allowedTicketTypeKeys: active.allowed_ticket_type_keys ?? [],
    statusMapping: active.status_mapping_json ?? {},
    workflowMapping: active.workflow_mapping_json ?? {},
    publishState: "published",
    publishChecks: preflight.checks,
    changeReason: reason ?? active.change_reason,
    rolledBackFrom: active.rolled_back_from,
    timeoutMs: active.timeout_ms,
    retries: active.retries,
    dataSourceMode: active.data_source_mode,
    onesProjectKey: active.ones_project_key,
    onesTeamId: active.ones_team_id,
    schemaHash: active.schema_hash,
    schemaSyncedAt: active.schema_synced_at,
    updatedBy: actor
  });
  await repo.addOnesSyncAudit({
    actor,
    scope: "config",
    eventType: "config_published",
    payload: { configId: saved.id, configVersion: saved.config_version, reason: reason ?? null, checks: preflight.checks }
  });
  return getConfig();
}

export async function rollbackConfig(targetConfigId: string, actor = "internal_operator", reason?: string) {
  const target = await repo.getConfigById(targetConfigId);
  if (!target) throw new Error("Target config not found");

  const saved = await repo.upsertActiveConfig({
    profileName: target.profile_name,
    baseUrl: target.base_url,
    authType: target.auth_type,
    authHeader: target.auth_header,
    authSecretEncrypted: target.auth_secret_encrypted,
    createTicketPath: target.create_ticket_path,
    listProjectsPath: target.list_projects_path,
    listTicketTypesPath: target.list_ticket_types_path,
    listFieldsPathTemplate: target.list_fields_path_template,
    endpointTemplates: target.endpoint_templates_json ?? {},
    allowedTicketTypeKeys: target.allowed_ticket_type_keys ?? [],
    statusMapping: target.status_mapping_json ?? {},
    workflowMapping: target.workflow_mapping_json ?? {},
    publishState: target.publish_state ?? "draft",
    publishChecks: target.publish_checks_json ?? {},
    changeReason: reason ?? target.change_reason,
    rolledBackFrom: target.id,
    timeoutMs: target.timeout_ms,
    retries: target.retries,
    dataSourceMode: target.data_source_mode,
    onesProjectKey: target.ones_project_key,
    onesTeamId: target.ones_team_id,
    schemaHash: target.schema_hash,
    schemaSyncedAt: target.schema_synced_at,
    updatedBy: actor
  });
  await repo.addOnesSyncAudit({
    actor,
    scope: "config",
    eventType: "config_rolled_back",
    payload: {
      fromConfigId: targetConfigId,
      toConfigId: saved.id,
      toVersion: saved.config_version,
      reason: reason ?? null
    }
  });
  return getConfig();
}

export async function listConfigHistory(limit = 20) {
  const rows = await repo.listConfigHistory(limit);
  return rows.map((row) => ({
    id: row.id,
    version: row.config_version,
    profileName: row.profile_name,
    publishState: row.publish_state,
    updatedBy: row.updated_by,
    updatedAt: row.updated_at,
    changeReason: row.change_reason,
    rolledBackFrom: row.rolled_back_from,
    isActive: row.is_active
  }));
}

export async function createOnesTicket(input: {
  ticketTypeKey: string;
  context: Record<string, unknown>;
}): Promise<{ key: string; raw: Record<string, unknown> }> {
  const config = await repo.getActiveConfig();
  if (!config) {
    throw new Error("ONES sync config not set");
  }
  const endpoints = resolveEndpointTemplates(config);
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
    issueTypeID: input.ticketTypeKey,
    ...built.payload
  };
  const createPath = endpoints.createIssuePath ?? config.create_ticket_path;
  const raw = await onesFetch(config, createPath, {
    method: "POST",
    body: JSON.stringify(requestBody)
  }).then((res) => res.json()) as Record<string, unknown>;

  const key = String(raw.key ?? raw.ticketKey ?? raw.id ?? "");
  if (!key) {
    throw new Error("ONES create ticket response missing key");
  }
  return { key, raw };
}

export async function updateOnesTicketByFlow(input: {
  flow: "transition" | "comment" | "update";
  ticketTypeKey: string;
  onesTicketKey: string;
  context: Record<string, unknown>;
}) {
  const config = await repo.getActiveConfig();
  if (!config) throw new Error("ONES sync config not set");
  const endpoints = resolveEndpointTemplates(config);

  const activeMapping = await repo.getLatestMapping(input.ticketTypeKey, input.flow, "active");
  const mappingRows = (activeMapping?.mapping_json ?? []) as Array<z.infer<typeof mappingRowSchema>>;
  const built = buildPayloadFromMapping(mappingRows, input.context);
  if (built.errors.length) throw new Error(`ONES mapping validation failed: ${built.errors.join("; ")}`);

  let path = "";
  let method: "POST" | "PATCH" = "POST";
  let body = built.payload;
  if (input.flow === "transition") {
    const targetStatus = String(input.context.toStatus ?? "");
    const workflowID = String((config.workflow_mapping_json ?? {})[targetStatus] ?? "");
    path = resolvePathTemplate(
      endpoints.executeIssueWorkflowPathTemplate ?? "/project/issues/{issueID}",
      { ticketTypeKey: input.ticketTypeKey, projectKey: config.ones_project_key, teamId: config.ones_team_id }
    ).replace("{issueID}", encodeURIComponent(input.onesTicketKey));
    body = {
      action: "executeWorkflow",
      workflowID: workflowID || built.payload.workflowID || built.payload.transitionID
    };
  } else if (input.flow === "comment") {
    path = (endpoints.addCommentPathTemplate ?? "/project/issues/{issueID}/comments")
      .replace("{issueID}", encodeURIComponent(input.onesTicketKey));
    body = { content: String(input.context.body ?? built.payload.body ?? "") };
  } else {
    path = (endpoints.updateIssuePathTemplate ?? "/project/issues/{issueID}")
      .replace("{issueID}", encodeURIComponent(input.onesTicketKey));
    method = "PATCH";
  }

  const raw = await onesFetch(config, path, { method, body: JSON.stringify(body) }).then((res) => res.json()) as Record<string, unknown>;
  return raw;
}

export async function getDataSourceMode(): Promise<"ones_primary" | "local_mirror"> {
  const config = await repo.getActiveConfig();
  return config?.data_source_mode ?? "ones_primary";
}

export async function ingestWebhook(input: unknown) {
  const parsed = webhookInputSchema.parse(input);
  const event = await repo.insertWebhookEvent({
    externalEventId: parsed.eventId,
    eventType: parsed.eventType,
    onesTicketKey: parsed.ticketKey,
    payload: parsed.payload,
    signature: parsed.signature,
    traceId: parsed.traceId
  });
  try {
    const payload = parsed.payload;
    await ticketsRepo.applyOnesWebhookEvent({
      onesTicketKey: parsed.ticketKey ?? String(payload.ticketKey ?? payload.issueKey ?? ""),
      status: typeof payload.status === "string" ? payload.status : undefined,
      assigneeName: typeof payload.assigneeName === "string" ? payload.assigneeName : undefined,
      commentBody: typeof payload.commentBody === "string" ? payload.commentBody : undefined
    });
    await repo.markWebhookProcessed(event.id);
    return { id: event.id, status: "processed" as const };
  } catch (error) {
    await repo.markWebhookFailed(event.id, (error as Error).message);
    throw error;
  }
}

export async function replayFailedWebhook(eventId: string) {
  const failed = await repo.listFailedWebhookEvents(200);
  const event = failed.find((row) => row.id === eventId);
  if (!event) throw new Error("Failed webhook event not found");
  try {
    await repo.markWebhookProcessed(event.id);
    return { id: event.id, status: "processed" as const };
  } catch (error) {
    await repo.markWebhookFailed(event.id, (error as Error).message);
    throw error;
  }
}

export async function listFailedWebhooks() {
  return repo.listFailedWebhookEvents(100);
}

export async function getSyncHealthSummary() {
  const failed = await repo.listFailedWebhookEvents(100);
  return {
    failedWebhookCount: failed.length,
    topErrors: failed.slice(0, 5).map((item) => item.error).filter(Boolean),
    updatedAt: new Date().toISOString()
  };
}

export async function reconcileReadModel(limit = 50) {
  const config = await repo.getActiveConfig();
  if (!config) {
    return { scanned: 0, updated: 0, skipped: 0, errors: ["ONES sync config not set"] };
  }
  const linked = await ticketsRepo.listOnesLinkedTickets(limit);
  let updated = 0;
  let skipped = 0;
  const errors: string[] = [];

  for (const ticket of linked) {
    if (!ticket.ones_ticket_key) {
      skipped += 1;
      continue;
    }
    try {
      const raw = await onesFetch(config, `${config.create_ticket_path}/${encodeURIComponent(ticket.ones_ticket_key)}`).then((res) => res.json()) as Record<string, unknown>;
      await ticketsRepo.applyOnesWebhookEvent({
        onesTicketKey: ticket.ones_ticket_key,
        status: typeof raw.status === "string" ? raw.status : undefined,
        assigneeName: typeof raw.assigneeName === "string" ? raw.assigneeName : undefined
      });
      updated += 1;
    } catch (error) {
      errors.push(`${ticket.ones_ticket_key}: ${(error as Error).message}`);
    }
  }

  return { scanned: linked.length, updated, skipped, errors };
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
    listProjectsPath: env.ONES_SYNC_DEFAULT_PROJECTS_PATH,
    listTicketTypesPath: env.ONES_SYNC_DEFAULT_TICKET_TYPES_PATH,
    listFieldsPathTemplate: env.ONES_SYNC_DEFAULT_FIELDS_PATH_TEMPLATE,
    endpointTemplates: {
      ...endpointTemplateDefaults,
      listProjectsPath: env.ONES_SYNC_DEFAULT_PROJECTS_PATH,
      listIssueTypesPath: env.ONES_SYNC_DEFAULT_TICKET_TYPES_PATH,
      listIssueFieldsPath: env.ONES_SYNC_DEFAULT_FIELDS_PATH_TEMPLATE
    },
    allowedTicketTypeKeys: [],
    statusMapping: {},
    workflowMapping: {},
    publishState: "draft",
    publishChecks: {},
    changeReason: "bootstrap default config",
    timeoutMs: 12000,
    retries: 1,
    dataSourceMode: "ones_primary",
    onesProjectKey: null,
    updatedBy: "bootstrap"
  });
}
