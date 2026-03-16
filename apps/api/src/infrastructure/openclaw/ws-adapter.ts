import fs from "node:fs/promises";
import { WebSocket } from "ws";
import { env } from "../../config/env.js";
import { detectMimeType, resolveAttachmentPath } from "../../modules/ai/multimodal.js";
import type {
  OpenClawAdapter,
  OpenClawAnalyzeInput,
  OpenClawAnalyzeOutput,
  OpenClawClassifyIntentInput,
  OpenClawClassifyIntentOutput,
  OpenClawRuntimeContext,
  OpenClawSearchAnswerInput,
  OpenClawSearchAnswerOutput,
  OpenClawSearchInput,
  OpenClawSearchOutput
} from "./types.js";

interface RpcReq {
  type: "req";
  id: string;
  method: string;
  params: Record<string, unknown>;
}

interface RpcRes {
  type: "res";
  id: string;
  ok: boolean;
  result?: unknown;
  payload?: unknown;
  error?: { code: string; message: string };
}

type OpenClawChatAttachment = {
  type: "image";
  mimeType: string;
  content: string;
};

export class WsOpenClawAdapter implements OpenClawAdapter {
  private consecutiveFailures = 0;
  private readonly requestedScopes = env.OPENCLAW_REQUEST_SCOPES.split(",").map((item) => item.trim()).filter(Boolean);

  async healthCheck() {
    try {
      await this.connectOnly();
      return { ok: true, mode: "ws" as const, detail: "Connected to OpenClaw gateway" };
    } catch (error) {
      return { ok: false, mode: "ws" as const, detail: (error as Error).message };
    }
  }

  async analyzeTicket(
    input: OpenClawAnalyzeInput,
    idempotencyKey: string,
    runtime?: OpenClawRuntimeContext
  ): Promise<OpenClawAnalyzeOutput> {
    return this.withRetry(async () => {
      if (input.attachments?.length) {
        return this.analyzeViaChat(input, idempotencyKey, runtime);
      }
      try {
        const result = await this.callMethod("ticket.analyze", { ...input, idempotency_key: idempotencyKey });
        return result as OpenClawAnalyzeOutput;
      } catch (error) {
        const message = (error as Error).message.toLowerCase();
        if (!message.includes("unknown method")) {
          throw error;
        }
        return this.analyzeViaChat(input, idempotencyKey, runtime);
      }
    });
  }

  async searchKnowledge(
    input: OpenClawSearchInput,
    idempotencyKey: string,
    runtime?: OpenClawRuntimeContext
  ): Promise<OpenClawSearchOutput> {
    return this.withRetry(async () => {
      if (input.attachments?.length) {
        return this.searchViaChat(input, idempotencyKey, runtime);
      }
      try {
        const result = await this.callMethod(
          "kb.search",
          {
            query: input.query,
            top_k: input.topK,
            index: input.index,
            idempotency_key: idempotencyKey
          },
          env.OPENCLAW_SEARCH_TIMEOUT_MS
        );
        return result as OpenClawSearchOutput;
      } catch (error) {
        const message = (error as Error).message.toLowerCase();
        if (!message.includes("unknown method")) {
          throw error;
        }
        return this.searchViaChat(input, idempotencyKey, runtime);
      }
    });
  }

