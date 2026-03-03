import { Sparkles } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { StatusBadge } from "../components/StatusBadge";
import { assignTicket, getTicketDetail, replyTicketAsAgent, transitionTicket } from "../lib/api";
import type { Ticket, TicketMessage } from "../lib/types";

function computeSlaRisk(ticket: Ticket): "healthy" | "at_risk" | "breached" {
  const due = ticket.resolution_due_at ?? ticket.sla_due_at;
  if (!due) return "healthy";
  const diff = new Date(due).getTime() - Date.now();
  if (diff <= 0) return "breached";
  if (diff <= 60 * 60 * 1000) return "at_risk";
  return "healthy";
}

function formatCountdown(ticket: Ticket): string {
  const due = ticket.resolution_due_at ?? ticket.sla_due_at;
  if (!due) return "-";
  const diff = new Date(due).getTime() - Date.now();
  if (diff <= 0) return "Overdue";
  const hours = Math.floor(diff / (1000 * 60 * 60));
  const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
  return `${hours}h ${minutes}m`;
}

export function AgentTicketDetailPage() {
  const { id } = useParams();
  const [ticket, setTicket] = useState<Ticket | null>(null);
  const [messages, setMessages] = useState<TicketMessage[]>([]);
  const [publicReplyBody, setPublicReplyBody] = useState("");
  const [internalNote, setInternalNote] = useState("");
  const [assigneeName, setAssigneeName] = useState("R&D Team");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const slaRisk = useMemo(() => (ticket ? computeSlaRisk(ticket) : "healthy"), [ticket]);
  const nextActionHint = useMemo(() => {
    if (!ticket) return "";
    if (slaRisk === "breached") return "Escalate or resolve immediately.";
    if (ticket.status === "WAITING_CUSTOMER") return "Waiting customer input. Send reminder if needed.";
    if (slaRisk === "at_risk") return "Ask customer or escalate before SLA breach.";
    return "Continue triage with AI recommendation and timeline context.";
  }, [ticket, slaRisk]);

  const load = async () => {
    if (!id) return;
    setLoading(true);
    setError(null);
    try {
      const detail = await getTicketDetail(id);
      setTicket(detail.ticket);
      setMessages(detail.messages);
    } catch (err) {
      setError((err as Error).message);
      setTicket(null);
      setMessages([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, [id]);

  const sendAgentReply = async () => {
    if (!id || publicReplyBody.trim().length < 1) return;
    setSaving(true);
    setError(null);
    try {
      await replyTicketAsAgent(id, publicReplyBody.trim(), assigneeName || "Support Team");
      setPublicReplyBody("");
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const addInternalNote = async () => {
    if (!id || internalNote.trim().length < 1) return;
    setSaving(true);
    setError(null);
    try {
      await replyTicketAsAgent(id, `[INTERNAL_NOTE]\n${internalNote.trim()}`, "Support Internal");
      setInternalNote("");
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const runTransition = async (
    to: "WAITING_CUSTOMER" | "RESOLVED" | "CLOSED" | "IN_PROGRESS" | "ESCALATED_RND",
    reasonCode: "manual_waiting_customer" | "manual_resolution" | "customer_reply" | "manual_escalation"
  ) => {
    if (!id) return;
    setSaving(true);
    setError(null);
    try {
      await transitionTicket(id, to, reasonCode);
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const runAssign = async (assigneeType: "SUPPORT_TEAM" | "RND_TEAM") => {
    if (!id) return;
    setSaving(true);
    setError(null);
    try {
      await assignTicket(id, assigneeType, assigneeName.trim() || (assigneeType === "RND_TEAM" ? "R&D Team" : "Support Team"), "manual_claim");
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  if (loading && !ticket) {
    return <div className="mx-auto max-w-7xl px-4 py-8 text-sm text-slate-600">Loading ticket...</div>;
  }

  if (!ticket) {
    return (
      <div className="mx-auto max-w-7xl px-4 py-8">
        <p className="text-sm text-rose-600">{error ?? "Ticket not found"}</p>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-7xl px-4 py-8 md:px-8">
      <div className="mb-4 flex items-center justify-between">
        <Link to="/support" className="text-sm text-brand-500 hover:underline">
          Back to Queue
        </Link>
        <span className="text-xs text-slate-500">Trace: {ticket.ai_last_trace_id ?? "-"}</span>
      </div>

      <div className="grid gap-4 xl:grid-cols-[1fr_320px_320px]">
        <section className="space-y-4 rounded-mdplus border border-slate-200 bg-white p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <p className="text-xs text-slate-500">{ticket.ticket_no}</p>
              <h1 className="text-xl font-semibold text-[#16171A]">{ticket.title}</h1>
            </div>
            <div className="flex items-center gap-2">
              <StatusBadge status={ticket.status} />
              <span className={`rounded px-2 py-1 text-xs ${slaRisk === "breached" ? "bg-rose-50 text-rose-700" : slaRisk === "at_risk" ? "bg-amber-50 text-amber-700" : "bg-emerald-50 text-emerald-700"}`}>
                SLA {slaRisk}
              </span>
            </div>
          </div>

          <div className="rounded-mdplus border border-slate-200 bg-slate-50 p-3 text-sm text-slate-700">
            <p className="font-semibold">SLA Countdown: {formatCountdown(ticket)}</p>
            <p className="mt-1 text-xs">Pause reason: {ticket.sla_pause_reason ?? "none"} | Next recommended action: {nextActionHint}</p>
          </div>

          <div className="space-y-3">
            {messages.map((message) => (
              <article key={message.id} className="rounded-mdplus border border-slate-200 bg-white p-4">
                <div className="mb-1 flex items-center justify-between text-xs text-slate-500">
                  <span>
                    {message.author_name} ({message.author_type})
                  </span>
                  <span>{new Date(message.created_at).toLocaleString()}</span>
                </div>
                <p className="whitespace-pre-wrap text-sm text-slate-700">{message.body}</p>
              </article>
            ))}
          </div>

          <div className="rounded-mdplus border border-slate-200 p-4">
            <h2 className="text-sm font-semibold text-[#16171A]">Public Reply</h2>
            <textarea
              rows={4}
              className="mt-2 w-full rounded-mdplus border border-slate-200 px-3 py-2 text-sm"
              placeholder="Reply to customer..."
              value={publicReplyBody}
              onChange={(e) => setPublicReplyBody(e.target.value)}
            />
            <div className="mt-3 flex justify-end">
              <button className="rounded-mdplus bg-brand-500 px-4 py-2 text-sm text-white disabled:opacity-60" disabled={saving} onClick={() => void sendAgentReply()}>
                Send Reply
              </button>
            </div>
          </div>

          <div className="rounded-mdplus border border-slate-200 p-4">
            <h2 className="text-sm font-semibold text-[#16171A]">Internal Note</h2>
            <textarea
              rows={3}
              className="mt-2 w-full rounded-mdplus border border-slate-200 px-3 py-2 text-sm"
              placeholder="Internal handoff notes..."
              value={internalNote}
              onChange={(e) => setInternalNote(e.target.value)}
            />
            <div className="mt-3 flex justify-end">
              <button className="rounded-mdplus border border-slate-200 px-4 py-2 text-sm disabled:opacity-60" disabled={saving} onClick={() => void addInternalNote()}>
                Add Internal Note
              </button>
            </div>
          </div>
        </section>

        <aside className="space-y-3 rounded-mdplus border border-slate-200 bg-white p-4">
          <h2 className="text-sm font-semibold text-[#16171A]">Actions</h2>
          <div className="grid gap-2">
            <button className="rounded border border-slate-200 px-3 py-2 text-xs" disabled={saving} onClick={() => void runTransition("IN_PROGRESS", "customer_reply")}>
              Set In Progress
            </button>
            <button className="rounded border border-slate-200 px-3 py-2 text-xs" disabled={saving} onClick={() => void runTransition("WAITING_CUSTOMER", "manual_waiting_customer")}>
              Ask Customer
            </button>
            <button className="rounded border border-rose-200 px-3 py-2 text-xs text-rose-700" disabled={saving} onClick={() => void runTransition("ESCALATED_RND", "manual_escalation")}>
              Escalate to R&D
            </button>
            <button className="rounded border border-slate-200 px-3 py-2 text-xs" disabled={saving} onClick={() => void runTransition("RESOLVED", "manual_resolution")}>
              Resolve
            </button>
            <button className="rounded border border-slate-200 px-3 py-2 text-xs" disabled={saving} onClick={() => void runTransition("CLOSED", "manual_resolution")}>
              Close
            </button>
          </div>
          <div className="mt-2 border-t border-slate-200 pt-2">
            <p className="text-xs text-slate-500">Assignee</p>
            <input value={assigneeName} onChange={(e) => setAssigneeName(e.target.value)} className="mt-1 w-full rounded-mdplus border border-slate-200 px-2 py-1 text-xs" placeholder="Assignee name" />
            <div className="mt-2 flex gap-2">
              <button className="rounded border border-slate-200 px-2 py-1 text-xs" disabled={saving} onClick={() => void runAssign("SUPPORT_TEAM")}>
                Assign Support
              </button>
              <button className="rounded border border-slate-200 px-2 py-1 text-xs" disabled={saving} onClick={() => void runAssign("RND_TEAM")}>
                Assign R&D
              </button>
            </div>
          </div>
        </aside>

        <aside className="space-y-3 rounded-mdplus border border-slate-200 bg-white p-4">
          <h2 className="text-sm font-semibold text-[#16171A]">AI Panel</h2>
          <div className="rounded-mdplus border border-brand-100 bg-brand-50 p-3 text-xs text-slate-700">
            <div className="mb-1 flex items-center gap-1 text-brand-600">
              <Sparkles size={12} /> AI First Line
            </div>
            <p>Mode snapshot: {ticket.ai_mode_snapshot ?? "AI_ON"}</p>
            <p className="mt-1">Suggested action: {ticket.ai_last_action ?? "ask_user"}</p>
            <p className="mt-1">Confidence: {ticket.ai_last_confidence ?? "-"}</p>
            <p className="mt-1">Model: {ticket.ai_last_model ?? "-"}</p>
            <p className="mt-1">Fallback applied: {ticket.ai_last_fallback_applied ? "yes" : "no"}</p>
            <p className="mt-1">Trace ID: {ticket.ai_last_trace_id ?? "-"}</p>
          </div>
          <button className="w-full rounded border border-slate-200 px-3 py-2 text-xs" disabled={saving} onClick={() => void runTransition("WAITING_CUSTOMER", "manual_waiting_customer")}>
            Apply AI Suggestion
          </button>
          <button
            className="w-full rounded border border-slate-200 px-3 py-2 text-xs"
            disabled={saving}
            onClick={() => {
              const reason = window.prompt("Override reason", "manual_override") || "manual_override";
              setInternalNote((prev) => `${prev}\n[AI_OVERRIDE] ${reason}`.trim());
            }}
          >
            Manual Override
          </button>
        </aside>
      </div>
      {error && <p className="mt-3 text-sm text-rose-600">{error}</p>}
    </div>
  );
}
