import { useEffect, useMemo, useState } from "react";
import {
  discoverOnesTicketTypes,
  getOnesSyncConfig,
  listOnesMappings,
  listOnesTicketTypesInternal,
  publishOnesMapping,
  rollbackOnesMapping,
  saveOnesMappingDraft,
  updateOnesSyncConfig,
  validateOnesMapping
} from "../lib/api";
import type { OnesTicketType } from "../lib/types";

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

export function OnesSyncConfigPage() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [discovering, setDiscovering] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [ticketTypes, setTicketTypes] = useState<OnesTicketType[]>([]);
  const [selectedType, setSelectedType] = useState<string>("");
  const [flow, setFlow] = useState<"create" | "update">("create");
  const [draftRows, setDraftRows] = useState<MappingRow[]>(defaultMapping);
  const [draftId, setDraftId] = useState<string | null>(null);
  const [validation, setValidation] = useState<{ valid: boolean; errors: string[]; payload: Record<string, unknown> } | null>(null);
  const [form, setForm] = useState<{
    profileName: string;
    baseUrl: string;
    authType: "bearer" | "header";
    authHeader: string;
    authSecret: string;
    createTicketPath: string;
    listTicketTypesPath: string;
    listFieldsPathTemplate: string;
    timeoutMs: number;
    retries: number;
  }>({
    profileName: "default",
    baseUrl: "",
    authType: "bearer",
    authHeader: "Authorization",
    authSecret: "",
    createTicketPath: "/api/v1/tickets",
    listTicketTypesPath: "/api/v1/ticket-types",
    listFieldsPathTemplate: "/api/v1/ticket-types/{ticketTypeKey}/fields",
    timeoutMs: 12000,
    retries: 1
  });

  const selectedTypeDetail = useMemo(() => ticketTypes.find((t) => t.key === selectedType) ?? null, [selectedType, ticketTypes]);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const [config, types] = await Promise.all([getOnesSyncConfig(), listOnesTicketTypesInternal()]);
      if (config) {
        setForm({
          profileName: config.profileName,
          baseUrl: config.baseUrl,
          authType: config.authType,
          authHeader: config.authHeader,
          authSecret: "",
          createTicketPath: config.createTicketPath,
          listTicketTypesPath: config.listTicketTypesPath,
          listFieldsPathTemplate: config.listFieldsPathTemplate,
          timeoutMs: config.timeoutMs,
          retries: config.retries
        });
      }
      setTicketTypes(types);
      if (types.length > 0) {
        setSelectedType((prev) => prev || types[0].key);
      }
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
    if (!form.baseUrl) {
      setError("Base URL is required.");
      return;
    }
    if (!form.authSecret) {
      setError("Auth Secret is required when updating config.");
      return;
    }
    setSaving(true);
    setError(null);
    setSuccess(null);
    try {
      await updateOnesSyncConfig({
        ...form,
        actor: "support_admin"
      });
      setSuccess("ONES sync config updated.");
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const saveDraft = async () => {
    if (!selectedType) {
      setError("Select a ticket type first.");
      return;
    }
    setSaving(true);
    setError(null);
    setSuccess(null);
    try {
      const draft = await saveOnesMappingDraft({
        ticketTypeKey: selectedType,
        flow,
        mappings: draftRows,
        actor: "support_admin"
      });
      setDraftId(draft.id);
      setSuccess(`Draft saved (v${draft.version}).`);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const runValidate = async () => {
    if (!selectedType) {
      setError("Select a ticket type first.");
      return;
    }
    setSaving(true);
    setError(null);
    setSuccess(null);
    try {
      const result = await validateOnesMapping({
        ticketTypeKey: selectedType,
        flow,
        mappings: draftRows,
        sampleContext: {
          title: "Sample ticket title",
          description: "Sample ticket description",
          customer: { name: "Acme User", id: "customer_demo" },
          fields: { module: "auth", severity: "high" }
        }
      });
      setValidation(result);
      setSuccess(result.valid ? "Validation passed." : "Validation returned errors.");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const publishDraft = async () => {
    if (!draftId) {
      setError("No draft mapping to publish.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await publishOnesMapping(draftId, "support_admin");
      setSuccess("Draft published as active mapping.");
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const rollback = async () => {
    if (!selectedType) return;
    setSaving(true);
    setError(null);
    try {
      await rollbackOnesMapping(selectedType, flow, "support_admin");
      setSuccess("Rolled back to previous active mapping.");
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return <div className="mx-auto max-w-7xl px-4 py-8 text-sm text-slate-600">Loading ONES sync configuration...</div>;
  }

  return (
    <div className="mx-auto max-w-7xl space-y-6 px-4 py-8 md:px-8">
      <div>
        <h1 className="text-3xl font-bold text-ink">ONES Sync Configuration</h1>
        <p className="mt-2 text-sm text-slate-600">Configure ticket type discovery and field mappings for create/update ticket synchronization.</p>
      </div>

      {error && <p className="rounded-mdplus border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">{error}</p>}
      {success && <p className="rounded-mdplus border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700">{success}</p>}

      <section className="rounded-mdplus border border-slate-200 bg-white p-4">
        <h2 className="text-sm font-semibold text-[#16171A]">Connection Profile</h2>
        <div className="mt-3 grid gap-3 md:grid-cols-2">
          <input className="rounded-mdplus border border-slate-200 px-3 py-2 text-sm" placeholder="Profile Name" value={form.profileName} onChange={(e) => setForm((p) => ({ ...p, profileName: e.target.value }))} />
          <input className="rounded-mdplus border border-slate-200 px-3 py-2 text-sm" placeholder="Base URL" value={form.baseUrl} onChange={(e) => setForm((p) => ({ ...p, baseUrl: e.target.value }))} />
          <select className="rounded-mdplus border border-slate-200 px-3 py-2 text-sm" value={form.authType} onChange={(e) => setForm((p) => ({ ...p, authType: e.target.value as "bearer" | "header" }))}>
            <option value="bearer">Bearer Token</option>
            <option value="header">Custom Header Token</option>
          </select>
          <input className="rounded-mdplus border border-slate-200 px-3 py-2 text-sm" placeholder="Auth Header" value={form.authHeader} onChange={(e) => setForm((p) => ({ ...p, authHeader: e.target.value }))} />
          <input className="rounded-mdplus border border-slate-200 px-3 py-2 text-sm" placeholder="Auth Secret (required to update)" value={form.authSecret} onChange={(e) => setForm((p) => ({ ...p, authSecret: e.target.value }))} />
          <input className="rounded-mdplus border border-slate-200 px-3 py-2 text-sm" placeholder="Create Ticket Path" value={form.createTicketPath} onChange={(e) => setForm((p) => ({ ...p, createTicketPath: e.target.value }))} />
          <input className="rounded-mdplus border border-slate-200 px-3 py-2 text-sm" placeholder="List Ticket Types Path" value={form.listTicketTypesPath} onChange={(e) => setForm((p) => ({ ...p, listTicketTypesPath: e.target.value }))} />
          <input className="rounded-mdplus border border-slate-200 px-3 py-2 text-sm" placeholder="List Fields Path Template" value={form.listFieldsPathTemplate} onChange={(e) => setForm((p) => ({ ...p, listFieldsPathTemplate: e.target.value }))} />
        </div>
        <div className="mt-3 flex gap-2">
          <button className="rounded-mdplus bg-brand-500 px-3 py-2 text-sm text-white disabled:opacity-70" disabled={saving} onClick={() => void saveConfig()}>
            Save Config
          </button>
          <button className="rounded-mdplus border border-slate-200 px-3 py-2 text-sm" disabled={discovering} onClick={() => {
            setDiscovering(true);
            setError(null);
            discoverOnesTicketTypes("support_admin")
              .then((rows) => {
                setTicketTypes(rows);
                if (rows.length > 0) setSelectedType(rows[0].key);
              })
              .catch((err) => setError((err as Error).message))
              .finally(() => setDiscovering(false));
          }}>
            {discovering ? "Refreshing..." : "Refresh from ONES"}
          </button>
        </div>
      </section>

      <section className="rounded-mdplus border border-slate-200 bg-white p-4">
        <div className="flex flex-wrap items-center gap-2">
          <select className="rounded-mdplus border border-slate-200 px-3 py-2 text-sm" value={selectedType} onChange={(e) => setSelectedType(e.target.value)}>
            {ticketTypes.map((t) => (
              <option key={t.key} value={t.key}>
                {t.name} ({t.key})
              </option>
            ))}
          </select>
          <select className="rounded-mdplus border border-slate-200 px-3 py-2 text-sm" value={flow} onChange={(e) => setFlow(e.target.value as "create" | "update")}>
            <option value="create">Create Flow</option>
            <option value="update">Update Flow</option>
          </select>
          <button className="rounded-mdplus border border-slate-200 px-3 py-2 text-sm" disabled={saving} onClick={() => setDraftRows((rows) => [...rows, { source: "", target: "", transform: "none", transformConfig: {}, requiredPolicy: "hard_fail" }])}>
            Add Mapping Row
          </button>
        </div>

        {selectedTypeDetail && (
          <div className="mt-3 rounded-mdplus border border-slate-200 bg-slate-50 p-3">
            <p className="text-xs font-semibold uppercase text-slate-500">ONES Fields ({selectedTypeDetail.fields.length})</p>
            <div className="mt-2 max-h-40 overflow-auto text-xs text-slate-600">
              {selectedTypeDetail.fields.map((field, idx) => (
                <pre key={`${selectedTypeDetail.key}-${idx}`} className="whitespace-pre-wrap">{JSON.stringify(field)}</pre>
              ))}
            </div>
          </div>
        )}

        <div className="mt-3 space-y-2">
          {draftRows.map((row, idx) => (
            <div key={`mapping-${idx}`} className="grid gap-2 rounded-mdplus border border-slate-200 p-2 md:grid-cols-[1fr_1fr_140px_160px_auto]">
              <input className="rounded border border-slate-200 px-2 py-1 text-xs" placeholder="source (e.g. title)" value={row.source} onChange={(e) => setDraftRows((prev) => prev.map((item, i) => (i === idx ? { ...item, source: e.target.value } : item)))} />
              <input className="rounded border border-slate-200 px-2 py-1 text-xs" placeholder="target field key" value={row.target} onChange={(e) => setDraftRows((prev) => prev.map((item, i) => (i === idx ? { ...item, target: e.target.value } : item)))} />
              <select className="rounded border border-slate-200 px-2 py-1 text-xs" value={row.transform} onChange={(e) => setDraftRows((prev) => prev.map((item, i) => (i === idx ? { ...item, transform: e.target.value as MappingRow["transform"] } : item)))}>
                <option value="none">none</option>
                <option value="concat">concat</option>
                <option value="enumMap">enumMap</option>
                <option value="dateFormat">dateFormat</option>
                <option value="constant">constant</option>
                <option value="fallback">fallback</option>
              </select>
              <select className="rounded border border-slate-200 px-2 py-1 text-xs" value={row.requiredPolicy} onChange={(e) => setDraftRows((prev) => prev.map((item, i) => (i === idx ? { ...item, requiredPolicy: e.target.value as MappingRow["requiredPolicy"] } : item)))}>
                <option value="hard_fail">hard_fail</option>
                <option value="default_value">default_value</option>
              </select>
              <button className="rounded border border-rose-200 px-2 py-1 text-xs text-rose-700" onClick={() => setDraftRows((prev) => prev.filter((_, i) => i !== idx))}>
                Remove
              </button>
            </div>
          ))}
        </div>

        <div className="mt-3 flex flex-wrap gap-2">
          <button className="rounded-mdplus bg-brand-500 px-3 py-2 text-sm text-white disabled:opacity-70" disabled={saving} onClick={() => void saveDraft()}>
            Save Draft
          </button>
          <button className="rounded-mdplus border border-slate-200 px-3 py-2 text-sm" disabled={saving} onClick={() => void runValidate()}>
            Validate + Dry Run
          </button>
          <button className="rounded-mdplus border border-emerald-200 px-3 py-2 text-sm text-emerald-700" disabled={saving || !draftId} onClick={() => void publishDraft()}>
            Publish Active
          </button>
          <button className="rounded-mdplus border border-amber-200 px-3 py-2 text-sm text-amber-700" disabled={saving || !selectedType} onClick={() => void rollback()}>
            Rollback Active
          </button>
        </div>

        {validation && (
          <div className={`mt-3 rounded-mdplus border p-3 text-xs ${validation.valid ? "border-emerald-200 bg-emerald-50 text-emerald-700" : "border-rose-200 bg-rose-50 text-rose-700"}`}>
            <p className="font-semibold">{validation.valid ? "Validation passed" : "Validation failed"}</p>
            {validation.errors.length > 0 && <p className="mt-1">{validation.errors.join("; ")}</p>}
            <pre className="mt-2 whitespace-pre-wrap">{JSON.stringify(validation.payload, null, 2)}</pre>
          </div>
        )}
      </section>
    </div>
  );
}
