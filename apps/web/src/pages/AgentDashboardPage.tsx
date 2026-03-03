import * as Tabs from "@radix-ui/react-tabs";
import { Sparkles } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import {
  assignTicket,
  getAiAgentMode,
  getAiMetricsSummary,
  listSupportTickets,
  runBulkTicketAction,
  setAiAgentMode,
  transitionTicket
} from "../lib/api";
import type { AgentQueueTicket, TicketStatus } from "../lib/types";
import { StatusBadge } from "../components/StatusBadge";

type QueueTab = "pending" | "mine" | "all";
type SlaRisk = "healthy" | "at_risk" | "breached";

function formatRemaining(slaDueAt: string | null | undefined): string {
  if (!slaDueAt) return "-";
  const diff = new Date(slaDueAt).getTime() - Date.now();
  if (diff <= 0) return "Overdue";
  const hours = Math.floor(diff / (1000 * 60 * 60));
  const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
  return `${hours}h ${minutes}m`;
}

const riskTone: Record<SlaRisk, string> = {
  healthy: "bg-emerald-50 text-emerald-700",
  at_risk: "bg-amber-50 text-amber-700",
  breached: "bg-rose-50 text-rose-700"
};

export function AgentDashboardPage() {
  const [tab, setTab] = useState<QueueTab>("pending");
  const [rows, setRows] = useState<AgentQueueTicket[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [workingId, setWorkingId] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [assigneeFilter, setAssigneeFilter] = useState("Support Team");
  const [statusFilter, setStatusFilter] = useState<TicketStatus | "ALL">("ALL");
  const [priorityFilter, setPriorityFilter] = useState<"ALL" | "P1" | "P2" | "P3" | "P4">("ALL");
  const [riskFilter, setRiskFilter] = useState<"ALL" | SlaRisk>("ALL");
  const [typeFilter, setTypeFilter] = useState<string>("");
  const [metrics, setMetrics] = useState<{ hitRate: number; citationCoverage: number; fallbackRate: number } | null>(null);
  const [aiMode, setAiMode] = useState<{ enabled: boolean; updatedAt: string; updatedBy: string } | null>(null);
  const [modeSaving, setModeSaving] = useState(false);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const list = await listSupportTickets({
        queue: tab,
        assignee: tab === "mine" ? assigneeFilter : undefined,
        status: statusFilter === "ALL" ? undefined : statusFilter,
        priority: priorityFilter === "ALL" ? undefined : priorityFilter,
        slaRisk: riskFilter === "ALL" ? undefined : riskFilter,
        ticketType: typeFilter || undefined,
        sort: "sla_risk"
      });
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
  const allSelected = sortedRows.length > 0 && selectedIds.length === sortedRows.length;

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

  const onBulkAction = async (action: "assign" | "priority" | "escalate") => {
    if (selectedIds.length === 0) {
      setError("Select at least one ticket.");
      return;
    }
    const confirmed = window.confirm(`Apply "${action}" to ${selectedIds.length} ticket(s)?`);
    if (!confirmed) return;
    setWorkingId("bulk");
    setError(null);
    try {
      await runBulkTicketAction({
        ticketIds: selectedIds,
        action,
        assigneeType: action === "assign" ? "SUPPORT_TEAM" : undefined,
        assigneeName: action === "assign" ? assigneeFilter : undefined,
        priority: action === "priority" ? "P2" : undefined,
        actor: "support_operator"
      });
      setSelectedIds([]);
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setWorkingId(null);
    }
  };

  const onToggleAiMode = async (enabled: boolean) => {
    const reason = window.prompt(`Switch AI mode to ${enabled ? "ON" : "OFF"}. Enter reason for audit:`, "support_operation") || "support_operation";
    setModeSaving(true);
    setError(null);
    try {
      const mode = await setAiAgentMode(enabled, "support_admin", reason);
      setAiMode({ enabled: mode.enabled, updatedAt: mode.updatedAt, updatedBy: mode.updatedBy });
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setModeSaving(false);
    }
  };

  return (
    <div className="mx-auto max-w-7xl px-4 py-8 md:px-8 md:py-12">
      <h1 className="text-3xl font-bold text-ink">Support Portal</h1>
      <p className="mt-2 text-sm text-slate-600">Queue-first console. Canonical route: /support</p>
      <div className="mt-4 rounded-mdplus border border-slate-200 bg-white p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-sm font-semibold text-[#16171A]">AI Mode Selector (Global)</p>
            <p className="text-xs text-slate-500">
              {aiMode ? `Updated by ${aiMode.updatedBy} at ${new Date(aiMode.updatedAt).toLocaleString()}` : "Mode unavailable"}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <span className={`rounded-full px-2 py-1 text-xs ${aiMode?.enabled ? "bg-emerald-50 text-emerald-700" : "bg-amber-50 text-amber-700"}`}>
              {aiMode?.enabled ? "AI ON: First line active" : "AI OFF: Manual support"}
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

      <Tabs.Root className="mt-6" value={tab} onValueChange={(v) => setTab(v as QueueTab)}>
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

      <div className="mt-4 grid gap-2 md:grid-cols-6">
        <input value={assigneeFilter} onChange={(e) => setAssigneeFilter(e.target.value)} className="h-10 rounded-mdplus border border-slate-200 px-3 text-sm" placeholder="Assignee for Mine" />
        <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as TicketStatus | "ALL")} className="h-10 rounded-mdplus border border-slate-200 px-3 text-sm">
          <option value="ALL">Status: All</option>
          <option value="OPEN">OPEN</option>
          <option value="IN_PROGRESS">IN_PROGRESS</option>
          <option value="WAITING_CUSTOMER">WAITING_CUSTOMER</option>
          <option value="ESCALATED_RND">ESCALATED_RND</option>
          <option value="RESOLVED">RESOLVED</option>
          <option value="CLOSED">CLOSED</option>
        </select>
        <select value={priorityFilter} onChange={(e) => setPriorityFilter(e.target.value as typeof priorityFilter)} className="h-10 rounded-mdplus border border-slate-200 px-3 text-sm">
          <option value="ALL">Priority: All</option>
          <option value="P1">P1</option>
          <option value="P2">P2</option>
          <option value="P3">P3</option>
          <option value="P4">P4</option>
        </select>
        <select value={riskFilter} onChange={(e) => setRiskFilter(e.target.value as typeof riskFilter)} className="h-10 rounded-mdplus border border-slate-200 px-3 text-sm">
          <option value="ALL">SLA Risk: All</option>
          <option value="healthy">healthy</option>
          <option value="at_risk">at_risk</option>
          <option value="breached">breached</option>
        </select>
        <input value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)} className="h-10 rounded-mdplus border border-slate-200 px-3 text-sm" placeholder="Ticket type key" />
        <button className="rounded-mdplus border border-slate-200 px-3 py-2 text-sm" onClick={() => void load()}>
          Refresh
        </button>
      </div>

      <div className="mt-3 flex flex-wrap gap-2">
        <button className="rounded border border-slate-200 px-3 py-1.5 text-xs" disabled={workingId === "bulk"} onClick={() => void onBulkAction("assign")}>
          Bulk Assign
        </button>
        <button className="rounded border border-slate-200 px-3 py-1.5 text-xs" disabled={workingId === "bulk"} onClick={() => void onBulkAction("priority")}>
          Bulk Priority P2
        </button>
        <button className="rounded border border-rose-200 px-3 py-1.5 text-xs text-rose-700" disabled={workingId === "bulk"} onClick={() => void onBulkAction("escalate")}>
          Bulk Escalate R&D
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
              <th className="px-4 py-3">
                <input
                  type="checkbox"
                  checked={allSelected}
                  onChange={(e) => {
                    if (e.target.checked) {
                      setSelectedIds(sortedRows.map((row) => row.id));
                      return;
                    }
                    setSelectedIds([]);
                  }}
                />
              </th>
              <th className="px-4 py-3">ID & Title</th>
              <th className="px-4 py-3">Customer</th>
              <th className="px-4 py-3">Status</th>
              <th className="px-4 py-3">SLA</th>
              <th className="px-4 py-3">Mode</th>
              <th className="px-4 py-3">Assignee</th>
              <th className="px-4 py-3">Actions</th>
            </tr>
          </thead>
          <tbody>
            {sortedRows.map((row) => (
              <tr key={row.id} className="group border-t border-slate-100 align-top hover:bg-slate-50/60">
                <td className="px-4 py-4">
                  <input
                    type="checkbox"
                    checked={selectedIds.includes(row.id)}
                    onChange={(e) =>
                      setSelectedIds((prev) =>
                        e.target.checked ? Array.from(new Set([...prev, row.id])) : prev.filter((id) => id !== row.id)
                      )
                    }
                  />
                </td>
                <td className="px-4 py-4">
                  <Link to={`/support/tickets/${row.id}`} className="font-medium text-brand-500 hover:underline">
                    {row.ticket_no}
                  </Link>
                  <div className="text-slate-700">{row.title}</div>
                  <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-slate-500">
                    {row.priority && <span className="rounded bg-slate-100 px-1.5 py-0.5">{row.priority}</span>}
                    {row.sla_risk && <span className={`rounded px-1.5 py-0.5 ${riskTone[row.sla_risk]}`}>{row.sla_risk}</span>}
                    {row.ones_ticket_type_key && <span className="rounded bg-brand-50 px-1.5 py-0.5 text-brand-600">{row.ones_ticket_type_key}</span>}
                  </div>
                  {(row.triage_reasoning_summary || row.triage_evidence?.length) && (
                    <div className="mt-2 rounded-mdplus border border-brand-100 bg-brand-50 p-2 text-xs text-slate-700">
                      <div className="mb-1 flex items-center gap-1 text-brand-600">
                        <Sparkles size={12} /> AI Recommendation
                      </div>
                      <div>{row.triage_reasoning_summary ?? "No summary."}</div>
                      <div className="mt-1 text-[11px] text-slate-600">
                        Confidence: {row.triage_confidence ?? "-"} | Trace: {row.ai_last_trace_id ?? "-"} | Handoff: {row.handoff_reason_code ?? "-"}
                      </div>
                    </div>
                  )}
                </td>
                <td className="px-4 py-4">{row.customer_name}</td>
                <td className="px-4 py-4">
                  <StatusBadge status={row.status} />
                </td>
                <td className="px-4 py-4">
                  <div>{formatRemaining(row.resolution_due_at ?? row.sla_due_at)}</div>
                  <div className="text-xs text-slate-500">Due: {row.resolution_due_at ? new Date(row.resolution_due_at).toLocaleString() : "-"}</div>
                </td>
                <td className="px-4 py-4">
                  <span className={`rounded-full px-2 py-1 text-[11px] ${row.ai_mode_snapshot === "AI_OFF" ? "bg-amber-50 text-amber-700" : "bg-emerald-50 text-emerald-700"}`}>
                    {row.ai_mode_snapshot === "AI_OFF" ? "AI_OFF" : "AI_ON"}
                  </span>
                </td>
                <td className="px-4 py-4">{row.assignee_name}</td>
                <td className="px-4 py-4">
                  <div className="flex flex-wrap gap-2">
                    <button className="rounded border border-slate-200 px-2 py-1 text-xs" disabled={workingId === row.id} onClick={() => void runAction(row.id, "claim")}>
                      Claim
                    </button>
                    <button className="rounded border border-slate-200 px-2 py-1 text-xs" disabled={workingId === row.id} onClick={() => void runAction(row.id, "waiting")}>
                      Ask Customer
                    </button>
                    <button className="rounded border border-slate-200 px-2 py-1 text-xs" disabled={workingId === row.id} onClick={() => void runAction(row.id, "resolve")}>
                      Resolve
                    </button>
                    <button className="rounded border border-rose-200 px-2 py-1 text-xs text-rose-700" disabled={workingId === row.id} onClick={() => void runAction(row.id, "escalate")}>
                      Escalate R&D
                    </button>
                    <Link className="rounded border border-slate-200 px-2 py-1 text-xs" to={`/support/tickets/${row.id}`}>
                      Open
                    </Link>
                  </div>
                </td>
              </tr>
            ))}
            {!sortedRows.length && !loading && (
              <tr>
                <td className="px-4 py-10 text-center text-sm text-slate-500" colSpan={8}>
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
