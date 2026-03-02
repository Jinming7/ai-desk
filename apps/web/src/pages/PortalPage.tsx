import * as Dialog from "@radix-ui/react-dialog";
import { motion } from "framer-motion";
import { Loader2, Search, X, Wrench, Lightbulb, ShieldAlert } from "lucide-react";
import { useState } from "react";
import { createTicket, searchKnowledge } from "../lib/api";

const services = [
  {
    key: "technical_support" as const,
    title: "Technical Support",
    description: "Troubleshoot production incidents and platform instability with guided diagnostics.",
    icon: Wrench
  },
  {
    key: "feature_consulting" as const,
    title: "Feature Request",
    description: "Propose enhancements and discuss workflow design with product specialists.",
    icon: Lightbulb
  },
  {
    key: "account_issue" as const,
    title: "Account Issue",
    description: "Resolve login, access control, and billing permissions with secure verification.",
    icon: ShieldAlert
  }
];

export function PortalPage() {
  const [open, setOpen] = useState(false);
  const [service, setService] = useState<(typeof services)[number] | null>(null);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [searchResult, setSearchResult] = useState<{
    answer: string;
    suggested_next_step: "self_serve" | "submit_ticket";
    citations: Array<{ id: string; title: string; excerpt: string }>;
  } | null>(null);

  const submit = async () => {
    if (!service) return;
    await createTicket({ title, description, serviceCategory: service.key });
    setOpen(false);
    setTitle("");
    setDescription("");
  };

  const onSearch = async () => {
    if (query.trim().length < 2) return;
    setSearching(true);
    setSearchError(null);
    try {
      const result = await searchKnowledge(query.trim());
      setSearchResult(result);
      if (!title) setTitle(query.trim());
      if (!description) setDescription(`Issue summary:\n${query.trim()}`);
    } catch (error) {
      setSearchError((error as Error).message);
      setSearchResult(null);
    } finally {
      setSearching(false);
    }
  };

  return (
    <div className="nexus-portal-bg">
      <main className="mx-auto max-w-[1200px] px-4 pb-20 md:px-8">
        <section className="flex min-h-[50vh] flex-col items-center justify-center pt-24 text-center md:pt-28">
          <motion.h1
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.65, delay: 0, ease: "easeOut" }}
            className="nexus-hero-title"
          >
            How can we help you?
          </motion.h1>

          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.65, delay: 0.12, ease: "easeOut" }}
            className="search-shell mt-16 flex h-[60px] w-full items-center rounded-full bg-gradient-to-b from-white to-[#FBFCFF] px-5 shadow-[inset_0_1px_0_rgba(255,255,255,0.84)] md:w-[60%]"
          >
            <Search size={24} className="text-[#9CA3AF]" />
            <input
              placeholder="Search knowledge base or services..."
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  void onSearch();
                }
              }}
              className="ml-4 w-full border-none bg-transparent text-base font-normal text-[#111827] outline-none placeholder:text-[#9CA3AF]"
            />
            <button
              onClick={() => void onSearch()}
              disabled={searching || query.trim().length < 2}
              className="rounded-full bg-brand-500 px-4 py-2 text-sm font-medium text-white disabled:cursor-not-allowed disabled:opacity-60"
            >
              {searching ? <Loader2 size={16} className="animate-spin" /> : "Search"}
            </button>
          </motion.div>
          {searchError && <p className="mt-3 text-sm text-rose-600">{searchError}</p>}
          {searchResult && (
            <div className="mt-6 w-full rounded-2xl border border-[#D1D5DB] bg-white/90 p-5 text-left md:w-[60%]">
              <p className="text-sm font-medium text-[#111827]">{searchResult.answer}</p>
              {searchResult.citations.length > 0 && (
                <div className="mt-3 space-y-2">
                  {searchResult.citations.map((item) => (
                    <div key={item.id} className="rounded-xl border border-slate-200 bg-slate-50 p-3">
                      <p className="text-sm font-semibold text-[#1F2937]">{item.title}</p>
                      <p className="mt-1 text-xs text-[#6B7280]">{item.excerpt}...</p>
                    </div>
                  ))}
                </div>
              )}
              <div className="mt-4 flex items-center gap-3">
                <span className="text-xs text-[#6B7280]">Still need help?</span>
                <button
                  onClick={() => {
                    setService(services[0]);
                    setOpen(true);
                  }}
                  className="rounded-lg bg-brand-500 px-3 py-1.5 text-xs font-medium text-white"
                >
                  Submit Ticket
                </button>
              </div>
            </div>
          )}
        </section>

        <motion.section
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.65, delay: 0.24, ease: "easeOut" }}
          className="mt-16 grid gap-8 md:grid-cols-3"
        >
          {services.map((item, index) => {
            const Icon = item.icon;
            return (
              <motion.button
                key={item.key}
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.65, delay: 0.3 + index * 0.08, ease: "easeOut" }}
                onClick={() => {
                  setService(item);
                  setOpen(true);
                }}
                whileHover={{ y: -6, backgroundColor: "#F5F8FF" }}
                whileTap={{ scale: 0.995 }}
                className="group rounded-2xl bg-white p-8 text-left [box-shadow:0_1px_2px_rgba(22,23,26,0.06),0_18px_38px_rgba(0,100,255,0.08),0_2px_10px_rgba(51,221,255,0.1)] transition-all duration-300"
              >
                <motion.div
                  className="inline-flex"
                  whileHover={{ scale: 1.06, rotate: -3 }}
                  transition={{ duration: 0.35, ease: "easeOut" }}
                >
                  <Icon className="text-brand-500" size={48} strokeWidth={1.7} />
                </motion.div>
                <h3 className="mt-6 text-[20px] font-semibold text-[#1F2937]">{item.title}</h3>
                <p className="mt-2 text-[14px] font-normal leading-6 text-[#6B7280]">{item.description}</p>
              </motion.button>
            );
          })}
        </motion.section>
      </main>

      <Dialog.Root open={open} onOpenChange={setOpen}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 bg-slate-900/40" />
          <Dialog.Content className="fixed left-1/2 top-1/2 w-[95vw] max-w-3xl -translate-x-1/2 -translate-y-1/2 rounded-2xl bg-white p-6 shadow-[0_30px_60px_rgba(17,24,39,0.2)] md:p-8">
            <div className="mb-6 flex items-center justify-between">
              <Dialog.Title className="text-xl font-semibold text-[#1F2937]">Submit {service?.title}</Dialog.Title>
              <Dialog.Close className="rounded-lg p-2 text-[#6B7280] hover:bg-slate-100">
                <X size={18} />
              </Dialog.Close>
            </div>

            <div className="space-y-4">
              <div>
                <label className="mb-2 block text-sm font-medium text-[#1F2937]">Title</label>
                <input
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  className="h-11 w-full rounded-xl border border-line px-3"
                />
              </div>
              <div>
                <label className="mb-2 block text-sm font-medium text-[#1F2937]">Description (Markdown supported)</label>
                <textarea
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  rows={8}
                  className="w-full rounded-xl border border-line px-3 py-2"
                />
              </div>
              <div className="rounded-xl border border-dashed border-[#D1D5DB] px-4 py-8 text-center text-sm text-[#6B7280]">
                Drag and drop attachments here
              </div>
            </div>

            <div className="mt-6 flex justify-end">
              <button
                onClick={submit}
                className="rounded-lg bg-brand-500 px-5 py-2 text-sm font-medium text-white transition hover:bg-brand-600"
              >
                Submit Ticket
              </button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  );
}
