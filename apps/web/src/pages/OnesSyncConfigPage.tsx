import { useEffect, useMemo, useState } from "react";
import {
  discoverOnesProjects,
  discoverOnesTicketTypes,
  getOnesCatalogStatus,
  getOnesSyncConfig,
  getOnesSyncHealth,
  listFailedWebhookEvents,
  listOnesMappings,
  listOnesTicketTypesInternal,
  publishOnesMapping,
  replayWebhookEvent,
  rollbackOnesMapping,
  saveOnesMappingDraft,
  updateOnesSyncConfig,
  validateOnesMapping
} from "../lib/api";
import type { OnesCatalogStatus, OnesTicketType } from "../lib/types";

type ModuleTab = "connection" | "catalog" | "mapping" | "workflow" | "webhook" | "operations";

type MappingFlow = "create" | "update" | "transition" | "comment";

type MappingRow = {
  source: string;
  target: string;
  transform: "none" | "concat" | "enumMap" | "dateFormat" | "constant" | "fallback";
  transformConfig: Record<string, unknown>;
  requiredPolicy: "hard_fail" | "default_value";
};

const defaultMapping: MappingRow[] = [
  { source: "title", target: "title", transform: "none", transformConfig: {}, requiredPolicy: "hard_fail" },
  { source: "description", target: "description", transform: "none", transformConfig: {}, requiredPolicy: "hard_fail" }
];

const tabs: Array<{ key: ModuleTab; label: string }> = [
  { key: "connection", label: "Connection" },
  { key: "catalog", label: "Catalog" },
  { key: "mapping", label: "Mapping" },
  { key: "workflow", label: "Workflow" },
  { key: "webhook", label: "Webhook" },
  { key: "operations", label: "Operations" }
];

