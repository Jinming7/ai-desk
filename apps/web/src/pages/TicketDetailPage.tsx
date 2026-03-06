import { UserRound } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useParams } from "react-router-dom";
import { StatusBadge } from "../components/StatusBadge";
import { getTicketDetail, replyTicket } from "../lib/api";
import type { Ticket, TicketMessage } from "../lib/types";

function formatRemaining(slaDueAt?: string) {
  if (!slaDueAt) return "Not set";
  const diff = new Date(slaDueAt).getTime() - Date.now();
  if (diff <= 0) return "Overdue";
  const hours = Math.floor(diff / (1000 * 60 * 60));
  const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
  return `${hours}h ${minutes}m`;
}

export function TicketDetailPage() {
  const { id } = useParams();
  const [ticket, setTicket] = useState<Ticket | null>(null);
  const [messages, setMessages] = useState<TicketMessage[]>([]);
  const [replyBody, setReplyBody] = useState("");
  const [replying, setReplying] = useState(false);
  const [replyError, setReplyError] = useState<string | null>(null);

  const load = () => {
    if (!id) return;
    getTicketDetail(id)
      .then((data) => {
        setTicket(data.ticket);
        setMessages(data.messages);
      })
      .catch(() => {
        setTicket(null);
        setMessages([]);
      });
  };

  useEffect(() => {
    load();
  }, [id]);

  const slaTone = useMemo(() => {
    if (!ticket?.sla_due_at) return "text-slate-600";
    const minutes = (new Date(ticket.sla_due_at).getTime() - Date.now()) / (1000 * 60);
    if (minutes < 120) return "text-rose-600";
    if (minutes < 480) return "text-amber-600";
    return "text-emerald-600";
  }, [ticket?.sla_due_at]);

  if (!ticket) {
    return <div className="mx-auto max-w-7xl px-4 py-10">Ticket not found.</div>;
  }

  const onSendReply = async () => {
    if (!id || replyBody.trim().length < 1) {
      setReplyError("Reply cannot be empty.");
      return;
    }
    setReplyError(null);
    setReplying(true);

    const optimisticMessage: TicketMessage = {
      id: `optimistic-${Date.now()}`,
      author_name: "Acme User",
      author_type: "CUSTOMER",
      body: replyBody.trim(),
      is_ai_generated: false,
      created_at: new Date().toISOString()
    };
    setMessages((prev) => [optimisticMessage, ...prev]);
    const cachedBody = replyBody.trim();
    setReplyBody("");

    try {
      await replyTicket(id, cachedBody);
      load();
    } catch (error) {
      setMessages((prev) => prev.filter((m) => m.id !== optimisticMessage.id));
      setReplyError((error as Error).message);
      setReplyBody(cachedBody);
    } finally {
      setReplying(false);
    }
  };

  return (
    <div className="mx-auto grid max-w-7xl gap-6 px-4 py-8 md:grid-cols-[300px_1fr] md:px-8">
      <aside className="space-y-3 rounded-mdplus border border-slate-200 bg-white p-4 shadow-sm">
        <p className="text-xs text-slate-500">{ticket.ticket_no}</p>
        <h2 className="text-lg font-semibold text-ink">{ticket.title}</h2>
        <StatusBadge status={ticket.status} />
        <p className={`text-sm font-medium ${slaTone}`}>SLA remaining: {formatRemaining(ticket.sla_due_at)}</p>
        <p className="text-sm text-slate-600">Assignee: {ticket.assignee_name}</p>
      </aside>

      <section className="space-y-4">
        {messages.map((message) => (
          <article
            key={message.id}
            className="rounded-mdplus border border-slate-200 bg-white p-4"
          >
            <div className="mb-2 flex items-center justify-between text-sm text-slate-500">
              <div className="flex items-center gap-2">
                <UserRound size={16} />
                <span>{message.author_name}</span>
              </div>
              <span>{new Date(message.created_at).toLocaleString()}</span>
            </div>
            <p className="whitespace-pre-wrap text-sm text-slate-700">{message.body}</p>
          </article>
        ))}

        <div className="rounded-mdplus border border-slate-200 bg-white p-4">
          <label className="mb-2 block text-sm font-medium">Reply (Markdown supported)</label>
          <textarea
            rows={5}
            className="w-full rounded-mdplus border border-slate-200 px-3 py-2"
            placeholder="Type your message..."
            value={replyBody}
            onChange={(e) => setReplyBody(e.target.value)}
          />
          {replyError && <p className="mt-2 text-xs text-rose-600">{replyError}</p>}
          <div className="mt-3 flex items-center justify-between">
            <div className="text-xs text-slate-500">Attach files by dragging into this area (skeleton)</div>
            <button
              disabled={replying}
              onClick={() => void onSendReply()}
              className="rounded-mdplus bg-brand-500 px-4 py-2 text-sm font-medium text-white disabled:cursor-not-allowed disabled:opacity-70"
            >
              {replying ? "Sending..." : "Send Reply"}
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}
