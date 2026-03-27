import * as Dialog from "@radix-ui/react-dialog";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  discoverOnesIssueStatuses,
  discoverOnesProjects,
  ensureDocsComKb,
  getDocsComKbStatus,
  discoverProjectIssueTypes,
  getOnesSyncConfig,
  getProjectIssueTypeConfig,
  getProjectIssueTypeFields,
  listProjectIssueTypes,
  saveProjectIssueTypeConfig,
  setProjectIssueTypeExposure,
  updateOnesSyncConfig
} from "../lib/api";
import type { DocsComEnsureResult, DocsComStatusResult, OnesProjectIssueType, OnesProjectIssueTypeConfig, OnesSyncConfig } from "../lib/types";

type Step = 0 | 1;
type ToastKind = "error" | "success";
type ToastItem = { id: number; kind: ToastKind; message: string };
const steps = ["1. Setup & Project", "2. Ticket Types"] as const;
const INTERNAL_ISSUE_FORM_FIELDS_PATH = "/project/api/ones-project/team/{teamID}/issue_form/fields";

function categorizeProjectDiscoveryError(message: string) {
  const lower = message.toLowerCase();
  if (lower.includes("401") || lower.includes("unauthorized") || lower.includes("token")) {
    return "Authentication failed. Check Access Token and Auth Header.";
  }
  if (lower.includes("403") || lower.includes("forbidden") || lower.includes("permission")) {
    return "Permission denied. Ensure token has project read scope.";
  }
  if (lower.includes("missing") || lower.includes("parameter") || lower.includes("team")) {
    return "Missing/invalid parameters. Verify Team ID and endpoint template.";
  }
  if (lower.includes("timeout") || lower.includes("connect") || lower.includes("network") || lower.includes("fetch failed")) {
    return "Network timeout. Verify Base URL accessibility from API server and retry.";
  }
  return message;
}

function prettyType(value: string) {
  const v = value.toLowerCase();
  if (v.includes("date")) return "date";
  if (v.includes("multi") || v.includes("text")) return "textarea";
  if (v.includes("select") || v.includes("enum") || v.includes("option")) return "select";
  if (v.includes("number") || v.includes("int") || v.includes("float")) return "number";
  if (v.includes("bool")) return "checkbox";
  return "text";
}

function fieldTypeLabel(value: string) {
  const v = prettyType(value);
  if (v === "textarea") return "多行文本";
  if (v === "select") return "下拉选择";
  if (v === "number") return "数字";
  if (v === "date") return "日期";
  if (v === "checkbox") return "布尔";
  return "单行文本";
}