export function OnesSyncConfigPage() {
  const [activeTab, setActiveTab] = useState<ModuleTab>("connection");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [discovering, setDiscovering] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [ticketTypes, setTicketTypes] = useState<OnesTicketType[]>([]);
  const [selectedType, setSelectedType] = useState<string>("");
  const [flow, setFlow] = useState<MappingFlow>("create");
  const [draftRows, setDraftRows] = useState<MappingRow[]>(defaultMapping);
  const [draftId, setDraftId] = useState<string | null>(null);
  const [validation, setValidation] = useState<{ valid: boolean; errors: string[]; payload: Record<string, unknown> } | null>(null);
  const [catalogStatus, setCatalogStatus] = useState<OnesCatalogStatus | null>(null);
  const [projects, setProjects] = useState<Array<{ key: string; name: string }>>([]);
  const [projectCursor, setProjectCursor] = useState<string | null>(null);
  const [projectNextCursor, setProjectNextCursor] = useState<string | null>(null);
  const [failedWebhookEvents, setFailedWebhookEvents] = useState<Array<{ id: string; event_type: string; ones_ticket_key: string | null; error: string | null; retries: number; received_at: string }>>([]);
  const [health, setHealth] = useState<{ failedWebhookCount: number; topErrors: string[]; updatedAt: string } | null>(null);
  const [authSecretMasked, setAuthSecretMasked] = useState("");
  const [authSecretDirty, setAuthSecretDirty] = useState(false);
  const [editingAuthSecret, setEditingAuthSecret] = useState(false);

  const [form, setForm] = useState<{
    profileName: string;
    baseUrl: string;
    authType: "bearer" | "header";
    authHeader: string;
    authSecret: string;
    createTicketPath: string;
    listProjectsPath: string;
    listTicketTypesPath: string;
    listFieldsPathTemplate: string;
    timeoutMs: number;
    retries: number;
    dataSourceMode: "ones_primary" | "local_mirror";
    onesProjectKey: string;
    onesTeamId: string;
    updatedBy: string;
    updatedAt: string;
  }>({
    profileName: "default",
    baseUrl: "",
    authType: "bearer",
    authHeader: "Authorization",
    authSecret: "",
    createTicketPath: "/api/v1/tickets",
    listProjectsPath: "/openapi/v2/project/projects",
    listTicketTypesPath: "/api/v1/ticket-types",
    listFieldsPathTemplate: "/api/v1/ticket-types/{ticketTypeKey}/fields",
    timeoutMs: 12000,
    retries: 1,
    dataSourceMode: "ones_primary",
    onesProjectKey: "",
    onesTeamId: "",
    updatedBy: "-",
    updatedAt: "-"
  });

  const selectedTypeDetail = useMemo(() => ticketTypes.find((t) => t.key === selectedType) ?? null, [selectedType, ticketTypes]);

  const resolveTemplatePreview = (template: string, vars: Record<string, string>) => {
    const placeholders = Array.from(template.matchAll(/\{([a-zA-Z0-9_]+)\}/g)).map((x) => x[1]);
    const missing = placeholders.filter((name) => !vars[name]);
    let resolved = template;
    for (const [key, value] of Object.entries(vars)) {
      resolved = resolved.replaceAll(`{${key}}`, encodeURIComponent(value));
    }
    return {
      resolved,
      placeholders,
      missing
    };
  };

  const endpointPreview = useMemo(() => {
    const vars = {
      team_id: form.onesTeamId,
      teamID: form.onesTeamId,
      project_key: form.onesProjectKey,
      projectID: form.onesProjectKey,
      ticketTypeKey: selectedType || "sample_type_key"
    };
    return {
      projects: resolveTemplatePreview(form.listProjectsPath, vars),
      ticketTypes: resolveTemplatePreview(form.listTicketTypesPath, vars),
      fields: resolveTemplatePreview(form.listFieldsPathTemplate, vars)
    };
  }, [form.onesTeamId, form.onesProjectKey, form.listProjectsPath, form.listTicketTypesPath, form.listFieldsPathTemplate, selectedType]);

  const canDiscoverProjects = Boolean((authSecretDirty ? form.authSecret.trim().length > 0 : authSecretMasked.length > 0) && form.onesTeamId && form.baseUrl);
  const canRefreshCatalog = Boolean(form.onesTeamId && form.onesProjectKey);

  const load = async (options?: { keepAuthSecret?: boolean }) => {
    setLoading(true);
    setError(null);
    try {
      const [config, types, status, failedEvents, syncHealth] = await Promise.all([
        getOnesSyncConfig(),
        listOnesTicketTypesInternal(),
        getOnesCatalogStatus().catch(() => null),
        listFailedWebhookEvents().catch(() => []),
        getOnesSyncHealth().catch(() => null)
      ]);
      if (config) {
        setForm((prev) => ({
          profileName: config.profileName,
          baseUrl: config.baseUrl,
          authType: config.authType,
          authHeader: config.authHeader,
          authSecret: options?.keepAuthSecret ? prev.authSecret : "",
          createTicketPath: config.createTicketPath,
          listProjectsPath: config.listProjectsPath,
          listTicketTypesPath: config.listTicketTypesPath,
          listFieldsPathTemplate: config.listFieldsPathTemplate,
          timeoutMs: config.timeoutMs,
          retries: config.retries,
          dataSourceMode: config.dataSourceMode,
          onesProjectKey: config.onesProjectKey ?? "",
          onesTeamId: config.onesTeamId ?? "",
          updatedBy: config.updatedBy,
          updatedAt: config.updatedAt
        }));
        setAuthSecretMasked(config.authSecretMasked ?? "");
        setEditingAuthSecret(false);
        if (!options?.keepAuthSecret) setAuthSecretDirty(false);
      }
      setCatalogStatus(status);
      setTicketTypes(types);
      setFailedWebhookEvents(failedEvents);
      setHealth(syncHealth);
      if (types.length > 0) setSelectedType((prev) => prev || types[0].key);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  useEffect(() => {
    if (!selectedType) return;
    listOnesMappings(selectedType, flow)
      .then((rows) => {
        const latestDraft = rows.find((r: { status: string }) => r.status === "draft");
        if (latestDraft?.mapping_json && Array.isArray(latestDraft.mapping_json)) {
          setDraftRows(latestDraft.mapping_json as MappingRow[]);
          setDraftId(latestDraft.id);
          return;
        }
        setDraftRows(defaultMapping);
        setDraftId(null);
      })
      .catch(() => {
        setDraftRows(defaultMapping);
        setDraftId(null);
      });
  }, [selectedType, flow]);

  const saveConfig = async () => {
    if (!form.baseUrl) return setError("Base URL is required.");
    setSaving(true);
    setError(null);
    setSuccess(null);
    try {
      await updateOnesSyncConfig({
        profileName: form.profileName,
        baseUrl: form.baseUrl,
        authType: form.authType,
        authHeader: form.authHeader,
        authSecret: authSecretDirty ? form.authSecret : undefined,
        keepExistingSecret: !authSecretDirty,
        createTicketPath: form.createTicketPath,
        listProjectsPath: form.listProjectsPath,
        listTicketTypesPath: form.listTicketTypesPath,
        listFieldsPathTemplate: form.listFieldsPathTemplate,
        timeoutMs: form.timeoutMs,
        retries: form.retries,
        dataSourceMode: form.dataSourceMode,
        onesProjectKey: form.onesProjectKey,
        onesTeamId: form.onesTeamId,
        actor: "support_admin"
      });
      setSuccess("Configuration updated.");
      await load({ keepAuthSecret: false });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const saveDraft = async () => {
    if (!selectedType) return setError("Select a ticket type first.");
    setSaving(true);
    setError(null);
    try {
      const draft = await saveOnesMappingDraft({ ticketTypeKey: selectedType, flow, mappings: draftRows, actor: "support_admin" });
      setDraftId(draft.id);
      setSuccess(`Draft saved (v${draft.version}).`);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const runValidate = async () => {
    if (!selectedType) return setError("Select a ticket type first.");
    setSaving(true);
    try {
      const result = await validateOnesMapping({
        ticketTypeKey: selectedType,
        flow,
        mappings: draftRows,
        sampleContext: { title: "Sample", description: "Sample desc", toStatus: "WAITING_CUSTOMER", body: "comment" }
      });
      setValidation(result);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const fetchProjects = async (cursor: string | null = null) => {
    setSaving(true);
    setError(null);
    try {
      const result = await discoverOnesProjects({
        baseUrl: form.baseUrl,
        authType: form.authType,
        authHeader: form.authHeader,
        authSecret: authSecretDirty ? form.authSecret : undefined,
        keepExistingSecret: !authSecretDirty,
        teamId: form.onesTeamId,
        limit: 50,
        cursor: cursor ?? undefined,
        listProjectsPath: form.listProjectsPath,
        timeoutMs: form.timeoutMs
      });
      setProjects((prev) => (cursor ? [...prev, ...result.projects] : result.projects));
      setProjectCursor(cursor);
      setProjectNextCursor(result.nextCursor);
      if (result.projects[0]?.key) {
        setForm((p) => ({ ...p, onesProjectKey: p.onesProjectKey || result.projects[0].key }));
      }
      setSuccess(`Fetched ${result.projects.length} projects${result.nextCursor ? " (next page available)" : ""}.`);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <div className="mx-auto max-w-7xl px-4 py-8 text-sm text-slate-600">Loading configuration...</div>;

  return (
    <div className="mx-auto max-w-7xl space-y-6 px-4 py-8 md:px-8">
      <header className="rounded-mdplus border border-slate-200 bg-white p-4">
        <h1 className="text-3xl font-bold text-ink">Configuration</h1>
        <p className="mt-2 text-sm text-slate-600">ONES integration control plane for catalog, mappings, workflow, webhook, and operations.</p>
        <div className="mt-3 flex flex-wrap gap-2 text-xs text-slate-600">
          <span className="rounded-full bg-slate-100 px-2 py-1">Mode: {form.dataSourceMode}</span>
          <span className="rounded-full bg-slate-100 px-2 py-1">Updated by: {form.updatedBy}</span>
          <span className="rounded-full bg-slate-100 px-2 py-1">Updated at: {form.updatedAt === "-" ? "-" : new Date(form.updatedAt).toLocaleString()}</span>
          {catalogStatus?.driftDetected && <span className="rounded-full bg-rose-100 px-2 py-1 text-rose-700">Schema drift detected</span>}
        </div>
      </header>

      {error && <p className="rounded-mdplus border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">{error}</p>}
      {success && <p className="rounded-mdplus border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700">{success}</p>}

      <section className="rounded-mdplus border border-slate-200 bg-white p-2">
        <div className="flex flex-wrap gap-2">
          {tabs.map((tab) => (
            <button key={tab.key} onClick={() => setActiveTab(tab.key)} className={`rounded-md px-3 py-2 text-sm ${activeTab === tab.key ? "bg-brand-500 text-white" : "bg-slate-100 text-slate-700"}`}>
              {tab.label}
            </button>
          ))}
        </div>
      </section>

      {activeTab === "connection" && (
        <section className="rounded-mdplus border border-slate-200 bg-white p-4">
          <h2 className="text-sm font-semibold text-[#16171A]">Connection</h2>
          <div className="mt-3 grid gap-3 md:grid-cols-2">
            <input className="rounded-mdplus border border-slate-200 px-3 py-2 text-sm" placeholder="Profile Name" value={form.profileName} onChange={(e) => setForm((p) => ({ ...p, profileName: e.target.value }))} />
            <input className="rounded-mdplus border border-slate-200 px-3 py-2 text-sm" placeholder="Base URL (e.g. https://xxx.myones.net)" value={form.baseUrl} onChange={(e) => setForm((p) => ({ ...p, baseUrl: e.target.value }))} />
          </div>
          <div className="mt-4 grid gap-3 rounded-mdplus border border-slate-200 bg-slate-50 p-3 md:grid-cols-2">
            <div>
              <p className="text-xs font-semibold uppercase tracking-wide text-slate-600">Required Parameters</p>
              <input className="mt-2 w-full rounded-mdplus border border-slate-200 bg-white px-3 py-2 text-sm" placeholder="ONES team_id" value={form.onesTeamId} onChange={(e) => setForm((p) => ({ ...p, onesTeamId: e.target.value }))} />
              <p className="mt-1 text-xs text-slate-500">Used by ONES APIs. Supports template placeholders: {"{team_id}"} / {"{teamID}"}.</p>
              <input className="mt-3 w-full rounded-mdplus border border-slate-200 bg-white px-3 py-2 text-sm" placeholder="ONES project_key" value={form.onesProjectKey} onChange={(e) => setForm((p) => ({ ...p, onesProjectKey: e.target.value }))} />
              <p className="mt-1 text-xs text-slate-500">Used for issue type/field APIs. Supports {"{project_key}"} / {"{projectID}"}.</p>
              <p className="mt-3 text-xs text-slate-500">Project list API uses query params: <code>teamID</code>, <code>limit</code>, <code>cursor</code>. Cursor and limit are handled automatically by system UI.</p>
            </div>
            <div>
              <p className="text-xs font-semibold uppercase tracking-wide text-slate-600">Auth</p>
              <div className="mt-2 grid gap-2">
                <select className="rounded-mdplus border border-slate-200 bg-white px-3 py-2 text-sm" value={form.authType} onChange={(e) => setForm((p) => ({ ...p, authType: e.target.value as "bearer" | "header" }))}>
                  <option value="bearer">Bearer Token</option>
                  <option value="header">Custom Header Token</option>
                </select>
                <input className="rounded-mdplus border border-slate-200 bg-white px-3 py-2 text-sm" placeholder="Auth Header" value={form.authHeader} onChange={(e) => setForm((p) => ({ ...p, authHeader: e.target.value }))} />
                {!editingAuthSecret ? (
                  <div className="flex gap-2">
                    <input className="min-w-0 flex-1 rounded-mdplus border border-slate-200 bg-slate-100 px-3 py-2 text-sm" type="password" value={authSecretMasked || "********"} readOnly />
                    <button
                      className="rounded-mdplus border border-slate-300 bg-white px-3 py-2 text-sm"
                      onClick={() => {
                        setEditingAuthSecret(true);
                        setAuthSecretDirty(true);
                        setForm((p) => ({ ...p, authSecret: "" }));
                      }}
                    >
                      Replace Token
                    </button>
                  </div>
                ) : (
                  <div className="flex gap-2">
                    <input
                      className="min-w-0 flex-1 rounded-mdplus border border-slate-200 bg-white px-3 py-2 text-sm"
                      type="password"
                      placeholder="Enter new OpenAPI token"
                      value={form.authSecret}
                      onChange={(e) => setForm((p) => ({ ...p, authSecret: e.target.value }))}
                    />
                    <button
                      className="rounded-mdplus border border-slate-300 bg-white px-3 py-2 text-sm"
                      onClick={() => {
                        setEditingAuthSecret(false);
                        setAuthSecretDirty(false);
                        setForm((p) => ({ ...p, authSecret: "" }));
                      }}
                    >
                      Keep Stored
                    </button>
                  </div>
                )}
                <p className="text-xs text-slate-500">Token is encrypted server-side. UI only shows masked value.</p>
              </div>
            </div>
          </div>
          <div className="mt-4 grid gap-3 rounded-mdplus border border-slate-200 bg-white p-3 md:grid-cols-2">
            <div className="md:col-span-2">
              <p className="text-xs font-semibold uppercase tracking-wide text-slate-600">Endpoint Templates (ONES OpenAPI)</p>
              <p className="mt-1 text-xs text-slate-500">Supports placeholders: <code>{"{team_id}"}</code> <code>{"{teamID}"}</code> <code>{"{project_key}"}</code> <code>{"{projectID}"}</code> <code>{"{ticketTypeKey}"}</code>.</p>
            </div>
            <input className="rounded-mdplus border border-slate-200 px-3 py-2 text-sm" placeholder="Create Ticket Path" value={form.createTicketPath} onChange={(e) => setForm((p) => ({ ...p, createTicketPath: e.target.value }))} />
            <select className="rounded-mdplus border border-slate-200 px-3 py-2 text-sm" value={form.dataSourceMode} onChange={(e) => setForm((p) => ({ ...p, dataSourceMode: e.target.value as "ones_primary" | "local_mirror" }))}>
              <option value="ones_primary">ones_primary</option>
              <option value="local_mirror">local_mirror</option>
            </select>
            <input className="rounded-mdplus border border-slate-200 px-3 py-2 text-sm" placeholder="List Projects Path (supports {team_id})" value={form.listProjectsPath} onChange={(e) => setForm((p) => ({ ...p, listProjectsPath: e.target.value }))} />
            <input className="rounded-mdplus border border-slate-200 px-3 py-2 text-sm" placeholder="List Ticket Types Path (supports {team_id},{project_key})" value={form.listTicketTypesPath} onChange={(e) => setForm((p) => ({ ...p, listTicketTypesPath: e.target.value }))} />
            <input className="rounded-mdplus border border-slate-200 px-3 py-2 text-sm md:col-span-2" placeholder="List Fields Path Template (supports {team_id},{project_key},{ticketTypeKey})" value={form.listFieldsPathTemplate} onChange={(e) => setForm((p) => ({ ...p, listFieldsPathTemplate: e.target.value }))} />
          </div>
          <div className="mt-4 grid gap-3 rounded-mdplus border border-slate-200 bg-slate-50 p-3 md:grid-cols-3">
            <article className="rounded-md border border-slate-200 bg-white p-2 text-xs">
              <p className="font-semibold text-[#16171A]">Projects API Preview</p>
              <p className="mt-1 break-all text-slate-600">{form.baseUrl.replace(/\/$/, "")}{endpointPreview.projects.resolved}</p>
              {endpointPreview.projects.missing.length > 0 && <p className="mt-1 text-rose-600">Missing: {endpointPreview.projects.missing.join(", ")}</p>}
            </article>
            <article className="rounded-md border border-slate-200 bg-white p-2 text-xs">
              <p className="font-semibold text-[#16171A]">Ticket Types API Preview</p>
              <p className="mt-1 break-all text-slate-600">{form.baseUrl.replace(/\/$/, "")}{endpointPreview.ticketTypes.resolved}</p>
              {endpointPreview.ticketTypes.missing.length > 0 && <p className="mt-1 text-rose-600">Missing: {endpointPreview.ticketTypes.missing.join(", ")}</p>}
            </article>
            <article className="rounded-md border border-slate-200 bg-white p-2 text-xs">
              <p className="font-semibold text-[#16171A]">Fields API Preview</p>
              <p className="mt-1 break-all text-slate-600">{form.baseUrl.replace(/\/$/, "")}{endpointPreview.fields.resolved}</p>
              {endpointPreview.fields.missing.length > 0 && <p className="mt-1 text-rose-600">Missing: {endpointPreview.fields.missing.join(", ")}</p>}
            </article>
          </div>
          <div className="mt-4 grid gap-3 md:grid-cols-2">
            {projects.length > 0 ? (
              <select className="rounded-mdplus border border-slate-200 px-3 py-2 text-sm" value={form.onesProjectKey} onChange={(e) => setForm((p) => ({ ...p, onesProjectKey: e.target.value }))}>
                <option value="">Select ONES Project</option>
                {projects.map((project) => (
                  <option key={project.key} value={project.key}>
                    {project.name} ({project.key})
                  </option>
                ))}
              </select>
            ) : (
              <input className="rounded-mdplus border border-slate-200 px-3 py-2 text-sm" placeholder="ONES Project Key" value={form.onesProjectKey} onChange={(e) => setForm((p) => ({ ...p, onesProjectKey: e.target.value }))} />
            )}
            <input className="rounded-mdplus border border-slate-200 px-3 py-2 text-sm" type="number" min={3000} max={60000} placeholder="Timeout (ms)" value={form.timeoutMs} onChange={(e) => setForm((p) => ({ ...p, timeoutMs: Number(e.target.value) || 12000 }))} />
            <input className="rounded-mdplus border border-slate-200 px-3 py-2 text-sm" type="number" min={0} max={3} placeholder="Retries" value={form.retries} onChange={(e) => setForm((p) => ({ ...p, retries: Number(e.target.value) || 0 }))} />
          </div>
          <div className="mt-3 flex gap-2">
            <button className="rounded-mdplus border border-slate-200 px-3 py-2 text-sm" disabled={saving || !canDiscoverProjects} onClick={() => void fetchProjects(null)}>
              Fetch Projects
            </button>
            <button
              className="rounded-mdplus border border-slate-200 px-3 py-2 text-sm disabled:opacity-60"
              disabled={saving || !projectNextCursor || !canDiscoverProjects}
              onClick={() => void fetchProjects(projectNextCursor)}
            >
              Load Next Page
            </button>
            <button className="rounded-mdplus bg-brand-500 px-3 py-2 text-sm text-white disabled:opacity-70" disabled={saving} onClick={() => void saveConfig()}>
              Save Configuration
            </button>
          </div>
          {projectNextCursor && (
            <p className="mt-2 text-xs text-slate-500">
              Next cursor available: <code>{projectNextCursor}</code>
            </p>
          )}
        </section>
      )}

      {activeTab === "catalog" && (
        <section className="rounded-mdplus border border-slate-200 bg-white p-4">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-sm font-semibold text-[#16171A]">Catalog</h2>
            <button className="rounded-mdplus border border-slate-200 px-3 py-2 text-sm" disabled={discovering} onClick={() => {
              if (!canRefreshCatalog) {
                setError("Catalog discovery requires both ONES Team ID and ONES Project Key in Connection.");
                return;
              }
              setDiscovering(true);
              setError(null);
              discoverOnesTicketTypes("support_admin").then((rows) => {
                setTicketTypes(rows);
                setSelectedType(rows[0]?.key ?? "");
                return getOnesCatalogStatus().then(setCatalogStatus).catch(() => undefined);
              }).finally(() => setDiscovering(false));
            }}>{discovering ? "Refreshing..." : "Refresh from ONES"}</button>
          </div>
          <div className="mb-3 grid gap-2 rounded-mdplus border border-slate-200 bg-slate-50 p-3 text-xs text-slate-700 md:grid-cols-3">
            <article className="rounded border border-slate-200 bg-white p-2">
              <p className="font-semibold text-[#16171A]">Projects API</p>
              <p className="mt-1 text-slate-500">Method: GET | Auth: header/bearer</p>
              <p className="mt-1">Params: <span className="font-medium">team_id / teamID</span> (query or path)</p>
              <p className="mt-1 break-all text-slate-600">{form.baseUrl.replace(/\/$/, "")}{endpointPreview.projects.resolved}</p>
            </article>
            <article className="rounded border border-slate-200 bg-white p-2">
              <p className="font-semibold text-[#16171A]">Ticket Types API</p>
              <p className="mt-1 text-slate-500">Method: GET | Auth: header/bearer</p>
              <p className="mt-1">Params: <span className="font-medium">team_id/teamID + project_key/projectID</span></p>
              <p className="mt-1 break-all text-slate-600">{form.baseUrl.replace(/\/$/, "")}{endpointPreview.ticketTypes.resolved}</p>
            </article>
            <article className="rounded border border-slate-200 bg-white p-2">
              <p className="font-semibold text-[#16171A]">Fields API</p>
              <p className="mt-1 text-slate-500">Method: GET | Auth: header/bearer</p>
              <p className="mt-1">Params: <span className="font-medium">team/project + ticketTypeKey</span></p>
              <p className="mt-1 break-all text-slate-600">{form.baseUrl.replace(/\/$/, "")}{endpointPreview.fields.resolved}</p>
            </article>
          </div>
          {!canRefreshCatalog && (
            <p className="mb-3 rounded border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-700">
              Configure both ONES Team ID and ONES Project Key in Connection before refreshing catalog.
            </p>
          )}
          {catalogStatus && (
            <div className="mb-3 rounded border border-slate-200 bg-slate-50 p-2 text-xs text-slate-600">
              <p>Ticket types: {catalogStatus.ticketTypeCount}</p>
              <p>Schema hash: {catalogStatus.schemaHash ?? "-"}</p>
              <p>Current hash: {catalogStatus.currentHash}</p>
              <p>Drift: {catalogStatus.driftDetected ? "YES" : "NO"}</p>
            </div>
          )}
          <div className="grid gap-2 md:grid-cols-2">
            {ticketTypes.map((type) => (
              <article key={type.key} className="rounded border border-slate-200 p-2">
                <p className="text-sm font-medium text-[#16171A]">{type.name}</p>
                <p className="text-xs text-slate-500">{type.key}</p>
                <p className="mt-1 text-xs text-slate-600">fields: {type.fields.length}</p>
              </article>
            ))}
          </div>
        </section>
      )}

      {(activeTab === "mapping" || activeTab === "workflow") && (
        <section className="rounded-mdplus border border-slate-200 bg-white p-4">
          <h2 className="text-sm font-semibold text-[#16171A]">{activeTab === "mapping" ? "Field Mapping" : "Workflow Mapping"}</h2>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <select className="rounded-mdplus border border-slate-200 px-3 py-2 text-sm" value={selectedType} onChange={(e) => setSelectedType(e.target.value)}>
              {ticketTypes.map((t) => <option key={t.key} value={t.key}>{t.name} ({t.key})</option>)}
            </select>
            <select className="rounded-mdplus border border-slate-200 px-3 py-2 text-sm" value={flow} onChange={(e) => setFlow(e.target.value as MappingFlow)}>
              <option value="create">Create Flow</option>
              <option value="update">Update Flow</option>
              <option value="transition">Transition Flow</option>
              <option value="comment">Comment Flow</option>
            </select>
            <button className="rounded-mdplus border border-slate-200 px-3 py-2 text-sm" onClick={() => setDraftRows((rows) => [...rows, { source: "", target: "", transform: "none", transformConfig: {}, requiredPolicy: "hard_fail" }])}>Add Row</button>
          </div>

          {selectedTypeDetail && (
            <div className="mt-3 rounded-mdplus border border-slate-200 bg-slate-50 p-3">
              <p className="text-xs font-semibold uppercase text-slate-500">ONES Fields ({selectedTypeDetail.fields.length})</p>
              <div className="mt-2 max-h-40 overflow-auto text-xs text-slate-600">{selectedTypeDetail.fields.map((field, idx) => <pre key={`${selectedTypeDetail.key}-${idx}`} className="whitespace-pre-wrap">{JSON.stringify(field)}</pre>)}</div>
            </div>
          )}

          <div className="mt-3 space-y-2">
            {draftRows.map((row, idx) => (
              <div key={`mapping-${idx}`} className="grid gap-2 rounded-mdplus border border-slate-200 p-2 md:grid-cols-[1fr_1fr_160px_160px_auto]">
                <input className="rounded border border-slate-200 px-2 py-1 text-xs" placeholder="source" value={row.source} onChange={(e) => setDraftRows((prev) => prev.map((item, i) => (i === idx ? { ...item, source: e.target.value } : item)))} />
                <input className="rounded border border-slate-200 px-2 py-1 text-xs" placeholder="target" value={row.target} onChange={(e) => setDraftRows((prev) => prev.map((item, i) => (i === idx ? { ...item, target: e.target.value } : item)))} />
                <select className="rounded border border-slate-200 px-2 py-1 text-xs" value={row.transform} onChange={(e) => setDraftRows((prev) => prev.map((item, i) => (i === idx ? { ...item, transform: e.target.value as MappingRow["transform"] } : item)))}>
                  <option value="none">none</option><option value="concat">concat</option><option value="enumMap">enumMap</option><option value="dateFormat">dateFormat</option><option value="constant">constant</option><option value="fallback">fallback</option>
                </select>
                <select className="rounded border border-slate-200 px-2 py-1 text-xs" value={row.requiredPolicy} onChange={(e) => setDraftRows((prev) => prev.map((item, i) => (i === idx ? { ...item, requiredPolicy: e.target.value as MappingRow["requiredPolicy"] } : item)))}>
                  <option value="hard_fail">hard_fail</option><option value="default_value">default_value</option>
                </select>
                <button className="rounded border border-rose-200 px-2 py-1 text-xs text-rose-700" onClick={() => setDraftRows((prev) => prev.filter((_, i) => i !== idx))}>Remove</button>
              </div>
            ))}
          </div>

          <div className="mt-3 flex flex-wrap gap-2">
            <button className="rounded-mdplus bg-brand-500 px-3 py-2 text-sm text-white" disabled={saving} onClick={() => void saveDraft()}>Save Draft</button>
            <button className="rounded-mdplus border border-slate-200 px-3 py-2 text-sm" disabled={saving} onClick={() => void runValidate()}>Validate + Dry Run</button>
            <button
              className="rounded-mdplus border border-emerald-200 px-3 py-2 text-sm text-emerald-700"
              disabled={saving || !draftId}
              onClick={() => {
                if (!draftId) return;
                void publishOnesMapping(draftId, "support_admin").then(() => setSuccess("Draft published."));
              }}
            >
              Publish
            </button>
            <button className="rounded-mdplus border border-amber-200 px-3 py-2 text-sm text-amber-700" disabled={saving || !selectedType} onClick={() => void rollbackOnesMapping(selectedType, flow, "support_admin").then(() => setSuccess("Rolled back."))}>Rollback</button>
          </div>

          {validation && (
            <div className={`mt-3 rounded-mdplus border p-3 text-xs ${validation.valid ? "border-emerald-200 bg-emerald-50 text-emerald-700" : "border-rose-200 bg-rose-50 text-rose-700"}`}>
              <p className="font-semibold">{validation.valid ? "Validation passed" : "Validation failed"}</p>
              {validation.errors.length > 0 && <p className="mt-1">{validation.errors.join("; ")}</p>}
            </div>
          )}
        </section>
      )}

      {activeTab === "webhook" && (
        <section className="rounded-mdplus border border-slate-200 bg-white p-4">
          <h2 className="text-sm font-semibold text-[#16171A]">Webhook</h2>
          <p className="mt-2 text-sm text-slate-600">Failed events can be replayed from this panel.</p>
          <div className="mt-3 space-y-2">
            {failedWebhookEvents.length === 0 && <p className="text-sm text-slate-500">No failed webhook events.</p>}
            {failedWebhookEvents.map((event) => (
              <div key={event.id} className="flex items-center justify-between rounded border border-slate-200 p-2 text-xs">
                <div>
                  <p className="font-medium">{event.event_type} / {event.ones_ticket_key ?? "-"}</p>
                  <p className="text-slate-500">retry: {event.retries} | {event.error ?? "unknown error"}</p>
                </div>
                <button className="rounded border border-slate-200 px-2 py-1" onClick={() => void replayWebhookEvent(event.id).then(() => load())}>Replay</button>
              </div>
            ))}
          </div>
        </section>
      )}

      {activeTab === "operations" && (
        <section className="rounded-mdplus border border-slate-200 bg-white p-4">
          <h2 className="text-sm font-semibold text-[#16171A]">Operations</h2>
          {health ? (
            <div className="mt-3 rounded border border-slate-200 bg-slate-50 p-3 text-sm text-slate-700">
              <p>Failed webhooks: {health.failedWebhookCount}</p>
              <p>Last updated: {new Date(health.updatedAt).toLocaleString()}</p>
              <p>Top errors: {health.topErrors.length ? health.topErrors.join(" | ") : "None"}</p>
            </div>
          ) : <p className="mt-2 text-sm text-slate-500">No operation metrics available.</p>}
        </section>
      )}
    </div>
  );
}
