import { env } from "../../config/env.js";
import { OpenAIClient } from "../ai/openai-client.js";
import type {
  OpenClawAdapter,
  OpenClawAnalyzeInput,
  OpenClawAnalyzeOutput,
  OpenClawClassifyIntentInput,
  OpenClawClassifyIntentOutput,
  OpenClawHealthCheckInput,
  OpenClawHealthCheckResult,
  OpenClawRuntimeContext,
  OpenClawSearchAnswerInput,
  OpenClawSearchAnswerOutput,
  OpenClawSearchInput,
  OpenClawSearchOutput
} from "../openclaw/types.js";
import { WsOpenClawAdapter } from "../openclaw/ws-adapter.js";

const VALID_INTENTS = new Set<OpenClawClassifyIntentOutput["intent"]>([
  "api_operation",
  "feature_usage",
  "troubleshooting",
  "concept_explanation",
  "configuration",
  "general"
]);

const VALID_ROUTES = new Set<OpenClawClassifyIntentOutput["route"]>([
  "openapi_doc",
  "infra_runbook",
  "integration_diagnosis",
  "product_diagnosis",
  "kb_guidance",
  "clarification"
]);

export class HermesNativeAdapter extends WsOpenClawAdapter implements OpenClawAdapter {
  private readonly hermesClient = new OpenAIClient({
    baseUrl: env.HERMES_LLM_API_BASE,
    apiKey: env.HERMES_LLM_API_KEY,
    defaultModel: env.HERMES_LLM_MODEL
  });

  async healthCheck(input?: OpenClawHealthCheckInput): Promise<OpenClawHealthCheckResult> {
    const configuredAgents = Array.from(new Set((input?.agentIds ?? []).map((item) => String(item).trim()).filter(Boolean)));
    try {
      await this.hermesClient.chatCompletion({
        temperature: 0,
        messages: [
          { role: "system", content: "Return valid JSON only." },
          { role: "user", content: "{\"ok\":true}" }
        ]
      });
      return {
        ok: true,
        mode: "native",
        detail: "Hermes native runtime is available",
        configuredAgents,
        reachableAgents: configuredAgents,
        unreachableAgents: []
      };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      return {
        ok: false,
        mode: "native",
        detail,
        configuredAgents,
        reachableAgents: [],
        unreachableAgents: configuredAgents.map((agentId) => ({ agentId, detail }))
      };
    }
  }

  async analyzeTicket(
    input: OpenClawAnalyzeInput,
    idempotencyKey: string,
    runtime?: OpenClawRuntimeContext
  ): Promise<OpenClawAnalyzeOutput> {
    return this.runWithRetry(async () => {
      const parsed = (await this.runNativePrompt(
        [
          "You are first-line ticket triage.",
          "Return ONLY valid JSON with keys: action, confidence, reply, reasoning_summary, evidence, risk_flags.",
          `ticket_id: ${input.ticket_id}`,
          `title: ${input.title}`,
          `description: ${input.description}`,
          `priority: ${input.priority}`,
          `customer_meta: ${JSON.stringify(input.customer_meta)}`,
          `history: ${JSON.stringify(input.history)}`
        ].join("\n"),
        runtime
      )) as Partial<OpenClawAnalyzeOutput>;

      return {
        action: this.normalizeActionValue(parsed.action),
        confidence: this.normalizeConfidenceValue(parsed.confidence),
        reply: typeof parsed.reply === "string" ? parsed.reply : "",
        reasoning_summary: typeof parsed.reasoning_summary === "string" ? parsed.reasoning_summary : "Hermes native response",
        evidence: Array.isArray(parsed.evidence) ? parsed.evidence.map((item) => String(item)) : [],
        risk_flags: Array.isArray(parsed.risk_flags) ? parsed.risk_flags.map((item) => String(item)) : []
      };
    });
  }

  async searchKnowledge(
    input: OpenClawSearchInput,
    idempotencyKey: string,
    runtime?: OpenClawRuntimeContext
  ): Promise<OpenClawSearchOutput> {
    return this.runWithRetry(async () => {
      const parsed = (await this.runNativePrompt(
        [
          "You are a knowledge retrieval assistant.",
          "Return ONLY valid JSON with keys: confidence, hits([{id,title,snippet,score,sourceUrl}]).",
          `query: ${input.query}`,
          `topK: ${input.topK}`,
          `index: ${input.index}`
        ].join("\n"),
        runtime
      )) as Record<string, unknown>;

      const rawHits = Array.isArray(parsed.hits) ? parsed.hits : [];
      return {
        confidence: this.normalizeConfidenceValue(parsed.confidence),
        hits: rawHits.map((item, index) => {
          const row = (item ?? {}) as Record<string, unknown>;
          return {
            id: typeof row.id === "string" && row.id ? row.id : `hermes-hit-${index + 1}`,
            title: typeof row.title === "string" ? row.title : "Knowledge result",
            snippet: typeof row.snippet === "string" ? row.snippet : "",
            score: this.normalizeConfidenceValue(row.score),
            sourceUrl: typeof row.sourceUrl === "string" ? row.sourceUrl : ""
          };
        })
      };
    });
  }

