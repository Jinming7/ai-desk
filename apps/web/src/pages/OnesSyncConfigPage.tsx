import { useEffect, useMemo, useState } from "react";
import {
  discoverOnesIssueStatuses,
  discoverOnesProjects,
  discoverOnesTicketTypes,
  getOnesConfigHistory,
  getOnesSyncConfig,
  listOnesTicketTypesInternal,
  publishOnesConfig,
  rollbackOnesConfig,
  runOnesPublishPreflight,
  testIntegrationEndpoint,
  updateOnesSyncConfig
} from "../lib/api";
import type { OnesConfigHistoryItem, OnesSyncConfig, OnesTicketType } from "../lib/types";

type Step = 0 | 1 | 2 | 3;
type EndpointMethod = "GET" | "POST" | "PATCH" | "DELETE";
type EndpointKey =
  | "listProjectsPath"
  | "listIssueTypesPath"
  | "listIssueFieldsPath"
  | "listIssueStatusesPath"
  | "listIssuesPath"
  | "getIssuePathTemplate"
  | "createIssuePath"
  | "updateIssuePathTemplate"
  | "deleteIssuePathTemplate"
  | "listIssueWorkflowsPathTemplate"
  | "executeIssueWorkflowPathTemplate"
  | "listCommentsPathTemplate"
  | "getCommentPathTemplate"
  | "addCommentPathTemplate"
  | "updateCommentPathTemplate"
  | "deleteCommentPathTemplate";

type EndpointDef = {
  key: EndpointKey;
  label: string;
  method: EndpointMethod;
  requiresBody?: boolean;
  responsePath?: string;
};

type TestResult = {
  ok: boolean;
  status: number;
  statusText: string;
  url: string;
  elapsedMs: number;
  response: unknown;
  error?: string | null;
};

const steps = ["Connection", "Endpoints", "Mapping & Scope", "Publish"] as const;
const internalStatuses = ["OPEN", "IN_PROGRESS", "WAITING_CUSTOMER", "ESCALATED_RND", "RESOLVED", "CLOSED"] as const;
const workflowActions = ["IN_PROGRESS", "WAITING_CUSTOMER", "ESCALATED_RND", "RESOLVED", "CLOSED"] as const;

const endpointDefs: EndpointDef[] = [
  { key: "listProjectsPath", label: "Get Projects", method: "GET", responsePath: "projects" },
  { key: "listIssueTypesPath", label: "Get Issue Types", method: "GET", responsePath: "issueTypes" },
  { key: "listIssueFieldsPath", label: "Get Issue Fields", method: "GET", responsePath: "issueFields" },
  { key: "listIssueStatusesPath", label: "Get Issue Statuses", method: "GET", responsePath: "statuses" },
  { key: "listIssuesPath", label: "Get Work Item List", method: "GET", responsePath: "issues" },
  { key: "getIssuePathTemplate", label: "Get Work Item Detail", method: "GET" },
  { key: "createIssuePath", label: "Create Work Item", method: "POST", requiresBody: true },
  { key: "updateIssuePathTemplate", label: "Update Work Item", method: "PATCH", requiresBody: true },
  { key: "deleteIssuePathTemplate", label: "Delete Work Item", method: "DELETE" },
  { key: "listIssueWorkflowsPathTemplate", label: "Get Work Item Workflows", method: "GET", responsePath: "workflows" },
  { key: "executeIssueWorkflowPathTemplate", label: "Execute Work Item Workflow", method: "POST", requiresBody: true },
  { key: "listCommentsPathTemplate", label: "Get Comments", method: "GET", responsePath: "comments" },
  { key: "getCommentPathTemplate", label: "Get Comment Detail", method: "GET" },
  { key: "addCommentPathTemplate", label: "Add Comment", method: "POST", requiresBody: true },
  { key: "updateCommentPathTemplate", label: "Update Comment", method: "PATCH", requiresBody: true },
  { key: "deleteCommentPathTemplate", label: "Delete Comment", method: "DELETE" }
];

const defaultEndpoints: Record<EndpointKey, string> = {
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
};

