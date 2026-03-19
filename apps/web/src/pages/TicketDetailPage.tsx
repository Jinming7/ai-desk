import { ImagePlus, Paperclip, UserRound, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { StatusBadge } from "../components/StatusBadge";
import { getTicketDetail, replyTicket, uploadAttachment } from "../lib/api";
import type { Ticket, TicketMessage, UploadedAttachment } from "../lib/types";

function isImageUrl(url: string) {
  return /\/uploads\/images\/|(\.png|\.jpe?g|\.gif|\.webp)(?:\?|$)/i.test(url);
}

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
  const [attachments, setAttachments] = useState<UploadedAttachment[]>([]);
  const [uploadingAttachment, setUploadingAttachment] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

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
      attachments: attachments.map((item) => item.url),
      is_ai_generated: false,
      created_at: new Date().toISOString()
    };
    setMessages((prev) => [optimisticMessage, ...prev]);
    const cachedBody = replyBody.trim();
    setReplyBody("");

    try {
      await replyTicket(id, cachedBody, attachments.map((item) => item.url));
      setAttachments([]);
      load();
    } catch (error) {
      setMessages((prev) => prev.filter((m) => m.id !== optimisticMessage.id));
      setReplyError((error as Error).message);
      setReplyBody(cachedBody);
    } finally {
      setReplying(false);
    }
  };

  const uploadFiles = async (fileList: FileList | File[]) => {
    const files = Array.from(fileList);
    if (!files.length) {
      setReplyError("No files selected.");
      return;
    }
    setUploadingAttachment(true);
    setReplyError(null);
    try {
      const uploaded = await Promise.all(files.map((file) => uploadAttachment(file)));
      setAttachments((prev) => [...prev, ...uploaded]);
    } catch (error) {
      setReplyError((error as Error).message);
    } finally {
      setUploadingAttachment(false);
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
            {(message.attachments?.length ?? 0) > 0 && (
              <div className="mt-3 flex flex-wrap gap-3">
                {message.attachments.map((attachment) => (
                  <a
                    key={attachment}
                    href={attachment}
                    target="_blank"
                    rel="noreferrer"
                    className="flex min-w-[12rem] items-center gap-3 overflow-hidden rounded-2xl border border-[#D9E4FF] bg-white p-3"
                  >
                    {isImageUrl(attachment) ? (
                      <img src={attachment} alt="attachment" className="h-16 w-16 rounded-xl object-cover" />
                    ) : (
                      <span className="inline-flex h-10 w-10 items-center justify-center rounded-xl bg-slate-100 text-xs font-semibold text-slate-600">
                        FILE
                      </span>
                    )}
                    <span className="max-w-[14rem] truncate text-sm text-slate-700">{attachment.split("/").pop()}</span>
                  </a>
                ))}
              </div>
            )}
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
            onPaste={(e) => {
              const files = Array.from(e.clipboardData.files ?? []).filter((file) => file.type.startsWith("image/"));
              if (!files.length) return;
              e.preventDefault();
              void uploadFiles(files);
            }}
          />
          <input
            ref={fileInputRef}
            type="file"
            multiple
            className="hidden"
            onChange={(e) => {
              const files = e.target.files;
              if (files?.length) void uploadFiles(files);
              e.currentTarget.value = "";
            }}
          />
          {(attachments.length > 0 || uploadingAttachment) && (
            <div className="mt-3 rounded-2xl border border-[#CFE0FF] bg-[linear-gradient(180deg,rgba(255,255,255,0.98),rgba(242,247,255,0.96))] p-3">
              <div className="flex items-center gap-2 text-xs font-medium text-[#3050C8]">
                <ImagePlus size={14} />
                <span>Attachments will be sent with this reply.</span>
              </div>
              {attachments.length > 0 && (
                <div className="mt-3 flex flex-wrap gap-3">
                  {attachments.map((item) => (
                    <div key={item.url} className="relative flex items-center gap-3 overflow-hidden rounded-2xl border border-[#D9E4FF] bg-white p-2 pr-10">
                      {item.contentType.startsWith("image/") ? (
                        <img src={item.url} alt={item.name} className="h-16 w-16 rounded-xl object-cover" />
                      ) : (
                        <span className="inline-flex h-16 w-16 items-center justify-center rounded-xl bg-slate-100 text-xs font-semibold text-slate-600">
                          FILE
                        </span>
                      )}
                      <div className="min-w-0">
                        <p className="max-w-[12rem] truncate text-sm font-medium text-slate-700">{item.name}</p>
                        <p className="text-xs text-slate-500">{item.contentType || "application/octet-stream"}</p>
                      </div>
                      <button
                        type="button"
                        onClick={() => setAttachments((prev) => prev.filter((attachment) => attachment.url !== item.url))}
                        className="absolute right-1 top-1 inline-flex h-6 w-6 items-center justify-center rounded-full bg-black/55 text-white"
                        aria-label="Remove attachment"
                      >
                        <X size={12} />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
          {replyError && <p className="mt-2 text-xs text-rose-600">{replyError}</p>}
          <div className="mt-3 flex items-center justify-between">
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="inline-flex items-center gap-2 text-xs font-medium text-brand-600"
            >
              <Paperclip size={14} />
              {uploadingAttachment ? "Uploading attachment..." : "Upload file or paste screenshot"}
            </button>
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
