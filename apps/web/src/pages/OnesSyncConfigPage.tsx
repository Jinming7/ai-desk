import { useEffect, useMemo, useState } from "react";
import { discoverOnesProjects, getOnesSyncConfig, testIntegrationEndpoint, updateOnesSyncConfig } from "../lib/api";

type WizardStep = 0 | 1 | 2 | 3;
type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
type AuthType = "bearer" | "header";

type EndpointConfig = {
  key: string;
  label: string;
  method: HttpMethod;
  path: string;
  responsePath?: string;
  bodyTemplate?: string;
  testResult?: TestResult | null;
};

type TestResult = {
  ok: boolean;
  status: number;
  statusText: string;
  url: string;
  elapsedMs: number;
  response: unknown;
};

type KeyValueHeader = { id: string; key: string; value: string };
type ProjectOption = { key: string; name: string };

const STEPS = ["Connection", "Endpoints", "Field Mapping", "Summary"];
const INTERNAL_STATUSES = ["OPEN", "IN_PROGRESS", "WAITING_CUSTOMER", "ESCALATED_RND", "RESOLVED", "CLOSED"];

function getAtPath(input: unknown, path?: string): unknown {
  if (!path?.trim()) return input;
  return path
    .split(".")
    .filter(Boolean)
    .reduce<unknown>((acc, key) => {
      if (acc && typeof acc === "object" && key in (acc as Record<string, unknown>)) {
        return (acc as Record<string, unknown>)[key];
      }
      return undefined;
    }, input);
}

function parseListResponse(input: unknown, path?: string): Array<Record<string, unknown>> {
  const source = getAtPath(input, path);
  if (Array.isArray(source)) {
    return source.filter((row) => row && typeof row === "object") as Array<Record<string, unknown>>;
  }
  if (source && typeof source === "object") {
    const obj = source as Record<string, unknown>;
    const candidates = [obj.items, obj.list, obj.data, obj.projects, obj.statuses, obj.values];
    for (const candidate of candidates) {
      if (Array.isArray(candidate)) return candidate as Array<Record<string, unknown>>;
    }
  }
  return [];
}

function toPrettyJson(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return "{}";
  }
}

function resolveTemplatePath(path: string, vars: Record<string, string>) {
  let resolved = path;
  Object.entries(vars).forEach(([k, v]) => {
    resolved = resolved.replaceAll(`{{${k}}}`, encodeURIComponent(v));
  });
  return resolved;
}

function pill(ok?: boolean) {
  if (ok === undefined) return "bg-slate-100 text-slate-600";
  return ok ? "bg-emerald-100 text-emerald-700" : "bg-rose-100 text-rose-700";
}