  async answerSearchQuery(
    input: OpenClawSearchAnswerInput,
    idempotencyKey: string,
    runtime?: OpenClawRuntimeContext
  ): Promise<OpenClawSearchAnswerOutput> {
    return this.withRetry(async () => {
      const historyLines: string[] = [];
      if (input.conversationHistory?.length) {
        const recent = input.conversationHistory.slice(-6);
        historyLines.push("=== Conversation History (most recent 6 turns) ===");
        for (const turn of recent) {
          historyLines.push(`[${turn.role}]: ${turn.content}`);
        }
        historyLines.push("=== End History ===");
      }

      const prompt = [
        "You are search-bot, a grounded support retrieval assistant.",
        "",
        "## Instructions",
        "1. Your answer MUST directly address the user's question. Do NOT give generic troubleshooting steps when the references contain a specific answer.",
        "2. If the references contain relevant information, cite and synthesize it into a concrete answer.",
        "3. If the draft_answer already contains a specific conclusion, preserve and enhance it — do NOT replace it with a vague clarification.",
        "4. Only ask for clarification when you genuinely lack enough information to answer. Do NOT default to clarification.",
        "5. If a capability is not explicitly shown in the provided references, say: 不确定（文档未显示）.",
        "6. Classify the user's question yourself before answering.",
        "",
        "## Output Format",
        "Return ONLY valid JSON with keys:",
        "answer, style(kb_answer|diagnosis|clarification), summary, assessment, steps(string[]), validation(string[]), required_inputs(string[]), suggested_next_step(self_serve|submit_ticket)",
        "",
        ...(historyLines.length ? [...historyLines, ""] : []),
        `language: ${input.language}`,
        `route_hint: ${input.routeHint ?? "none"}`,
        `grounded: ${input.grounded ? "true" : "false"}`,
        `user_query: ${input.query}`,
        `references: ${JSON.stringify(input.references)}`,
        `draft_answer: ${JSON.stringify(input.draftAnswer ?? null)}`
      ].join("\n");

      const runId = await this.startChatRun(prompt, idempotencyKey, runtime, input.attachments);
      await this.waitAgentRun(runId);
      const text = await this.fetchLatestAssistantText(runtime);
      const parsed = this.parseFirstJson(text) as Partial<OpenClawSearchAnswerOutput>;
      return {
        answer: typeof parsed.answer === "string" ? parsed.answer : typeof parsed.summary === "string" ? parsed.summary : "",
        style: parsed.style,
        summary: typeof parsed.summary === "string" ? parsed.summary : "",
        assessment: typeof parsed.assessment === "string" ? parsed.assessment : undefined,
        steps: Array.isArray(parsed.steps) ? parsed.steps.map((x) => String(x)) : [],
        validation: Array.isArray(parsed.validation) ? parsed.validation.map((x) => String(x)) : [],
        required_inputs: Array.isArray(parsed.required_inputs) ? parsed.required_inputs.map((x) => String(x)) : undefined,
        suggested_next_step: parsed.suggested_next_step
      };
    });
  }

  async classifyIntent(
    input: OpenClawClassifyIntentInput,
    idempotencyKey: string,
    runtime?: OpenClawRuntimeContext
  ): Promise<OpenClawClassifyIntentOutput> {
    // No retry for classification — it's an optional enhancement; regex fallback is always available.
    const contextLines: string[] = [];
    if (input.conversationContext?.length) {
      contextLines.push("Previous conversation context:");
      for (const msg of input.conversationContext.slice(-4)) {
        contextLines.push(`- ${msg}`);
      }
    }

    const prompt = [
      "You are an intent classifier for a technical support system.",
      "",
      "## Task",
      "Classify the user's query into an intent and a routing category.",
      "",
      "## Intent categories",
      "- api_operation: Questions about API endpoints, HTTP requests, SDK usage, OpenAPI docs",
      "- feature_usage: How-to questions about product features, UI navigation, workflows",
      "- troubleshooting: Error reports, failures, timeout, crash, unexpected behavior",
      "- concept_explanation: What-is questions, comparisons, conceptual understanding",
      "- configuration: Setup, deployment, config, integration, OAuth/token configuration",
      "- general: Vague or unclassifiable queries",
      "",
      "## Route categories",
      "- openapi_doc: Query specifically asks about OpenAPI/REST endpoint documentation",
      "- infra_runbook: Infrastructure troubleshooting (k8s, pods, volumes, database ops)",
      "- integration_diagnosis: Third-party integration failures (GitHub/GitLab/Slack + error)",
      "- product_diagnosis: Product bug reports with concrete evidence",
      "- kb_guidance: Answerable from knowledge base (most feature/config/troubleshooting questions)",
      "- clarification: Query is too vague to route without more information",
      "",
      "## Rules",
      "- If the query mentions auth/OAuth/token in a configuration context (e.g. 'how to configure OAuth'), classify as configuration + kb_guidance, NOT api_operation",
      "- If the query has concrete error details + integration keywords, classify as troubleshooting + integration_diagnosis",
      "- If there is conversation context, use it to disambiguate vague queries — prefer kb_guidance over clarification",
      "- Only use clarification when the query is truly uninformative (e.g. just 'help' or 'hi')",
      "",
      "## Output",
      "Return ONLY valid JSON: {intent, route, confidence(0..1), reasoning(short string)}",
      "",
      ...(contextLines.length ? [...contextLines, ""] : []),
      `language: ${input.language}`,
      `user_query: ${input.query}`
    ].join("\n");

    const runId = await this.startChatRun(prompt, idempotencyKey, runtime);
    await this.waitAgentRun(runId);
    const text = await this.fetchLatestAssistantText(runtime);
    const parsed = this.parseFirstJson(text) as Partial<OpenClawClassifyIntentOutput>;

    const validIntents = ["api_operation", "feature_usage", "troubleshooting", "concept_explanation", "configuration", "general"];
    const validRoutes = ["openapi_doc", "infra_runbook", "integration_diagnosis", "product_diagnosis", "kb_guidance", "clarification"];

    return {
      intent: validIntents.includes(parsed.intent as string) ? parsed.intent! : "general",
      route: validRoutes.includes(parsed.route as string) ? parsed.route! : "kb_guidance",
      confidence: this.normalizeConfidence(parsed.confidence),
      reasoning: typeof parsed.reasoning === "string" ? parsed.reasoning : ""
    };
  }