  async answerSearchQuery(
    input: OpenClawSearchAnswerInput,
    idempotencyKey: string,
    runtime?: OpenClawRuntimeContext
  ): Promise<OpenClawSearchAnswerOutput> {
    return this.runWithRetry(async () => {
      const parsed = (await this.runNativePrompt(
        [
          "You are an expert technical support assistant for ONES.",
          "Return ONLY valid JSON with keys: answer, style, summary, assessment, steps, validation, required_inputs, suggested_next_step.",
          `language: ${input.language}`,
          `route_hint: ${input.routeHint ?? "none"}`,
          `grounded: ${input.grounded ? "true" : "false"}`,
          `user_query: ${input.query}`,
          `references: ${JSON.stringify(input.references)}`,
          ...(input.draftAnswer ? [`draft_answer: ${JSON.stringify(input.draftAnswer)}`] : [])
        ].join("\n"),
        runtime
      )) as Partial<OpenClawSearchAnswerOutput>;
      return {
        answer: typeof parsed.answer === "string" ? parsed.answer : "",
        style: parsed.style,
        summary: typeof parsed.summary === "string" ? parsed.summary : "",
        assessment: typeof parsed.assessment === "string" ? parsed.assessment : undefined,
        steps: Array.isArray(parsed.steps) ? parsed.steps.map((item) => String(item)) : [],
        validation: Array.isArray(parsed.validation) ? parsed.validation.map((item) => String(item)) : [],
        required_inputs: Array.isArray(parsed.required_inputs) ? parsed.required_inputs.map((item) => String(item)) : undefined,
        suggested_next_step: parsed.suggested_next_step
      };
    });
  }

  async classifyIntent(
    input: OpenClawClassifyIntentInput,
    idempotencyKey: string,
    runtime?: OpenClawRuntimeContext
  ): Promise<OpenClawClassifyIntentOutput> {
    const parsed = (await this.runNativePrompt(
      [
        "You are an intent classifier for a technical support system.",
        "Return ONLY valid JSON: {intent, route, confidence, reasoning}.",
        "intent must be one of: api_operation, feature_usage, troubleshooting, concept_explanation, configuration, general.",
        "route must be one of: openapi_doc, infra_runbook, integration_diagnosis, product_diagnosis, kb_guidance, clarification.",
        `language: ${input.language}`,
        `user_query: ${input.query}`,
        ...(input.conversationContext?.length ? [`conversation_context: ${JSON.stringify(input.conversationContext.slice(-4))}`] : [])
      ].join("\n"),
      runtime
    )) as Partial<OpenClawClassifyIntentOutput>;

    if (!VALID_INTENTS.has(parsed.intent as OpenClawClassifyIntentOutput["intent"])) {
      throw new Error("Hermes native classifyIntent contract violation: intent");
    }
    if (!VALID_ROUTES.has(parsed.route as OpenClawClassifyIntentOutput["route"])) {
      throw new Error("Hermes native classifyIntent contract violation: route");
    }

    return {
      intent: parsed.intent as OpenClawClassifyIntentOutput["intent"],
      route: parsed.route as OpenClawClassifyIntentOutput["route"],
      confidence: this.normalizeConfidenceValue(parsed.confidence),
      reasoning: typeof parsed.reasoning === "string" ? parsed.reasoning : ""
    };
  }

  protected override async runJsonPrompt(
    message: string,
    _idempotencyKey: string,
    runtime?: OpenClawRuntimeContext
  ): Promise<unknown> {
    const controller = new AbortController();
    const timeoutId = runtime?.timeoutMs ? setTimeout(() => controller.abort(), runtime.timeoutMs) : null;
    try {
      const result = await this.hermesClient.chatCompletion({
        temperature: 0,
        max_tokens: 8192,
        messages: [
          { role: "system", content: "You are a helpful assistant. Always respond with valid JSON only." },
          { role: "user", content: message }
        ],
        signal: controller.signal
      });
      return this.parseJsonObject(result.content);
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
    }
  }

  private async runNativePrompt(message: string, runtime?: OpenClawRuntimeContext): Promise<Record<string, unknown>> {
    return (await this.runJsonPrompt(message, "hermes-native", runtime)) as Record<string, unknown>;
  }

  private async runWithRetry<T>(fn: () => Promise<T>): Promise<T> {
    let lastError: unknown = null;
    const attempts = Math.max(1, env.OPENCLAW_MAX_RETRIES);
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        return await fn();
      } catch (error) {
        lastError = error;
        if (attempt === attempts) break;
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError ?? "Hermes native call failed"));
  }

  private normalizeActionValue(value: unknown): OpenClawAnalyzeOutput["action"] {
    return value === "resolve" || value === "ask_user" || value === "escalate" || value === "none" ? value : "none";
  }

  private normalizeConfidenceValue(value: unknown): number {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return 0;
    return Math.max(0, Math.min(1, numeric));
  }

  private parseJsonObject(text: string): Record<string, unknown> {
    const trimmed = text.trim();
    if (!trimmed) {
      throw new Error("Hermes native returned empty JSON payload");
    }
    const fenced = trimmed.replace(/^```(?:json)?\s*/, "").replace(/\s*```$/, "");
    return JSON.parse(fenced) as Record<string, unknown>;
  }
}
