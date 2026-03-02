import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { listTickets } from "../lib/api";
import type { Ticket, TicketStatus } from "../lib/types";
import { StatusBadge } from "../components/StatusBadge";

const statusOptions: Array<{ key: "ALL" | TicketStatus; label: string }> = [
  { key: "ALL", label: "All" },
  { key: "IN_PROGRESS", label: "In Progress" },
  { key: "WAITING_CUSTOMER", label: "Waiting for Me" },
  { key: "RESOLVED", label: "Resolved" }
];

export function RequestsPage() {
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [status, setStatus] = useState<(typeof statusOptions)[number]["key"]>("ALL");

  useEffect(() => {
    listTickets("customer_demo").then(setTickets).catch(() => setTickets([]));
  }, []);

  const filtered = useMemo(
    () => (status === "ALL" ? tickets : tickets.filter((ticket) => ticket.status === status)),
    [status, tickets]
  );

  return (
    <div className="mx-auto max-w-7xl px-4 py-8 md:px-8 md:py-12">
      <h1 className="text-3xl font-bold text-ink">My Requests</h1>

      <div className="mt-6 flex flex-wrap items-center gap-2">
        {statusOptions.map((item) => (
          <button
            key={item.key}
            onClick={() => setStatus(item.key)}
            className={`rounded-full px-3 py-1.5 text-sm ${status === item.key ? "bg-brand-500 text-white" : "bg-white text-slate-600"}`}
          >
            {item.label}
          </button>
        ))}
      </div>

      <div className="mt-6 overflow-hidden rounded-mdplus border border-slate-200 bg-white">
        <table className="w-full border-collapse text-left">
          <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
            <tr>
              <th className="px-4 py-3">Ticket</th>
              <th className="px-4 py-3">Status</th>
              <th className="px-4 py-3">Assignee</th>
              <th className="px-4 py-3">Updated</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((ticket) => (
              <tr key={ticket.id} className="border-t border-slate-100 hover:bg-slate-50/60">
                <td className="px-4 py-4">
                  <Link to={`/tickets/${ticket.id}`} className="font-medium text-brand-500">
                    {ticket.ticket_no}
                  </Link>
                  <p className="text-sm text-slate-700">{ticket.title}</p>
                </td>
                <td className="px-4 py-4">
                  <StatusBadge status={ticket.status} />
                </td>
                <td className="px-4 py-4 text-sm text-slate-600">{ticket.assignee_name}</td>
                <td className="px-4 py-4 text-sm text-slate-600">{new Date(ticket.updated_at).toLocaleString()}</td>
              </tr>
            ))}
            {!filtered.length && (
              <tr>
                <td className="px-4 py-10 text-center text-sm text-slate-500" colSpan={4}>
                  No tickets found.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
