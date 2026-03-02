import type { TicketStatus } from "../lib/types";

const statusTheme: Record<TicketStatus, string> = {
  OPEN: "bg-slate-100 text-slate-700",
  IN_PROGRESS: "bg-brand-50 text-brand-600",
  WAITING_CUSTOMER: "bg-amber-100 text-amber-700",
  ESCALATED_RND: "bg-rose-100 text-rose-700",
  RESOLVED: "bg-emerald-100 text-emerald-700",
  CLOSED: "bg-slate-200 text-slate-700"
};

export function StatusBadge({ status }: { status: TicketStatus }) {
  return <span className={`rounded-full px-2 py-1 text-xs font-medium ${statusTheme[status]}`}>{status}</span>;
}