function applyPlaceholders(path: string, vars: Record<string, string>) {
  let out = path;
  Object.entries(vars).forEach(([key, value]) => {
    out = out.replaceAll(`{${key}}`, encodeURIComponent(value));
  });
  return out;
}

function unresolved(path: string) {
  return /\{[a-zA-Z0-9_]+\}/.test(path);
}

function appendQuery(path: string, key: string, value: string) {
  if (!value.trim()) return path;
  const [base, hash] = path.split("#", 2);
  const [pathname, query] = base.split("?", 2);
  const params = new URLSearchParams(query ?? "");
  if (!params.has(key)) {
    params.set(key, value);
  }
  const rebuilt = `${pathname}${params.toString() ? `?${params.toString()}` : ""}`;
  return hash ? `${rebuilt}#${hash}` : rebuilt;
}

function extractArrayByHint(response: unknown, hint: string): unknown[] | null {
  if (Array.isArray(response)) return response;
  if (!response || typeof response !== "object") return null;
  const root = response as Record<string, unknown>;
  const data = root.data as Record<string, unknown> | unknown[] | undefined;

  const candidates: unknown[] = [
    root[hint],
    root.items,
    root.list,
    data,
    Array.isArray(data) ? data : (data as Record<string, unknown> | undefined)?.[hint],
    Array.isArray(data) ? undefined : (data as Record<string, unknown> | undefined)?.items,
    Array.isArray(data) ? undefined : (data as Record<string, unknown> | undefined)?.list
  ];

  for (const item of candidates) {
    if (Array.isArray(item)) return item;
  }
  return null;
}

