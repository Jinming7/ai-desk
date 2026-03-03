import { AlertTriangle, Bot, CheckCircle2, Clock3, Loader2, MessageCircleReply, Sparkles, Ticket } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import {
  assignTicket,
  getAiAgentMode,
  getSupportQueueCounts,
  getSupportUxMetrics,
  getTicketDetail,
  listSupportTickets,
  replyTicketAsAgent,
  runBulkTicketAction,
  setAiAgentMode,
  trackSupportUxEvent,
  transitionTicket
} from "../lib/api";
import { StatusBadge } from "../components/StatusBadge";
import type { AgentQueueTicket, Ticket as TicketDetail, TicketMessage } from "../lib/types";

type SmartQueue = "sla_at_risk" | "ai_suggested" | "new_assigned" | "waiting_my_reply" | "my_all" | "resolved";

const queues: Array<{
  key: SmartQueue;
  label: string;
  icon: typeof AlertTriangle;
  tone: string;
}> = [
  { key: "sla_at_risk", label: "SLA At Risk", icon: AlertTriangle, tone: "text-rose-700 bg-rose-50" },
  { key: "ai_suggested", label: "AI Suggested", icon: Sparkles, tone: "text-brand-700 bg-brand-50" },
  { key: "new_assigned", label: "Newly Assigned", icon: Ticket, tone: "text-slate-700 bg-slate-100" },
  { key: "waiting_my_reply", label: "Waiting My Reply", icon: MessageCircleReply, tone: "text-amber-700 bg-amber-50" },
  { key: "my_all", label: "My All Tickets", icon: Bot, tone: "text-slate-700 bg-slate-100" },
  { key: "resolved", label: "Resolved", icon: CheckCircle2, tone: "text-emerald-700 bg-emerald-50" }
];

function formatRemaining(due: string | null | undefined) {
  if (!due) return "No SLA";
  const diff = new Date(due).getTime() - Date.now();
  if (diff <= 0) return "Overdue";
  const hours = Math.floor(diff / (1000 * 60 * 60));
  const mins = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
  return `${hours}h ${mins}m`;
}

function toneByRisk(risk: AgentQueueTicket["sla_risk"]) {
  if (risk === "breached") return "bg-rose-50 text-rose-700";
  if (risk === "at_risk") return "bg-amber-50 text-amber-700";
  return "bg-emerald-50 text-emerald-700";
}