  private async analyzeViaChat(
    input: OpenClawAnalyzeInput,
    idempotencyKey: string,
    runtime?: OpenClawRuntimeContext
  ): Promise<OpenClawAnalyzeOutput> {
    const prompt = [
      "You are first-line ticket triage.",
      "Return ONLY valid JSON with keys:",
      "action(resolve|ask_user|escalate), confidence(0..1), reply, reasoning_summary, evidence(string[]), risk_flags(string[])",
      "All output text must be English.",
      "If you need more user information, action must be ask_user.",
      "Do not include markdown.",
      `ticket_id: ${input.ticket_id}`,
      `title: ${input.title}`,
      `description: ${input.description}`,
      `priority: ${input.priority}`,
      `customer_meta: ${JSON.stringify(input.customer_meta)}`,
      `history: ${JSON.stringify(input.history)}`
    ].join("\n");

    const runId = await this.startChatRun(prompt, idempotencyKey, runtime, input.attachments);
    await this.waitAgentRun(runId);
    const text = await this.fetchLatestAssistantText(runtime);
    const parsed = this.parseFirstJson(text) as Partial<OpenClawAnalyzeOutput>;
    const reply = typeof parsed.reply === "string" ? parsed.reply : "";
    return {
      action: this.normalizeAction(parsed.action),
      confidence: this.normalizeConfidence(parsed.confidence),
      reply,
      reasoning_summary: typeof parsed.reasoning_summary === "string" ? parsed.reasoning_summary : "OpenClaw agent response",
      evidence: Array.isArray(parsed.evidence) ? parsed.evidence.map((x) => String(x)) : [],
      risk_flags: Array.isArray(parsed.risk_flags) ? parsed.risk_flags.map((x) => String(x)) : []
    };
  }

  private async searchViaChat(
    input: OpenClawSearchInput,
    idempotencyKey: string,
    runtime?: OpenClawRuntimeContext
  ): Promise<OpenClawSearchOutput> {
    const prompt = [
      "You are knowledge retrieval assistant.",
      "Return ONLY valid JSON with keys:",
      "confidence(0..1), hits([{id,title,snippet,score,sourceUrl}])",
      "Do not include markdown.",
      `query: ${input.query}`,
      `topK: ${input.topK}`,
      `index: ${input.index}`
    ].join("\n");

    const runId = await this.startChatRun(prompt, idempotencyKey, runtime, input.attachments);
    await this.waitAgentRun(runId);
    const text = await this.fetchLatestAssistantText(runtime);
    const parsed = this.parseFirstJson(text) as Record<string, unknown>;
    const rawHits = Array.isArray(parsed.hits) ? parsed.hits : [];
    const hits = rawHits.map((item, index) => {
      const row = (item ?? {}) as Record<string, unknown>;
      return {
        id: typeof row.id === "string" && row.id ? row.id : `agent-hit-${index + 1}`,
        title: typeof row.title === "string" ? row.title : "Knowledge result",
        snippet: typeof row.snippet === "string" ? row.snippet : "",
        score: this.normalizeConfidence(row.score),
        sourceUrl: typeof row.sourceUrl === "string" ? row.sourceUrl : ""
      };
    });
    return {
      confidence: this.normalizeConfidence(parsed.confidence),
      hits
    };
  }

