import * as Dialog from "@radix-ui/react-dialog";
import { motion } from "framer-motion";
import { Check, Copy, ImagePlus, Loader2, Paperclip, SendHorizontal, ShieldAlert, UserRound, Wrench, X, Lightbulb } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ClipboardEvent, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { useNavigate } from "react-router-dom";
import {
  createChatTicketDraft,
  createTicket,
  getAiCapabilities,
  listOnesTicketTypesPublic,
  searchKnowledge,
  submitChatTicketDraft,
  uploadAttachment
} from "../lib/api";
import type { AiCapabilities, ChatTicketDraft, OnesTicketType, SearchResult, UploadedAttachment } from "../lib/types";

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

function detectLang(text: string): "zh" | "en" {
  return /[\u3400-\u9FBF]/.test(text) ? "zh" : "en";
}

function isImageAttachment(item: Pick<UploadedAttachment, "url" | "contentType">) {
  return item.contentType.startsWith("image/") || /\/uploads\/images\/|(\.png|\.jpe?g|\.gif|\.webp)(?:\?|$)/i.test(item.url);
}

function extractClipboardImageFiles(event: ClipboardEvent<HTMLElement>): File[] {
  const filesFromItems = Array.from(event.clipboardData.items ?? [])
    .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
    .map((item) => item.getAsFile())
    .filter((file): file is File => Boolean(file));

  if (filesFromItems.length) {
    return filesFromItems;
  }

  return Array.from(event.clipboardData.files ?? []).filter((file) => file.type.startsWith("image/"));
}

function t(lang: "zh" | "en") {
  return lang === "zh"
    ? {
        hero: "我可以如何帮助你？",
        placeholderSearch: "搜索知识库或服务...",
        placeholderChat: "继续补充线索：日志、期望结果、实际结果、报错信息...",
        search: "搜索",
        quickAnswer: "直接结论",
        actionPlan: "执行建议",
        oneLineConclusion: "1. 一句话结论",
        doNow: "2. 立即执行（3 步）",
        minNeed: "3. 我还需要你补充（最少必要）",
        assessment: "判断依据",
        whatNow: "先做什么",
        steps: "执行步骤",
        verify: "如何验证",
        needInputs: "需要你补充的信息",
        blocked: "仍未解决",
        blockedDescResolved: "补充错误日志和复现步骤，继续在当前会话追问。",
        blockedDescUnresolved: "可使用 Quick Ticket 发起深度检索与工单协同。",
        primary: "主来源",
        more: "更多来源",
        citations: "引用",
        reference: "参考",
        open: "打开",
        openSource: "打开来源",
        round: "追问轮次",
        typing: "AI 正在分析上下文...",
        busy: "当前检索压力较高，请稍后重试。",
        retry: "重试",
        quickTicket: "快速提单",
        createTicketNow: "立即创建工单",
        submitFromChat: "基于聊天提交工单",
        preparingDraft: "正在准备草稿...",
        stillNeedHelp: "还需要帮助？",
        submitTicket: "提交工单",
        you: "你",
        aiBot: "AI助手",
        confidence: "置信度",
        escalation: "升级状态",
        submitting: "提交中...",
        agentResolved: "深度检索已给出解决方案",
        resolvedGenerated: "已生成解决建议。",
        deepRetrievalTicketCreated: "深度检索仍未解决，已创建工单。",
        openTicket: "打开工单",
        onesTicketTypes: "ONES 工单类型",
        typesUnavailable: "当前还没有可用工单类型，请联系管理员发布客户门户可见的配置。",
        noResultsYet: "尚未返回结果，点击“搜索”开始检索知识库。",
        clueExpected: "期望结果",
        clueActual: "实际结果",
        clueStep: "出问题的具体步骤",
        clueEnv: "环境（生产/预发/测试）",
        clueLog: "错误信息或日志",
        clueReq: "请求 URL 与 Method",
        clueStatus: "HTTP 状态码与响应体",
        clueAuth: "鉴权方式与 token scope",
        clueRole: "用户角色/账号",
        clueOp: "执行的具体操作",
        cluePerm: "权限配置截图或描述"
      }
    : {
        hero: "How can we help you?",
        placeholderSearch: "Search knowledge base or services...",
        placeholderChat: "Reply with details, logs, expected vs actual result...",
        search: "Search",
        quickAnswer: "Quick Answer",
        actionPlan: "Action Plan",
        oneLineConclusion: "1. One-line conclusion",
        doNow: "2. Do these 3 steps now",
        minNeed: "3. I still need (minimum)",
        assessment: "Assessment",
        whatNow: "What to do now",
        steps: "Steps to execute",
        verify: "How to verify",
        needInputs: "Need from you",
        blocked: "If still blocked",
        blockedDescResolved: "Collect logs/repro steps and continue in this session.",
        blockedDescUnresolved: "Use Quick Ticket for deep retrieval and handoff.",
        primary: "Primary Source",
        more: "More Sources",
        citations: "Citations",
        reference: "Reference",
        open: "Open",
        openSource: "Open source",
        round: "Clarification round",
        typing: "AI is analyzing context...",
        busy: "Knowledge base is temporarily busy. Please retry in a few seconds.",
        retry: "Retry",
        quickTicket: "Quick Ticket",
        createTicketNow: "Create a ticket now",
        submitFromChat: "Submit Ticket based on chat",
        preparingDraft: "Preparing draft...",
        stillNeedHelp: "Still need help?",
        submitTicket: "Submit Ticket",
        you: "You",
        aiBot: "AI Bot",
        confidence: "confidence",
        escalation: "Escalation",
        submitting: "Submitting...",
        agentResolved: "Agent resolved using deep retrieval",
        resolvedGenerated: "Resolved answer generated.",
        deepRetrievalTicketCreated: "Deep retrieval could not resolve. Ticket created.",
        openTicket: "Open Ticket",
        onesTicketTypes: "ONES Ticket Types",
        typesUnavailable: "Ticket types are not available yet. Ask support admin to publish Configuration whitelist for customer portal.",
        noResultsYet: "No results yet. Press Search to query the knowledge base.",
        clueExpected: "Expected result",
        clueActual: "Actual result",
        clueStep: "Exact failing step",
        clueEnv: "Environment (prod/staging/test)",
        clueLog: "Error message or logs",
        clueReq: "Request URL + method",
        clueStatus: "HTTP status code + response body",
        clueAuth: "Auth mode/token scope used",
        clueRole: "User role/account",
        clueOp: "Operation attempted",
        cluePerm: "Permission configuration snapshot"
      };
}

type ConversationMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  attachments?: UploadedAttachment[];
  result?: SearchResult;
  isError?: boolean;
  retryQuery?: string;
};

type ReadableBlock =
  | { type: "paragraph"; text: string }
  | { type: "bullet"; marker: string; text: string }
  | { type: "label"; label: string; text: string };

export function PortalPage() {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [service, setService] = useState<(typeof services)[number] | null>(null);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [searchResult, setSearchResult] = useState<SearchResult | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitLoading, setSubmitLoading] = useState(false);
  const [submitSuccess, setSubmitSuccess] = useState<string | null>(null);
  const [onesTypes, setOnesTypes] = useState<OnesTicketType[]>([]);
  const [selectedOnesTypeKey, setSelectedOnesTypeKey] = useState<string>("");
  const [onesFields, setOnesFields] = useState<Record<string, string>>({});
  const [searchSessionId, setSearchSessionId] = useState<string | null>(null);
  const [chatMessages, setChatMessages] = useState<ConversationMessage[]>([]);
  const [draftLoading, setDraftLoading] = useState(false);
  const [draftError, setDraftError] = useState<string | null>(null);
  const [chatDraft, setChatDraft] = useState<ChatTicketDraft | null>(null);
  const [composerAttachments, setComposerAttachments] = useState<UploadedAttachment[]>([]);
  const [ticketAttachments, setTicketAttachments] = useState<UploadedAttachment[]>([]);
  const [uploadingAttachment, setUploadingAttachment] = useState(false);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const [aiCapabilities, setAiCapabilities] = useState<AiCapabilities | null>(null);
  const [copiedCodeId, setCopiedCodeId] = useState<string | null>(null);
  const chatBottomRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const isComposingRef = useRef(false);

  useEffect(() => {
    listOnesTicketTypesPublic()
      .then((rows) => {
        setOnesTypes(rows);
        if (rows[0]?.key) setSelectedOnesTypeKey((prev) => prev || rows[0].key);
      })
      .catch(() => setOnesTypes([]));
  }, []);

  useEffect(() => {
    getAiCapabilities().then(setAiCapabilities).catch(() => setAiCapabilities(null));
  }, []);

  const noCustomerTypes = onesTypes.length === 0;
  const inChatMode = chatMessages.length > 0 || searching;
  const latestResult = [...chatMessages].reverse().find((item) => item.role === "assistant" && item.result)?.result ?? searchResult;
  const unresolved = useMemo(
    () => latestResult?.suggested_next_step === "submit_ticket" && Boolean(latestResult.unresolved_reason_code),
    [latestResult]
  );
  const showCreateTicketNow = Boolean(latestResult?.show_create_ticket_now);
  const detailResult = latestResult;
  const primaryReference = latestResult?.references?.[0] ?? null;
  const latestUserQuestion = chatMessages.filter((item) => item.role === "user").at(-1)?.content ?? query;
  const uiLang: "zh" | "en" = detailResult?.answer_language ?? detectLang(latestUserQuestion || query || "");
  const copy = t(uiLang);
  const summaryText = detailResult?.structured_answer?.summary ?? detailResult?.answer ?? "";
  const answerStyle = detailResult?.structured_answer?.style ?? (detailResult?.follow_up_question ? "clarification" : "kb_answer");
  const composerRef = useRef<HTMLTextAreaElement | null>(null);

  const uploadFiles = async (fileList: FileList | File[]) => {
    const files = Array.from(fileList);
    if (!files.length) {
      setAttachmentError(uiLang === "zh" ? "未选择任何文件。" : "No files selected.");
      return;
    }
    setUploadingAttachment(true);
    setAttachmentError(null);
    try {
      const uploaded = await Promise.all(files.map((file) => uploadAttachment(file)));
      setComposerAttachments((prev) => [...prev, ...uploaded]);
      setTicketAttachments((prev) => [...prev, ...uploaded.filter((item) => !prev.some((existing) => existing.url === item.url))]);
    } catch (error) {
      setAttachmentError((error as Error).message);
    } finally {
      setUploadingAttachment(false);
    }
  };

  const removeAttachment = (url: string) => {
    setComposerAttachments((prev) => prev.filter((item) => item.url !== url));
    setTicketAttachments((prev) => prev.filter((item) => item.url !== url));
  };

  const copyCodeText = async (text: string, id: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedCodeId(id);
      window.setTimeout(() => {
        setCopiedCodeId((prev) => (prev === id ? null : prev));
      }, 1200);
    } catch {
      // ignore clipboard errors silently in UI
    }
  };

  const renderInlineCode = (text: string, keyPrefix: string) => {
    const parts = text.split(/(`[^`]+`)/g).filter(Boolean);
    return parts.map((part, idx) => {
      const key = `${keyPrefix}-${idx}`;
      if (part.startsWith("`") && part.endsWith("`")) {
        const code = part.slice(1, -1);
        return (
          <span key={key} className="mx-0.5 inline-flex items-center gap-1 rounded-lg bg-slate-100 px-2 py-0.5 align-middle font-mono text-[0.92em] text-slate-900">
            <code>{code}</code>
            <button
              type="button"
              onClick={() => void copyCodeText(code, key)}
              className="inline-flex h-4 w-4 items-center justify-center rounded text-slate-500 hover:bg-slate-200 hover:text-slate-700"
              title={uiLang === "zh" ? "复制代码" : "Copy code"}
              aria-label={uiLang === "zh" ? "复制代码" : "Copy code"}
            >
              {copiedCodeId === key ? <Check size={11} /> : <Copy size={11} />}
            </button>
          </span>
        );
      }
      return <span key={key}>{part}</span>;
    });
  };

  const normalizeReadableBlocks = (text: string): ReadableBlock[] => {
    const labelPattern =
      /^(要点|原因|影响|解决方法|解决方案|建议|下一步|排查重点|现象|接口|参数|返回|风险|说明|优先级|描述|Assessment|Reason|Impact|Recommendation|Next step|Validation|Endpoint|Parameters|Response|Risk|Notes?)[:：]\s*(.+)$/i;

    return text
      .replace(/\r\n?/g, "\n")
      .replace(/\s+[•·]\s+/g, "\n• ")
      .replace(/\s+-\s+(?=(?:优先级|描述|原因|影响|解决方法|解决方案|要点|建议|下一步|排查重点|处理|现象|接口|参数|返回|风险|说明)\s*[:：])/g, "\n- ")
      .replace(/([。！？；])\s+/g, "$1\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim()
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const bulletMatch = /^([•-]|\d+\.)\s+(.+)$/.exec(line);
        if (bulletMatch) {
          return {
            type: "bullet",
            marker: bulletMatch[1],
            text: bulletMatch[2]
          } satisfies ReadableBlock;
        }

        const labelMatch = labelPattern.exec(line);
        if (labelMatch) {
          return {
            type: "label",
            label: labelMatch[1],
            text: labelMatch[2]
          } satisfies ReadableBlock;
        }

        return {
          type: "paragraph",
          text: line
        } satisfies ReadableBlock;
      });
  };

  const renderReadableText = (text: string, keyPrefix: string, emphasis: "summary" | "detail" = "detail") => {
    const blocks = normalizeReadableBlocks(text);
    return blocks.map((block, idx) => {
      if (block.type === "bullet") {
        return (
          <div key={`${keyPrefix}-line-${idx}`} className="flex items-start gap-2 leading-7 text-slate-800">
            <span className="mt-0.5 w-5 shrink-0 text-center font-medium text-slate-400">
              {block.marker === "•" ? "•" : block.marker}
            </span>
            <div className="min-w-0 break-words">{renderInlineCode(block.text, `${keyPrefix}-${idx}`)}</div>
          </div>
        );
      }

      if (block.type === "label") {
        return (
          <div
            key={`${keyPrefix}-line-${idx}`}
            className={`rounded-xl border px-3 py-2 ${
              emphasis === "summary" ? "border-slate-200 bg-white/70" : "border-slate-200 bg-white"
            }`}
          >
            <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">{block.label}</p>
            <div className="mt-1 break-words leading-7 text-slate-900">{renderInlineCode(block.text, `${keyPrefix}-${idx}`)}</div>
          </div>
        );
      }

      return (
        <p
          key={`${keyPrefix}-line-${idx}`}
          className={`break-words text-slate-900 ${emphasis === "summary" ? "leading-8" : "leading-7"}`}
        >
          {renderInlineCode(block.text, `${keyPrefix}-${idx}`)}
        </p>
      );
    });
  };

  useEffect(() => {
    chatBottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [chatMessages, searching]);

  useEffect(() => {
    const el = composerRef.current;
    if (!el) return;
    el.style.height = "0px";
    const next = Math.min(220, Math.max(40, el.scrollHeight));
    el.style.height = `${next}px`;
  }, [query]);

  const submit = async () => {
    if (!service) return;
    if (title.trim().length < 3) {
      setSubmitError("Title must be at least 3 characters.");
      return;
    }
    if (description.trim().length < 5) {
      setSubmitError("Description must be at least 5 characters.");
      return;
    }
    const selectedType = onesTypes.find((item) => item.key === selectedOnesTypeKey) ?? null;
    if (!selectedType) {
      setSubmitError("Please select a valid ONES ticket type.");
      return;
    }
    if (selectedType?.fields?.length) {
      for (const field of selectedType.fields) {
        const row = field as Record<string, unknown>;
        const required = Boolean(row.required ?? false);
        const visible = Boolean(row.visible ?? true);
        const key = String(row.key ?? row.id ?? "");
        if (!visible) continue;
        if (required && key && !(onesFields[key] ?? "").trim()) {
          setSubmitError(`Field "${String(row.label ?? row.name ?? key)}" is required.`);
          return;
        }
      }
    }
    setSubmitError(null);
    setSubmitLoading(true);
    try {
      const created = chatDraft
        ? await submitChatTicketDraft({
            draftId: chatDraft.id,
            title: title.trim(),
            description: description.trim(),
            attachments: ticketAttachments.map((item) => item.url),
            serviceCategory: service?.key,
            onesTicketTypeKey: selectedType?.key ?? undefined,
            onesFields
          })
        : await createTicket({
            title: title.trim(),
            description: description.trim(),
            attachments: ticketAttachments.map((item) => item.url),
            serviceCategory: service?.key,
            onesTicketTypeKey: selectedType?.key ?? undefined,
            onesFields
          });
      setSubmitSuccess(`Ticket ${created.ticket.ticket_no} submitted successfully.`);
      setOpen(false);
      setTitle("");
      setDescription("");
      setSelectedOnesTypeKey("");
      setOnesFields({});
      setChatDraft(null);
      setComposerAttachments([]);
      setTicketAttachments([]);
      navigate(`/tickets/${created.ticket.id}`);
    } catch (error) {
      setSubmitError((error as Error).message);
    } finally {
      setSubmitLoading(false);
    }
  };

  const executeSearch = async (userInput: string, appendUserBubble = true) => {
    if (userInput.trim().length < 2 && composerAttachments.length === 0) return;
    const priorConversation = chatMessages.map((item) => item.content);
    const pendingAttachments = composerAttachments;
    if (appendUserBubble) {
      setChatMessages((prev) => [
        ...prev,
        {
          id: `u-${Date.now()}`,
          role: "user" as const,
          content: userInput || (uiLang === "zh" ? `已发送 ${pendingAttachments.length} 张截图` : `Sent ${pendingAttachments.length} screenshot(s)`),
          attachments: pendingAttachments
        }
      ]);
    }
    setSearching(true);
    setSearchError(null);
    setSubmitSuccess(null);
    setDraftError(null);
    setChatDraft(null);
    try {
      const result = await searchKnowledge({
        query: userInput,
        attachments: pendingAttachments.map((item) => item.url),
        imageAttachments: pendingAttachments.filter((item) => isImageAttachment(item)).map((item) => item.url),
        sessionId: searchSessionId ?? undefined,
        conversation: priorConversation,
        answerLanguage: userInput ? detectLang(userInput) : uiLang
      });
      setSearchResult(result);
      setSearchSessionId(result.session_id);
      setChatMessages((prev) =>
        [
          ...prev,
          {
            id: `a-${Date.now()}`,
            role: "assistant" as const,
            content: result.answer,
            result
          }
        ].slice(-80)
      );
      if (!title) setTitle(userInput);
      if (!description) setDescription(`Issue summary:\n${userInput}`);
    } catch (error) {
      const msg = (error as Error).message;
      setSearchError(msg);
      setChatMessages((prev) =>
        [
          ...prev,
          {
            id: `a-err-${Date.now()}`,
            role: "assistant" as const,
            content:
              msg.includes("temporarily busy")
                ? copy.busy
                : uiLang === "zh"
                  ? "暂时无法给出可靠答案，请重试或补充更多上下文。"
                  : "I could not retrieve a reliable answer just now. Please try again or provide more context.",
            isError: true,
            retryQuery: userInput
          }
        ].slice(-80)
      );
    } finally {
      setSearching(false);
    }
  };

  const onSearch = async () => {
    const userInput = query.trim();
    if (userInput.length < 2 && composerAttachments.length === 0) return;
    setQuery("");
    setComposerAttachments([]);
    await executeSearch(userInput, true);
  };

  const shouldInterceptEnter = (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    const native = event.nativeEvent as KeyboardEvent & { isComposing?: boolean };
    return !native.isComposing && !isComposingRef.current && native.keyCode !== 229;
  };

  const onCreateTicketNow = async () => {
    if (!searchResult?.session_id) return;
    setDraftLoading(true);
    setDraftError(null);
    try {
      const draft = await createChatTicketDraft({
        sessionId: searchResult.session_id,
        question: chatMessages.filter((item) => item.role === "user").at(-1)?.content ?? "",
        conversation: chatMessages.map((item) => item.content),
        retrievalTraces: searchResult.citations
      });
      setChatDraft(draft);
      setTitle(draft.title);
      setDescription(draft.description);
      setSelectedOnesTypeKey(draft.ticketTypeKey);
      setOnesFields(draft.onesFields);
      setService(services.find((item) => item.key === draft.serviceCategory) ?? services[0]);
      setOpen(true);
    } catch (error) {
      setDraftError((error as Error).message);
    } finally {
      setDraftLoading(false);
    }
  };

  const openQuickSubmitTicket = () => {
    setChatDraft(null);
    if (!selectedOnesTypeKey && onesTypes[0]?.key) setSelectedOnesTypeKey(onesTypes[0].key);
    setService((prev) => prev ?? services[0]);
    setOpen(true);
  };

  return (
    <div className={`nexus-portal-bg ${inChatMode ? "chat-window" : ""}`}>
      <main
        className={`mx-auto w-full px-4 md:px-8 ${inChatMode ? "max-w-[1600px] flex min-h-[calc(100dvh-72px)] flex-col pb-28 pt-4 md:pb-32" : "max-w-[1200px] pb-20"}`}
      >
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
        <section className={inChatMode ? "chat-no-x-scroll flex min-h-0 flex-1 flex-col pt-4" : "flex min-h-[50vh] flex-col items-center justify-center pt-24 text-center md:pt-28"}>
          {!inChatMode && (
            <motion.h1
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.65, delay: 0, ease: "easeOut" }}
              className="nexus-hero-title"
            >
              {copy.hero}
            </motion.h1>
          )}

          {inChatMode && (
            <div className="chat-lane chat-stage chat-no-x-scroll mx-auto mb-4 flex min-h-0 w-full flex-1 flex-col">
              <div className="chat-scroll space-y-6">
                {chatMessages
                  .filter((message) => message.role === "user")
                  .map((message) => (
                  <div key={message.id} className="chat-row flex justify-end">
                    <div className="chat-bubble chat-bubble-user max-w-[78%] px-5 py-3 text-left text-sm text-slate-900">
                      <div className="mb-2 flex items-center gap-2">
                        <span className="inline-flex h-7 w-7 items-center justify-center rounded-full bg-[#E2E8FF] text-[#3050c8]">
                          <UserRound size={14} />
                        </span>
                        <span className="text-xs font-medium text-slate-500">{copy.you}</span>
                      </div>
                      <p className="chat-text-safe">{message.content}</p>
                      {(message.attachments?.length ?? 0) > 0 && (
                        <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3">
                          {message.attachments?.map((item) => (
                            <a key={item.url} href={item.url} target="_blank" rel="noreferrer" className="overflow-hidden rounded-2xl border border-[#D9E4FF] bg-white">
                              {isImageAttachment(item) ? (
                                <img src={item.url} alt={item.name} className="h-24 w-full object-cover" />
                              ) : (
                                <div className="flex h-24 min-w-[11rem] items-center gap-3 px-4">
                                  <span className="inline-flex h-10 w-10 items-center justify-center rounded-xl bg-slate-100 text-xs font-semibold text-slate-600">
                                    FILE
                                  </span>
                                  <span className="max-w-[8rem] truncate text-sm text-slate-700">{item.name}</span>
                                </div>
                              )}
                            </a>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                ))}
                {searching && (
                  <div className="flex justify-start">
                    <div className="chat-bubble chat-bubble-ai max-w-[78%] px-4 py-3">
                      <div className="flex items-center gap-2">
                        <span className="h-2 w-2 animate-bounce rounded-full bg-slate-400 [animation-delay:-0.2s]" />
                        <span className="h-2 w-2 animate-bounce rounded-full bg-slate-400 [animation-delay:-0.1s]" />
                        <span className="h-2 w-2 animate-bounce rounded-full bg-slate-400" />
                        <span className="ml-1 text-xs text-slate-500">{copy.typing}</span>
                      </div>
                    </div>
                  </div>
                )}
                {!searching && searchError && (
                  <div className="flex justify-start">
                    <div className="chat-bubble chat-bubble-ai max-w-[78%] px-4 py-3 text-sm text-rose-700">
                      {searchError}
                    </div>
                  </div>
                )}
              </div>
              <div ref={chatBottomRef} />
            </div>
          )}

          {!inChatMode ? (
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.65, delay: 0.12, ease: "easeOut" }}
              className="search-shell mt-16 flex min-h-[62px] w-full items-end rounded-[32px] bg-gradient-to-b from-white to-[#FBFCFF] px-5 py-2 shadow-[inset_0_1px_0_rgba(255,255,255,0.84)] md:w-[60%]"
            >
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className="mb-1 inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-[#7B88A8] transition hover:bg-white/70"
                title="Attach"
                aria-label="Attach"
              >
                <Paperclip size={17} />
              </button>
              <textarea
                ref={composerRef}
                placeholder={copy.placeholderSearch}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onCompositionStart={() => {
                  isComposingRef.current = true;
                }}
                onCompositionEnd={() => {
                  isComposingRef.current = false;
                }}
                onPaste={(e) => {
                  const files = extractClipboardImageFiles(e);
                  if (!files.length) return;
                  e.preventDefault();
                  void uploadFiles(files);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey && shouldInterceptEnter(e)) {
                    e.preventDefault();
                    void onSearch();
                  }
                }}
                rows={1}
                className="chat-input-textarea ml-4 w-full flex-1"
              />
              <button
                onClick={() => void onSearch()}
                disabled={searching || (query.trim().length < 2 && composerAttachments.length === 0)}
                className="mb-1 inline-flex h-10 shrink-0 items-center rounded-full bg-brand-500 px-4 py-2 text-sm font-medium text-white disabled:cursor-not-allowed disabled:opacity-60"
              >
                {searching ? <Loader2 size={16} className="animate-spin" /> : copy.search}
              </button>
            </motion.div>
          ) : null}
          {!inChatMode && (composerAttachments.length > 0 || uploadingAttachment || attachmentError) && (
            <div className="mt-4 w-full max-w-[720px] rounded-[24px] border border-[#CFE0FF] bg-white/92 p-3 text-left shadow-[0_12px_32px_rgba(0,100,255,0.08)]">
              <div className="flex items-center gap-2 text-xs font-medium text-[#3050C8]">
                <ImagePlus size={14} />
                <span>
                  {uiLang === "zh"
                    ? `已添加 ${composerAttachments.length} 个附件`
                    : `${composerAttachments.length} attachment${composerAttachments.length > 1 ? "s" : ""} added`}
                </span>
              </div>
              {composerAttachments.length > 0 && (
                <div className="mt-3 flex flex-wrap gap-3">
                  {composerAttachments.map((item) => (
                    <div key={item.url} className="relative flex items-center gap-3 overflow-hidden rounded-2xl border border-[#D9E4FF] bg-white p-2 pr-10">
                      {isImageAttachment(item) ? (
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
                        onClick={() => removeAttachment(item.url)}
                        className="absolute right-1 top-1 inline-flex h-6 w-6 items-center justify-center rounded-full bg-black/55 text-white"
                        aria-label={uiLang === "zh" ? "移除附件" : "Remove attachment"}
                      >
                        <X size={12} />
                      </button>
                    </div>
                  ))}
                </div>
              )}
              {uploadingAttachment && <p className="mt-2 text-xs text-slate-500">{uiLang === "zh" ? "正在上传附件..." : "Uploading attachment..."}</p>}
              {attachmentError && <p className="mt-2 text-xs text-rose-600">{attachmentError}</p>}
            </div>
          )}
          {!inChatMode && searchError && <p className="mt-3 text-sm text-rose-600">{searchError}</p>}
          {detailResult && (
            <div className={`chat-no-x-scroll mt-6 w-full max-w-[1080px] rounded-2xl border border-[#D1D5DB] bg-white/92 p-5 text-left ${inChatMode ? "" : "md:w-[70%]"}`}>
              <div className="min-w-0 rounded-2xl border border-slate-200 bg-[linear-gradient(180deg,#FFFFFF_0%,#F8FAFF_100%)] p-4 shadow-[inset_0_1px_0_rgba(255,255,255,0.75)]">
                <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                  {answerStyle === "diagnosis"
                    ? uiLang === "zh"
                      ? "诊断结论"
                      : "Diagnosis"
                    : answerStyle === "clarification"
                      ? uiLang === "zh"
                        ? "当前判断"
                        : "Current assessment"
                      : copy.oneLineConclusion}
                </p>
                <div className="mt-3 space-y-2 text-[17px] font-semibold text-[#111827]">{renderReadableText(summaryText, "summary", "summary")}</div>
              </div>

              {detailResult.structured_answer && (
                <div className="mt-4 space-y-3 rounded-2xl border border-slate-200 bg-slate-50/85 p-4">
                  {detailResult.structured_answer.assessment && answerStyle === "diagnosis" && (
                    <div>
                      <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">{uiLang === "zh" ? "判断依据" : "Assessment"}</p>
                      <div className="mt-2 space-y-2 text-sm text-slate-800">
                        {renderReadableText(detailResult.structured_answer.assessment, "assessment", "detail")}
                      </div>
                    </div>
                  )}
                  {(detailResult.structured_answer.steps?.length ?? 0) > 0 && (
                    <div className={detailResult.structured_answer.assessment ? "mt-3" : "mt-2"}>
                      <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                        {answerStyle === "diagnosis"
                          ? uiLang === "zh"
                            ? "建议动作"
                            : "Recommended actions"
                          : answerStyle === "clarification"
                            ? uiLang === "zh"
                              ? "下一步"
                              : "Next step"
                            : copy.doNow}
                      </p>
                      <ol className="mt-1 list-decimal space-y-1.5 pl-5 text-sm leading-6 text-slate-800">
                        {detailResult.structured_answer.steps.slice(0, 4).map((step, idx) => (
                          <li key={step}>{renderInlineCode(step, `step-${idx}`)}</li>
                        ))}
                      </ol>
                    </div>
                  )}
                  {(detailResult.structured_answer.validation?.length ?? 0) > 0 && answerStyle === "diagnosis" && (
                    <div className="mt-3">
                      <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">{uiLang === "zh" ? "排查重点" : "Validation focus"}</p>
                      <ul className="mt-1 list-disc space-y-1.5 pl-5 text-sm leading-6 text-slate-800">
                        {detailResult.structured_answer.validation.slice(0, 3).map((item, idx) => (
                          <li key={item}>{renderInlineCode(item, `validation-${idx}`)}</li>
                        ))}
                      </ul>
                    </div>
                  )}
                  {(detailResult.structured_answer.required_inputs?.length ?? 0) > 0 && answerStyle === "clarification" && (
                    <div className="mt-3">
                      <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">{copy.minNeed}</p>
                      <ul className="mt-1 list-disc space-y-1.5 pl-5 text-sm leading-6 text-slate-800">
                        {detailResult.structured_answer.required_inputs?.slice(0, 3).map((item, idx) => (
                          <li key={item}>{renderInlineCode(item, `need-${idx}`)}</li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>
              )}

              {primaryReference && (
                <div className="mt-3 rounded-xl border border-emerald-100 bg-emerald-50 p-3">
                  <div className="flex items-center justify-between gap-3">
                    <p className="text-xs font-semibold uppercase tracking-wide text-emerald-700">{copy.primary}</p>
                    <a className="text-xs text-brand-500 hover:underline" href={primaryReference.sourceUrl} target="_blank" rel="noreferrer">
                      {copy.open}
                    </a>
                  </div>
                  <p className="mt-1 text-sm font-semibold text-slate-800">{primaryReference.title}</p>
                  {(primaryReference.path || primaryReference.commitSha) && (
                    <p className="chat-text-safe mt-1 text-[11px] text-slate-500">
                      {primaryReference.path ?? "unknown path"} {primaryReference.commitSha ? `@ ${primaryReference.commitSha.slice(0, 8)}` : ""}
                    </p>
                  )}
                </div>
              )}

              {(detailResult.follow_up_question || (answerStyle === "clarification" && (detailResult.structured_answer?.required_inputs?.length ?? 0) > 0)) && (
                <div className="mt-4 rounded-2xl border border-slate-200 bg-slate-50 p-4">
                  {detailResult.follow_up_question && (
                    <div className="space-y-2 text-sm text-slate-800">{renderReadableText(detailResult.follow_up_question, "followup", "detail")}</div>
                  )}
                </div>
              )}

              {showCreateTicketNow && (
                <div className="mt-4 rounded-xl border border-orange-200 bg-orange-50 p-3">
                  <p className="text-xs text-orange-700">
                    {answerStyle === "diagnosis"
                      ? uiLang === "zh"
                        ? "当前判断更像产品问题，建议直接创建工单并自动预填上下文。"
                        : "This looks more like a product issue. Create a ticket now with prefilled context."
                      : uiLang === "zh"
                        ? "当前证据仍不足，建议创建工单并自动预填上下文。"
                        : "Evidence is still insufficient. Create a ticket now with prefilled context."}
                  </p>
                  <button
                    onClick={() => void onCreateTicketNow()}
                    disabled={draftLoading}
                    className="mt-2 rounded-lg bg-orange-600 px-3 py-1.5 text-xs font-medium text-white disabled:cursor-not-allowed disabled:opacity-70"
                  >
                    {draftLoading ? copy.preparingDraft : copy.createTicketNow}
                  </button>
                  {draftError && <p className="mt-2 text-xs text-rose-600">{draftError}</p>}
                </div>
              )}
            </div>
          )}
          {unresolved && onesTypes.length > 0 && (
            <div className="mt-4 w-full rounded-2xl border border-slate-200 bg-white p-4 text-left md:w-[60%]">
              <p className="text-xs font-semibold uppercase text-slate-500">{copy.onesTicketTypes}</p>
              <div className="mt-2 grid gap-2">
                {onesTypes.map((type) => (
                  <button
                    key={type.key}
                    onClick={() => {
                      setChatDraft(null);
                      setService({
                        key: "technical_support",
                        title: type.name,
                        description: `Create ${type.name} ticket in ONES.`,
                        icon: Wrench
                      });
                      setSelectedOnesTypeKey(type.key);
                      setOpen(true);
                    }}
                    className="rounded-lg border border-slate-200 px-3 py-2 text-left text-sm hover:bg-slate-50"
                  >
                    {type.name}
                  </button>
                ))}
              </div>
            </div>
          )}
          {unresolved && noCustomerTypes && (
            <div className="mt-4 w-full rounded-2xl border border-amber-200 bg-amber-50 p-4 text-left md:w-[60%]">
              <p className="text-xs text-amber-700">{copy.typesUnavailable}</p>
            </div>
          )}
          {!searching && query.trim().length >= 2 && !searchResult && !searchError && (
            <p className="mt-3 text-sm text-slate-500">{copy.noResultsYet}</p>
          )}
          {submitSuccess && <p className="mt-3 text-sm text-emerald-700">{submitSuccess}</p>}

          {inChatMode && (
            <div className="chat-input-dock fixed inset-x-0 bottom-0 z-40 w-full px-2 pb-2 pt-3 md:px-0">
              <motion.div
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.4, ease: "easeOut" }}
                className="chat-lane mx-auto w-full"
              >
                <div className="mb-2 flex justify-end">
                  <button
                    onClick={openQuickSubmitTicket}
                    className="rounded-xl border border-[#B8C9FF] bg-white px-5 py-2.5 text-sm font-semibold text-brand-600 shadow-[0_6px_18px_rgba(0,100,255,0.14)] hover:bg-[#F7FAFF]"
                  >
                    {copy.submitFromChat}
                  </button>
                </div>
                {(composerAttachments.length > 0 || uploadingAttachment || attachmentError) && (
                  <div className="mb-2 rounded-[24px] border border-[#CFE0FF] bg-white/92 p-3 shadow-[0_12px_32px_rgba(0,100,255,0.08)]">
                    <div className="flex items-center gap-2 text-xs font-medium text-[#3050C8]">
                      <ImagePlus size={14} />
                      <span>
                        {uiLang === "zh"
                          ? `已添加 ${composerAttachments.length} 个附件`
                          : `${composerAttachments.length} attachment${composerAttachments.length > 1 ? "s" : ""} added`}
                      </span>
                    </div>
                    {composerAttachments.length > 0 && (
                      <div className="mt-3 flex flex-wrap gap-3">
                        {composerAttachments.map((item) => (
                          <div key={item.url} className="relative flex items-center gap-3 overflow-hidden rounded-2xl border border-[#D9E4FF] bg-white p-2 pr-10">
                            {isImageAttachment(item) ? (
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
                              onClick={() => removeAttachment(item.url)}
                              className="absolute right-1 top-1 inline-flex h-6 w-6 items-center justify-center rounded-full bg-black/55 text-white"
                              aria-label={uiLang === "zh" ? "移除附件" : "Remove attachment"}
                            >
                              <X size={12} />
                            </button>
                          </div>
                        ))}
                      </div>
                    )}
                    {uploadingAttachment && <p className="mt-2 text-xs text-slate-500">{uiLang === "zh" ? "正在上传附件..." : "Uploading attachment..."}</p>}
                    {attachmentError && <p className="mt-2 text-xs text-rose-600">{attachmentError}</p>}
                  </div>
                )}
                <div className="chat-input-shell flex min-h-[62px] w-full items-end gap-2 rounded-[32px] px-4 py-2 md:px-5">
                  <button
                    type="button"
                    className="mb-1 inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-[#7B88A8] transition hover:bg-white/70"
                    title="Attach"
                    aria-label="Attach"
                    onClick={() => fileInputRef.current?.click()}
                  >
                    <Paperclip size={17} />
                  </button>
                  <textarea
                    ref={composerRef}
                    placeholder={copy.placeholderChat}
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    onCompositionStart={() => {
                      isComposingRef.current = true;
                    }}
                    onCompositionEnd={() => {
                      isComposingRef.current = false;
                    }}
                    onPaste={(e) => {
                      const files = extractClipboardImageFiles(e);
                      if (!files.length) return;
                      e.preventDefault();
                      void uploadFiles(files);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && !e.shiftKey && shouldInterceptEnter(e)) {
                        e.preventDefault();
                        void onSearch();
                      }
                    }}
                    rows={1}
                    className="chat-input-textarea ml-1 w-full flex-1"
                  />
                  <button
                    onClick={() => void onSearch()}
                    disabled={searching || (query.trim().length < 2 && composerAttachments.length === 0)}
                    className="chat-send-btn mb-1 inline-flex h-10 min-w-10 shrink-0 items-center justify-center rounded-full px-4 text-sm font-medium text-white disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {searching ? <Loader2 size={16} className="animate-spin" /> : <SendHorizontal size={16} />}
                  </button>
                </div>
              </motion.div>
            </div>
          )}
        </section>

        {!inChatMode && (
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
                    setChatDraft(null);
                    setService(item);
                    if (!selectedOnesTypeKey && onesTypes[0]?.key) setSelectedOnesTypeKey(onesTypes[0].key);
                    setOpen(true);
                  }}
                  whileHover={{ y: -6, backgroundColor: "#F5F8FF" }}
                  whileTap={{ scale: 0.995 }}
                  className="group rounded-2xl bg-white p-8 text-left [box-shadow:0_1px_2px_rgba(22,23,26,0.06),0_18px_38px_rgba(0,100,255,0.08),0_2px_10px_rgba(51,221,255,0.1)] transition-all duration-300"
                >
                  <motion.div className="inline-flex" whileHover={{ scale: 1.06, rotate: -3 }} transition={{ duration: 0.35, ease: "easeOut" }}>
                    <Icon className="text-brand-500" size={48} strokeWidth={1.7} />
                  </motion.div>
                  <h3 className="mt-6 text-[20px] font-semibold text-[#1F2937]">{item.title}</h3>
                  <p className="mt-2 text-[14px] font-normal leading-6 text-[#6B7280]">{item.description}</p>
                </motion.button>
              );
            })}
          </motion.section>
        )}
      </main>

      <Dialog.Root open={open} onOpenChange={setOpen}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 bg-slate-900/40" />
          <Dialog.Content className="fixed left-1/2 top-1/2 flex max-h-[88vh] w-[95vw] max-w-3xl -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-2xl bg-white p-6 shadow-[0_30px_60px_rgba(17,24,39,0.2)] md:p-8">
            <div className="mb-6 flex items-center justify-between">
              <Dialog.Title className="text-xl font-semibold text-[#1F2937]">Submit {service?.title}</Dialog.Title>
              <Dialog.Close className="rounded-lg p-2 text-[#6B7280] hover:bg-slate-100">
                <X size={18} />
              </Dialog.Close>
            </div>

            <div className="flex-1 space-y-4 overflow-y-auto pr-1">
              {chatDraft && (
                <div className="rounded-xl border border-indigo-200 bg-indigo-50 p-3">
                  <p className="text-xs font-semibold text-indigo-700">
                    AI draft ready for {chatDraft.ticketTypeName}
                  </p>
                  {chatDraft.missingRequiredFields.length > 0 && (
                    <p className="mt-1 text-xs text-indigo-700">
                      Missing required fields: {chatDraft.missingRequiredFields.join(", ")}
                    </p>
                  )}
                </div>
              )}
              <div>
                <label className="mb-2 block text-sm font-medium text-[#1F2937]">Title</label>
                <input value={title} onChange={(e) => setTitle(e.target.value)} className="h-11 w-full rounded-xl border border-line px-3" />
              </div>
              <div>
                <label className="mb-2 block text-sm font-medium text-[#1F2937]">Description (Markdown supported)</label>
                <textarea
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  rows={10}
                  className="min-h-[220px] w-full rounded-xl border border-line px-3 py-2"
                />
              </div>
              {onesTypes.length > 0 && (
                <div className="space-y-3">
                  <div>
                    <label className="mb-1 block text-sm font-medium text-[#1F2937]">Ticket Type</label>
                    <select
                      className="h-10 w-full rounded-xl border border-line px-3 text-sm"
                      value={selectedOnesTypeKey}
                      onChange={(e) => setSelectedOnesTypeKey(e.target.value)}
                    >
                      {onesTypes.map((type) => (
                        <option key={type.key} value={type.key}>
                          {type.name}
                        </option>
                      ))}
                    </select>
                  </div>
                  {(onesTypes.find((type) => type.key === selectedOnesTypeKey)?.fields ?? []).map((field, idx) => {
                      const asRecord = field as Record<string, unknown>;
                      const key = String(asRecord.key ?? asRecord.id ?? `field_${idx}`);
                      const label = String(asRecord.label ?? asRecord.name ?? key);
                      const required = Boolean(asRecord.required ?? false);
                      const visible = Boolean(asRecord.visible ?? true);
                      const fieldType = String(asRecord.type ?? "text").toLowerCase();
                      if (!visible) return null;
                      return (
                        <div key={key}>
                          <label className="mb-1 block text-xs font-medium text-slate-600">
                            {label} {required ? "*" : ""}
                          </label>
                          {chatDraft?.fieldHints.find((item) => item.key === key) && (
                            <p className="mb-1 text-[11px] text-slate-500">
                              AI confidence: {chatDraft.fieldHints.find((item) => item.key === key)?.confidence.toFixed(2)}
                            </p>
                          )}
                          {fieldType.includes("select") && Array.isArray(asRecord.options) ? (
                            <select
                              className="h-10 w-full rounded-xl border border-line px-3 text-sm"
                              value={onesFields[key] ?? String(asRecord.defaultValue ?? "")}
                              onChange={(e) => setOnesFields((prev) => ({ ...prev, [key]: e.target.value }))}
                            >
                              <option value="">Select...</option>
                              {(asRecord.options as Array<Record<string, unknown>>).map((opt) => {
                                const value = String(opt.value ?? opt.key ?? opt.id ?? "");
                                const text = String(opt.label ?? opt.name ?? value);
                                return <option key={`${key}_${value}`} value={value}>{text}</option>;
                              })}
                            </select>
                          ) : fieldType.includes("textarea") || fieldType.includes("multi") ? (
                            <textarea
                              className="w-full rounded-xl border border-line px-3 py-2 text-sm"
                              rows={3}
                              value={onesFields[key] ?? String(asRecord.defaultValue ?? "")}
                              onChange={(e) => setOnesFields((prev) => ({ ...prev, [key]: e.target.value }))}
                            />
                          ) : (
                            <input
                              className="h-10 w-full rounded-xl border border-line px-3 text-sm"
                              value={onesFields[key] ?? String(asRecord.defaultValue ?? "")}
                              onChange={(e) => setOnesFields((prev) => ({ ...prev, [key]: e.target.value }))}
                            />
                          )}
                        </div>
                      );
                    })}
                </div>
              )}
              {!service && <p className="text-xs text-rose-600">Please select a service category before submitting.</p>}
              {submitError && <p className="text-xs text-rose-600">{submitError}</p>}
              <div className="rounded-2xl border border-dashed border-[#BFD5FF] bg-[linear-gradient(180deg,rgba(255,255,255,0.98),rgba(242,247,255,0.96))] px-4 py-5">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <p className="text-sm font-semibold text-[#1F2937]">{uiLang === "zh" ? "附件" : "Attachments"}</p>
                    <p className="mt-1 text-xs text-[#6B7280]">
                      {uiLang === "zh" ? "图片会直接预览；HAR、日志与文本文件会作为工单证据一并提交。" : "Images render inline here; HAR, logs, and text files are attached as ticket evidence."}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    className="rounded-full border border-[#B8C9FF] px-4 py-2 text-sm font-semibold text-brand-600 hover:bg-[#F5F8FF]"
                  >
                    {uiLang === "zh" ? "上传附件" : "Upload attachment"}
                  </button>
                </div>
                {ticketAttachments.length > 0 && (
                  <div className="mt-4 grid gap-3 sm:grid-cols-2">
                    {ticketAttachments.map((item) => (
                      <div key={item.url} className="relative overflow-hidden rounded-2xl border border-[#D9E4FF] bg-white p-3 pr-10">
                        {isImageAttachment(item) ? (
                          <a href={item.url} target="_blank" rel="noreferrer" className="block">
                            <img src={item.url} alt={item.name} className="h-40 w-full rounded-xl border border-slate-100 object-cover" />
                          </a>
                        ) : (
                          <div className="flex items-center gap-3 rounded-xl bg-slate-50 p-3">
                            <span className="inline-flex h-14 w-14 shrink-0 items-center justify-center rounded-xl bg-slate-200 text-xs font-semibold text-slate-600">
                              FILE
                            </span>
                            <div className="min-w-0">
                              <p className="truncate text-sm font-medium text-slate-700">{item.name}</p>
                              <p className="text-xs text-slate-500">{item.contentType || "application/octet-stream"}</p>
                            </div>
                          </div>
                        )}
                        <div className="mt-3 min-w-0">
                          <p className="truncate text-sm font-medium text-slate-700">{item.name}</p>
                          <p className="text-xs text-slate-500">{item.contentType || "application/octet-stream"}</p>
                        </div>
                        <button
                          type="button"
                          onClick={() => removeAttachment(item.url)}
                          className="absolute right-1 top-1 inline-flex h-6 w-6 items-center justify-center rounded-full bg-black/55 text-white"
                          aria-label={uiLang === "zh" ? "移除附件" : "Remove attachment"}
                        >
                          <X size={12} />
                        </button>
                      </div>
                    ))}
                  </div>
                )}
                {uploadingAttachment && <p className="mt-3 text-xs text-slate-500">{uiLang === "zh" ? "正在上传附件..." : "Uploading attachment..."}</p>}
                {attachmentError && <p className="mt-3 text-xs text-rose-600">{attachmentError}</p>}
              </div>
            </div>

            <div className="mt-6 flex justify-end border-t border-slate-100 pt-4">
              <button
                onClick={submit}
                disabled={submitLoading}
                className="rounded-lg bg-brand-500 px-5 py-2 text-sm font-medium text-white transition hover:bg-brand-600 disabled:cursor-not-allowed disabled:opacity-70"
              >
                {submitLoading ? "Submitting..." : "Submit Ticket"}
              </button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  );
}
