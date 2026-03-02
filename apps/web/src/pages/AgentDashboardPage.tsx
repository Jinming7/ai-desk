import * as Tabs from "@radix-ui/react-tabs";
import { Sparkles } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { assignTicket, getAiMetricsSummary, listAgentTickets, transitionTicket } from "../lib/api";
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

  return (
    <div className="mx-auto max-w-7xl px-4 py-8 md:px-8 md:py-12">
      <h1 className="text-3xl font-bold text-ink">Agent Queue</h1>
      <p className="mt-2 text-sm text-slate-600">Internal Portal Route: /agent</p>

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