  private resolveAgentRuntime(runtime?: OpenClawRuntimeContext): { agentId: string; sessionKey: string } {
    return {
      agentId: runtime?.agentId?.trim() || env.OPENCLAW_AGENT_ID || "main",
      sessionKey: runtime?.sessionKey?.trim() || env.OPENCLAW_AGENT_SESSION_KEY || `agent:main:${Date.now()}`
    };
  }

  private async startAgentRun(message: string, idempotencyKey: string, runtime?: OpenClawRuntimeContext): Promise<string> {
    const agentRuntime = this.resolveAgentRuntime(runtime);
    const payload = (await this.callMethod("agent", {
      agentId: agentRuntime.agentId,
      sessionKey: agentRuntime.sessionKey,
      message,
      timeout: env.OPENCLAW_AGENT_TIMEOUT_MS,
      idempotencyKey
    })) as { runId?: string; status?: string; summary?: string };

    if (!payload?.runId) {
      throw new Error("OpenClaw agent did not return runId");
    }
    if (payload.status === "error") {
      throw new Error(payload.summary || "OpenClaw agent run failed");
    }
    return payload.runId;
  }

  private async startChatRun(
    message: string,
    idempotencyKey: string,
    runtime?: OpenClawRuntimeContext,
    attachmentUrls?: string[]
  ): Promise<string> {
    const agentRuntime = this.resolveAgentRuntime(runtime);
    const attachments = await this.buildChatAttachments(attachmentUrls);
    const payload = (await this.callMethod("chat.send", {
      sessionKey: agentRuntime.sessionKey,
      message,
      deliver: false,
      idempotencyKey,
      ...(attachments.length ? { attachments } : {})
    })) as { runId?: string; status?: string; summary?: string };

    if (!payload?.runId) {
      throw new Error("OpenClaw chat.send did not return runId");
    }
    if (payload.status === "error") {
      throw new Error(payload.summary || "OpenClaw chat.send failed");
    }
    return payload.runId;
  }

  private async buildChatAttachments(attachmentUrls?: string[]): Promise<OpenClawChatAttachment[]> {
    const results: OpenClawChatAttachment[] = [];

    for (const item of attachmentUrls ?? []) {
      const filePath = await resolveAttachmentPath(item);
      if (!filePath) continue;
      const mimeType = detectMimeType(filePath);
      if (!mimeType.startsWith("image/")) continue;
      const binary = await fs.readFile(filePath);
      results.push({
        type: "image",
        mimeType,
        content: binary.toString("base64")
      });
    }

    return results;
  }

  private async waitAgentRun(runId: string): Promise<void> {
    const payload = (await this.callMethod(
      "agent.wait",
      { runId, timeoutMs: env.OPENCLAW_AGENT_TIMEOUT_MS },
      env.OPENCLAW_AGENT_TIMEOUT_MS + 2000
    )) as { status?: string; error?: string };

    if (payload?.status === "ok") {
      return;
    }
    if (payload?.status === "error") {
      throw new Error(payload.error || "OpenClaw agent wait failed");
    }
    throw new Error(`OpenClaw agent wait status: ${payload?.status ?? "unknown"}`);
  }