export function AgentDashboardPage() {
  const featureV2 = import.meta.env.VITE_SUPPORT_WORKBENCH_V2 !== "false";
  const [queue, setQueue] = useState<SmartQueue>("sla_at_risk");
  const [rows, setRows] = useState<AgentQueueTicket[]>([]);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [selectedTicketId, setSelectedTicketId] = useState<string | null>(null);
  const [ticketDetail, setTicketDetail] = useState<TicketDetail | null>(null);
  const [messages, setMessages] = useState<TicketMessage[]>([]);
  const [assignee, setAssignee] = useState("Support Team");
  const [statusFilter, setStatusFilter] = useState<"ALL" | "OPEN" | "IN_PROGRESS" | "WAITING_CUSTOMER" | "ESCALATED_RND" | "RESOLVED" | "CLOSED">("ALL");
  const [priorityFilter, setPriorityFilter] = useState<"ALL" | "P1" | "P2" | "P3" | "P4">("ALL");
  const [loading, setLoading] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [replyBody, setReplyBody] = useState("");
  const [internalNote, setInternalNote] = useState("");
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [aiMode, setAiMode] = useState<{ enabled: boolean; updatedAt: string; updatedBy: string } | null>(null);
  const [aiModeLoading, setAiModeLoading] = useState(true);
  const [uxMetrics, setUxMetrics] = useState<{ firstActionLatencySecondsAvg: number; aiSuggestionAdoptionRate: number; slaAtRiskQueueSelections: number; actionsExecuted: number } | null>(null);

  const loadQueue = async () => {
    setLoading(true);
    setError(null);
    try {
      const [list, queueCounts] = await Promise.all([
        listSupportTickets({
          queue,
          assignee: queue === "my_all" || queue === "waiting_my_reply" ? assignee : undefined,
          status: statusFilter === "ALL" ? undefined : statusFilter,
          priority: priorityFilter === "ALL" ? undefined : priorityFilter,
          sort: "sla_risk"
        }),
        getSupportQueueCounts(assignee)
      ]);
      setRows(list);
      setCounts(queueCounts);
      if (!selectedTicketId && list.length > 0) {
        setSelectedTicketId(list[0].id);
      }
    } catch (err) {
      setError((err as Error).message);
      setRows([]);
    } finally {
      setLoading(false);
    }
  };

  const loadDetail = async (ticketId: string) => {
    setDetailLoading(true);
    try {
      const detail = await getTicketDetail(ticketId);
      setTicketDetail(detail.ticket);
      setMessages(detail.messages);
    } catch (err) {
      setError((err as Error).message);
      setTicketDetail(null);
      setMessages([]);
    } finally {
      setDetailLoading(false);
    }
  };

  useEffect(() => {
    void loadQueue();
  }, [queue, assignee, statusFilter, priorityFilter]);

  useEffect(() => {
    const timer = setInterval(() => {
      void loadQueue();
    }, 30000);
    return () => clearInterval(timer);
  }, [queue, assignee, statusFilter, priorityFilter]);

  useEffect(() => {
    if (!selectedTicketId) return;
    void loadDetail(selectedTicketId);
    void trackSupportUxEvent({ actor: "support_user", eventType: "ticket_opened", ticketId: selectedTicketId }).catch(() => undefined);
  }, [selectedTicketId]);

  useEffect(() => {
    let cancelled = false;
    const loadAiMode = async () => {
      setAiModeLoading(true);
      try {
        const mode = await getAiAgentMode();
        if (!cancelled) setAiMode(mode);
      } catch {
        if (!cancelled) setAiMode(null);
      } finally {
        if (!cancelled) setAiModeLoading(false);
      }
    };
    void loadAiMode();
    getSupportUxMetrics().then(setUxMetrics).catch(() => setUxMetrics(null));
    return () => {
      cancelled = true;
    };
  }, []);

  const selectedRow = useMemo(() => rows.find((r) => r.id === selectedTicketId) ?? null, [rows, selectedTicketId]);

  const changeQueue = async (next: SmartQueue) => {
    setQueue(next);
    setSelectedTicketId(null);
    void trackSupportUxEvent({ actor: "support_user", eventType: "queue_selected", queueKey: next }).catch(() => undefined);
  };

  const refreshAfterAction = async (eventType: "action_executed" | "response_sent" | "ai_suggestion_applied" | "ai_suggestion_overridden", payload?: Record<string, unknown>) => {
    if (!selectedTicketId) return;
    await trackSupportUxEvent({
      actor: "support_user",
      eventType,
      ticketId: selectedTicketId,
      traceId: ticketDetail?.ai_last_trace_id ?? undefined,
      payload
    }).catch(() => undefined);
    await Promise.all([loadQueue(), loadDetail(selectedTicketId)]);
  };

  const runAction = async (action: "ask_customer" | "resolve" | "escalate" | "in_progress" | "close" | "assign_support" | "assign_rnd") => {
    if (!selectedTicketId) return;
    setSaving(true);
    setError(null);
    try {
      if (action === "ask_customer") {
        await transitionTicket(selectedTicketId, "WAITING_CUSTOMER", "manual_waiting_customer");
      } else if (action === "resolve") {
        await transitionTicket(selectedTicketId, "RESOLVED", "manual_resolution");
      } else if (action === "close") {
        await transitionTicket(selectedTicketId, "CLOSED", "manual_resolution");
      } else if (action === "in_progress") {
        await transitionTicket(selectedTicketId, "IN_PROGRESS", "customer_reply");
      } else if (action === "escalate") {
        await transitionTicket(selectedTicketId, "ESCALATED_RND", "manual_escalation");
        await assignTicket(selectedTicketId, "RND_TEAM", "R&D Team", "manual_escalation");
      } else if (action === "assign_support") {
        await assignTicket(selectedTicketId, "SUPPORT_TEAM", assignee, "manual_claim");
      } else if (action === "assign_rnd") {
        await assignTicket(selectedTicketId, "RND_TEAM", "R&D Team", "manual_escalation");
      }
      await refreshAfterAction("action_executed", { action });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const sendReply = async (kind: "public" | "internal") => {
    if (!selectedTicketId) return;
    const body = kind === "public" ? replyBody.trim() : internalNote.trim();
    if (!body) return;
    setSaving(true);
    setError(null);
    try {
      await replyTicketAsAgent(selectedTicketId, kind === "public" ? body : `[INTERNAL_NOTE]\n${body}`, kind === "public" ? "Support Team" : "Support Internal");
      if (kind === "public") setReplyBody("");
      else setInternalNote("");
      await refreshAfterAction("response_sent", { kind });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const bulkAction = async (action: "assign" | "priority" | "escalate") => {
    if (!selectedIds.length) return;
    if (!window.confirm(`Apply ${action} to ${selectedIds.length} tickets?`)) return;
    setSaving(true);
    try {
      await runBulkTicketAction({
        ticketIds: selectedIds,
        action,
        assigneeType: action === "assign" ? "SUPPORT_TEAM" : undefined,
        assigneeName: action === "assign" ? assignee : undefined,
        priority: action === "priority" ? "P2" : undefined
      });
      setSelectedIds([]);
      await loadQueue();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const applyAiSuggestion = async () => {
    if (!ticketDetail?.ai_last_action) return;
    if (ticketDetail.ai_last_action === "resolve") {
      await runAction("resolve");
    } else if (ticketDetail.ai_last_action === "escalate") {
      await runAction("escalate");
    } else {
      setReplyBody((prev) => prev || "Thanks for contacting support. Please share exact reproduction steps, expected result, actual result, and screenshots/logs.");
      await refreshAfterAction("ai_suggestion_applied", { applied: "template" });
    }
  };

  const overrideAiSuggestion = async () => {
    const reason = window.prompt("Override reason (required):");
    if (!reason?.trim()) return;
    await refreshAfterAction("ai_suggestion_overridden", { reason: reason.trim() });
  };

  const toggleAiMode = async () => {
    if (!aiMode || aiModeLoading) return;
    const reason = window.prompt("Reason for AI mode switch:", "support_operation") || "support_operation";
    setSaving(true);
    try {
      const mode = await setAiAgentMode(!aiMode.enabled, "support_admin", reason);
      setAiMode(mode);
      await loadQueue();
    } finally {
      setSaving(false);
    }
  };

  if (!featureV2) {
    return (
      <div className="mx-auto max-w-7xl px-4 py-8">
        <h1 className="text-2xl font-bold">Support Portal</h1>
        <p className="mt-2 text-sm text-slate-600">Three-pane workbench is disabled by feature flag `VITE_SUPPORT_WORKBENCH_V2=false`.</p>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-[1680px] px-4 py-6 md:px-6">
      <div className="mb-4 flex items-center justify-between gap-3 rounded-mdplus border border-slate-200 bg-white p-4">
        <div>
          <h1 className="text-2xl font-semibold text-[#16171A]">Support Agent Workbench</h1>
          <p className="text-sm text-slate-500">Guidance-first console: priority to context to action</p>
        </div>
        <div className="flex items-center gap-2">
          <span
            className={`rounded-full px-2 py-1 text-xs ${
              aiModeLoading ? "bg-slate-100 text-slate-600" : aiMode?.enabled ? "bg-emerald-50 text-emerald-700" : "bg-amber-50 text-amber-700"
            }`}
          >
            {aiModeLoading ? "AI Mode Syncing" : aiMode?.enabled ? "AI ON: First-line automation" : "AI OFF: Manual support"}
          </span>
          <button
            className="rounded border border-slate-200 px-3 py-1 text-xs disabled:cursor-not-allowed disabled:opacity-60"
            onClick={() => void toggleAiMode()}
            disabled={aiModeLoading || saving || !aiMode}
          >
            {aiModeLoading ? "Loading..." : aiMode?.enabled ? "Switch OFF" : "Switch ON"}
          </button>
        </div>
      </div>

      <div className="grid min-h-[calc(100vh-180px)] gap-3 xl:grid-cols-[minmax(220px,280px)_minmax(360px,35fr)_minmax(560px,65fr)]">
        <aside className="rounded-mdplus border border-slate-200 bg-white p-3">
          <p className="mb-2 text-xs font-semibold uppercase text-slate-500">Smart Queues</p>
          <div className="space-y-1.5">
            {queues.map((item) => {
              const Icon = item.icon;
              const active = queue === item.key;
              return (
                <button
                  key={item.key}
                  onClick={() => void changeQueue(item.key)}
                  className={`flex w-full items-center justify-between rounded px-2 py-2 text-left text-sm ${active ? "bg-brand-50 text-brand-700" : "hover:bg-slate-50"}`}
                >
                  <span className="flex items-center gap-2">
                    <span className={`rounded p-1 ${item.tone}`}>
                      <Icon size={14} />
                    </span>
                    {item.label}
                  </span>
                  <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs">{counts[item.key] ?? 0}</span>
                </button>
              );
            })}
          </div>
          {uxMetrics && (
            <div className="mt-4 rounded border border-slate-200 bg-slate-50 p-2 text-xs text-slate-600">
              <p>First Action Avg: {Math.round(uxMetrics.firstActionLatencySecondsAvg)}s</p>
              <p>AI Adoption: {(uxMetrics.aiSuggestionAdoptionRate * 100).toFixed(1)}%</p>
              <p>SLA Queue Opens: {uxMetrics.slaAtRiskQueueSelections}</p>
            </div>
          )}
        </aside>

        <section className="rounded-mdplus border border-slate-200 bg-white p-3">
          <div className="mb-3 grid gap-2 md:grid-cols-4">
            <input className="h-9 rounded border border-slate-200 px-2 text-sm" value={assignee} onChange={(e) => setAssignee(e.target.value)} placeholder="Assignee" />
            <select className="h-9 rounded border border-slate-200 px-2 text-sm" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as typeof statusFilter)}>
              <option value="ALL">Status: All</option>
              <option value="OPEN">OPEN</option>
              <option value="IN_PROGRESS">IN_PROGRESS</option>
              <option value="WAITING_CUSTOMER">WAITING_CUSTOMER</option>
              <option value="ESCALATED_RND">ESCALATED_RND</option>
              <option value="RESOLVED">RESOLVED</option>
              <option value="CLOSED">CLOSED</option>
            </select>
            <select className="h-9 rounded border border-slate-200 px-2 text-sm" value={priorityFilter} onChange={(e) => setPriorityFilter(e.target.value as typeof priorityFilter)}>
              <option value="ALL">Priority: All</option>
              <option value="P1">P1</option>
              <option value="P2">P2</option>
              <option value="P3">P3</option>
              <option value="P4">P4</option>
            </select>
            <button className="h-9 rounded border border-slate-200 text-sm" onClick={() => void loadQueue()}>
              Refresh
            </button>
          </div>
          <div className="mb-3 flex flex-wrap gap-2">
            <button className="rounded border border-slate-200 px-2 py-1 text-xs" onClick={() => void bulkAction("assign")}>Bulk Assign</button>
            <button className="rounded border border-slate-200 px-2 py-1 text-xs" onClick={() => void bulkAction("priority")}>Bulk Priority P2</button>
            <button className="rounded border border-rose-200 px-2 py-1 text-xs text-rose-700" onClick={() => void bulkAction("escalate")}>Bulk Escalate</button>
          </div>
          <div className="space-y-3 overflow-auto">
            {loading && <p className="text-sm text-slate-500">Loading queue...</p>}
            {rows.map((row) => (
              <button
                key={row.id}
                onClick={() => setSelectedTicketId(row.id)}
                className={`w-full rounded-mdplus border p-4 text-left transition ${selectedTicketId === row.id ? "border-slate-300 border-l-4 border-l-brand-500 bg-[#F3F4F6]" : "border-slate-200 bg-white hover:bg-slate-50"}`}
              >
                <div className="mb-1 flex items-center justify-between gap-2">
                  <span className="font-semibold text-[#16171A]">{row.customer_name} - {row.title}</span>
                  <input
                    type="checkbox"
                    checked={selectedIds.includes(row.id)}
                    onChange={(e) => {
                      e.stopPropagation();
                      setSelectedIds((prev) => (prev.includes(row.id) ? prev.filter((id) => id !== row.id) : [...prev, row.id]));
                    }}
                  />
                </div>
                <p className="mt-2 flex items-start gap-1.5 text-sm leading-6 text-[#4B5563]">
                  <Sparkles size={14} className="mt-1 shrink-0 text-brand-600" />
                  <span>{row.triage_reasoning_summary || "AI summary is not available yet. Open detail to process manually."}</span>
                </p>
                <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
                  <span>{row.ticket_no}</span>
                  <span className="text-slate-400">|</span>
                  <span>{row.assignee_name}</span>
                  <span className={`rounded-full px-2 py-0.5 ${toneByRisk(row.sla_risk)}`}>{formatRemaining(row.resolution_due_at ?? row.sla_due_at)}</span>
                  <StatusBadge status={row.status} />
                </div>
              </button>
            ))}
            {!rows.length && !loading && <p className="text-sm text-slate-500">No tickets in this queue.</p>}
          </div>
        </section>

        <section className="rounded-mdplus border border-slate-200 bg-white p-4">
          {detailLoading && <div className="flex items-center gap-2 text-sm text-slate-500"><Loader2 size={14} className="animate-spin" />Loading detail...</div>}
          {!ticketDetail && !detailLoading && <p className="text-sm text-slate-500">Select a ticket to view detail and actions.</p>}
          {ticketDetail && (
            <div className="space-y-3">
              <header className="rounded border border-slate-200 bg-slate-50 p-4">
                <p className="text-xs text-slate-500">{ticketDetail.ticket_no}</p>
                <h2 className="text-2xl font-semibold text-[#16171A]">{ticketDetail.title}</h2>
                <div className="mt-2 flex items-center gap-2">
                  <StatusBadge status={ticketDetail.status} />
                  <span className={`rounded-full px-2 py-1 text-xs ${toneByRisk(selectedRow?.sla_risk)}`}>
                    SLA {selectedRow?.sla_risk ?? "healthy"} - {formatRemaining(ticketDetail.resolution_due_at ?? ticketDetail.sla_due_at)}
                  </span>
                </div>
              </header>

              <div className="rounded-xl border border-slate-200 bg-slate-50 p-4 shadow-sm">
                <p className="mb-1 text-xs font-semibold uppercase text-brand-700">AI Insight & Suggestion</p>
                <p className="text-sm leading-6 text-slate-700">{selectedRow?.triage_reasoning_summary || "No AI summary available."}</p>
                <p className="mt-1 text-xs text-slate-600">Confidence: {ticketDetail.ai_last_confidence ?? selectedRow?.triage_confidence ?? "-"} | Trace: {ticketDetail.ai_last_trace_id ?? "-"}</p>
                <div className="mt-2 flex gap-2">
                  <button className="rounded border border-brand-300 bg-white px-2 py-1 text-xs" onClick={() => void applyAiSuggestion()}>
                    One-click Apply
                  </button>
                  <button className="rounded border border-slate-300 bg-white px-2 py-1 text-xs" onClick={() => void overrideAiSuggestion()}>
                    Manual Override
                  </button>
                </div>
                <div className="mt-2 flex flex-wrap gap-2">
                  {(selectedRow?.triage_evidence ?? []).map((evidence) => {
                    const value = String(evidence);
                    const href = value.startsWith("http")
                      ? value
                      : `https://ones.com/search?q=${encodeURIComponent(value)}`;
                    return (
                      <a key={value} className="rounded bg-white px-2 py-1 text-xs text-brand-600 underline" href={href} target="_blank" rel="noreferrer">
                        {value}
                      </a>
                    );
                  })}
                </div>
              </div>

              <div className="grid gap-2 sm:grid-cols-3">
                <button className="rounded border border-slate-200 px-2 py-1 text-xs" disabled={saving} onClick={() => void runAction("assign_support")}>Assign Support</button>
                <button className="rounded border border-slate-200 px-2 py-1 text-xs" disabled={saving} onClick={() => void runAction("assign_rnd")}>Assign R&D</button>
                <button className="rounded border border-slate-200 px-2 py-1 text-xs" disabled={saving} onClick={() => void runAction("in_progress")}>In Progress</button>
                <button className="rounded border border-slate-200 px-2 py-1 text-xs" disabled={saving} onClick={() => void runAction("ask_customer")}>Ask Customer</button>
                <button className="rounded border border-rose-200 px-2 py-1 text-xs text-rose-700" disabled={saving} onClick={() => void runAction("escalate")}>Escalate</button>
                <button className="rounded border border-slate-200 px-2 py-1 text-xs" disabled={saving} onClick={() => void runAction("resolve")}>Resolve</button>
                <button className="rounded border border-slate-200 px-2 py-1 text-xs" disabled={saving} onClick={() => void runAction("close")}>Close</button>
              </div>

              <div className="space-y-2 rounded border border-slate-200 p-3">
                <label className="text-sm font-medium">Reply to Customer</label>
                <textarea className="w-full rounded border border-slate-200 px-2 py-1 text-sm" rows={3} value={replyBody} onChange={(e) => setReplyBody(e.target.value)} />
                <button className="rounded bg-brand-500 px-3 py-1 text-xs text-white" disabled={saving} onClick={() => void sendReply("public")}>Send Reply</button>
              </div>

              <div className="space-y-2 rounded border border-slate-200 p-3">
                <label className="text-sm font-medium">Internal Note</label>
                <textarea className="w-full rounded border border-slate-200 px-2 py-1 text-sm" rows={3} value={internalNote} onChange={(e) => setInternalNote(e.target.value)} />
                <button className="rounded border border-slate-200 px-3 py-1 text-xs" disabled={saving} onClick={() => void sendReply("internal")}>Add Internal Note</button>
              </div>

              <div className="max-h-64 space-y-2 overflow-auto">
                {messages.map((m) => (
                  <article key={m.id} className="rounded border border-slate-200 p-2">
                    <div className="mb-1 flex items-center justify-between text-xs text-slate-500">
                      <span>{m.author_name} ({m.author_type})</span>
                      <span><Clock3 size={12} className="inline" /> {new Date(m.created_at).toLocaleString()}</span>
                    </div>
                    <p className="whitespace-pre-wrap text-sm text-slate-700">{m.body}</p>
                  </article>
                ))}
              </div>
            </div>
          )}
          {error && <p className="mt-2 text-sm text-rose-600">{error}</p>}
        </section>
      </div>
    </div>
  );
}