export function OnesSyncConfigPage() {
  const [step, setStep] = useState<Step>(0);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const [kbStatus, setKbStatus] = useState<DocsComStatusResult | null>(null);
  const [kbLoading, setKbLoading] = useState(true);
  const [kbActionLoading, setKbActionLoading] = useState<false | "incremental" | "reindex" | "full">(false);

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
  const [systemTokenMasked, setSystemTokenMasked] = useState("");
  const [editingSystemToken, setEditingSystemToken] = useState(false);
  const [systemTokenInput, setSystemTokenInput] = useState("");

  const [listProjectsPath, setListProjectsPath] = useState("/project/projects");
  const [listIssuesPath, setListIssuesPath] = useState("/project/issues");
  const [listIssueFieldsPath, setListIssueFieldsPath] = useState(INTERNAL_ISSUE_FORM_FIELDS_PATH);
  const [createIssuePath, setCreateIssuePath] = useState("/project/issues");

  const [projectOptions, setProjectOptions] = useState<Array<{ key: string; name: string }>>([]);
  const [projectLoading, setProjectLoading] = useState(false);
  const [projectPickerOpen, setProjectPickerOpen] = useState(false);
  const [projectQuery, setProjectQuery] = useState("");
  const projectPickerRef = useRef<HTMLDivElement | null>(null);
  const projectLoadInFlightRef = useRef<Promise<void> | null>(null);
  const projectLoadAbortRef = useRef<AbortController | null>(null);

  const [issueTypes, setIssueTypes] = useState<OnesProjectIssueType[]>([]);
  const [issueTypesLoading, setIssueTypesLoading] = useState(false);

  const [configuringType, setConfiguringType] = useState<OnesProjectIssueType | null>(null);
  const [configureTab, setConfigureTab] = useState<"content" | "status">("content");
  const [configureContentError, setConfigureContentError] = useState<string | null>(null);
  const [fieldPickerOpen, setFieldPickerOpen] = useState(false);
  const [fieldPickerTab, setFieldPickerTab] = useState<"required" | "optional">("required");
  const [fieldPickerQuery, setFieldPickerQuery] = useState("");
  const [fieldPickerDraftKeys, setFieldPickerDraftKeys] = useState<string[]>([]);
  const [typeConfigLoading, setTypeConfigLoading] = useState(false);
  const [statusLoading, setStatusLoading] = useState(false);
  const [openingIssueTypeKey, setOpeningIssueTypeKey] = useState<string | null>(null);
  const [typeFieldSchema, setTypeFieldSchema] = useState<OnesProjectIssueTypeConfig["fieldSchema"]>([]);
  const [typeStatusMapping, setTypeStatusMapping] = useState<Record<string, string>>({});
  const [statusOptions, setStatusOptions] = useState<Array<{ key: string; name: string }>>([]);
  const issueTypesRequestIdRef = useRef(0);
  const activeConfigureKeyRef = useRef<string | null>(null);
  const discoverIssueTypesAbortRef = useRef<AbortController | null>(null);
  const statusAbortRef = useRef<AbortController | null>(null);
  const loadedStatusForTypeRef = useRef<string | null>(null);
  const issueTypeConfigCacheRef = useRef(new Map<string, OnesProjectIssueTypeConfig>());
  const issueTypeFieldsCacheRef = useRef(new Map<string, OnesProjectIssueTypeConfig["fieldSchema"]>());

  const hasStoredToken = tokenMasked.trim().length > 0;
  const hasTypedToken = tokenInput.trim().length > 0;
  const tokenReady = hasStoredToken || hasTypedToken;
  const hasStoredSystemToken = systemTokenMasked.trim().length > 0;
  const hasTypedSystemToken = systemTokenInput.trim().length > 0;
  const canDiscoverProjects = Boolean(baseUrl.trim() && teamId.trim() && tokenReady);
  const canProceedSetup = Boolean(canDiscoverProjects && projectKey.trim());

  const pushToast = (kind: ToastKind, message: string) => {
    const id = Date.now() + Math.floor(Math.random() * 1000);
    setToasts((prev) => [...prev, { id, kind, message }]);
    window.setTimeout(() => {
      setToasts((prev) => prev.filter((item) => item.id !== id));
    }, 4200);
  };

  const loadKbStatus = async () => {
    setKbLoading(true);
    try {
      const result = await getDocsComKbStatus(8);
      setKbStatus(result);
    } catch (e) {
      pushToast("error", (e as Error).message);
    } finally {
      setKbLoading(false);
    }
  };

  const handleEnsureKb = async (mode: "incremental" | "reindex" | "full") => {
    setKbActionLoading(mode);
    try {
      const result: DocsComEnsureResult = await ensureDocsComKb({
        mode,
        actor: "support_portal",
        runLimit: 4
      });
      setKbStatus({
        exists: true,
        canonical: kbStatus?.canonical ?? {
          repoUrl: "https://github.com/BangWork/docs-com",
          publicBaseUrl: "https://docs.ones.com",
          defaultBranch: "master",
          includePaths: ["**/*.md", "**/*.mdx"],
          excludePaths: [],
          pollingIntervalSeconds: 300,
          actor: "support_portal"
        },
        status: result.afterStatus
      });
      pushToast(
        "success",
        `${mode} completed: processed ${result.runResult.processed}, succeeded ${result.runResult.succeeded}, failed ${result.runResult.failed}.`
      );
    } catch (e) {
      pushToast("error", (e as Error).message);
    } finally {
      setKbActionLoading(false);
    }
  };

  const enabledTypeCount = useMemo(() => issueTypes.filter((item) => item.enabledForCustomer).length, [issueTypes]);
  const mappingStatuses = useMemo(() => {
    if (statusOptions.length > 0) return statusOptions;
    return Object.keys(typeStatusMapping).map((key) => ({ key, name: key }));
  }, [statusOptions, typeStatusMapping]);
  const selectedProjectName = useMemo(
    () => projectOptions.find((row) => row.key === projectKey)?.name ?? "",
    [projectOptions, projectKey]
  );
  const filteredProjectOptions = useMemo(() => {
    const q = projectQuery.trim().toLowerCase();
    if (!q) return projectOptions;
    return projectOptions.filter((row) => row.name.toLowerCase().includes(q) || row.key.toLowerCase().includes(q));
  }, [projectOptions, projectQuery]);
  const setupDirty = useMemo(() => {
    if (!config) return true;
    const sameBase = (config.baseUrl ?? "") === baseUrl;
    const sameTeam = (config.onesTeamId ?? "") === teamId;
    const sameProject = (config.onesProjectKey ?? "") === projectKey;
    const sameAuthType = (config.authType ?? "bearer") === authType;
    const sameAuthHeader = (config.authHeader ?? "Authorization") === authHeader;
    const sameTimeout = (config.timeoutMs ?? 12000) === timeoutMs;
    const sameRetries = (config.retries ?? 1) === retries;
    const samePaths =
      (config.endpointTemplates?.listProjectsPath ?? config.listProjectsPath ?? "") === listProjectsPath &&
      (config.endpointTemplates?.listIssuesPath ?? "") === listIssuesPath &&
      (config.endpointTemplates?.listIssueFieldsPath ?? config.listFieldsPathTemplate ?? "") === listIssueFieldsPath &&
      (config.endpointTemplates?.createIssuePath ?? config.createTicketPath ?? "") === createIssuePath;
    const sameTokenState = !hasTypedToken;
    const sameSystemTokenState = !hasTypedSystemToken;
    return !(
      sameBase &&
      sameTeam &&
      sameProject &&
      sameAuthType &&
      sameAuthHeader &&
      sameTimeout &&
      sameRetries &&
      samePaths &&
      sameTokenState &&
      sameSystemTokenState
    );
  }, [
    config,
    baseUrl,
    teamId,
    projectKey,
    authType,
    authHeader,
    timeoutMs,
    retries,
    listProjectsPath,
    listIssuesPath,
    listIssueFieldsPath,
    createIssuePath,
    hasTypedToken,
    hasTypedSystemToken
  ]);

  const selectedFieldRows = useMemo(
    () => typeFieldSchema.filter((field) => field.required || field.visible),
    [typeFieldSchema]
  );
  const pickerSelectedSet = useMemo(() => new Set(fieldPickerDraftKeys), [fieldPickerDraftKeys]);
  const pickerCandidates = useMemo(() => {
    const q = fieldPickerQuery.trim().toLowerCase();
    return typeFieldSchema.filter((field) => {
      const matchesTab = fieldPickerTab === "required" ? field.required : !field.required;
      if (!matchesTab) return false;
      if (!q) return true;
      return field.label.toLowerCase().includes(q) || field.key.toLowerCase().includes(q);
    });
  }, [fieldPickerQuery, fieldPickerTab, typeFieldSchema]);

  useEffect(() => {
    const load = async () => {
      setLoading(true);
      setError(null);
      try {
        const cfg = await getOnesSyncConfig();
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
          setSystemTokenMasked(cfg.systemAuthSecretMasked ?? "");
          setListProjectsPath(cfg.endpointTemplates?.listProjectsPath ?? cfg.listProjectsPath ?? "/project/projects");
          setListIssuesPath(cfg.endpointTemplates?.listIssuesPath ?? "/project/issues");
          const loadedFieldsPath = cfg.endpointTemplates?.listIssueFieldsPath ?? cfg.listFieldsPathTemplate ?? INTERNAL_ISSUE_FORM_FIELDS_PATH;
          setListIssueFieldsPath(
            loadedFieldsPath.includes("/issue_form/fields") ? loadedFieldsPath : INTERNAL_ISSUE_FORM_FIELDS_PATH
          );
          setCreateIssuePath(cfg.endpointTemplates?.createIssuePath ?? cfg.createTicketPath ?? "/project/issues");
        }
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setLoading(false);
      }
    };
    void load();
  }, []);

  useEffect(() => {
    void loadKbStatus();
  }, []);

  useEffect(() => {
    if (!projectKey) {
      setIssueTypes([]);
      setConfiguringType(null);
      return;
    }
    issueTypeConfigCacheRef.current.clear();
    issueTypeFieldsCacheRef.current.clear();
    activeConfigureKeyRef.current = null;
    issueTypesRequestIdRef.current += 1;
    const requestId = issueTypesRequestIdRef.current;
    void (async () => {
      setIssueTypesLoading(true);
      setIssueTypes([]);
      try {
        const rows = await listProjectIssueTypes(projectKey);
        if (issueTypesRequestIdRef.current !== requestId) return;
        setIssueTypes(rows);
      } catch {
        if (issueTypesRequestIdRef.current !== requestId) return;
        setIssueTypes([]);
      } finally {
        if (issueTypesRequestIdRef.current !== requestId) return;
        setIssueTypesLoading(false);
      }
    })();
  }, [projectKey]);

  useEffect(() => {
    const onClick = (event: MouseEvent) => {
      if (!projectPickerRef.current) return;
      if (!projectPickerRef.current.contains(event.target as Node)) {
        setProjectPickerOpen(false);
      }
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, []);

  useEffect(() => {
    if (!projectKey) return;
    setProjectPickerOpen(false);
    setProjectQuery("");
  }, [projectKey]);

  useEffect(() => {
    if (!error) return;
    pushToast("error", error);
    setError(null);
  }, [error]);

  useEffect(() => {
    if (!success) return;
    pushToast("success", success);
    setSuccess(null);
  }, [success]);

  const upsertDraftConfig = async () => {
    if (!tokenReady) {
      throw new Error("Access Token is required. Click Replace and paste token.");
    }
    const enabledTypes = issueTypes.filter((item) => item.enabledForCustomer).map((item) => item.key);
    const updated = await updateOnesSyncConfig({
      profileName: "default",
      baseUrl,
      authType,
      authHeader,
      authSecret: hasTypedToken ? tokenInput.trim() : undefined,
      // Preserve existing stored token unless user explicitly replaces it in this save.
      keepExistingSecret: !hasTypedToken,
      systemAuthSecret: hasTypedSystemToken ? systemTokenInput.trim() : undefined,
      // Preserve existing stored system token unless user explicitly replaces it.
      keepExistingSystemSecret: !hasTypedSystemToken,
      createTicketPath: createIssuePath,
      listProjectsPath,
      listTicketTypesPath: "/project/issueTypes",
      listFieldsPathTemplate: listIssueFieldsPath,
      endpointTemplates: {
        listProjectsPath,
        listIssuesPath,
        listIssueFieldsPath,
        createIssuePath,
        listIssueStatusesPath: "/project/api/ones-project/team/{teamID}/v2/field/reference_object/query"
      },
      allowedTicketTypeKeys: enabledTypes,
      statusMapping: {},
      workflowMapping: {},
      timeoutMs,
      retries,
      publishState: "draft",
      dataSourceMode: "ones_primary",
      onesProjectKey: projectKey,
      onesTeamId: teamId,
      actor: "support_admin"
    });
    setConfig(updated);
    setTokenMasked(updated.authSecretMasked ?? "");
    setSystemTokenMasked(updated.systemAuthSecretMasked ?? "");
    setEditingToken(false);
    setTokenInput("");
    setEditingSystemToken(false);
    setSystemTokenInput("");
    return updated;
  };

  const handleSaveDraft = async () => {
    setSaving(true);
    setError(null);
    setSuccess(null);
    try {
      await upsertDraftConfig();
      setSuccess("Draft configuration saved.");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const loadProjects = async (force = false) => {
    if (!canDiscoverProjects) return;
    if (!force && projectOptions.length > 0) return;
    if (projectLoadInFlightRef.current) return projectLoadInFlightRef.current;

    const task = (async () => {
      projectLoadAbortRef.current?.abort();
      const controller = new AbortController();
      projectLoadAbortRef.current = controller;
      setProjectLoading(true);
      setError(null);
      try {
        let cursor: string | undefined;
        let pages = 0;
        const merged = new Map<string, { key: string; name: string }>();
        do {
          const page = await discoverOnesProjects({
            baseUrl,
            authType,
            authHeader,
            authSecret: hasTypedToken ? tokenInput.trim() : undefined,
            keepExistingSecret: !hasTypedToken && hasStoredToken,
            teamId,
            cursor,
            listProjectsPath,
            timeoutMs,
            signal: controller.signal
          });
          page.projects.forEach((project) => merged.set(project.key, project));
          cursor = page.nextCursor ?? undefined;
          pages += 1;
        } while (cursor && pages < 20);

        const options = Array.from(merged.values());
        setProjectOptions(options);
        if (projectKey && !options.some((option) => option.key === projectKey)) {
          setProjectKey("");
        }
        if (!projectKey && options[0]) {
          setProjectKey(options[0].key);
        }
      } catch (e) {
        if ((e as Error).name === "AbortError") return;
        const message = categorizeProjectDiscoveryError((e as Error).message);
        setError(`Project discovery failed. ${message}`);
      } finally {
        setProjectLoading(false);
        projectLoadInFlightRef.current = null;
      }
    })();

    projectLoadInFlightRef.current = task;
    return task;
  };

  const handleDiscoverIssueTypes = async () => {
    if (!projectKey) {
      setError("Select a project before discovering issue types.");
      return;
    }
    discoverIssueTypesAbortRef.current?.abort();
    const controller = new AbortController();
    discoverIssueTypesAbortRef.current = controller;
    setIssueTypesLoading(true);
    setError(null);
    setSuccess(null);
    setIssueTypes([]);
    setConfiguringType(null);
    try {
      if (setupDirty) {
        await upsertDraftConfig();
      }
      const rows = await discoverProjectIssueTypes({ projectKey, actor: "support_admin", signal: controller.signal });
      setIssueTypes(rows);
      setSuccess(`Discovered ${rows.length} issue types from project work items.`);
    } catch (e) {
      if ((e as Error).name === "AbortError") return;
      setIssueTypes([]);
      setError((e as Error).message);
    } finally {
      setIssueTypesLoading(false);
    }
  };

  const handleToggleIssueType = async (row: OnesProjectIssueType, enabledForCustomer: boolean) => {
    setError(null);
    try {
      await setProjectIssueTypeExposure({
        projectKey,
        issueTypeKey: row.key,
        issueTypeName: row.name,
        enabledForCustomer,
        actor: "support_admin"
      });
      setIssueTypes((prev) => prev.map((item) => (item.key === row.key ? { ...item, enabledForCustomer } : item)));
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const mergeFieldsWithConfig = (
    fields: OnesProjectIssueTypeConfig["fieldSchema"],
    cfg?: OnesProjectIssueTypeConfig
  ) => {
    const configuredByKey = new Map((cfg?.fieldSchema ?? []).map((item) => [item.key, item]));
    return fields.map((field) => {
      const existing = configuredByKey.get(field.key);
      const suggestedVisibleByDefault = field.required || field.key === "field016" || field.key === "field002";
      return {
        ...field,
        type: prettyType(field.type),
        visible: existing?.visible ?? suggestedVisibleByDefault,
        required: existing?.required ?? field.required,
        defaultValue: existing?.defaultValue ?? field.defaultValue,
        options: existing?.options?.length ? existing.options : field.options
      };
    });
  };

  const openConfigure = async (row: OnesProjectIssueType) => {
    statusAbortRef.current?.abort();
    const cacheKey = `${projectKey}::${row.key}`;
    const cachedCfg = issueTypeConfigCacheRef.current.get(cacheKey);
    const cachedFields = issueTypeFieldsCacheRef.current.get(cacheKey);
    setConfiguringType(row);
    setOpeningIssueTypeKey(row.key);
    activeConfigureKeyRef.current = cacheKey;
    setConfigureTab("content");
    setConfigureContentError(null);
    setTypeConfigLoading(!cachedFields);
    setStatusLoading(false);
    setError(null);
    setTypeFieldSchema(cachedFields ? mergeFieldsWithConfig(cachedFields, cachedCfg) : []);
    setTypeStatusMapping(cachedCfg?.statusMapping ?? {});
    setStatusOptions([]);
    loadedStatusForTypeRef.current = null;
    try {
      if (setupDirty) {
        await upsertDraftConfig();
      }
      const fields = cachedFields ?? (await getProjectIssueTypeFields(projectKey, row.key));
      issueTypeFieldsCacheRef.current.set(cacheKey, fields);
      const merged = mergeFieldsWithConfig(fields, cachedCfg);
      setTypeFieldSchema(merged);
      setFieldPickerDraftKeys(merged.filter((item) => item.visible || item.required).map((item) => item.key));
    } catch (e) {
      setTypeFieldSchema([]);
      setFieldPickerDraftKeys([]);
      setTypeStatusMapping({});
      setConfigureContentError((e as Error).message);
      setError((e as Error).message);
    } finally {
      setTypeConfigLoading(false);
      setOpeningIssueTypeKey(null);
    }
  };

  useEffect(() => {
    if (!configuringType || configureTab !== "status") return;
    if (loadedStatusForTypeRef.current === configuringType.key) return;

    statusAbortRef.current?.abort();
    const controller = new AbortController();
    statusAbortRef.current = controller;
    setStatusLoading(true);
    setError(null);
    void (async () => {
      try {
        const cacheKey = `${projectKey}::${configuringType.key}`;
        const cachedCfg = issueTypeConfigCacheRef.current.get(cacheKey);
        if (!cachedCfg) {
          const cfg = await getProjectIssueTypeConfig(projectKey, configuringType.key);
          issueTypeConfigCacheRef.current.set(cacheKey, cfg);
          setTypeStatusMapping((prev) => (Object.keys(prev).length > 0 ? prev : (cfg.statusMapping ?? {})));
        }
        const statuses = await discoverOnesIssueStatuses({
          teamId,
          projectKey,
          issueTypeKey: configuringType.key,
          signal: controller.signal
        });
        setStatusOptions(statuses.map((item) => ({ key: item.key, name: item.name })));
        loadedStatusForTypeRef.current = configuringType.key;
      } catch (e) {
        if ((e as Error).name === "AbortError") return;
        setStatusOptions([]);
        setError(`Status discovery failed: ${(e as Error).message}`);
      } finally {
        setStatusLoading(false);
      }
    })();
    return () => controller.abort();
  }, [configureTab, configuringType, projectKey, teamId]);

  useEffect(() => {
    return () => {
      projectLoadAbortRef.current?.abort();
      discoverIssueTypesAbortRef.current?.abort();
      statusAbortRef.current?.abort();
    };
  }, []);

  const saveTypeConfig = async () => {
    if (!configuringType) return;
    setSaving(true);
    setError(null);
    setSuccess(null);
    try {
      await saveProjectIssueTypeConfig({
        projectKey,
        issueTypeKey: configuringType.key,
        issueTypeName: configuringType.name,
        fieldSchema: typeFieldSchema,
        statusMapping: typeStatusMapping,
        actor: "support_admin"
      });
      await upsertDraftConfig();
      const cacheKey = `${projectKey}::${configuringType.key}`;
      issueTypeConfigCacheRef.current.set(cacheKey, {
        projectKey,
        issueTypeKey: configuringType.key,
        issueTypeName: configuringType.name,
        enabledForCustomer: true,
        fieldSchema: typeFieldSchema,
        statusMapping: typeStatusMapping,
        updatedAt: new Date().toISOString(),
        updatedBy: "support_admin"
      });
      issueTypeFieldsCacheRef.current.set(cacheKey, typeFieldSchema);
      setSuccess(`Saved configuration for ${configuringType.name}.`);
      activeConfigureKeyRef.current = null;
      setConfiguringType(null);
      const rows = await listProjectIssueTypes(projectKey);
      setIssueTypes(rows);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const openFieldPicker = () => {
    setFieldPickerTab("required");
    setFieldPickerQuery("");
    setFieldPickerDraftKeys(typeFieldSchema.filter((field) => field.required || field.visible).map((field) => field.key));
    setFieldPickerOpen(true);
  };

  const applyFieldPicker = () => {
    const chosen = new Set(fieldPickerDraftKeys);
    setTypeFieldSchema((prev) =>
      prev.map((field) => ({
        ...field,
        visible: field.required ? true : chosen.has(field.key)
      }))
    );
    setFieldPickerOpen(false);
  };

  const handleNext = async () => {
    if (step === 0) {
      if (!canProceedSetup) return;
      if (setupDirty) {
        setSaving(true);
        try {
          await upsertDraftConfig();
        } catch (e) {
          setError((e as Error).message);
          setSaving(false);
          return;
        }
        setSaving(false);
      }
      setStep(1);
      return;
    }
    if (enabledTypeCount === 0) return;
    await handleSaveDraft();
  };

  if (loading) return <div className="mx-auto max-w-6xl px-6 py-10 text-sm text-slate-600">Loading configuration...</div>;

  return (
    <div className="mx-auto max-w-6xl space-y-5 px-4 py-8 md:px-8">
      <header className="rounded-mdplus border border-slate-200 bg-white p-5">
        <h1 className="text-3xl font-bold text-[#16171A]">Configuration</h1>
        <p className="mt-2 text-sm text-slate-600">Project-driven ONES OpenAPI configuration for support/customer runtime.</p>
        <p className="mt-1 text-xs text-slate-500">
          Active Version: {config?.configVersion ?? "-"} | Publish State: {config?.publishState ?? "draft"} | Updated by {config?.updatedBy ?? "-"}
        </p>
      </header>

      <section className="rounded-mdplus border border-slate-200 bg-white p-5">
        <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
          <div className="max-w-3xl">
            <h2 className="text-lg font-semibold text-[#16171A]">Knowledge Base Sync</h2>
            <p className="mt-1 text-sm text-slate-600">
              Primary source is <span className="font-medium text-slate-900">BangWork/docs-com:master</span>. Production runs on Vercel serverless, so KB sync uses explicit automation instead of background loops.
            </p>
            <p className="mt-1 text-xs text-slate-500">
              Automatic path should call the same ensure endpoint after deploy and on schedule. The buttons below are backup operations for Support Portal only.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              className="rounded-mdplus border border-slate-300 px-4 py-2 text-sm text-slate-700 disabled:opacity-40"
              onClick={() => void loadKbStatus()}
              disabled={kbLoading || kbActionLoading !== false}
            >
              {kbLoading ? "Refreshing..." : "Refresh Status"}
            </button>
            <button
              className="rounded-mdplus border border-slate-300 px-4 py-2 text-sm text-slate-700 disabled:opacity-40"
              onClick={() => void handleEnsureKb("incremental")}
              disabled={kbActionLoading !== false}
            >
              {kbActionLoading === "incremental" ? "Running..." : "Run Incremental"}
            </button>
            <button
              className="rounded-mdplus border border-slate-300 px-4 py-2 text-sm text-slate-700 disabled:opacity-40"
              onClick={() => void handleEnsureKb("reindex")}
              disabled={kbActionLoading !== false}
            >
              {kbActionLoading === "reindex" ? "Running..." : "Run Reindex"}
            </button>
            <button
              className="rounded-mdplus bg-brand-500 px-4 py-2 text-sm font-medium text-white disabled:opacity-40"
              onClick={() => void handleEnsureKb("full")}
              disabled={kbActionLoading !== false}
            >
              {kbActionLoading === "full" ? "Running..." : "Run Full Sync"}
            </button>
          </div>
        </div>

        <div className="mt-4 grid gap-3 md:grid-cols-4">
          <div className="rounded-mdplus border border-slate-200 bg-slate-50 p-3">
            <p className="text-xs font-semibold uppercase tracking-[0.08em] text-slate-500">Registration</p>
            <p className="mt-2 text-sm font-medium text-slate-900">
              {kbStatus?.exists ? kbStatus.status?.registration.repo ?? "docs-com" : "Missing"}
            </p>
            <p className="mt-1 text-xs text-slate-500">{kbStatus?.status?.registration.branch ?? kbStatus?.canonical.defaultBranch ?? "master"}</p>
          </div>
          <div className="rounded-mdplus border border-slate-200 bg-slate-50 p-3">
            <p className="text-xs font-semibold uppercase tracking-[0.08em] text-slate-500">Sync Coverage</p>
            <p className={`mt-2 text-sm font-medium ${kbStatus?.status?.health.ok ? "text-emerald-700" : "text-amber-700"}`}>
              {typeof kbStatus?.status?.overview.activeCoverageRate === "number"
                ? `${Math.round(kbStatus.status.overview.activeCoverageRate * 100)}% indexed`
                : kbStatus?.status?.health.ok
                  ? "Healthy"
                  : kbStatus?.status
                    ? "Needs Attention"
                    : "Unknown"}
            </p>
            <p className="mt-1 text-xs text-slate-500">
              {kbStatus?.status
                ? `source ${kbStatus.status.overview.sourceTotal} / kb active ${kbStatus.status.overview.kbActive}`
                : "Waiting for first status load."}
            </p>
          </div>
          <div className="rounded-mdplus border border-slate-200 bg-slate-50 p-3">
            <p className="text-xs font-semibold uppercase tracking-[0.08em] text-slate-500">Source Snapshot</p>
            <p className="mt-2 text-sm font-medium text-slate-900">
              {kbStatus?.status?.sourceSnapshot.mode === "local_mirror" ? "Local Mirror" : kbStatus?.status ? "Remote GitHub" : "-"}
            </p>
            <p className="mt-1 text-xs text-slate-500">
              {kbStatus?.status?.sourceSnapshot.head ?? kbStatus?.status?.sourceSnapshot.errorMessage ?? "Waiting for source probe."}
            </p>
          </div>
          <div className="rounded-mdplus border border-slate-200 bg-slate-50 p-3">
            <p className="text-xs font-semibold uppercase tracking-[0.08em] text-slate-500">Last Sync</p>
            <p className="mt-2 text-sm font-medium text-slate-900">
              {kbStatus?.status?.checkpoint?.lastSyncedAt ?? "-"}
            </p>
            <p className="mt-1 text-xs text-slate-500">{kbStatus?.status?.checkpoint?.lastSyncedCommitSha ?? "No checkpoint yet"}</p>
          </div>
        </div>

        <div className="mt-3 rounded-mdplus border border-slate-200 bg-[linear-gradient(135deg,rgba(0,100,255,0.06),rgba(51,221,255,0.08))] p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.08em] text-slate-500">Probe Summary</p>
              <p className="mt-1 text-sm font-medium text-slate-900">
                Compare current source repo markdown totals against indexed KB totals in the shared database.
              </p>
            </div>
            <div className="text-right text-sm text-slate-700">
              <p>Gap: {kbStatus?.status?.overview.syncGap ?? "-"}</p>
              <p className="text-xs text-slate-500">
                {kbStatus?.status?.health.message ?? "The source probe will show whether missing data is a real sync gap or simply zero documents upstream."}
              </p>
            </div>
          </div>
        </div>

        <div className="mt-4 grid gap-3 lg:grid-cols-[1.2fr_0.8fr]">
          <div className="rounded-mdplus border border-slate-200">
            <div className="border-b border-slate-200 px-4 py-3">
              <h3 className="text-sm font-semibold text-slate-900">Corpus Families</h3>
              <p className="mt-1 text-xs text-slate-500">Each family compares source markdown counts against what the KB has already indexed.</p>
            </div>
            <div className="divide-y divide-slate-100">
              {(kbStatus?.status?.corpus ?? []).map((row) => (
                <div key={row.prefix} className="flex items-center justify-between px-4 py-3 text-sm">
                  <div>
                    <p className="font-medium text-slate-900">{row.prefix}</p>
                    <p className="text-xs text-slate-500">
                      source {row.sourceTotal ?? "-"} / kb total {row.total} / kb active {row.active}
                    </p>
                    <p className="mt-1 text-xs text-slate-400">gap {row.gap ?? "-"}</p>
                  </div>
                  <span
                    className={`rounded-full px-2 py-1 text-xs font-medium ${
                      row.sourceTotal !== null && row.sourceTotal === row.active
                        ? "bg-emerald-50 text-emerald-700"
                        : row.active > 0
                          ? "bg-sky-50 text-sky-700"
                          : "bg-amber-50 text-amber-700"
                    }`}
                  >
                    {row.sourceTotal !== null && row.sourceTotal === row.active ? "In Sync" : row.active > 0 ? "Catching Up" : "Check"}
                  </span>
                </div>
              ))}
              {!kbStatus?.status?.corpus?.length ? (
                <div className="px-4 py-5 text-sm text-slate-500">No corpus status loaded yet.</div>
              ) : null}
            </div>
          </div>

          <div className="rounded-mdplus border border-slate-200">
            <div className="border-b border-slate-200 px-4 py-3">
              <h3 className="text-sm font-semibold text-slate-900">Recent Jobs</h3>
            </div>
            <div className="divide-y divide-slate-100">
              {(kbStatus?.status?.recentJobs ?? []).map((job) => (
                <div key={job.id} className="px-4 py-3 text-sm">
                  <div className="flex items-center justify-between gap-3">
                    <span className="font-medium text-slate-900">{job.mode}</span>
                    <span className="text-xs text-slate-500">{job.status}</span>
                  </div>
                  <p className="mt-1 text-xs text-slate-500">{job.updatedAt}</p>
                  {job.errorMessage ? <p className="mt-1 text-xs text-rose-600">{job.errorMessage}</p> : null}
                </div>
              ))}
              {!kbStatus?.status?.recentJobs?.length ? (
                <div className="px-4 py-5 text-sm text-slate-500">No jobs recorded yet.</div>
              ) : null}
            </div>
          </div>
        </div>
      </section>

      <div className="fixed right-6 top-20 z-[90] flex w-[360px] max-w-[calc(100vw-2rem)] flex-col gap-2">
        {toasts.map((toast) => (
          <div
            key={toast.id}
            className={`rounded-mdplus border px-3 py-2 text-sm shadow-lg ${
              toast.kind === "error"
                ? "border-rose-200 bg-rose-50 text-rose-700"
                : "border-emerald-200 bg-emerald-50 text-emerald-700"
            }`}
          >
            {toast.message}
          </div>
        ))}
      </div>

      <section className="rounded-mdplus border border-slate-200 bg-white p-4">
        <ol className="grid gap-2 md:grid-cols-2">
          {steps.map((name, index) => (
            <li
              key={name}
              className={`rounded-mdplus border px-3 py-2 text-sm ${
                step === index
                  ? "border-brand-500 bg-brand-50 text-brand-600"
                  : step > index
                    ? "border-emerald-200 bg-emerald-50 text-emerald-700"
                    : "border-slate-200 bg-slate-50 text-slate-600"
              }`}
            >
              {name}
            </li>
          ))}
        </ol>
      </section>

      {step === 0 && (
        <section className="rounded-mdplus border border-slate-200 bg-white p-5">
          <h2 className="text-lg font-semibold text-[#16171A]">Setup & Project</h2>
          <div className="mt-3 grid gap-3 md:grid-cols-2">
            <label className="space-y-1">
              <span className="text-xs font-semibold text-slate-600">Base URL</span>
              <input className="w-full rounded-mdplus border border-slate-200 px-3 py-2 text-sm" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} />
            </label>
            <label className="space-y-1">
              <span className="text-xs font-semibold text-slate-600">Team ID</span>
              <input className="w-full rounded-mdplus border border-slate-200 px-3 py-2 text-sm" value={teamId} onChange={(e) => setTeamId(e.target.value)} />
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
                  <input
                    className="min-w-0 flex-1 rounded-mdplus border border-slate-200 bg-slate-100 px-3 py-2 text-sm"
                    value={hasStoredToken ? tokenMasked : ""}
                    type="password"
                    placeholder={hasStoredToken ? "" : "No token saved"}
                    readOnly
                  />
                  <button className="rounded border border-slate-300 px-3 py-2 text-sm" onClick={() => setEditingToken(true)}>
                    {hasStoredToken ? "Replace" : "Set Token"}
                  </button>
                </div>
              ) : (
                <input
                  className="w-full rounded-mdplus border border-slate-200 px-3 py-2 text-sm"
                  value={tokenInput}
                  onChange={(e) => setTokenInput(e.target.value)}
                  type="password"
                  placeholder="Paste access token"
                />
              )}
            </label>
            <label className="space-y-1 md:col-span-2">
              <span className="text-xs font-semibold text-slate-600">System API Token</span>
              {!editingSystemToken ? (
                <div className="flex gap-2">
                  <input
                    className="min-w-0 flex-1 rounded-mdplus border border-slate-200 bg-slate-100 px-3 py-2 text-sm"
                    value={hasStoredSystemToken ? systemTokenMasked : ""}
                    type="password"
                    placeholder={hasStoredSystemToken ? "" : "No system API token saved"}
                    readOnly
                  />
                  <button className="rounded border border-slate-300 px-3 py-2 text-sm" onClick={() => setEditingSystemToken(true)}>
                    {hasStoredSystemToken ? "Replace" : "Set Token"}
                  </button>
                </div>
              ) : (
                <input
                  className="w-full rounded-mdplus border border-slate-200 px-3 py-2 text-sm"
                  value={systemTokenInput}
                  onChange={(e) => setSystemTokenInput(e.target.value)}
                  type="password"
                  placeholder="Paste system API token"
                />
              )}
              <p className="text-xs text-slate-500">Used for internal system APIs (e.g. issue_form/fields), separate from OpenAPI token.</p>
            </label>
            <label className="space-y-1">
              <span className="text-xs font-semibold text-slate-600">Timeout (ms)</span>
              <input className="w-full rounded-mdplus border border-slate-200 px-3 py-2 text-sm" type="number" value={timeoutMs} onChange={(e) => setTimeoutMs(Number(e.target.value || 12000))} />
            </label>
            <label className="space-y-1">
              <span className="text-xs font-semibold text-slate-600">Retries</span>
              <input className="w-full rounded-mdplus border border-slate-200 px-3 py-2 text-sm" type="number" value={retries} onChange={(e) => setRetries(Number(e.target.value || 1))} />
            </label>
            <label className="space-y-1 md:col-span-2">
              <span className="text-xs font-semibold text-slate-600">Project</span>
              <div ref={projectPickerRef} className="relative">
                <button
                  type="button"
                  disabled={!canDiscoverProjects}
                  onClick={() => {
                    setProjectPickerOpen((prev) => !prev);
                    if (!projectPickerOpen) void loadProjects();
                  }}
                  className="flex w-full items-center justify-between rounded-mdplus border border-slate-200 px-3 py-2 text-left text-sm disabled:bg-slate-100 disabled:text-slate-400"
                >
                  <span className={selectedProjectName ? "text-slate-900" : "text-slate-500"}>
                    {!canDiscoverProjects
                      ? "Complete Base URL + Team ID + Token first"
                      : selectedProjectName || (projectLoading ? "Loading projects..." : "Select project")}
                  </span>
                  <span className="text-slate-400">▾</span>
                </button>
                {projectPickerOpen && canDiscoverProjects ? (
                  <div className="absolute z-20 mt-1 w-full rounded-mdplus border border-slate-200 bg-white p-2 shadow-lg">
                    <input
                      className="mb-2 w-full rounded border border-slate-200 px-2 py-1.5 text-sm"
                      placeholder="Search project..."
                      value={projectQuery}
                      onChange={(e) => setProjectQuery(e.target.value)}
                    />
                    <div className="max-h-64 overflow-auto">
                      {filteredProjectOptions.length === 0 ? (
                        <p className="px-2 py-2 text-xs text-slate-500">No projects found.</p>
                      ) : (
                        filteredProjectOptions.map((project) => (
                          <button
                            type="button"
                            key={project.key}
                            className={`flex w-full items-center justify-between rounded px-2 py-2 text-left text-sm hover:bg-slate-50 ${
                              project.key === projectKey ? "bg-brand-50 text-brand-700" : "text-slate-700"
                            }`}
                            onClick={(e) => {
                              e.preventDefault();
                              e.stopPropagation();
                              setProjectPickerOpen(false);
                              setProjectQuery("");
                              if (project.key !== projectKey) {
                                setProjectKey(project.key);
                              }
                              // Defensive close to avoid any queued reopen caused by bubbling/toggle timing.
                              requestAnimationFrame(() => setProjectPickerOpen(false));
                            }}
                          >
                            <span className="truncate">{project.name}</span>
                            {project.key === projectKey ? <span className="text-xs">Selected</span> : null}
                          </button>
                        ))
                      )}
                    </div>
                  </div>
                ) : null}
              </div>
              <p className="text-xs text-slate-500">Project list loads when dropdown is opened.</p>
            </label>
            <label className="space-y-1">
              <span className="text-xs font-semibold text-slate-600">Projects Endpoint</span>
              <input className="w-full rounded-mdplus border border-slate-200 px-3 py-2 text-sm" value={listProjectsPath} onChange={(e) => setListProjectsPath(e.target.value)} />
            </label>
            <label className="space-y-1">
              <span className="text-xs font-semibold text-slate-600">Work Items Endpoint</span>
              <input className="w-full rounded-mdplus border border-slate-200 px-3 py-2 text-sm" value={listIssuesPath} onChange={(e) => setListIssuesPath(e.target.value)} />
            </label>
            <label className="space-y-1">
              <span className="text-xs font-semibold text-slate-600">Issue Fields Endpoint</span>
              <input className="w-full rounded-mdplus border border-slate-200 px-3 py-2 text-sm" value={listIssueFieldsPath} onChange={(e) => setListIssueFieldsPath(e.target.value)} />
            </label>
            <label className="space-y-1">
              <span className="text-xs font-semibold text-slate-600">Create Work Item Endpoint</span>
              <input className="w-full rounded-mdplus border border-slate-200 px-3 py-2 text-sm" value={createIssuePath} onChange={(e) => setCreateIssuePath(e.target.value)} />
            </label>
          </div>
          <div className="mt-4 flex flex-wrap gap-2">
            <button className="rounded-mdplus border border-slate-300 px-4 py-2 text-sm" onClick={() => void handleSaveDraft()} disabled={saving}>
              Save Draft
            </button>
          </div>
        </section>
      )}

      {step === 1 && (
        <section className="rounded-mdplus border border-slate-200 bg-white p-5">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-lg font-semibold text-[#16171A]">Project Ticket Types</h2>
              <p className="text-xs text-slate-500">Discover from project work items and choose what customer portal can create.</p>
            </div>
            <div className="flex items-center gap-3">
              <span className="text-xs text-slate-600">Enabled: {enabledTypeCount}</span>
              <button className="rounded-mdplus bg-brand-500 px-3 py-2 text-sm font-medium text-white" onClick={() => void handleDiscoverIssueTypes()} disabled={issueTypesLoading || !projectKey}>
                {issueTypesLoading ? "Discovering..." : "Discover Issue Types"}
              </button>
            </div>
          </div>

          {!issueTypes.length ? (
            <p className="mt-4 rounded-mdplus border border-dashed border-slate-300 bg-slate-50 px-3 py-4 text-sm text-slate-500">No issue types loaded yet. Click "Discover Issue Types".</p>
          ) : (
            <div className="mt-4 overflow-x-auto rounded-mdplus border border-slate-200">
              <table className="w-full text-left text-sm">
                <thead className="bg-slate-50 text-slate-600">
                  <tr>
                    <th className="px-3 py-2">Issue Type</th>
                    <th className="px-3 py-2">Customer Exposure</th>
                    <th className="px-3 py-2">Configure</th>
                  </tr>
                </thead>
                <tbody>
                  {issueTypes.map((row) => (
                    <tr key={row.key} className="border-t border-slate-200">
                      <td className="px-3 py-2">
                        <p className="font-medium text-slate-900">{row.name}</p>
                        <p className="text-xs text-slate-500">{row.key}</p>
                      </td>
                      <td className="px-3 py-2">
                        <button
                          type="button"
                          role="switch"
                          aria-checked={row.enabledForCustomer}
                          onClick={() => void handleToggleIssueType(row, !row.enabledForCustomer)}
                          className={`relative h-6 w-11 rounded-full transition ${row.enabledForCustomer ? "bg-emerald-500" : "bg-slate-300"}`}
                        >
                          <span
                            className={`absolute top-0.5 h-5 w-5 rounded-full bg-white transition ${row.enabledForCustomer ? "left-5" : "left-0.5"}`}
                          />
                        </button>
                      </td>
                      <td className="px-3 py-2">
                        <button
                          className="rounded border border-slate-300 px-3 py-1 text-xs disabled:opacity-50"
                          onClick={() => void openConfigure(row)}
                          disabled={openingIssueTypeKey === row.key}
                        >
                          {openingIssueTypeKey === row.key ? "Loading..." : "Configure"}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}

      <section className="flex items-center justify-between rounded-mdplus border border-slate-200 bg-white p-4">
        <button
          className="rounded-mdplus border border-slate-300 px-4 py-2 text-sm disabled:opacity-40"
          onClick={() => setStep(0)}
          disabled={step === 0}
        >
          Back
        </button>
        <button
          className="rounded-mdplus bg-brand-500 px-4 py-2 text-sm font-medium text-white disabled:opacity-40"
          onClick={() => void handleNext()}
          disabled={saving || (step === 0 && !canProceedSetup) || (step === 1 && enabledTypeCount === 0)}
        >
          {step === 0 ? "Next" : "Save & Finish"}
        </button>
      </section>

      <Dialog.Root
        open={Boolean(configuringType)}
        onOpenChange={(open) => {
          if (!open) {
            activeConfigureKeyRef.current = null;
            setConfiguringType(null);
          }
        }}
      >
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-40 bg-black/35" />
          <Dialog.Content className="fixed left-1/2 top-1/2 z-50 h-[84vh] w-[96vw] max-w-6xl -translate-x-1/2 -translate-y-1/2 overflow-hidden rounded-xl border border-slate-200 bg-white shadow-2xl">
            <div className="flex h-full flex-col">
              <div className="flex items-center justify-between border-b border-slate-200 px-6 py-4">
                <Dialog.Title className="text-lg font-semibold text-slate-900">Configure {configuringType?.name}</Dialog.Title>
                {typeConfigLoading || statusLoading ? <span className="text-xs text-slate-500">Loading...</span> : null}
              </div>
              <div className="flex min-h-0 flex-1">
                <aside className="w-52 border-r border-slate-200 bg-slate-50 p-3">
                  <button
                    className={`mb-2 w-full rounded px-3 py-2 text-left text-sm ${configureTab === "content" ? "bg-brand-100 text-brand-700" : "text-slate-700 hover:bg-slate-100"}`}
                    onClick={() => setConfigureTab("content")}
                  >
                    设置内容
                  </button>
                  <button
                    className={`w-full rounded px-3 py-2 text-left text-sm ${configureTab === "status" ? "bg-brand-100 text-brand-700" : "text-slate-700 hover:bg-slate-100"}`}
                    onClick={() => setConfigureTab("status")}
                  >
                    设置工作流状态
                  </button>
                </aside>
                <div className="min-h-0 flex-1 overflow-auto p-5">
                  {configureTab === "content" ? (
                    <section>
                      <div className="rounded border border-brand-100 bg-brand-50 px-3 py-2 text-xs text-brand-700">
                        Configure customer form fields for this issue type.
                      </div>
                      {typeConfigLoading && !typeFieldSchema.length ? (
                        <div className="mt-4 space-y-3">
                          <div className="h-9 animate-pulse rounded bg-slate-100" />
                          <div className="h-9 animate-pulse rounded bg-slate-100" />
                          <div className="h-9 animate-pulse rounded bg-slate-100" />
                          <p className="text-xs text-slate-500">Loading form fields...</p>
                        </div>
                      ) : !typeFieldSchema.length ? (
                        <div className="mt-4 rounded-mdplus border border-dashed border-slate-300 bg-slate-50 px-3 py-4 text-sm text-slate-600">
                          {configureContentError ?? "未获取到该工作项类型的字段。请确认请求携带了 `project_uuid`、`issue_type_uuid` 和 `form_type=create`。"}
                        </div>
                      ) : (
                        <div className="mt-4 space-y-3">
                          <div className="rounded-mdplus border border-slate-200">
                            <table className="w-full text-left text-sm">
                              <thead className="bg-slate-50 text-slate-600">
                                <tr>
                                  <th className="w-10 px-3 py-2" />
                                  <th className="px-3 py-2">工作项属性</th>
                                  <th className="px-3 py-2">属性类型</th>
                                  <th className="px-3 py-2">默认值</th>
                                  <th className="px-3 py-2">是否必填</th>
                                  <th className="px-3 py-2">操作</th>
                                </tr>
                              </thead>
                              <tbody>
                                {selectedFieldRows.map((field) => (
                                  <tr key={field.key} className="border-t border-slate-200">
                                    <td className="px-3 py-2 text-slate-400">⋮⋮</td>
                                    <td className="px-3 py-2">
                                      <p className="font-medium text-slate-900">{field.label}</p>
                                      <p className="text-xs text-slate-500">{field.key}</p>
                                    </td>
                                    <td className="px-3 py-2">{fieldTypeLabel(field.type)}</td>
                                    <td className="px-3 py-2">
                                      <input
                                        className="w-full rounded border border-slate-200 px-2 py-1 text-xs"
                                        value={String(field.defaultValue ?? "")}
                                        onChange={(e) =>
                                          setTypeFieldSchema((prev) =>
                                            prev.map((row) => (row.key === field.key ? { ...row, defaultValue: e.target.value } : row))
                                          )
                                        }
                                      />
                                    </td>
                                    <td className="px-3 py-2">
                                      {field.required ? (
                                        <span className="rounded-full bg-rose-50 px-2 py-0.5 text-xs font-medium text-rose-600">是</span>
                                      ) : (
                                        <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-600">否</span>
                                      )}
                                    </td>
                                    <td className="px-3 py-2">
                                      <button
                                        className="text-xs text-brand-600 disabled:text-slate-300"
                                        disabled={field.required}
                                        onClick={() =>
                                          setTypeFieldSchema((prev) =>
                                            prev.map((row) => (row.key === field.key ? { ...row, visible: false } : row))
                                          )
                                        }
                                      >
                                        {field.required ? "—" : "移除"}
                                      </button>
                                    </td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                          <button className="rounded-mdplus border border-slate-300 px-3 py-1.5 text-sm" onClick={openFieldPicker}>
                            + 工作项属性
                          </button>
                        </div>
                      )}
                    </section>
                  ) : (
                    <section>
                      <div className="rounded border border-brand-100 bg-brand-50 px-3 py-2 text-xs text-brand-700">
                        Map internal workflow statuses to customer-visible labels.
                      </div>
                      {statusLoading ? (
                        <div className="mt-4 space-y-3">
                          <div className="h-9 animate-pulse rounded bg-slate-100" />
                          <div className="h-9 animate-pulse rounded bg-slate-100" />
                          <div className="h-9 animate-pulse rounded bg-slate-100" />
                          <p className="text-xs text-slate-500">Loading workflow statuses...</p>
                        </div>
                      ) : mappingStatuses.length === 0 ? (
                        <p className="mt-4 rounded border border-dashed border-slate-300 bg-slate-50 px-3 py-4 text-sm text-slate-500">
                          No workflow statuses loaded for this project yet.
                        </p>
                      ) : (
                        <div className="mt-4 rounded-mdplus border border-slate-200">
                          <table className="w-full text-left text-sm">
                            <thead className="bg-slate-50 text-slate-600">
                              <tr>
                                <th className="px-3 py-2">内部工作项状态名</th>
                                <th className="px-3 py-2">外部客户侧显示的状态名</th>
                              </tr>
                            </thead>
                            <tbody>
                              {mappingStatuses.map((status, idx) => (
                                <tr key={status.key} className="border-t border-slate-200">
                                  <td className="px-3 py-2">
                                    <span className={idx === 0 ? "font-semibold text-brand-600" : "font-medium text-slate-700"}>{status.name}</span>
                                  </td>
                                  <td className="px-3 py-2">
                                    <input
                                      className="w-full rounded border border-slate-200 px-2 py-1"
                                      placeholder="客户可见状态"
                                      value={typeStatusMapping[status.key] ?? ""}
                                      onChange={(e) => setTypeStatusMapping((prev) => ({ ...prev, [status.key]: e.target.value }))}
                                    />
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      )}
                    </section>
                  )}
                </div>
              </div>
            </div>

            {fieldPickerOpen ? (
              <div className="absolute inset-0 z-10 flex items-center justify-center bg-black/30 px-4">
                <div className="h-[78vh] w-[92%] max-w-5xl rounded-lg border border-slate-200 bg-white shadow-2xl">
                  <div className="flex h-full flex-col">
                    <div className="flex items-center justify-between border-b border-slate-200 px-6 py-4">
                      <h3 className="text-3xl font-semibold text-[#16171A]">添加工作项属性</h3>
                      <button className="text-2xl text-slate-400 hover:text-slate-700" onClick={() => setFieldPickerOpen(false)}>
                        ×
                      </button>
                    </div>
                    <div className="grid min-h-0 flex-1 grid-cols-[320px_1fr]">
                      <aside className="border-r border-slate-200 p-5">
                        <p className="text-3xl font-semibold text-[#16171A]">可选属性</p>
                        <input
                          className="mt-4 w-full rounded-mdplus border border-slate-200 px-3 py-2 text-sm"
                          placeholder="搜索属性..."
                          value={fieldPickerQuery}
                          onChange={(e) => setFieldPickerQuery(e.target.value)}
                        />
                        <div className="mt-4 flex gap-4 border-b border-slate-200">
                          <button
                            className={`pb-2 text-sm ${fieldPickerTab === "required" ? "border-b-2 border-brand-500 text-brand-600" : "text-slate-500"}`}
                            onClick={() => setFieldPickerTab("required")}
                          >
                            必填属性
                          </button>
                          <button
                            className={`pb-2 text-sm ${fieldPickerTab === "optional" ? "border-b-2 border-brand-500 text-brand-600" : "text-slate-500"}`}
                            onClick={() => setFieldPickerTab("optional")}
                          >
                            非必填属性
                          </button>
                        </div>
                        <div className="mt-3 max-h-[46vh] space-y-2 overflow-auto pr-1">
                          {pickerCandidates.map((field) => (
                            <label key={field.key} className="flex items-center gap-2 text-sm text-slate-700">
                              <input
                                type="checkbox"
                                checked={field.required ? true : pickerSelectedSet.has(field.key)}
                                disabled={field.required}
                                onChange={(e) =>
                                  setFieldPickerDraftKeys((prev) => {
                                    if (field.required) return prev;
                                    const set = new Set(prev);
                                    if (e.target.checked) set.add(field.key);
                                    else set.delete(field.key);
                                    return Array.from(set);
                                  })
                                }
                              />
                              <span>{field.label}</span>
                            </label>
                          ))}
                        </div>
                      </aside>
                      <section className="p-5">
                        <p className="text-3xl font-semibold text-[#16171A]">已选属性(共{fieldPickerDraftKeys.length}个)</p>
                        <div className="mt-4 overflow-hidden rounded-mdplus border border-slate-200">
                          <table className="w-full text-left text-sm">
                            <thead className="bg-slate-50 text-slate-600">
                              <tr>
                                <th className="px-3 py-2">属性名称</th>
                                <th className="px-3 py-2">默认值</th>
                                <th className="px-3 py-2">是否必填</th>
                                <th className="px-3 py-2">操作</th>
                              </tr>
                            </thead>
                            <tbody>
                              {typeFieldSchema
                                .filter((field) => field.required || pickerSelectedSet.has(field.key))
                                .map((field) => (
                                  <tr key={field.key} className="border-t border-slate-200">
                                    <td className="px-3 py-2">{field.label}</td>
                                    <td className="px-3 py-2">-</td>
                                    <td className="px-3 py-2">{field.required ? "是" : "否"}</td>
                                    <td className="px-3 py-2">
                                      <button
                                        className="text-xl leading-none text-slate-500 disabled:text-slate-300"
                                        disabled={field.required}
                                        onClick={() => setFieldPickerDraftKeys((prev) => prev.filter((key) => key !== field.key))}
                                      >
                                        ×
                                      </button>
                                    </td>
                                  </tr>
                                ))}
                            </tbody>
                          </table>
                        </div>
                      </section>
                    </div>
                    <div className="flex justify-end gap-2 border-t border-slate-200 px-6 py-4">
                      <button className="rounded border border-slate-300 px-4 py-2 text-sm" onClick={() => setFieldPickerOpen(false)}>
                        取消
                      </button>
                      <button className="rounded bg-brand-500 px-4 py-2 text-sm font-medium text-white" onClick={applyFieldPicker}>
                        添加
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            ) : null}

            <div className="border-t border-slate-200 px-6 py-4">
              <div className="flex justify-end gap-2">
              <button className="rounded border border-slate-300 px-3 py-2 text-sm" onClick={() => setConfiguringType(null)}>
                Cancel
              </button>
              <button className="rounded bg-brand-500 px-3 py-2 text-sm font-medium text-white" onClick={() => void saveTypeConfig()} disabled={saving || typeConfigLoading}>
                Save
              </button>
            </div>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  );
}
