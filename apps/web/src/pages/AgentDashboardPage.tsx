import * as Tabs from "@radix-ui/react-tabs";
import { Sparkles } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { assignTicket, createTicket, getAiAgentMode, getAiMetricsSummary, listAgentTickets, setAiAgentMode, transitionTicket } from "../lib/api";
import type { AgentQueueTicket } from "../lib/types";
import { StatusBadge } from "../components/StatusBadge";

function formatRemaining(slaDueAt: string | null): string {
  if (!slaDueAt) return "-";
  const diff = new Date(slaDueAt).getTime() - Date.now();
  if (diff <= 0) return "Overdue";
  const hours = Math.floor(diff / (1000 * 60 * 60));
  const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
  return `${hours}h ${minutes}m`;
}

export function AgentDashboardPage() {
  const [tab, setTab] = useState<"pending" | "mine" | "all">("pending");
  const [rows, setRows] = useState<AgentQueueTicket[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [workingId, setWorkingId] = useState<string | null>(null);
  const [assigneeFilter, setAssigneeFilter] = useState("Support Team");
  const [metrics, setMetrics] = useState<{ hitRate: number; citationCoverage: number; fallbackRate: number } | null>(null);
  const [aiMode, setAiMode] = useState<{ enabled: boolean; updatedAt: string; updatedBy: string } | null>(null);
  const [modeSaving, setModeSaving] = useState(false);
  const [createInput, setCreateInput] = useState({
    title: "",
    description: "",
    serviceCategory: "technical_support" as const,
    customerId: "",
    customerName: "",
    customerEmail: "",
    environment: "unknown" as "production" | "staging" | "test" | "unknown",
    reproducibility: "unknown" as "always" | "sometimes" | "once" | "unknown",
    impactSummary: ""
  });

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const list = await listAgentTickets(tab, tab === "mine" ? assigneeFilter : undefined);
      setRows(list);
    } catch (err) {
      setError((err as Error).message);
      setRows([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, [tab]);

  useEffect(() => {
    getAiMetricsSummary()
      .then(setMetrics)
      .catch(() => setMetrics(null));
    getAiAgentMode()
      .then((mode) => setAiMode({ enabled: mode.enabled, updatedAt: mode.updatedAt, updatedBy: mode.updatedBy }))
      .catch(() => setAiMode(null));
  }, []);

  const sortedRows = useMemo(() => rows, [rows]);

  const runAction = async (ticketId: string, action: "resolve" | "waiting" | "escalate" | "claim") => {
    setWorkingId(ticketId);
    setError(null);
    try {
      if (action === "resolve") {
        await transitionTicket(ticketId, "RESOLVED", "manual_resolution");
      } else if (action === "waiting") {
        await transitionTicket(ticketId, "WAITING_CUSTOMER", "manual_waiting_customer");
      } else if (action === "escalate") {
        await transitionTicket(ticketId, "ESCALATED_RND", "manual_escalation");
        await assignTicket(ticketId, "RND_TEAM", "R&D Team", "manual_escalation");
      } else {
        await assignTicket(ticketId, "SUPPORT_TEAM", assigneeFilter, "manual_claim");
      }
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setWorkingId(null);
    }
  };

  const onToggleAiMode = async (enabled: boolean) => {
    setModeSaving(true);
    setError(null);
    try {
      const mode = await setAiAgentMode(enabled, "admin_portal");
      setAiMode({ enabled: mode.enabled, updatedAt: mode.updatedAt, updatedBy: mode.updatedBy });
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setModeSaving(false);
    }
  };

  const onCreateTicket = async () => {
    if (createInput.title.trim().length < 3) {
      setError("Internal create: title must be at least 3 characters.");
      return;
    }
    if (createInput.description.trim().length < 5) {
      setError("Internal create: description must be at least 5 characters.");
      return;
    }
    if (!createInput.customerId.trim() || !createInput.customerName.trim()) {
      setError("Internal create: requester ID and name are required.");
      return;
    }

    setError(null);
    setWorkingId("create");
    try {
      await createTicket({
        title: createInput.title.trim(),
        description: createInput.description.trim(),
        serviceCategory: createInput.serviceCategory,
        customer: {
          id: createInput.customerId.trim(),
          name: createInput.customerName.trim(),
          email: createInput.customerEmail.trim() || undefined
        },
        environment: createInput.environment,
        reproducibility: createInput.reproducibility,
        impactSummary: createInput.impactSummary.trim()
      });
      setCreateInput({
        title: "",
        description: "",
        serviceCategory: "technical_support",
        customerId: "",
        customerName: "",
        customerEmail: "",
        environment: "unknown",
        reproducibility: "unknown",
        impactSummary: ""
      });
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setWorkingId(null);
    }
  };

  return (
    <div className="mx-auto max-w-7xl px-4 py-8 md:px-8 md:py-12">
      <h1 className="text-3xl font-bold text-ink">Agent Queue</h1>
      <p className="mt-2 text-sm text-slate-600">Internal Portal Route: /agent</p>
      <div className="mt-4 rounded-mdplus border border-slate-200 bg-white p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-sm font-semibold text-[#16171A]">AI Agent Mode</p>
            <p className="text-xs text-slate-500">
              {aiMode ? `Updated by ${aiMode.updatedBy} at ${new Date(aiMode.updatedAt).toLocaleString()}` : "Mode unavailable"}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <span className={`rounded-full px-2 py-1 text-xs ${aiMode?.enabled ? "bg-emerald-50 text-emerald-700" : "bg-amber-50 text-amber-700"}`}>
              {aiMode?.enabled ? "AI ON (AI-first)" : "AI OFF (Direct R&D)"}
            </span>
            <button
              className="rounded-mdplus border border-slate-200 px-3 py-1.5 text-xs"
              onClick={() => void onToggleAiMode(!aiMode?.enabled)}
              disabled={modeSaving || !aiMode}
            >
              {modeSaving ? "Saving..." : aiMode?.enabled ? "Switch OFF" : "Switch ON"}
            </button>
          </div>
        </div>
      </div>

      <div className="mt-4 rounded-mdplus border border-slate-200 bg-white p-4">
        <h2 className="text-sm font-semibold text-[#16171A]">Create Ticket (Management Portal)</h2>
        <p className="mt-1 text-xs text-slate-500">Required: title, description, requester ID, requester name, service category.</p>
        <div className="mt-3 grid gap-3 md:grid-cols-2">
          <input className="rounded-mdplus border border-slate-200 px-3 py-2 text-sm" placeholder="Title *" value={createInput.title} onChange={(e) => setCreateInput((p) => ({ ...p, title: e.target.value }))} />
          <select className="rounded-mdplus border border-slate-200 px-3 py-2 text-sm" value={createInput.serviceCategory} onChange={(e) => setCreateInput((p) => ({ ...p, serviceCategory: e.target.value as typeof p.serviceCategory }))}>
            <option value="technical_support">Technical Support</option>
            <option value="feature_consulting">Feature Consulting</option>
            <option value="account_issue">Account Issue</option>
          </select>
          <input className="rounded-mdplus border border-slate-200 px-3 py-2 text-sm" placeholder="Requester ID *" value={createInput.customerId} onChange={(e) => setCreateInput((p) => ({ ...p, customerId: e.target.value }))} />
          <input className="rounded-mdplus border border-slate-200 px-3 py-2 text-sm" placeholder="Requester Name *" value={createInput.customerName} onChange={(e) => setCreateInput((p) => ({ ...p, customerName: e.target.value }))} />
          <input className="rounded-mdplus border border-slate-200 px-3 py-2 text-sm" placeholder="Requester Email (optional)" value={createInput.customerEmail} onChange={(e) => setCreateInput((p) => ({ ...p, customerEmail: e.target.value }))} />
          <input className="rounded-mdplus border border-slate-200 px-3 py-2 text-sm" placeholder="Impact summary (optional)" value={createInput.impactSummary} onChange={(e) => setCreateInput((p) => ({ ...p, impactSummary: e.target.value }))} />
          <select className="rounded-mdplus border border-slate-200 px-3 py-2 text-sm" value={createInput.environment} onChange={(e) => setCreateInput((p) => ({ ...p, environment: e.target.value as typeof p.environment }))}>
            <option value="unknown">Environment: Unknown</option>
            <option value="production">Environment: Production</option>
            <option value="staging">Environment: Staging</option>
            <option value="test">Environment: Test</option>
          </select>
          <select className="rounded-mdplus border border-slate-200 px-3 py-2 text-sm" value={createInput.reproducibility} onChange={(e) => setCreateInput((p) => ({ ...p, reproducibility: e.target.value as typeof p.reproducibility }))}>
            <option value="unknown">Reproducibility: Unknown</option>
            <option value="always">Reproducibility: Always</option>
            <option value="sometimes">Reproducibility: Sometimes</option>
            <option value="once">Reproducibility: Once</option>
          </select>
        </div>
        <textarea className="mt-3 w-full rounded-mdplus border border-slate-200 px-3 py-2 text-sm" rows={4} placeholder="Description *" value={createInput.description} onChange={(e) => setCreateInput((p) => ({ ...p, description: e.target.value }))} />
        <div className="mt-3 flex justify-end">
          <button className="rounded-mdplus bg-brand-500 px-4 py-2 text-sm text-white disabled:opacity-70" disabled={workingId === "create"} onClick={() => void onCreateTicket()}>
            {workingId === "create" ? "Creating..." : "Create Ticket"}
          </button>
        </div>
      </div>

      <Tabs.Root className="mt-6" value={tab} onValueChange={(v) => setTab(v as typeof tab)}>
        <Tabs.List className="flex gap-2 border-b border-slate-200 pb-2">
          <Tabs.Trigger value="pending" className="rounded-mdplus px-3 py-1.5 text-sm data-[state=active]:bg-brand-500 data-[state=active]:text-white">
            Pending Queue
          </Tabs.Trigger>
          <Tabs.Trigger value="mine" className="rounded-mdplus px-3 py-1.5 text-sm data-[state=active]:bg-brand-500 data-[state=active]:text-white">
            My Tickets
          </Tabs.Trigger>
          <Tabs.Trigger value="all" className="rounded-mdplus px-3 py-1.5 text-sm data-[state=active]:bg-brand-500 data-[state=active]:text-white">
            All Tickets
          </Tabs.Trigger>
        </Tabs.List>
      </Tabs.Root>

      <div className="mt-4 flex items-center gap-3">
        <input
          value={assigneeFilter}
          onChange={(e) => setAssigneeFilter(e.target.value)}
          className="h-10 rounded-mdplus border border-slate-200 px-3 text-sm"
          placeholder="Assignee for 'Mine'"
        />
        <button className="rounded-mdplus border border-slate-200 px-3 py-2 text-sm" onClick={() => void load()}>
          Refresh
        </button>
      </div>
      {metrics && (
        <div className="mt-4 grid gap-3 md:grid-cols-3">
          <div className="rounded-mdplus border border-slate-200 bg-white p-3 text-sm text-slate-700">
            <p className="text-xs text-slate-500">KB Hit Rate (24h)</p>
            <p className="mt-1 text-xl font-semibold text-[#16171A]">{(metrics.hitRate * 100).toFixed(1)}%</p>
          </div>
          <div className="rounded-mdplus border border-slate-200 bg-white p-3 text-sm text-slate-700">
            <p className="text-xs text-slate-500">Citation Coverage (24h)</p>
            <p className="mt-1 text-xl font-semibold text-[#16171A]">{metrics.citationCoverage.toFixed(2)}</p>
          </div>
          <div className="rounded-mdplus border border-slate-200 bg-white p-3 text-sm text-slate-700">
            <p className="text-xs text-slate-500">Fallback Rate (24h)</p>
            <p className="mt-1 text-xl font-semibold text-[#16171A]">{(metrics.fallbackRate * 100).toFixed(1)}%</p>
          </div>
        </div>
      )}
      {error && <p className="mt-3 text-sm text-rose-600">{error}</p>}
      {loading && <p className="mt-4 text-sm text-slate-600">Loading queue...</p>}

      <div className="mt-4 overflow-hidden rounded-mdplus border border-slate-200 bg-white">
        <table className="w-full text-left text-sm">
          <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
            <tr>
              <th className="px-4 py-3">ID & Title</th>
              <th className="px-4 py-3">Customer</th>
              <th className="px-4 py-3">Status</th>
              <th className="px-4 py-3">SLA</th>
              <th className="px-4 py-3">Assignee</th>
              <th className="px-4 py-3">Actions</th>
            </tr>
          </thead>
          <tbody>
            {sortedRows.map((row) => (
              <tr key={row.id} className="group border-t border-slate-100 align-top hover:bg-slate-50/60">
                <td className="px-4 py-4">
                  <div className="font-medium text-brand-500">{row.ticket_no}</div>
                  <div className="text-slate-700">{row.title}</div>
                  {(row.triage_reasoning_summary || row.triage_evidence?.length) && (
                    <div className="mt-2 rounded-mdplus border border-brand-100 bg-brand-50 p-2 text-xs text-slate-700">
                      <div className="mb-1 flex items-center gap-1 text-brand-600">
                        <Sparkles size={12} /> Triage
                      </div>
                      <div>{row.triage_reasoning_summary ?? "No summary."}</div>
                      <div className="mt-1 text-[11px] text-slate-600">
                        Confidence: {row.triage_confidence ?? "-"} | Evidence: {row.triage_evidence?.join(", ") || "-"} |
                        Handoff Reason: {row.handoff_reason_code ?? "-"}
                      </div>
                    </div>
                  )}
                </td>
                <td className="px-4 py-4">{row.customer_name}</td>
                <td className="px-4 py-4">
                  <StatusBadge status={row.status} />
                </td>
                <td className="px-4 py-4">{formatRemaining(row.sla_due_at)}</td>
                <td className="px-4 py-4">{row.assignee_name}</td>
                <td className="px-4 py-4">
                  <div className="flex flex-wrap gap-2">
                    <button
                      className="rounded border border-slate-200 px-2 py-1 text-xs"
                      disabled={workingId === row.id}
                      onClick={() => void runAction(row.id, "claim")}
                    >
                      Claim
                    </button>
                    <button
                      className="rounded border border-slate-200 px-2 py-1 text-xs"
                      disabled={workingId === row.id}
                      onClick={() => void runAction(row.id, "waiting")}
                    >
                      Ask Customer
                    </button>
                    <button
                      className="rounded border border-slate-200 px-2 py-1 text-xs"
                      disabled={workingId === row.id}
                      onClick={() => void runAction(row.id, "resolve")}
                    >
                      Resolve
                    </button>
                    <button
                      className="rounded border border-rose-200 px-2 py-1 text-xs text-rose-700"
                      disabled={workingId === row.id}
                      onClick={() => void runAction(row.id, "escalate")}
                    >
                      Escalate R&D
                    </button>
                    <Link className="rounded border border-slate-200 px-2 py-1 text-xs" to={`/agent/tickets/${row.id}`}>
                      Open
                    </Link>
                  </div>
                </td>
              </tr>
            ))}
            {!sortedRows.length && !loading && (
              <tr>
                <td className="px-4 py-10 text-center text-sm text-slate-500" colSpan={6}>
                  No tickets in this queue.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