export function OnesSyncConfigPage() {
  const [step, setStep] = useState<WizardStep>(0);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const [profileName, setProfileName] = useState("default");
  const [baseUrl, setBaseUrl] = useState("");
  const [authType, setAuthType] = useState<AuthType>("bearer");
  const [authHeader, setAuthHeader] = useState("Authorization");
  const [teamId, setTeamId] = useState("");
  const [tokenMasked, setTokenMasked] = useState("");
  const [editingToken, setEditingToken] = useState(false);
  const [tokenInput, setTokenInput] = useState("");
  const [timeoutMs, setTimeoutMs] = useState(12000);
  const [retries, setRetries] = useState(1);
  const [connectionTest, setConnectionTest] = useState<TestResult | null>(null);
  const [customHeaders, setCustomHeaders] = useState<KeyValueHeader[]>([]);

  const [projects, setProjects] = useState<ProjectOption[]>([]);
  const [projectCursor, setProjectCursor] = useState<string | null>(null);
  const [projectLoading, setProjectLoading] = useState(false);
  const [selectedProjectKey, setSelectedProjectKey] = useState("");
  const [selectedProjectName, setSelectedProjectName] = useState("");
  const [externalStatuses, setExternalStatuses] = useState<Array<{ key: string; name: string }>>([]);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [fieldMappingLoaded, setFieldMappingLoaded] = useState(false);

  const [projectsEndpoint, setProjectsEndpoint] = useState<EndpointConfig>({
    key: "projects.list",
    label: "Get Projects (List)",
    method: "GET",
    path: "/openapi/v2/project/projects?teamID={{team.id}}",
    responsePath: "projects"
  });

  const [workItemEndpoints, setWorkItemEndpoints] = useState<EndpointConfig[]>([
    { key: "workitems.list", label: "Get Work Item List", method: "GET", path: "/api/v1/tickets?project={{project.key}}", responsePath: "tickets" },
    { key: "workitems.detail", label: "Get Work Item Details", method: "GET", path: "/api/v1/tickets/{{workItem.id}}" },
    { key: "workitems.create", label: "Create Work Item", method: "POST", path: "/api/v1/tickets", bodyTemplate: "{\n  \"title\": \"{{summary}}\",\n  \"description\": \"{{description}}\",\n  \"onesTicketTypeKey\": \"{{issueTypeId}}\"\n}" },
    { key: "workitems.workflow", label: "Execute Workflow (Change Status)", method: "POST", path: "/api/v1/tickets/{{workItem.id}}/transition", bodyTemplate: "{\n  \"transition\": {\n    \"id\": \"{{transition.id}}\"\n  }\n}" },
    { key: "workitems.status", label: "Get Work Item Status List", method: "GET", path: "/api/v1/ticket-statuses", responsePath: "statuses" }
  ]);

  const [commentEndpoints, setCommentEndpoints] = useState<EndpointConfig[]>([
    { key: "comments.list", label: "Get Comments", method: "GET", path: "/api/v1/tickets/{{workItem.id}}/comments", responsePath: "comments" },
    { key: "comments.add", label: "Add Comment", method: "POST", path: "/api/v1/tickets/{{workItem.id}}/comments", bodyTemplate: "{\n  \"body\": \"{{comment.body}}\"\n}" },
    { key: "comments.update", label: "Update Comment", method: "PATCH", path: "/api/v1/tickets/{{workItem.id}}/comments/{{comment.id}}", bodyTemplate: "{\n  \"body\": \"{{comment.body}}\"\n}" },
    { key: "comments.delete", label: "Delete Comment", method: "DELETE", path: "/api/v1/tickets/{{workItem.id}}/comments/{{comment.id}}" }
  ]);

  const runtimePlaceholders = useMemo(
    () => ({
      "team.id": teamId,
      "project.id": selectedProjectKey,
      "project.key": selectedProjectKey,
      "workItem.id": "sample-work-item-id",
      "comment.id": "sample-comment-id",
      summary: "Sample ticket title",
      description: "Sample ticket description",
      "transition.id": "to-in-progress",
      "comment.body": "Sample comment from integration",
      issueTypeId: "sample-issue-type"
    }),
    [selectedProjectKey, teamId]
  );

  const connectionPassed = Boolean(connectionTest?.ok);
  const canGoNext = (current: WizardStep) => {
    if (current === 0) return connectionPassed;
    if (current === 1) return Boolean(selectedProjectKey);
    if (current === 2) return fieldMappingLoaded;
    return true;
  };

  const mergedHeaders = useMemo(() => {
    const out: Record<string, string> = {};
    for (const row of customHeaders) {
      const k = row.key.trim();
      const v = row.value.trim();
      if (!k || !v) continue;
      out[k] = v;
    }
    return out;
  }, [customHeaders]);

  const secureTokenAvailable = tokenMasked.length > 0 && !editingToken;
  const keepExistingSecret = secureTokenAvailable && tokenInput.trim().length === 0;

  const loadInitial = async () => {
    setLoading(true);
    setError(null);
    try {
      const config = await getOnesSyncConfig();
      if (config) {
        setProfileName(config.profileName || "default");
        setBaseUrl(config.baseUrl);
        setAuthType(config.authType);
        setAuthHeader(config.authHeader);
        setTokenMasked(config.authSecretMasked || "");
        setTeamId(config.onesTeamId ?? "");
        setTimeoutMs(config.timeoutMs);
        setRetries(config.retries);
        setSelectedProjectKey(config.onesProjectKey ?? "");
        setProjectsEndpoint((p) => ({ ...p, path: config.listProjectsPath }));
        setWorkItemEndpoints((prev) =>
          prev.map((item) => {
            if (item.key === "workitems.create") return { ...item, path: config.createTicketPath };
            if (item.key === "workitems.list") return { ...item, path: config.listTicketTypesPath };
            if (item.key === "workitems.status") return { ...item, path: config.listTicketTypesPath };
            return item;
          })
        );
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadInitial();
  }, []);

  const runEndpointTest = async (endpoint: EndpointConfig, setResult: (result: TestResult) => void) => {
    if (!baseUrl.trim()) return setError("Base URL is required.");
    const resolvedPath = resolveTemplatePath(endpoint.path, runtimePlaceholders);
    let body: unknown = undefined;
    if (endpoint.bodyTemplate?.trim()) {
      const resolvedBody = resolveTemplatePath(endpoint.bodyTemplate, runtimePlaceholders);
      try {
        body = JSON.parse(resolvedBody);
      } catch {
        body = resolvedBody;
      }
    }
    const result = await testIntegrationEndpoint({
      baseUrl,
      authType,
      authHeader,
      authSecret: tokenInput.trim() || undefined,
      keepExistingSecret,
      customHeaders: mergedHeaders,
      method: endpoint.method,
      path: resolvedPath,
      body,
      timeoutMs
    });
    setResult(result);
  };

  const runConnectionTest = async () => {
    setError(null);
    setSuccess(null);
    try {
      const result = await testIntegrationEndpoint({
        baseUrl,
        authType,
        authHeader,
        authSecret: tokenInput.trim() || undefined,
        keepExistingSecret,
        customHeaders: mergedHeaders,
        method: "GET",
        path: resolveTemplatePath(projectsEndpoint.path, runtimePlaceholders),
        timeoutMs
      });
      setConnectionTest(result);
      if (result.ok) setSuccess("Connection successful.");
    } catch (e) {
      setConnectionTest(null);
      setError((e as Error).message);
    }
  };

  const handleFetchProjects = async (append: boolean) => {
    setProjectLoading(true);
    setError(null);
    try {
      const result = await discoverOnesProjects({
        baseUrl,
        authType,
        authHeader,
        authSecret: tokenInput.trim() || undefined,
        keepExistingSecret,
        teamId,
        cursor: append ? projectCursor ?? undefined : undefined,
        listProjectsPath: projectsEndpoint.path,
        timeoutMs
      });
      const next = append ? [...projects, ...result.projects] : result.projects;
      setProjects(next);
      setProjectCursor(result.nextCursor);
      const selected = next.find((p) => p.key === selectedProjectKey) ?? next[0];
      if (selected) {
        setSelectedProjectKey(selected.key);
        setSelectedProjectName(selected.name);
      }
      setProjectsEndpoint((ep) => ({ ...ep, testResult: { ok: true, status: 200, statusText: "OK", url: "", elapsedMs: 0, response: result } }));
      setSuccess(`Loaded ${result.projects.length} projects.`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setProjectLoading(false);
    }
  };

  const setEndpoint = (scope: "workitem" | "comment", key: string, updater: (item: EndpointConfig) => EndpointConfig) => {
    if (scope === "workitem") {
      setWorkItemEndpoints((prev) => prev.map((item) => (item.key === key ? updater(item) : item)));
    } else {
      setCommentEndpoints((prev) => prev.map((item) => (item.key === key ? updater(item) : item)));
    }
  };

  const testWorkItemEndpoint = async (key: string) => {
    setError(null);
    const endpoint = workItemEndpoints.find((x) => x.key === key);
    if (!endpoint) return;
    try {
      await runEndpointTest(endpoint, (result) => {
        setEndpoint("workitem", key, (item) => ({ ...item, testResult: result }));
        if (key === "workitems.status") {
          const rows = parseListResponse(result.response, endpoint.responsePath);
          const statuses = rows
            .map((row) => ({
              key: String(row.key ?? row.id ?? row.status ?? row.value ?? ""),
              name: String(row.name ?? row.title ?? row.label ?? row.key ?? row.id ?? "")
            }))
            .filter((s) => s.key && s.name);
          setExternalStatuses(statuses);
          setFieldMappingLoaded(statuses.length > 0);
        }
      });
      setSuccess(`${endpoint.label} test passed.`);
    } catch (e) {
      setEndpoint("workitem", key, (item) => ({ ...item, testResult: null }));
      setError((e as Error).message);
    }
  };

  const testCommentEndpoint = async (key: string) => {
    setError(null);
    const endpoint = commentEndpoints.find((x) => x.key === key);
    if (!endpoint) return;
    try {
      await runEndpointTest(endpoint, (result) => {
        setEndpoint("comment", key, (item) => ({ ...item, testResult: result }));
      });
      setSuccess(`${endpoint.label} test passed.`);
    } catch (e) {
      setEndpoint("comment", key, (item) => ({ ...item, testResult: null }));
      setError((e as Error).message);
    }
  };

  const saveAll = async () => {
    setSaving(true);
    setError(null);
    setSuccess(null);
    try {
      await updateOnesSyncConfig({
        profileName: profileName.trim() || "default",
        baseUrl,
        authType,
        authHeader,
        authSecret: tokenInput.trim() || undefined,
        keepExistingSecret,
        createTicketPath: workItemEndpoints.find((x) => x.key === "workitems.create")?.path || "/api/v1/tickets",
        listProjectsPath: projectsEndpoint.path,
        listTicketTypesPath: workItemEndpoints.find((x) => x.key === "workitems.list")?.path || "/api/v1/ticket-types",
        listFieldsPathTemplate: "/api/v1/ticket-types/{ticketTypeKey}/fields",
        timeoutMs,
        retries,
        dataSourceMode: "ones_primary",
        onesProjectKey: selectedProjectKey,
        onesTeamId: teamId,
        actor: "support_admin"
      });
      setSuccess("Integration configuration saved and activated.");
      setTokenInput("");
      setEditingToken(false);
      await loadInitial();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return <div className="mx-auto max-w-6xl px-4 py-8 text-sm text-slate-600">Loading configuration wizard...</div>;
  }

  return (
    <div className="mx-auto max-w-6xl space-y-5 px-4 py-8 md:px-8">
      <header className="rounded-mdplus border border-slate-200 bg-white p-5">
        <h1 className="text-3xl font-bold text-[#16171A]">Configuration</h1>
        <p className="mt-2 text-sm text-slate-600">Guided wizard for API connection, endpoint setup, mapping, and activation.</p>
      </header>

      {error && <p className="rounded-mdplus border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">{error}</p>}
      {success && <p className="rounded-mdplus border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700">{success}</p>}

      <section className="rounded-mdplus border border-slate-200 bg-white p-4">
        <ol className="grid grid-cols-1 gap-3 md:grid-cols-4">
          {STEPS.map((name, index) => {
            const i = index as WizardStep;
            const active = step === i;
            const completed = i < step;
            return (
              <li key={name} className={`rounded-mdplus border px-3 py-2 text-sm ${active ? "border-brand-500 bg-brand-50 text-brand-600" : completed ? "border-emerald-200 bg-emerald-50 text-emerald-700" : "border-slate-200 bg-slate-50 text-slate-600"}`}>
                <span className="font-semibold">{index + 1}. {name}</span>
              </li>
            );
          })}
        </ol>
      </section>

      {step === 0 && (
        <section className="space-y-4 rounded-mdplus border border-slate-200 bg-white p-5">
          <h2 className="text-xl font-semibold text-[#16171A]">Step 1. Basic Connection</h2>
          <div className="grid gap-3 md:grid-cols-2">
            <label className="space-y-1">
              <span className="text-xs font-semibold text-slate-600">Profile Name</span>
              <input className="w-full rounded-mdplus border border-slate-200 px-3 py-2 text-sm" value={profileName} onChange={(e) => setProfileName(e.target.value)} placeholder="JIRA Production Instance" />
            </label>
            <label className="space-y-1">
              <span className="text-xs font-semibold text-slate-600">Base URL</span>
              <input className="w-full rounded-mdplus border border-slate-200 px-3 py-2 text-sm" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://demo688.ones.pro/" />
            </label>
            <label className="space-y-1">
              <span className="text-xs font-semibold text-slate-600">Team ID</span>
              <input className="w-full rounded-mdplus border border-slate-200 px-3 py-2 text-sm" value={teamId} onChange={(e) => setTeamId(e.target.value)} placeholder="3xy3ePkc" />
            </label>
            <label className="space-y-1">
              <span className="text-xs font-semibold text-slate-600">Auth Type</span>
              <select className="w-full rounded-mdplus border border-slate-200 px-3 py-2 text-sm" value={authType} onChange={(e) => setAuthType(e.target.value as AuthType)}>
                <option value="bearer">Bearer Token</option>
                <option value="header">API Key Header</option>
              </select>
            </label>
            <label className="space-y-1">
              <span className="text-xs font-semibold text-slate-600">Auth Header</span>
              <input className="w-full rounded-mdplus border border-slate-200 px-3 py-2 text-sm" value={authHeader} onChange={(e) => setAuthHeader(e.target.value)} placeholder="Authorization" />
            </label>
            <label className="space-y-1">
              <span className="text-xs font-semibold text-slate-600">Token</span>
              {!editingToken ? (
                <div className="flex gap-2">
                  <input className="min-w-0 flex-1 rounded-mdplus border border-slate-200 bg-slate-100 px-3 py-2 text-sm" type="password" value={tokenMasked || "No token stored"} readOnly />
                  <button className="rounded-mdplus border border-slate-300 bg-white px-3 py-2 text-sm" onClick={() => setEditingToken(true)}>Replace</button>
                </div>
              ) : (
                <div className="flex gap-2">
                  <input className="min-w-0 flex-1 rounded-mdplus border border-slate-200 px-3 py-2 text-sm" type="password" value={tokenInput} onChange={(e) => setTokenInput(e.target.value)} placeholder="Enter token" />
                  <button className="rounded-mdplus border border-slate-300 bg-white px-3 py-2 text-sm" onClick={() => { setEditingToken(false); setTokenInput(""); }}>Cancel</button>
                </div>
              )}
            </label>
          </div>

          <div className="rounded-mdplus border border-slate-200 bg-slate-50 p-3">
            <div className="mb-2 flex items-center justify-between">
              <p className="text-xs font-semibold uppercase tracking-wide text-slate-600">Custom Headers (Optional)</p>
              <button
                className="rounded-mdplus border border-slate-300 bg-white px-2 py-1 text-xs"
                onClick={() => setCustomHeaders((prev) => [...prev, { id: crypto.randomUUID(), key: "", value: "" }])}
              >
                Add Header
              </button>
            </div>
            <div className="space-y-2">
              {customHeaders.length === 0 && <p className="text-xs text-slate-500">No custom headers added.</p>}
              {customHeaders.map((row) => (
                <div key={row.id} className="grid grid-cols-[1fr_1fr_auto] gap-2">
                  <input className="rounded-mdplus border border-slate-200 px-2 py-1 text-sm" value={row.key} placeholder="Header name" onChange={(e) => setCustomHeaders((prev) => prev.map((x) => (x.id === row.id ? { ...x, key: e.target.value } : x)))} />
                  <input className="rounded-mdplus border border-slate-200 px-2 py-1 text-sm" value={row.value} placeholder="Header value" onChange={(e) => setCustomHeaders((prev) => prev.map((x) => (x.id === row.id ? { ...x, value: e.target.value } : x)))} />
                  <button className="rounded-mdplus border border-rose-200 bg-white px-2 py-1 text-xs text-rose-700" onClick={() => setCustomHeaders((prev) => prev.filter((x) => x.id !== row.id))}>Remove</button>
                </div>
              ))}
            </div>
            {Object.keys(mergedHeaders).length > 0 && <p className="mt-2 text-xs text-slate-500">Configured custom headers: {Object.keys(mergedHeaders).join(", ")}</p>}
          </div>

          <div className="flex items-center gap-2">
            <button className="rounded-mdplus bg-brand-500 px-3 py-2 text-sm text-white" onClick={() => void runConnectionTest()}>Test Connection</button>
            <span className={`rounded-full px-2 py-1 text-xs ${pill(connectionTest?.ok)}`}>
              {connectionTest ? `${connectionTest.status} ${connectionTest.statusText} (${connectionTest.elapsedMs}ms)` : "Not tested"}
            </span>
          </div>
        </section>
      )}

      {step === 1 && (
        <section className="space-y-4 rounded-mdplus border border-slate-200 bg-white p-5">
          <h2 className="text-xl font-semibold text-[#16171A]">Step 2. Endpoint & Resource Configuration</h2>

          <article className="rounded-mdplus border border-slate-200 p-4">
            <h3 className="text-sm font-semibold text-[#16171A]">Projects</h3>
            <div className="mt-2 grid gap-3 md:grid-cols-4">
              <select className="rounded-mdplus border border-slate-200 px-2 py-2 text-sm" value={projectsEndpoint.method} onChange={(e) => setProjectsEndpoint((p) => ({ ...p, method: e.target.value as HttpMethod }))}>
                <option>GET</option>
              </select>
              <input className="md:col-span-2 rounded-mdplus border border-slate-200 px-3 py-2 text-sm" value={projectsEndpoint.path} onChange={(e) => setProjectsEndpoint((p) => ({ ...p, path: e.target.value }))} />
              <input className="rounded-mdplus border border-slate-200 px-3 py-2 text-sm" value={projectsEndpoint.responsePath || ""} onChange={(e) => setProjectsEndpoint((p) => ({ ...p, responsePath: e.target.value }))} placeholder="Response Data Path" />
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <button className="rounded-mdplus border border-slate-300 bg-white px-3 py-2 text-sm" disabled={projectLoading} onClick={() => void handleFetchProjects(false)}>Test & Load Projects</button>
              <button className="rounded-mdplus border border-slate-300 bg-white px-3 py-2 text-sm" disabled={!projectCursor || projectLoading} onClick={() => void handleFetchProjects(true)}>Load More</button>
              <span className={`rounded-full px-2 py-1 text-xs ${pill(projectsEndpoint.testResult?.ok)}`}>
                {projectsEndpoint.testResult ? "Loaded" : "Not tested"}
              </span>
            </div>
            <label className="mt-3 block space-y-1">
              <span className="text-xs font-semibold text-slate-600">Project for this Integration</span>
              <select className="w-full rounded-mdplus border border-slate-200 px-3 py-2 text-sm" value={selectedProjectKey} onChange={(e) => { setSelectedProjectKey(e.target.value); setSelectedProjectName(projects.find((p) => p.key === e.target.value)?.name ?? ""); }}>
                <option value="">Select project</option>
                {projects.map((p) => (
                  <option key={p.key} value={p.key}>{p.name}</option>
                ))}
              </select>
            </label>
          </article>

          <article className="rounded-mdplus border border-slate-200 p-4">
            <h3 className="text-sm font-semibold text-[#16171A]">Work Items</h3>
            <p className="mt-1 text-xs text-slate-500">Use placeholders: {`{{project.id}}`} {`{{project.key}}`} {`{{workItem.id}}`} {`{{transition.id}}`}.</p>
            <div className="mt-3 space-y-3">
              {workItemEndpoints.map((ep) => (
                <div key={ep.key} className="rounded-md border border-slate-200 p-3">
                  <p className="mb-2 text-sm font-medium text-[#16171A]">{ep.label}</p>
                  <div className="grid gap-2 md:grid-cols-4">
                    <select className="rounded-mdplus border border-slate-200 px-2 py-2 text-sm" value={ep.method} onChange={(e) => setEndpoint("workitem", ep.key, (item) => ({ ...item, method: e.target.value as HttpMethod }))}>
                      {["GET", "POST", "PUT", "PATCH", "DELETE"].map((m) => <option key={m} value={m}>{m}</option>)}
                    </select>
                    <input className="md:col-span-2 rounded-mdplus border border-slate-200 px-3 py-2 text-sm" value={ep.path} onChange={(e) => setEndpoint("workitem", ep.key, (item) => ({ ...item, path: e.target.value }))} />
                    <input className="rounded-mdplus border border-slate-200 px-3 py-2 text-sm" value={ep.responsePath || ""} onChange={(e) => setEndpoint("workitem", ep.key, (item) => ({ ...item, responsePath: e.target.value }))} placeholder="Response Data Path" />
                  </div>
                  {ep.method !== "GET" && (
                    <textarea className="mt-2 w-full rounded-mdplus border border-slate-200 px-3 py-2 font-mono text-xs" rows={4} value={ep.bodyTemplate || ""} onChange={(e) => setEndpoint("workitem", ep.key, (item) => ({ ...item, bodyTemplate: e.target.value }))} />
                  )}
                  <div className="mt-2 flex items-center gap-2">
                    <button className="rounded-mdplus border border-slate-300 bg-white px-3 py-1.5 text-xs" onClick={() => void testWorkItemEndpoint(ep.key)}>Test</button>
                    <span className={`rounded-full px-2 py-1 text-xs ${pill(ep.testResult?.ok)}`}>
                      {ep.testResult ? `${ep.testResult.status} ${ep.testResult.statusText}` : "Not tested"}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </article>

          <article className="rounded-mdplus border border-slate-200 p-4">
            <h3 className="text-sm font-semibold text-[#16171A]">Comments</h3>
            <p className="mt-1 text-xs text-slate-500">Use placeholders: {`{{workItem.id}}`} {`{{comment.id}}`} {`{{comment.body}}`}.</p>
            <div className="mt-3 space-y-3">
              {commentEndpoints.map((ep) => (
                <div key={ep.key} className="rounded-md border border-slate-200 p-3">
                  <p className="mb-2 text-sm font-medium text-[#16171A]">{ep.label}</p>
                  <div className="grid gap-2 md:grid-cols-3">
                    <select className="rounded-mdplus border border-slate-200 px-2 py-2 text-sm" value={ep.method} onChange={(e) => setEndpoint("comment", ep.key, (item) => ({ ...item, method: e.target.value as HttpMethod }))}>
                      {["GET", "POST", "PUT", "PATCH", "DELETE"].map((m) => <option key={m} value={m}>{m}</option>)}
                    </select>
                    <input className="md:col-span-2 rounded-mdplus border border-slate-200 px-3 py-2 text-sm" value={ep.path} onChange={(e) => setEndpoint("comment", ep.key, (item) => ({ ...item, path: e.target.value }))} />
                  </div>
                  {ep.method !== "GET" && ep.method !== "DELETE" && (
                    <textarea className="mt-2 w-full rounded-mdplus border border-slate-200 px-3 py-2 font-mono text-xs" rows={3} value={ep.bodyTemplate || ""} onChange={(e) => setEndpoint("comment", ep.key, (item) => ({ ...item, bodyTemplate: e.target.value }))} />
                  )}
                  <div className="mt-2 flex items-center gap-2">
                    <button className="rounded-mdplus border border-slate-300 bg-white px-3 py-1.5 text-xs" onClick={() => void testCommentEndpoint(ep.key)}>Test</button>
                    <span className={`rounded-full px-2 py-1 text-xs ${pill(ep.testResult?.ok)}`}>
                      {ep.testResult ? `${ep.testResult.status} ${ep.testResult.statusText}` : "Not tested"}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </article>
        </section>
      )}

      {step === 2 && (
        <section className="space-y-4 rounded-mdplus border border-slate-200 bg-white p-5">
          <h2 className="text-xl font-semibold text-[#16171A]">Step 3. Field Mapping</h2>
          <p className="text-sm text-slate-600">Load external statuses from the configured “Get Work Item Status List” endpoint, then map to internal statuses.</p>
          <div className="flex items-center gap-2">
            <button
              className="rounded-mdplus bg-brand-500 px-3 py-2 text-sm text-white"
              onClick={() => void testWorkItemEndpoint("workitems.status")}
            >
              Load External Statuses
            </button>
            <span className="text-xs text-slate-500">{externalStatuses.length} statuses loaded</span>
          </div>

          <div className="overflow-hidden rounded-mdplus border border-slate-200">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-600">
                <tr>
                  <th className="px-3 py-2">Your System Status</th>
                  <th className="px-3 py-2">External System Status</th>
                </tr>
              </thead>
              <tbody>
                {INTERNAL_STATUSES.map((status) => (
                  <tr key={status} className="border-t border-slate-100">
                    <td className="px-3 py-2 font-medium text-[#16171A]">{status}</td>
                    <td className="px-3 py-2">
                      <select
                        className="w-full rounded-mdplus border border-slate-200 px-2 py-1.5 text-sm"
                        value={mapping[status] || ""}
                        onChange={(e) => {
                          setMapping((prev) => ({ ...prev, [status]: e.target.value }));
                          setFieldMappingLoaded(true);
                        }}
                      >
                        <option value="">Select external status</option>
                        {externalStatuses.map((item) => (
                          <option key={item.key} value={item.key}>{item.name}</option>
                        ))}
                      </select>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {step === 3 && (
        <section className="space-y-4 rounded-mdplus border border-slate-200 bg-white p-5">
          <h2 className="text-xl font-semibold text-[#16171A]">Step 4. Summary & Activation</h2>
          <div className="grid gap-4 md:grid-cols-3">
            <article className="rounded-md border border-slate-200 p-3">
              <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Connection</p>
              <pre className="mt-2 whitespace-pre-wrap break-all text-xs text-slate-700">{toPrettyJson({ profileName, baseUrl, authType, authHeader, teamId, tokenStored: Boolean(tokenMasked || tokenInput) })}</pre>
            </article>
            <article className="rounded-md border border-slate-200 p-3">
              <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Endpoints</p>
              <pre className="mt-2 whitespace-pre-wrap break-all text-xs text-slate-700">{toPrettyJson({ projectsEndpoint, workItemEndpoints, commentEndpoints, selectedProject: { key: selectedProjectKey, name: selectedProjectName } })}</pre>
            </article>
            <article className="rounded-md border border-slate-200 p-3">
              <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Mappings</p>
              <pre className="mt-2 whitespace-pre-wrap break-all text-xs text-slate-700">{toPrettyJson({ mapping })}</pre>
            </article>
          </div>
          <button className="rounded-mdplus bg-brand-500 px-4 py-2 text-sm text-white disabled:opacity-70" disabled={saving} onClick={() => void saveAll()}>
            {saving ? "Saving..." : "Activate Integration"}
          </button>
        </section>
      )}

      <footer className="flex items-center justify-between rounded-mdplus border border-slate-200 bg-white p-3">
        <button
          className="rounded-mdplus border border-slate-300 bg-white px-3 py-2 text-sm disabled:opacity-40"
          disabled={step === 0}
          onClick={() => setStep((s) => Math.max(0, s - 1) as WizardStep)}
        >
          Back
        </button>
        <button
          className="rounded-mdplus bg-brand-500 px-3 py-2 text-sm text-white disabled:opacity-40"
          disabled={step === 3 || !canGoNext(step)}
          onClick={() => setStep((s) => Math.min(3, s + 1) as WizardStep)}
        >
          Next
        </button>
      </footer>
    </div>
  );
}
