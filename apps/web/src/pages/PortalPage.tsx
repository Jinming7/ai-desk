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
    title: "Feature Request",
    description: "Share product ideas and discuss capability enhancements.",
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
    <div className="mx-auto max-w-[1280px] px-4 pb-16 pt-24 md:px-8">
      <section className="text-center">
        <h1 className="mb-12 text-5xl font-bold tracking-tight text-ink">How can we help?</h1>
        <div className="mx-auto mb-16 flex h-14 w-full items-center gap-4 rounded-xl border border-[#D1D5DB] bg-white px-4 transition duration-300 hover:border-[#9CA3AF] focus-within:border-brand-500 focus-within:shadow-[0_0_0_2px_#3B82F6] md:w-[60%]">
          <Search size={24} className="text-[#9CA3AF]" />
          <input
            placeholder="Search knowledge base or services..."
            className="w-full border-none bg-transparent text-base font-normal text-ink placeholder:text-[#9CA3AF] outline-none"
          />
        </div>
      </section>

      <section className="grid gap-8 md:grid-cols-3">
        {services.map((item) => {
          const Icon = item.icon;
          return (
            <button
              key={item.key}
              onClick={() => {
                setService(item);
                setOpen(true);
              }}
              className="rounded-2xl border border-line bg-white p-8 text-left transition duration-300 hover:-translate-y-1 hover:border-brand-500 hover:shadow-[0_10px_15px_-3px_rgb(0_0_0_/_0.1),0_4px_6px_-4px_rgb(0_0_0_/_0.1)]"
            >
              <Icon className="text-brand-500" size={48} strokeWidth={1.8} />
              <h3 className="mt-6 text-[20px] font-semibold text-ink">{item.title}</h3>
              <p className="mt-2 text-base font-normal text-muted">{item.description}</p>
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