export function OnesSyncConfigPage() {
  const [step, setStep] = useState<Step>(0);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [publishReason, setPublishReason] = useState("");

  const [config, setConfig] = useState<OnesSyncConfig | null>(null);
  const [baseUrl, setBaseUrl] = useState("");
  const [authType, setAuthType] = useState<"bearer" | "header">("bearer");
  const [authHeader, setAuthHeader] = useState("Authorization");
  const [teamId, setTeamId] = useState("");
  const [projectKey, setProjectKey] = useState("");
  const [timeoutMs, setTimeoutMs] = useState(12000);
  const [retries, setRetries] = useState(1);
  const [tokenMasked, setTokenMasked] = useState("");
  const [editingToken, setEditingToken] = useState(false);
  const [tokenInput, setTokenInput] = useState("");
  const [connectionTested, setConnectionTested] = useState(false);

  const [endpointPaths, setEndpointPaths] = useState<Record<EndpointKey, string>>(defaultEndpoints);
  const [endpointBodies, setEndpointBodies] = useState<Record<EndpointKey, string>>({
    createIssuePath: "{\n  \"title\": \"{{summary}}\",\n  \"description\": \"{{description}}\",\n  \"issueTypeID\": \"{{issueTypeID}}\"\n}",
    updateIssuePathTemplate: "{\n  \"title\": \"{{summary}}\"\n}",
    executeIssueWorkflowPathTemplate: "{\n  \"action\": \"executeWorkflow\",\n  \"workflowID\": \"{{workflowID}}\"\n}",
    addCommentPathTemplate: "{\n  \"content\": \"{{comment}}\"\n}",
    updateCommentPathTemplate: "{\n  \"content\": \"{{comment}}\"\n}"
  } as Record<EndpointKey, string>);
  const [endpointTests, setEndpointTests] = useState<Partial<Record<EndpointKey, TestResult>>>({});

  const [projectOptions, setProjectOptions] = useState<Array<{ key: string; name: string }>>([]);
  const [projectLoading, setProjectLoading] = useState(false);

  const [issueTypes, setIssueTypes] = useState<OnesTicketType[]>([]);
  const [allowedIssueTypes, setAllowedIssueTypes] = useState<string[]>([]);
  const [externalStatuses, setExternalStatuses] = useState<Array<{ key: string; name: string }>>([]);
  const [statusMapping, setStatusMapping] = useState<Record<string, string>>({});
  const [workflowMapping, setWorkflowMapping] = useState<Record<string, string>>({});
  const [history, setHistory] = useState<OnesConfigHistoryItem[]>([]);
  const [preflight, setPreflight] = useState<{ ready: boolean; checks: Record<string, boolean>; errors: string[] } | null>(null);

  const tokenRequiredForTest = tokenMasked.length === 0 || editingToken;
  const canTestConnection = Boolean(baseUrl.trim() && teamId.trim() && (!tokenRequiredForTest || tokenInput.trim()));
  const canGoNext = useMemo(() => {
    if (step === 0) return connectionTested;
    if (step === 1) return Boolean(projectKey);
    if (step === 2) return allowedIssueTypes.length > 0;
    return true;
  }, [step, connectionTested, projectKey, allowedIssueTypes.length]);

  const runtimeVars = useMemo(
    () => ({
      issueID: "sample_issue_id",
      commentsID: "sample_comment_id"
    }),
    []
  );

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const [cfg, cfgHistory] = await Promise.all([getOnesSyncConfig(), getOnesConfigHistory(30)]);
      if (cfg) {
        setConfig(cfg);
        setBaseUrl(cfg.baseUrl);
        setAuthType(cfg.authType);
        setAuthHeader(cfg.authHeader);
        setTeamId(cfg.onesTeamId ?? "");
        setProjectKey(cfg.onesProjectKey ?? "");
        setTimeoutMs(cfg.timeoutMs);
        setRetries(cfg.retries);
        setTokenMasked(cfg.authSecretMasked ?? "");
        setAllowedIssueTypes(cfg.allowedTicketTypeKeys ?? []);
        setStatusMapping((cfg.statusMapping ?? {}) as Record<string, string>);
        setWorkflowMapping((cfg.workflowMapping ?? {}) as Record<string, string>);
        setEndpointPaths((prev) => ({
          ...prev,
          ...(cfg.endpointTemplates as Record<EndpointKey, string> | undefined),
          listProjectsPath: cfg.listProjectsPath || prev.listProjectsPath,
          listIssueTypesPath: cfg.listTicketTypesPath || prev.listIssueTypesPath,
          listIssueFieldsPath: cfg.listFieldsPathTemplate || prev.listIssueFieldsPath,
          createIssuePath: cfg.createTicketPath || prev.createIssuePath
        }));
      }
      setHistory(cfgHistory);
      const types = await listOnesTicketTypesInternal().catch(() => []);
      setIssueTypes(types);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const saveDraft = async (publishState: "draft" | "published" = "draft") => {
    setSaving(true);
    setError(null);
    setSuccess(null);
    try {
      const updated = await updateOnesSyncConfig({
        profileName: "default",
        baseUrl,
        authType,
        authHeader,
        authSecret: tokenInput.trim() || undefined,
        keepExistingSecret: tokenInput.trim().length === 0,
        createTicketPath: endpointPaths.createIssuePath,
        listProjectsPath: endpointPaths.listProjectsPath,
        listTicketTypesPath: endpointPaths.listIssueTypesPath,
        listFieldsPathTemplate: endpointPaths.listIssueFieldsPath,
        endpointTemplates: endpointPaths,
        allowedTicketTypeKeys: allowedIssueTypes,
        statusMapping,
        workflowMapping,
        publishState,
        publishChecks: preflight?.checks ?? {},
        changeReason: publishReason.trim() || undefined,
        timeoutMs,
        retries,
        dataSourceMode: "ones_primary",
        onesProjectKey: projectKey,
        onesTeamId: teamId,
        actor: "support_admin"
      });
      setConfig(updated);
      setTokenInput("");
      setEditingToken(false);
      setSuccess(publishState === "published" ? "Configuration published." : "Draft configuration saved.");
      const cfgHistory = await getOnesConfigHistory(30);
      setHistory(cfgHistory);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const runConnectionTest = async () => {
    if (!canTestConnection) return;
    setError(null);
    setSuccess(null);
    try {
      const path = endpointPaths.listProjectsPath.includes("teamID")
        ? endpointPaths.listProjectsPath
        : `${endpointPaths.listProjectsPath}${endpointPaths.listProjectsPath.includes("?") ? "&" : "?"}teamID=${encodeURIComponent(teamId)}`;
      await testIntegrationEndpoint({
        baseUrl,
        authType,
        authHeader,
        authSecret: tokenInput.trim() || undefined,
        keepExistingSecret: tokenInput.trim().length === 0,
        method: "GET",
        path,
        timeoutMs
      });
      setConnectionTested(true);
      setSuccess("Connection successful.");
    } catch (e) {
      setConnectionTested(false);
      setError((e as Error).message);
    }
  };

  const fetchProjects = async () => {
    if (!baseUrl.trim() || !teamId.trim()) {
      return;
    }
    setProjectLoading(true);
    setError(null);
    try {
      const merged = new Map<string, { key: string; name: string }>();
      let cursor: string | undefined;
      let pages = 0;
      do {
        const result = await discoverOnesProjects({
          baseUrl,
          authType,
          authHeader,
          authSecret: tokenInput.trim() || undefined,
          keepExistingSecret: tokenInput.trim().length === 0,
          teamId,
          cursor,
          listProjectsPath: endpointPaths.listProjectsPath,
          timeoutMs
        });
        for (const project of result.projects) {
          merged.set(project.key, project);
        }
        cursor = result.nextCursor ?? undefined;
        pages += 1;
      } while (cursor && pages < 20);

      const options = Array.from(merged.values());
      setProjectOptions(options);
      if (!projectKey && options[0]) {
        setProjectKey(options[0].key);
      }
      if (projectKey && !options.some((p) => p.key === projectKey)) {
        setProjectKey("");
      }
      setSuccess(`Loaded ${options.length} projects.`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setProjectLoading(false);
    }
  };

  useEffect(() => {
    if (!config) return;
    if (!baseUrl.trim() || !teamId.trim()) return;
    if (projectOptions.length > 0) return;
    void fetchProjects();
  }, [config, baseUrl, teamId, projectOptions.length]);

  const runEndpointTest = async (def: EndpointDef) => {
    setError(null);
    setSuccess(null);
    try {
      const rawPath = endpointPaths[def.key];
      if (!rawPath?.trim()) throw new Error(`${def.label}: path required`);
      let resolvedPath = applyPlaceholders(rawPath, runtimeVars);
      if (def.method === "GET") {
        resolvedPath = appendQuery(resolvedPath, "teamID", teamId);
        if (projectKey) {
          resolvedPath = appendQuery(resolvedPath, "projectID", projectKey);
          resolvedPath = appendQuery(resolvedPath, "projectKey", projectKey);
        }
        const issueTypeKeyForTest = allowedIssueTypes[0] ?? issueTypes[0]?.key ?? "";
        if (def.key === "listIssueFieldsPath" && issueTypeKeyForTest) {
          resolvedPath = appendQuery(resolvedPath, "issueTypeID", issueTypeKeyForTest);
          resolvedPath = appendQuery(resolvedPath, "issueTypeKey", issueTypeKeyForTest);
        }
      }
      if (unresolved(resolvedPath)) {
        throw new Error(`${def.label}: unresolved placeholders remain (${resolvedPath})`);
      }
      let body: unknown = undefined;
      if (def.requiresBody) {
        const tmpl = endpointBodies[def.key] || "{}";
        const resolvedBody = tmpl
          .replaceAll("{{summary}}", "Sample summary")
          .replaceAll("{{description}}", "Sample description")
          .replaceAll("{{issueTypeID}}", allowedIssueTypes[0] ?? "sample_issue_type")
          .replaceAll("{{workflowID}}", workflowMapping.resolve ?? "sample_workflow")
          .replaceAll("{{comment}}", "Sample comment");
        body = JSON.parse(resolvedBody);
      }
      const result = await testIntegrationEndpoint({
        baseUrl,
        authType,
        authHeader,
        authSecret: tokenInput.trim() || undefined,
        keepExistingSecret: tokenInput.trim().length === 0,
        method: def.method,
        path: resolvedPath,
        body,
        timeoutMs
      });
      if (result.response && typeof result.response === "object") {
        const objectResponse = result.response as Record<string, unknown>;
        if (typeof objectResponse.errorMsg === "string" || typeof objectResponse.errorCode === "string") {
          throw new Error(
            `${def.label}: ONES API error ${String(objectResponse.errorCode ?? "UNKNOWN")} - ${String(objectResponse.errorMsg ?? "Request failed")}`
          );
        }
      }
      if (def.responsePath) {
        const bucket = extractArrayByHint(result.response, def.responsePath);
        if (!bucket) {
          throw new Error(`${def.label}: response path "${def.responsePath}" is not an array`);
        }
      }
      setEndpointTests((prev) => ({ ...prev, [def.key]: result }));
      setSuccess(`${def.label} test passed.`);
    } catch (e) {
      setEndpointTests((prev) => ({ ...prev, [def.key]: { ok: false, status: 0, statusText: "FAILED", url: "", elapsedMs: 0, response: null, error: (e as Error).message } }));
      setError((e as Error).message);
    }
  };

  const refreshIssueTypes = async () => {
    setError(null);
    try {
      await discoverOnesTicketTypes("support_admin");
      const rows = await listOnesTicketTypesInternal();
      setIssueTypes(rows);
      if (!rows.length) setAllowedIssueTypes([]);
      setSuccess(`Fetched ${rows.length} issue types.`);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const refreshStatuses = async () => {
    setError(null);
    try {
      const statuses = await discoverOnesIssueStatuses({ teamId, projectKey });
      setExternalStatuses(statuses.map((x) => ({ key: x.key, name: x.name })));
      setSuccess(`Fetched ${statuses.length} statuses.`);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const runPreflight = async () => {
    setError(null);
    try {
      const result = await runOnesPublishPreflight();
      setPreflight(result);
      setSuccess("Preflight passed.");
    } catch (e) {
      setPreflight(null);
      setError((e as Error).message);
    }
  };

  const doPublish = async () => {
    setSaving(true);
    setError(null);
    try {
      await saveDraft("draft");
      const result = await runOnesPublishPreflight();
      setPreflight(result);
      const published = await publishOnesConfig("support_admin", publishReason.trim() || undefined);
      setConfig(published);
      setSuccess("Configuration published successfully.");
      const cfgHistory = await getOnesConfigHistory(30);
      setHistory(cfgHistory);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const doRollback = async (configId: string) => {
    if (!window.confirm("Rollback to selected configuration version?")) return;
    setSaving(true);
    setError(null);
    try {
      await rollbackOnesConfig(configId, "support_admin", "manual rollback");
      await load();
      setSuccess("Rollback completed.");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return <div className="mx-auto max-w-6xl px-4 py-8 text-sm text-slate-600">Loading configuration...</div>;
  }

  return (
    <div className="mx-auto max-w-6xl space-y-5 px-4 py-8 md:px-8">
      <header className="rounded-mdplus border border-slate-200 bg-white p-5">
        <h1 className="text-3xl font-bold text-[#16171A]">Configuration</h1>
        <p className="mt-2 text-sm text-slate-600">ONES OpenAPI integration control plane for Support Portal, Customer Portal, and AI agent execution.</p>
        <div className="mt-2 text-xs text-slate-500">
          Active Version: {config?.configVersion ?? "-"} | Publish State: {config?.publishState ?? "draft"} | Updated by {config?.updatedBy ?? "-"}
        </div>
      </header>

      {error && <p className="rounded-mdplus border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">{error}</p>}
      {success && <p className="rounded-mdplus border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700">{success}</p>}

      <section className="rounded-mdplus border border-slate-200 bg-white p-4">
        <ol className="grid gap-2 md:grid-cols-4">
          {steps.map((name, index) => (
            <li
              key={name}
              className={`rounded-mdplus border px-3 py-2 text-sm ${
                step === index ? "border-brand-500 bg-brand-50 text-brand-600" : step > index ? "border-emerald-200 bg-emerald-50 text-emerald-700" : "border-slate-200 bg-slate-50 text-slate-600"
              }`}
            >
              {index + 1}. {name}
            </li>
          ))}
        </ol>
      </section>

      {step === 0 && (
        <section className="rounded-mdplus border border-slate-200 bg-white p-5">
          <h2 className="text-lg font-semibold text-[#16171A]">Basic Connection</h2>
          <div className="mt-3 grid gap-3 md:grid-cols-2">
            <label className="space-y-1">
              <span className="text-xs font-semibold text-slate-600">Base URL</span>
              <input className="w-full rounded-mdplus border border-slate-200 px-3 py-2 text-sm" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://demo688.ones.pro/openapi/v2" />
            </label>
            <label className="space-y-1">
              <span className="text-xs font-semibold text-slate-600">Team ID</span>
              <input className="w-full rounded-mdplus border border-slate-200 px-3 py-2 text-sm" value={teamId} onChange={(e) => setTeamId(e.target.value)} />
            </label>
            <label className="space-y-1">
              <span className="text-xs font-semibold text-slate-600">Project</span>
              <select className="w-full rounded-mdplus border border-slate-200 px-3 py-2 text-sm" value={projectKey} onFocus={() => void fetchProjects()} onMouseDown={() => void fetchProjects()} onChange={(e) => setProjectKey(e.target.value)}>
                <option value="">Select project</option>
                {projectKey && !projectOptions.some((p) => p.key === projectKey) ? (
                  <option value={projectKey}>(Current selection)</option>
                ) : null}
                {projectOptions.map((p) => (
                  <option key={p.key} value={p.key}>{p.name}</option>
                ))}
              </select>
              <p className="text-xs text-slate-500">{projectLoading ? "Loading projects..." : "Project list loads when dropdown is opened."}</p>
            </label>
            <label className="space-y-1">
              <span className="text-xs font-semibold text-slate-600">Auth Type</span>
              <select className="w-full rounded-mdplus border border-slate-200 px-3 py-2 text-sm" value={authType} onChange={(e) => setAuthType(e.target.value as "bearer" | "header")}>
                <option value="bearer">Bearer Token</option>
                <option value="header">Header Token</option>
              </select>
            </label>
            <label className="space-y-1">
              <span className="text-xs font-semibold text-slate-600">Auth Header</span>
              <input className="w-full rounded-mdplus border border-slate-200 px-3 py-2 text-sm" value={authHeader} onChange={(e) => setAuthHeader(e.target.value)} />
            </label>
            <label className="space-y-1 md:col-span-2">
              <span className="text-xs font-semibold text-slate-600">Access Token</span>
              {!editingToken ? (
                <div className="flex gap-2">
                  <input className="min-w-0 flex-1 rounded-mdplus border border-slate-200 bg-slate-100 px-3 py-2 text-sm" value={tokenMasked || "No stored token"} type="password" readOnly />
                  <button className="rounded border border-slate-300 px-3 py-2 text-sm" onClick={() => setEditingToken(true)}>Replace</button>
                </div>
              ) : (
                <input className="w-full rounded-mdplus border border-slate-200 px-3 py-2 text-sm" value={tokenInput} onChange={(e) => setTokenInput(e.target.value)} type="password" placeholder="Paste access token" />
              )}
            </label>
            <label className="space-y-1">
              <span className="text-xs font-semibold text-slate-600">Timeout (ms)</span>
              <input className="w-full rounded-mdplus border border-slate-200 px-3 py-2 text-sm" type="number" value={timeoutMs} onChange={(e) => setTimeoutMs(Number(e.target.value) || 12000)} />
            </label>
            <label className="space-y-1">
              <span className="text-xs font-semibold text-slate-600">Retries</span>
              <input className="w-full rounded-mdplus border border-slate-200 px-3 py-2 text-sm" type="number" value={retries} onChange={(e) => setRetries(Number(e.target.value) || 1)} />
            </label>
          </div>
          <div className="mt-4 flex gap-2">
            <button className="rounded-mdplus bg-brand-500 px-3 py-2 text-sm text-white disabled:opacity-60" disabled={!canTestConnection} onClick={() => void runConnectionTest()}>
              Test Connection
            </button>
            <button className="rounded-mdplus border border-slate-200 px-3 py-2 text-sm" onClick={() => void saveDraft("draft")} disabled={saving}>
              Save Draft
            </button>
          </div>
        </section>
      )}

      {step === 1 && (
        <section className="space-y-3 rounded-mdplus border border-slate-200 bg-white p-5">
          <h2 className="text-lg font-semibold text-[#16171A]">Endpoint Configuration</h2>
          {endpointDefs.map((def) => (
            <article key={def.key} className="rounded border border-slate-200 p-3">
              <div className="grid gap-2 md:grid-cols-[180px_1fr_120px]">
                <div className="text-sm font-medium text-[#16171A]">{def.label}</div>
                <input
                  className="rounded border border-slate-200 px-3 py-2 text-sm"
                  value={endpointPaths[def.key]}
                  onChange={(e) => setEndpointPaths((prev) => ({ ...prev, [def.key]: e.target.value }))}
                  placeholder="Endpoint path"
                />
                <button className="rounded border border-slate-200 px-2 py-2 text-xs" onClick={() => void runEndpointTest(def)}>Test</button>
              </div>
              {def.requiresBody && (
                <textarea
                  className="mt-2 w-full rounded border border-slate-200 px-3 py-2 font-mono text-xs"
                  rows={3}
                  value={endpointBodies[def.key] || ""}
                  onChange={(e) => setEndpointBodies((prev) => ({ ...prev, [def.key]: e.target.value }))}
                />
              )}
              <div className="mt-2 text-xs text-slate-500">
                Method: {def.method}
                {endpointTests[def.key] && (
                  <span className={`ml-2 rounded-full px-2 py-0.5 ${endpointTests[def.key]?.ok ? "bg-emerald-100 text-emerald-700" : "bg-rose-100 text-rose-700"}`}>
                    {endpointTests[def.key]?.ok ? "PASS" : `FAIL: ${endpointTests[def.key]?.error ?? endpointTests[def.key]?.statusText}`}
                  </span>
                )}
              </div>
              {endpointTests[def.key] && (
                <details className="mt-2 rounded border border-slate-200 bg-slate-50 p-2">
                  <summary className="cursor-pointer text-xs text-slate-600">Request/Response Preview</summary>
                  <pre className="mt-2 overflow-auto text-xs text-slate-700">{JSON.stringify(endpointTests[def.key], null, 2)}</pre>
                </details>
              )}
            </article>
          ))}
          <button className="rounded-mdplus border border-slate-200 px-3 py-2 text-sm" onClick={() => void saveDraft("draft")} disabled={saving}>Save Endpoint Draft</button>
        </section>
      )}

      {step === 2 && (
        <section className="space-y-4 rounded-mdplus border border-slate-200 bg-white p-5">
          <h2 className="text-lg font-semibold text-[#16171A]">Mapping & Customer Scope</h2>

          <div className="rounded border border-slate-200 p-3">
            <div className="mb-2 flex items-center justify-between">
              <p className="text-sm font-medium">Customer Creatable Issue Types</p>
              <button className="rounded border border-slate-200 px-2 py-1 text-xs" onClick={() => void refreshIssueTypes()}>Refresh from ONES</button>
            </div>
            <div className="grid gap-2 md:grid-cols-2">
              {issueTypes.map((type) => (
                <label key={type.key} className="flex items-center justify-between rounded border border-slate-200 px-2 py-1.5 text-sm">
                  <span>{type.name}</span>
                  <input
                    type="checkbox"
                    checked={allowedIssueTypes.includes(type.key)}
                    onChange={(e) => {
                      setAllowedIssueTypes((prev) => (e.target.checked ? [...new Set([...prev, type.key])] : prev.filter((x) => x !== type.key)));
                    }}
                  />
                </label>
              ))}
            </div>
          </div>

          <div className="rounded border border-slate-200 p-3">
            <div className="mb-2 flex items-center justify-between">
              <p className="text-sm font-medium">Status Mapping (Internal → ONES)</p>
              <button className="rounded border border-slate-200 px-2 py-1 text-xs" onClick={() => void refreshStatuses()}>Load ONES Statuses</button>
            </div>
            <div className="space-y-2">
              {internalStatuses.map((status) => (
                <div key={status} className="grid grid-cols-[180px_1fr] gap-2">
                  <div className="rounded border border-slate-200 bg-slate-50 px-2 py-2 text-sm">{status}</div>
                  <select
                    className="rounded border border-slate-200 px-2 py-2 text-sm"
                    value={statusMapping[status] || ""}
                    onChange={(e) => setStatusMapping((prev) => ({ ...prev, [status]: e.target.value }))}
                  >
                    <option value="">Select ONES status ID</option>
                    {externalStatuses.map((row) => (
                      <option key={row.key} value={row.key}>{row.name}</option>
                    ))}
                  </select>
                </div>
              ))}
            </div>
          </div>

          <div className="rounded border border-slate-200 p-3">
            <p className="mb-2 text-sm font-medium">Workflow Mapping (Action → workflowID)</p>
            <div className="space-y-2">
              {workflowActions.map((action) => (
                <div key={action} className="grid grid-cols-[200px_1fr] gap-2">
                  <div className="rounded border border-slate-200 bg-slate-50 px-2 py-2 text-sm">{action}</div>
                  <input
                    className="rounded border border-slate-200 px-2 py-2 text-sm"
                    value={workflowMapping[action] || ""}
                    onChange={(e) => setWorkflowMapping((prev) => ({ ...prev, [action]: e.target.value }))}
                    placeholder="workflowID"
                  />
                </div>
              ))}
            </div>
          </div>

          <button className="rounded-mdplus border border-slate-200 px-3 py-2 text-sm" onClick={() => void saveDraft("draft")} disabled={saving}>Save Mapping Draft</button>
        </section>
      )}

      {step === 3 && (
        <section className="space-y-4 rounded-mdplus border border-slate-200 bg-white p-5">
          <h2 className="text-lg font-semibold text-[#16171A]">Publish & Rollback</h2>
          <label className="space-y-1 block">
            <span className="text-xs font-semibold text-slate-600">Change Reason</span>
            <textarea className="w-full rounded border border-slate-200 px-3 py-2 text-sm" rows={3} value={publishReason} onChange={(e) => setPublishReason(e.target.value)} />
          </label>
          <div className="flex flex-wrap gap-2">
            <button className="rounded-mdplus border border-slate-200 px-3 py-2 text-sm" onClick={() => void saveDraft("draft")} disabled={saving}>Save Draft</button>
            <button className="rounded-mdplus border border-slate-200 px-3 py-2 text-sm" onClick={() => void runPreflight()} disabled={saving}>Run Preflight</button>
            <button className="rounded-mdplus bg-brand-500 px-3 py-2 text-sm text-white" onClick={() => void doPublish()} disabled={saving}>Publish</button>
          </div>
          {preflight && (
            <div className={`rounded border p-3 text-sm ${preflight.ready ? "border-emerald-200 bg-emerald-50 text-emerald-800" : "border-rose-200 bg-rose-50 text-rose-700"}`}>
              <p className="font-semibold">{preflight.ready ? "Preflight Ready" : "Preflight Failed"}</p>
              <pre className="mt-2 overflow-auto text-xs">{JSON.stringify(preflight, null, 2)}</pre>
            </div>
          )}
          <div className="rounded border border-slate-200 p-3">
            <p className="mb-2 text-sm font-medium">Configuration History</p>
            <div className="space-y-2">
              {history.map((item) => (
                <div key={item.id} className="flex flex-wrap items-center justify-between gap-2 rounded border border-slate-200 px-2 py-2 text-xs">
                  <div>
                    v{item.version} · {item.publishState} · {item.updatedBy} · {new Date(item.updatedAt).toLocaleString()}
                    {item.isActive && <span className="ml-2 rounded bg-brand-100 px-1.5 py-0.5 text-brand-700">active</span>}
                  </div>
                  <button className="rounded border border-slate-200 px-2 py-1" disabled={item.isActive || saving} onClick={() => void doRollback(item.id)}>Rollback</button>
                </div>
              ))}
            </div>
          </div>
        </section>
      )}

      <footer className="flex items-center justify-between rounded-mdplus border border-slate-200 bg-white p-3">
        <button className="rounded border border-slate-200 px-3 py-2 text-sm disabled:opacity-40" disabled={step === 0} onClick={() => setStep((s) => Math.max(0, s - 1) as Step)}>
          Back
        </button>
        <button className="rounded bg-brand-500 px-3 py-2 text-sm text-white disabled:opacity-40" disabled={step === 3 || !canGoNext} onClick={() => setStep((s) => Math.min(3, s + 1) as Step)}>
          Next
        </button>
      </footer>
    </div>
  );
}
