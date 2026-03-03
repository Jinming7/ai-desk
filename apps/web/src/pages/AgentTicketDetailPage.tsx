import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { StatusBadge } from "../components/StatusBadge";
import { assignTicket, getTicketDetail, replyTicketAsAgent, transitionTicket } from "../lib/api";
import type { Ticket, TicketMessage } from "../lib/types";

export function AgentTicketDetailPage() {
  const { id } = useParams();
  const [ticket, setTicket] = useState<Ticket | null>(null);
  const [messages, setMessages] = useState<TicketMessage[]>([]);
  const [replyBody, setReplyBody] = useState("");
  const [assigneeName, setAssigneeName] = useState("R&D Team");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
    if (!id || replyBody.trim().length < 1) return;
    setError(null);
    try {
      await replyTicketAsAgent(id, replyBody.trim(), assigneeName || "R&D Team");
      setReplyBody("");
      await load();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const runTransition = async (to: "WAITING_CUSTOMER" | "RESOLVED" | "CLOSED" | "IN_PROGRESS", reasonCode: "manual_waiting_customer" | "manual_resolution" | "customer_reply") => {
    if (!id) return;
    setError(null);
    try {
      await transitionTicket(id, to, reasonCode);
      await load();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const runAssign = async (assigneeType: "SUPPORT_TEAM" | "RND_TEAM") => {
    if (!id) return;
    setError(null);
    try {
      await assignTicket(id, assigneeType, assigneeName.trim() || (assigneeType === "RND_TEAM" ? "R&D Team" : "Support Team"), "manual_claim");
      await load();
    } catch (err) {
      setError((err as Error).message);
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
    <div className="mx-auto grid max-w-7xl gap-6 px-4 py-8 md:grid-cols-[320px_1fr]">
      <aside className="space-y-3 rounded-mdplus border border-slate-200 bg-white p-4">
        <p className="text-xs text-slate-500">{ticket.ticket_no}</p>
        <h1 className="text-xl font-semibold text-[#16171A]">{ticket.title}</h1>
        <StatusBadge status={ticket.status} />
        <p className="text-sm text-slate-600">Assignee: {ticket.assignee_name}</p>
        <p className="text-sm text-slate-600">Customer: {ticket.customer_name}</p>
        {ticket.environment && <p className="text-xs text-slate-500">Env: {ticket.environment}</p>}
        {ticket.reproducibility && <p className="text-xs text-slate-500">Reproducibility: {ticket.reproducibility}</p>}
        {ticket.impact_summary && <p className="text-xs text-slate-500">Impact: {ticket.impact_summary}</p>}
      </aside>

      <section className="space-y-4">
        <div className="rounded-mdplus border border-slate-200 bg-white p-4">
          <h2 className="text-sm font-semibold text-[#16171A]">Manual Handling Actions</h2>
          <div className="mt-3 flex flex-wrap gap-2">
            <button className="rounded border border-slate-200 px-3 py-1.5 text-xs" onClick={() => void runTransition("IN_PROGRESS", "customer_reply")}>Set In Progress</button>
            <button className="rounded border border-slate-200 px-3 py-1.5 text-xs" onClick={() => void runTransition("WAITING_CUSTOMER", "manual_waiting_customer")}>Ask Customer</button>
            <button className="rounded border border-slate-200 px-3 py-1.5 text-xs" onClick={() => void runTransition("RESOLVED", "manual_resolution")}>Resolve</button>
            <button className="rounded border border-slate-200 px-3 py-1.5 text-xs" onClick={() => void runTransition("CLOSED", "manual_resolution")}>Close</button>
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <input value={assigneeName} onChange={(e) => setAssigneeName(e.target.value)} className="rounded-mdplus border border-slate-200 px-3 py-1.5 text-xs" placeholder="Assignee name" />
            <button className="rounded border border-slate-200 px-3 py-1.5 text-xs" onClick={() => void runAssign("RND_TEAM")}>Assign R&D</button>
            <button className="rounded border border-slate-200 px-3 py-1.5 text-xs" onClick={() => void runAssign("SUPPORT_TEAM")}>Assign Support</button>
          </div>
        </div>

        <div className="rounded-mdplus border border-slate-200 bg-white p-4">
          <h2 className="text-sm font-semibold text-[#16171A]">Reply as Handler</h2>
          <textarea
            rows={4}
            className="mt-2 w-full rounded-mdplus border border-slate-200 px-3 py-2 text-sm"
            placeholder="Reply to customer..."
            value={replyBody}
            onChange={(e) => setReplyBody(e.target.value)}
          />
          <div className="mt-3 flex justify-end">
            <button className="rounded-mdplus bg-brand-500 px-4 py-2 text-sm text-white" onClick={() => void sendAgentReply()}>
              Send Handler Reply
            </button>
          </div>
        </div>

        {error && <p className="text-sm text-rose-600">{error}</p>}

        <div className="space-y-3">
          {messages.map((message) => (
            <article key={message.id} className="rounded-mdplus border border-slate-200 bg-white p-4">
              <div className="mb-1 flex items-center justify-between text-xs text-slate-500">
                <span>{message.author_name} ({message.author_type})</span>
                <span>{new Date(message.created_at).toLocaleString()}</span>
              </div>
              <p className="whitespace-pre-wrap text-sm text-slate-700">{message.body}</p>
            </article>
          ))}
        </div>
      </section>
    </div>
  );
}
