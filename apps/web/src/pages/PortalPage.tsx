import * as Dialog from "@radix-ui/react-dialog";
import { Search, X, Wrench, Lightbulb, ShieldAlert } from "lucide-react";
import { useState } from "react";
import { createTicket } from "../lib/api";

const services = [
  {
    key: "technical_support" as const,
    title: "Technical Support",
    description: "Troubleshoot runtime issues and diagnose failures.",
    icon: Wrench
  },
  {
    key: "feature_consulting" as const,
    title: "Feature Consulting",
    description: "Ask product capability and integration questions.",
    icon: Lightbulb
  },
  {
    key: "account_issue" as const,
    title: "Account Issue",
    description: "Handle access, SSO, permission, and billing issues.",
    icon: ShieldAlert
  }
];

export function PortalPage() {
  const [open, setOpen] = useState(false);
  const [service, setService] = useState<(typeof services)[number] | null>(null);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");

  const submit = async () => {
    if (!service) return;
    await createTicket({ title, description, serviceCategory: service.key });
    setOpen(false);
    setTitle("");
    setDescription("");
  };

  return (
    <div className="mx-auto max-w-7xl px-4 py-8 md:px-8 md:py-16">
      <section className="space-y-6 text-center md:space-y-8">
        <h1 className="text-4xl font-bold tracking-tight text-ink md:text-6xl">How can we help you today?</h1>
        <div className="mx-auto flex max-w-3xl items-center gap-3 rounded-mdplus border border-slate-200 bg-white px-4 py-3 shadow-soft transition focus-within:border-brand-500 focus-within:shadow-[0_0_0_4px_rgba(51,102,255,0.2)]">
          <Search size={18} className="text-slate-400" />
          <input
            placeholder="Search knowledge base, guides, and FAQs"
            className="w-full border-none text-sm text-ink outline-none"
          />
        </div>
      </section>

      <section className="mt-12 grid gap-5 md:mt-16 md:grid-cols-3">
        {services.map((item) => {
          const Icon = item.icon;
          return (
            <button
              key={item.key}
              onClick={() => {
                setService(item);
                setOpen(true);
              }}
              className="rounded-mdplus border border-slate-200 bg-white p-6 text-left shadow-sm transition hover:-translate-y-0.5 hover:shadow-soft"
            >
              <Icon className="mb-4 text-brand-500" size={22} />
              <h3 className="text-lg font-semibold text-ink">{item.title}</h3>
              <p className="mt-2 text-sm text-slate-600">{item.description}</p>
            </button>
          );
        })}
      </section>

      <Dialog.Root open={open} onOpenChange={setOpen}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 bg-slate-900/40" />
          <Dialog.Content className="fixed left-1/2 top-1/2 w-[95vw] max-w-3xl -translate-x-1/2 -translate-y-1/2 rounded-mdplus bg-white p-6 shadow-soft md:p-8">
            <div className="mb-6 flex items-center justify-between">
              <Dialog.Title className="text-xl font-semibold">Submit {service?.title}</Dialog.Title>
              <Dialog.Close className="rounded-mdplus p-2 hover:bg-slate-100">
                <X size={18} />
              </Dialog.Close>
            </div>

            <div className="space-y-4">
              <div>
                <label className="mb-1 block text-sm font-medium">Title</label>
                <input value={title} onChange={(e) => setTitle(e.target.value)} className="w-full rounded-mdplus border border-slate-200 px-3 py-2" />
              </div>
              <div>
                <label className="mb-1 block text-sm font-medium">Description (Markdown supported)</label>
                <textarea
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  rows={8}
                  className="w-full rounded-mdplus border border-slate-200 px-3 py-2"
                />
              </div>
              <div className="rounded-mdplus border border-dashed border-slate-300 px-4 py-8 text-center text-sm text-slate-500">
                Drag and drop attachments here
              </div>
            </div>

            <div className="mt-6 flex justify-end">
              <button onClick={submit} className="rounded-mdplus bg-brand-500 px-5 py-2 text-sm font-medium text-white hover:bg-brand-600">
                Submit Ticket
              </button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  );
}
