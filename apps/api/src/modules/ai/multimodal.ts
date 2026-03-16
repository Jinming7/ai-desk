import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { env } from "../../config/env.js";

export type AiCapabilities = {
  imageInputEnabled: boolean;
  provider: "openai" | "openai-codex-oauth" | "disabled";
  model: string | null;
  reason: string;
};

type OAuthProfileStore = {
  profiles?: Record<
    string,
    {
      provider?: string;
      type?: string;
      access?: string;
      refresh?: string;
      expires?: number;
    }
  >;
};

type ResolvedVisionAuth =
  | { provider: "openai"; authHeader: string; model: string; reason: string }
  | { provider: "openai-codex-oauth"; authHeader: string; model: string; reason: string }
  | null;

const DEFAULT_MULTIMODAL_MODEL = "gpt-5.4";
const TEXT_ATTACHMENT_MAX_CHARS = 12000;
const TEXT_ATTACHMENT_MAX_FILES = 4;

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const parts = token.split(".");
  if (parts.length < 2) return null;
  try {
    const normalized = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized + "=".repeat((4 - (normalized.length % 4 || 4)) % 4);
    return JSON.parse(Buffer.from(padded, "base64").toString("utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function resolveVisionAuth(): Promise<ResolvedVisionAuth> {
  const model = env.OPENAI_MULTIMODAL_MODEL.trim() || DEFAULT_MULTIMODAL_MODEL;
  if (env.OPENAI_API_KEY?.trim()) {
    return {
      provider: "openai",
      authHeader: `Bearer ${env.OPENAI_API_KEY.trim()}`,
      model,
      reason: "Vision analysis is enabled through the OpenAI Responses API."
    };
  }

  const profilePath =
    env.OPENAI_CODEX_AUTH_PROFILE_PATH?.trim() || path.join(os.homedir(), ".openclaw", "agents", "main", "agent", "auth-profiles.json");

  try {
    const payload = JSON.parse(await fs.readFile(profilePath, "utf8")) as OAuthProfileStore;
    const profile = Object.values(payload.profiles ?? {}).find((item) => item?.provider === "openai-codex" && item.type === "oauth");
    if (!profile?.access) return null;
    const jwtPayload = decodeJwtPayload(profile.access);
    const scopes = Array.isArray(jwtPayload?.scp) ? jwtPayload.scp.map((item) => String(item)) : [];
    if (!scopes.includes("api.responses.write")) {
      return null;
    }

    return {
      provider: "openai-codex-oauth",
      authHeader: `Bearer ${profile.access}`,
      model,
      reason: "Vision analysis is enabled through the local Codex OAuth profile."
    };
  } catch {
    return null;
  }
}

export async function resolveAttachmentPath(input: string): Promise<string | null> {
  let pathname = input;
  try {
    pathname = new URL(input).pathname;
  } catch {
    pathname = input;
  }

  if (!pathname.startsWith("/uploads/images/") && !pathname.startsWith("/uploads/files/")) {
    return null;
  }

  const relativePath = pathname.slice(1);
  const subdir = pathname.startsWith("/uploads/files/") ? "files" : "images";
  const roots = [path.resolve(process.cwd(), "uploads", subdir), path.resolve(process.cwd(), "apps", "api", "uploads", subdir)];

  for (const root of roots) {
    const absolute = path.resolve(root, path.basename(relativePath));
    if (!absolute.startsWith(root)) continue;
    try {
      await fs.access(absolute);
      return absolute;
    } catch {
      continue;
    }
  }
  return null;
}

export function detectMimeType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".png") return "image/png";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".gif") return "image/gif";
  if (ext === ".webp") return "image/webp";
  if (ext === ".har") return "application/json";
  if (ext === ".json") return "application/json";
  if (ext === ".txt") return "text/plain";
  if (ext === ".log") return "text/plain";
  if (ext === ".md") return "text/markdown";
  return "application/octet-stream";
}

