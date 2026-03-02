import * as Tabs from "@radix-ui/react-tabs";
import { Bot, Sparkles } from "lucide-react";

const rows = [
  {
    id: "T-93012011",
    title: "Login fails after SSO callback",
    customer: "Acme Corp",
    status: "Escalated",
    sla: "1h 23m",
    assignee: "R&D Team",
    created: "2026-03-02 10:15",
    ai: "Issue is highly related to KB #123. Base troubleshooting was auto-replied; customer confirmed no effect, so ticket was escalated."
  },
  {
    id: "T-93011998",
    title: "Webhook retries spike",
    customer: "Zen Labs",
    status: "In Progress",
    sla: "5h 02m",
    assignee: "Support Team",
    created: "2026-03-02 09:40",
    ai: "Pattern suggests endpoint timeout from customer side. Awaiting environment details from user response."
  }
];

export function AgentDashboardPage() {
  return (
    <div className="mx-auto max-w-7xl px-4 py-8 md:px-8 md:py-12">
      <h1 className="text-3xl font-bold text-ink">Agent Queue</h1>

      <Tabs.Root className="mt-6" defaultValue="pending">
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

        <Tabs.Content value="pending" className="mt-4 overflow-hidden rounded-mdplus border border-slate-200 bg-white">
          <table className="w-full text-left text-sm">
            <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-4 py-3">ID & Title</th>
                <th className="px-4 py-3">Customer</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3">SLA</th>
                <th className="px-4 py-3">Assignee</th>
                <th className="px-4 py-3">Created</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id} className="group border-t border-slate-100 align-top hover:bg-slate-50/60">
                  <td className="px-4 py-4">
                    <div className="font-medium text-brand-500">{row.id}</div>
                    <div className="text-slate-700">{row.title}</div>
                    <div className="mt-2 hidden rounded-mdplus border border-brand-100 bg-brand-50 p-2 text-xs text-slate-700 group-hover:block">
                      <div className="mb-1 flex items-center gap-1 text-brand-600">
                        <Sparkles size={12} /> AI Analysis
                      </div>
                      {row.ai}
                    </div>
                  </td>
                  <td className="px-4 py-4">{row.customer}</td>
                  <td className="px-4 py-4">{row.status}</td>
                  <td className="px-4 py-4 text-rose-600">{row.sla}</td>
                  <td className="px-4 py-4">
                    <span className="inline-flex items-center gap-1">
                      {row.assignee.includes("AI") && <Bot size={14} className="text-brand-500" />}
                      {row.assignee}
                    </span>
                  </td>
                  <td className="px-4 py-4 text-slate-500">{row.created}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Tabs.Content>

        <Tabs.Content value="mine" className="mt-4 rounded-mdplus border border-slate-200 bg-white p-6 text-sm text-slate-600">
          Skeleton view for tickets assigned to current agent.
        </Tabs.Content>
        <Tabs.Content value="all" className="mt-4 rounded-mdplus border border-slate-200 bg-white p-6 text-sm text-slate-600">
          Skeleton view for all tickets across queues.
        </Tabs.Content>
      </Tabs.Root>
    </div>
  );
}