  private async fetchLatestAssistantText(runtime?: OpenClawRuntimeContext): Promise<string> {
    const agentRuntime = this.resolveAgentRuntime(runtime);
    const history = (await this.callMethod("chat.history", {
      sessionKey: agentRuntime.sessionKey,
      limit: 12
    })) as { messages?: Array<Record<string, unknown>> };

    const messages = Array.isArray(history?.messages) ? history.messages : [];
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const msg = messages[i];
      if (msg.role !== "assistant") continue;
      const blocks = Array.isArray(msg.content) ? (msg.content as Array<Record<string, unknown>>) : [];
      const text = blocks
        .filter((b) => b.type === "text" && typeof b.text === "string")
        .map((b) => String(b.text))
        .join("\n")
        .trim();
      if (text) return text;
      if (typeof msg.errorMessage === "string" && msg.errorMessage) {
        throw new Error(msg.errorMessage);
      }
    }
    throw new Error("OpenClaw agent returned no assistant text");
  }

  private parseFirstJson(text: string): unknown {
    const trimmed = text.trim();
    try {
      return JSON.parse(trimmed);
    } catch {}
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start >= 0 && end > start) {
      return JSON.parse(trimmed.slice(start, end + 1));
    }
    throw new Error("OpenClaw agent output is not valid JSON");
  }

  private normalizeAction(value: unknown): OpenClawAnalyzeOutput["action"] {
    if (value === "resolve" || value === "ask_user" || value === "escalate") return value;
    if (value === "auto_resolve") return "resolve";
    if (value === "ask_info") return "ask_user";
    return "ask_user";
  }

  private normalizeConfidence(value: unknown): number {
    const num = typeof value === "number" ? value : Number(value);
    if (!Number.isFinite(num)) return 0;
    return Math.max(0, Math.min(1, num));
  }

  private async withRetry<T>(fn: () => Promise<T>): Promise<T> {
    if (this.consecutiveFailures >= env.OPENCLAW_CIRCUIT_BREAKER_THRESHOLD) {
      throw new Error("OpenClaw circuit breaker open");
    }

    for (let attempt = 0; attempt <= env.OPENCLAW_MAX_RETRIES; attempt += 1) {
      try {
        const result = await fn();
        this.consecutiveFailures = 0;
        return result;
      } catch (error) {
        this.consecutiveFailures += 1;
        if (attempt >= env.OPENCLAW_MAX_RETRIES) {
          throw error;
        }
        const backoff = 2 ** attempt * 300;
        await new Promise((resolve) => setTimeout(resolve, backoff));
      }
    }

    throw new Error("OpenClaw retry loop exhausted");
  }

  private async callMethod(method: string, params: Record<string, unknown>, timeoutMs = env.OPENCLAW_METHOD_TIMEOUT_MS): Promise<unknown> {
    const authHeader =
      env.OPENCLAW_BASIC_USER && env.OPENCLAW_BASIC_PASS
        ? `Basic ${Buffer.from(`${env.OPENCLAW_BASIC_USER}:${env.OPENCLAW_BASIC_PASS}`).toString("base64")}`
        : undefined;

    const headers: Record<string, string> = {};
    if (authHeader) {
      headers.Authorization = authHeader;
    }
    if (env.OPENCLAW_CLIENT_ORIGIN) {
      headers.Origin = env.OPENCLAW_CLIENT_ORIGIN;
    }

    const wsOptions = {
      headers: Object.keys(headers).length ? headers : undefined,
      rejectUnauthorized: !env.OPENCLAW_ALLOW_SELF_SIGNED
    };

    const ws = new WebSocket(env.OPENCLAW_WS_URL, wsOptions);

    return await new Promise<unknown>((resolve, reject) => {
      const connectTimeout = setTimeout(() => {
        reject(new Error("OpenClaw connect timeout"));
        ws.close();
      }, env.OPENCLAW_CONNECT_TIMEOUT_MS);

      let requestTimeout: NodeJS.Timeout | undefined;

      ws.on("open", () => {
        const connectReq: RpcReq = {
          type: "req",
          id: "connect-1",
          method: "connect",
          params: {
            minProtocol: 3,
            maxProtocol: 3,
            client: {
              id: env.OPENCLAW_CLIENT_ID,
              version: env.OPENCLAW_CLIENT_VERSION,
              platform: env.OPENCLAW_CLIENT_PLATFORM,
              mode: env.OPENCLAW_CLIENT_MODE,
              instanceId: env.OPENCLAW_CLIENT_INSTANCE_ID
            },
            role: "operator",
            scopes: this.requestedScopes,
            caps: [],
            auth: {
              token: env.OPENCLAW_GATEWAY_TOKEN
            },
            userAgent: "ticket-core",
            locale: "en-US"
          }
        };

        ws.send(JSON.stringify(connectReq));
      });

      ws.on("message", (raw) => {
        const data = JSON.parse(String(raw)) as RpcRes | { type: "event"; event: string };

        if (data.type === "event") {
          return;
        }

        if (data.type === "res" && data.id === "connect-1") {
          clearTimeout(connectTimeout);
          if (!data.ok) {
            reject(new Error(`OpenClaw connect failed: ${data.error?.code ?? "UNKNOWN"}`));
            ws.close();
            return;
          }

          const requestId = "method-1";
          const request: RpcReq = {
            type: "req",
            id: requestId,
            method,
            params
          };
          requestTimeout = setTimeout(() => {
            reject(new Error(`OpenClaw ${method} timeout`));
            ws.close();
          }, timeoutMs);
          ws.send(JSON.stringify(request));
          return;
        }

        if (data.type === "res" && data.id === "method-1") {
          if (requestTimeout) {
            clearTimeout(requestTimeout);
          }
          ws.close();
          if (!data.ok) {
            reject(new Error(`OpenClaw ${method} failed: ${data.error?.message ?? "UNKNOWN"}`));
            return;
          }
          resolve(data.payload ?? data.result);
        }
      });

      ws.on("error", (error) => {
        clearTimeout(connectTimeout);
        if (requestTimeout) {
          clearTimeout(requestTimeout);
        }
        reject(error);
      });

      ws.on("close", () => {
        clearTimeout(connectTimeout);
        if (requestTimeout) {
          clearTimeout(requestTimeout);
        }
      });

      if (!env.OPENCLAW_GATEWAY_TOKEN) {
        reject(new Error("OPENCLAW_GATEWAY_TOKEN is not configured"));
        ws.close();
      }
    });
  }

  private async connectOnly(): Promise<void> {
    const authHeader =
      env.OPENCLAW_BASIC_USER && env.OPENCLAW_BASIC_PASS
        ? `Basic ${Buffer.from(`${env.OPENCLAW_BASIC_USER}:${env.OPENCLAW_BASIC_PASS}`).toString("base64")}`
        : undefined;

    const headers: Record<string, string> = {};
    if (authHeader) {
      headers.Authorization = authHeader;
    }
    if (env.OPENCLAW_CLIENT_ORIGIN) {
      headers.Origin = env.OPENCLAW_CLIENT_ORIGIN;
    }

    const ws = new WebSocket(env.OPENCLAW_WS_URL, {
      headers: Object.keys(headers).length ? headers : undefined,
      rejectUnauthorized: !env.OPENCLAW_ALLOW_SELF_SIGNED
    });

    return await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error("OpenClaw health connect timeout"));
        ws.close();
      }, env.OPENCLAW_CONNECT_TIMEOUT_MS);

      ws.on("open", () => {
        const connectReq: RpcReq = {
          type: "req",
          id: "health-connect",
          method: "connect",
          params: {
            minProtocol: 3,
            maxProtocol: 3,
            client: {
              id: env.OPENCLAW_CLIENT_ID,
              version: env.OPENCLAW_CLIENT_VERSION,
              platform: env.OPENCLAW_CLIENT_PLATFORM,
              mode: env.OPENCLAW_CLIENT_MODE,
              instanceId: `${env.OPENCLAW_CLIENT_INSTANCE_ID}-health`
            },
            role: "operator",
            scopes: this.requestedScopes,
            caps: [],
            auth: {
              token: env.OPENCLAW_GATEWAY_TOKEN
            },
            userAgent: "ticket-core-health",
            locale: "en-US"
          }
        };
        ws.send(JSON.stringify(connectReq));
      });

      ws.on("message", (raw) => {
        const data = JSON.parse(String(raw)) as RpcRes | { type: "event"; event: string };
        if (data.type === "event") return;
        if (data.type === "res" && data.id === "health-connect") {
          clearTimeout(timeout);
          if (!data.ok) {
            reject(new Error(`OpenClaw health connect failed: ${data.error?.code ?? "UNKNOWN"}`));
            ws.close();
            return;
          }
          ws.close();
          resolve();
        }
      });

      ws.on("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });

      ws.on("close", () => {
        clearTimeout(timeout);
      });
    });
  }
}