function isTextAttachment(filePath: string, mimeType: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  return (
    mimeType.startsWith("text/") ||
    mimeType === "application/json" ||
    ext === ".har" ||
    ext === ".json" ||
    ext === ".txt" ||
    ext === ".log" ||
    ext === ".md"
  );
}

function truncateText(value: string, maxChars = TEXT_ATTACHMENT_MAX_CHARS): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}\n...[truncated]`;
}

function safeUrlPath(rawUrl: string): string {
  try {
    const url = new URL(rawUrl);
    return `${url.origin}${url.pathname}`;
  } catch {
    return rawUrl;
  }
}

function extractHarKeywords(entries: Array<{
  request?: { url?: string };
  response?: { status?: number; content?: { mimeType?: string; text?: string } };
}>): string[] {
  const matches = new Set<string>();
  const patterns = [
    /\b(error|exception|timeout|forbidden|unauthorized|not found|bad gateway|service unavailable|cors|csrf|rate limit)\b/gi,
    /\b(4\d\d|5\d\d)\b/g
  ];

  for (const entry of entries.slice(0, 30)) {
    const haystacks = [entry.request?.url ?? "", entry.response?.content?.mimeType ?? "", entry.response?.content?.text ?? ""];
    for (const haystack of haystacks) {
      for (const pattern of patterns) {
        for (const match of haystack.matchAll(pattern)) {
          matches.add(match[0].toLowerCase());
          if (matches.size >= 12) {
            return [...matches];
          }
        }
      }
    }
  }

  return [...matches];
}

function summarizeHar(name: string, rawText: string): string {
  try {
    const payload = JSON.parse(rawText) as {
      log?: {
        entries?: Array<{
          startedDateTime?: string;
          request?: { method?: string; url?: string };
          response?: { status?: number; statusText?: string; content?: { mimeType?: string; text?: string } };
          time?: number;
        }>;
      };
    };
    const entries = payload.log?.entries ?? [];
    const failedEntries = entries.filter((entry) => (entry.response?.status ?? 0) >= 400);
    const slowEntries = [...entries].sort((a, b) => (b.time ?? 0) - (a.time ?? 0)).slice(0, 5);
    const statusCounts = entries.reduce<Record<string, number>>((acc, entry) => {
      const status = String(entry.response?.status ?? "unknown");
      acc[status] = (acc[status] ?? 0) + 1;
      return acc;
    }, {});
    const statusSummary = Object.entries(statusCounts)
      .sort((a, b) => Number(a[0]) - Number(b[0]))
      .slice(0, 12)
      .map(([status, count]) => `${status}=${count}`)
      .join(", ");
    const keywords = extractHarKeywords(entries);
    const sample = (failedEntries.length ? failedEntries.slice(0, 8) : entries.slice(0, 8)).map((entry, index) => {
      const method = entry.request?.method ?? "GET";
      const url = safeUrlPath(entry.request?.url ?? "unknown-url");
      const status = entry.response?.status ?? "n/a";
      const statusText = entry.response?.statusText ?? "";
      const time = entry.time ?? 0;
      return `${index + 1}. ${method} ${url} -> ${status} ${statusText} (${time}ms)`;
    });
    const slowSample = slowEntries.map((entry, index) => {
      const method = entry.request?.method ?? "GET";
      const url = safeUrlPath(entry.request?.url ?? "unknown-url");
      const status = entry.response?.status ?? "n/a";
      const time = entry.time ?? 0;
      return `${index + 1}. ${method} ${url} -> ${status} (${time}ms)`;
    });
    return truncateText(
      [
        `[HAR attachment: ${name}]`,
        `entries=${entries.length}`,
        `error_entries=${failedEntries.length}`,
        `status_counts=${statusSummary || "none"}`,
        keywords.length ? `keywords=${keywords.join(", ")}` : "keywords=none",
        sample.length ? "[Failed or representative requests]" : "[No request entries found]",
        ...sample,
        slowSample.length ? "[Slowest requests]" : "",
        ...slowSample
      ]
        .filter(Boolean)
        .join("\n")
    );
  } catch {
    return truncateText(`[Attachment: ${name}]\n${rawText}`);
  }
}

export async function summarizeTextAttachments(input: { attachments: string[]; answerLanguage: "zh" | "en" }): Promise<string | null> {
  const sections: string[] = [];

  for (const attachment of input.attachments.slice(0, TEXT_ATTACHMENT_MAX_FILES)) {
    const filePath = await resolveAttachmentPath(attachment);
    if (!filePath) continue;
    const mimeType = detectMimeType(filePath);
    if (!isTextAttachment(filePath, mimeType)) continue;

    try {
      const rawText = await fs.readFile(filePath, "utf8");
      const name = path.basename(filePath);
      if (path.extname(filePath).toLowerCase() === ".har") {
        sections.push(summarizeHar(name, rawText));
        continue;
      }
      sections.push(truncateText(`[Attachment: ${name}]\n${rawText}`));
    } catch {
      continue;
    }
  }

  if (!sections.length) return null;
  const header = input.answerLanguage === "zh" ? "[文本附件上下文]" : "[Text attachment context]";
  return `${header}\n${sections.join("\n\n")}`;
}

function extractOutputText(payload: any): string {
  if (typeof payload?.output_text === "string" && payload.output_text.trim()) {
    return payload.output_text.trim();
  }

  const outputs = Array.isArray(payload?.output) ? payload.output : [];
  const textParts: string[] = [];
  for (const item of outputs) {
    const content = Array.isArray(item?.content) ? item.content : [];
    for (const block of content) {
      const text = typeof block?.text === "string" ? block.text : typeof block?.output_text === "string" ? block.output_text : "";
      if (text.trim()) textParts.push(text.trim());
    }
  }
  return textParts.join("\n").trim();
}

export async function getAiCapabilities(): Promise<AiCapabilities> {
  const auth = await resolveVisionAuth();
  if (auth) {
    return {
      imageInputEnabled: true,
      provider: auth.provider,
      model: auth.model,
      reason: auth.reason
    };
  }

  return {
    imageInputEnabled: false,
    provider: "disabled",
    model: null,
    reason:
      "Current OpenClaw agent accepts text-only message strings. Configure OPENAI_API_KEY or provide a local Codex OAuth auth-profiles.json to enable image analysis."
  };
}

export async function summarizeImageAttachments(input: {
  query: string;
  attachments: string[];
  answerLanguage: "zh" | "en";
}): Promise<string | null> {
  const auth = await resolveVisionAuth();
  if (!auth) {
    return null;
  }

  const selected = input.attachments.slice(0, env.OPENAI_MULTIMODAL_MAX_IMAGES);
  if (!selected.length) return null;

  const content: Array<Record<string, unknown>> = [
    {
      type: "input_text",
      text:
        input.answerLanguage === "zh"
          ? `请分析这些截图，并用中文输出：1. 你观察到的关键信息；2. 可能的问题；3. 可用于检索知识库的错误关键词。用户补充文本：${input.query || "（无额外文本）"}`
          : `Analyze these screenshots and respond in English with: 1) key observations, 2) likely issue, 3) error keywords useful for knowledge retrieval. User text: ${input.query || "(no extra text)"}` 
    }
  ];

  for (const attachment of selected) {
    const filePath = await resolveAttachmentPath(attachment);
    if (!filePath) continue;
    const binary = await fs.readFile(filePath);
    const mimeType = detectMimeType(filePath);
    content.push({
      type: "input_image",
      image_url: `data:${mimeType};base64,${binary.toString("base64")}`
    });
  }

  if (content.length === 1) {
    return null;
  }

  const response = await fetch(`${env.OPENAI_API_BASE.replace(/\/$/, "")}/responses`, {
    method: "POST",
    headers: {
      Authorization: auth.authHeader,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: auth.model,
      input: [
        {
          role: "user",
          content
        }
      ],
      max_output_tokens: 450
    })
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Image analysis failed: ${text || response.status}`);
  }

  const payload = await response.json();
  const outputText = extractOutputText(payload);
  return outputText || null;
}
