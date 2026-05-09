import { env } from "../../config/env.js";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatCompletionOptions {
  model?: string;
  messages: ChatMessage[];
  temperature?: number;
  max_tokens?: number;
  response_format?: { type: "json_object" | "json_schema"; json_schema?: unknown };
  signal?: AbortSignal;
}

export interface ChatCompletionResult {
  content: string;
  finishReason: string;
  usage?: { promptTokens: number; completionTokens: number; totalTokens: number };
}

export class OpenAIClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly defaultModel: string;

  constructor(input?: { baseUrl?: string; apiKey?: string; defaultModel?: string }) {
    this.baseUrl = (input?.baseUrl ?? env.OPENAI_API_BASE ?? "https://api.openai.com/v1").replace(/\/$/, "");
    this.apiKey = input?.apiKey ?? env.OPENAI_API_KEY ?? "";
    this.defaultModel = input?.defaultModel ?? (env.OPENAI_MULTIMODAL_MODEL || "gpt-4o-mini");
  }

  async chatCompletion(options: ChatCompletionOptions): Promise<ChatCompletionResult> {
    if (!this.apiKey) {
      throw new Error("LLM API key is not configured");
    }

    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`
      },
      body: JSON.stringify({
        model: options.model ?? this.defaultModel,
        messages: options.messages,
        temperature: options.temperature ?? 0,
        max_tokens: options.max_tokens ?? 8192,
        ...(options.response_format ? { response_format: options.response_format } : {})
      }),
      ...(options.signal ? { signal: options.signal } : {})
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`LLM HTTP ${response.status}: ${text.slice(0, 200)}`);
    }

    const data = (await response.json()) as {
      choices?: Array<{
        message?: { content?: string };
        finish_reason?: string;
      }>;
      usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
    };

    const choice = data.choices?.[0];
    return {
      content: choice?.message?.content ?? "",
      finishReason: choice?.finish_reason ?? "unknown",
      usage: data.usage
        ? {
            promptTokens: data.usage.prompt_tokens,
            completionTokens: data.usage.completion_tokens,
            totalTokens: data.usage.total_tokens
          }
        : undefined
    };
  }
}
