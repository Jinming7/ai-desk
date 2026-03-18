import crypto from "node:crypto";
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
  OpenClawSupportPlannerInput,
  OpenClawSupportVerifierInput,
  OpenClawSupportWriterInput,
  OpenClawSearchAnswerInput,
  OpenClawSearchAnswerOutput,
  OpenClawSearchInput,
  OpenClawSearchOutput
} from "./types.js";
import type {
  DraftSupportAnswer,
  SupportCaseFrame,
  SupportEvidenceBundle,
  SupportVerificationResult,
  TriageSupportInsight
} from "../../modules/ai/types.js";

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

type SessionLifecycleStage =
  | "search-answer"
  | "planner"
  | "support-writer"
  | "support-verifier"
  | "triage-writer"
  | "triage-verifier"
  | "classify"
  | "ticket-analyze"
  | "kb-search"
  | "json-prompt";

type ManagedRunSession = {
  sessionKey: string;
  baseSessionKey: string;
  stage: SessionLifecycleStage;
  createdAt: number;
  lastUsedAt: number;
  endedAt: number | null;
};

const managedRunSessions = new Map<string, ManagedRunSession>();

function sanitizeSessionPart(input: string): string {
  return input.replace(/[^a-zA-Z0-9:_-]/g, "_").slice(0, 180);
}

function compactSupportMetadata(metadata: unknown): Record<string, unknown> | undefined {
  const value = (metadata ?? {}) as Record<string, unknown>;
  const permissions = Array.isArray(value.permissions) ? value.permissions.map((item) => String(item)).slice(0, 4) : [];
  const prerequisites = Array.isArray(value.prerequisites) ? value.prerequisites.map((item) => String(item)).slice(0, 3) : [];
  const limitations = Array.isArray(value.limitations) ? value.limitations.map((item) => String(item)).slice(0, 3) : [];
  const compact = {
    evidence_kind: typeof value.evidence_kind === "string" ? value.evidence_kind : undefined,
    product_area: typeof value.product_area === "string" ? value.product_area : undefined,
    deployment_model: typeof value.deployment_model === "string" ? value.deployment_model : undefined,
    permissions,
    prerequisites,
    limitations
  };
  return Object.values(compact).some((item) => (Array.isArray(item) ? item.length > 0 : Boolean(item))) ? compact : undefined;
}

function compactEvidenceBundle(
  bundle: SupportEvidenceBundle,
  options?: { primaryLimit?: number; supplementalLimit?: number; snippetMax?: number }
) {
  const primaryLimit = options?.primaryLimit ?? 3;
  const supplementalLimit = options?.supplementalLimit ?? 2;
  const snippetMax = options?.snippetMax ?? 220;
  const trimReference = (reference: SupportEvidenceBundle["primary"][number]) => ({
    documentId: reference.documentId,
    title: reference.title,
    headingPath: reference.headingPath,
    sourceUrl: reference.sourceUrl,
    path: reference.path,
    snippet: reference.snippet.slice(0, snippetMax),
    score: reference.score,
    supportMetadata: compactSupportMetadata(reference.supportMetadata)
  });

  return {
    primary: bundle.primary.slice(0, primaryLimit).map(trimReference),
    supplemental: bundle.supplemental.slice(0, supplementalLimit).map(trimReference),
    evidence_gaps: bundle.evidence_gaps.slice(0, 3),
    confidence: bundle.confidence,
    fallbackUsed: bundle.fallbackUsed,
    resolvedQueries: bundle.resolvedQueries.slice(0, 4)
  };
}

function compactDraftSupportAnswerForVerification(answer?: DraftSupportAnswer) {
  if (!answer) return undefined;
  return {
    direct_answer: answer.direct_answer,
    claims: answer.claims.slice(0, 6),
    next_actions: answer.next_actions.slice(0, 4),
    unknowns: answer.unknowns.slice(0, 3),
    escalation_needed: answer.escalation_needed
  };
}

function compactTriageInsightForVerification(insight?: TriageSupportInsight) {
  if (!insight) return undefined;
  return {
    direct_answer: insight.direct_answer,
    recommended_action: insight.recommended_action,
    customer_reply: insight.customer_reply,
    customer_reply_policy: insight.customer_reply_policy,
    support_summary: insight.support_summary,
    verified_evidence: insight.verified_evidence.slice(0, 4),
    risk_flags: insight.risk_flags.slice(0, 4),
    missing_info: insight.missing_info.slice(0, 3),
    verifier_verdict: insight.verifier_verdict
  };
}

function roundMs(value: number): number {
  return Math.max(0, Math.round(value));
}

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

      const refLines: string[] = [];
      if (input.references.length > 0) {
        refLines.push("=== References (from KB search) ===");
        for (const ref of input.references) {
          refLines.push(`- [${ref.title}](${ref.sourceUrl})`);
          if (ref.snippet) refLines.push(`  ${ref.snippet.slice(0, 300)}`);
        }
        refLines.push("=== End References ===");
      }

      const prompt = [
        "You are an expert technical support assistant for ONES, a project management and collaboration platform.",
        "",
        "## Primary Goal",
        "Answer the user's question as specifically and helpfully as possible.",
        "",
        "## Answer Strategy (in priority order)",
        "1. If references contain relevant information, cite them and give a concrete answer with specific details.",
        "2. If references are insufficient but you know the answer from your own knowledge, give it directly.",
        "3. If you partially know the answer, give what you know and clearly state what you are unsure about.",
        "4. ONLY output style=clarification as an absolute LAST RESORT when you truly cannot help at all.",
        "",
        "## Critical Rules",
        "- NEVER output generic templates like '请明确你问的是哪个对象' or '以下是常见的API对象' — the user already told you what they want.",
        "- For API questions: ALWAYS provide specific Method + Path, key parameters, and documentation URL if known.",
        "- For configuration questions: ALWAYS provide specific steps with settings paths.",
        "- For troubleshooting: ALWAYS provide diagnostic commands and expected outputs.",
        "- If a draft_answer is provided with style=clarification, IGNORE it completely and answer from scratch using your own knowledge.",
        "- If a draft_answer is provided with style=kb_answer or diagnosis and contains useful content, you may enhance it.",
        "- Answer in the same language as the user's query.",
        "- Prefer style=kb_answer for most answers. Use style=diagnosis only for troubleshooting with escalation potential.",
        "",
        "## Output Format",
        "Return ONLY valid JSON with keys:",
        "answer (string: detailed answer text), style (kb_answer|diagnosis|clarification), summary (string: one-line summary), assessment (string: optional), steps (string[]: actionable steps), validation (string[]: how to verify), required_inputs (string[]: only if clarification), suggested_next_step (self_serve|submit_ticket)",
        "",
        ...(historyLines.length ? [...historyLines, ""] : []),
        ...(refLines.length ? [...refLines, ""] : []),
        `language: ${input.language}`,
        `route_hint: ${input.routeHint ?? "none"}`,
        `grounded: ${input.grounded ? "true" : "false"}`,
        `user_query: ${input.query}`,
        ...(input.draftAnswer && input.draftAnswer.style !== "clarification" ? [`draft_answer: ${JSON.stringify(input.draftAnswer)}`] : [])
      ].join("\n");

      const sessionKey = this.createRunScopedSessionKey(runtime, idempotencyKey, "search-answer");
      const runId = await this.startChatRun(prompt, idempotencyKey, runtime, input.attachments, sessionKey);
      await this.waitAgentRun(runId, sessionKey);
      const text = await this.fetchLatestAssistantText(sessionKey);
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

  async planSupportCase(
    input: OpenClawSupportPlannerInput,
    idempotencyKey: string,
    runtime?: OpenClawRuntimeContext
  ): Promise<SupportCaseFrame> {
    const prompt = [
      "You are a support case planner for ONES.",
      "Return ONLY valid JSON with keys:",
      "goal, symptom, object, action_type, deployment_model, product_area, constraints(string[]), missing_critical_info(string[]), retrieval_queries(string[]), query_plan({concept_queries:string[], object_queries:string[], behavior_queries:string[]})",
      "Rules:",
      "- Summarize the user goal and symptom crisply.",
      "- Propose 2 to 4 retrieval queries optimized for a documentation knowledge base.",
      "- Only put genuinely blocking items into missing_critical_info.",
      "- Keep deployment_model to one of: public_cloud, private_deployment, shared, unknown.",
      "- Keep product_area concise.",
      `context_type: ${input.contextType}`,
      `language: ${input.language}`,
      `user_query: ${input.query}`,
      ...(input.conversationHistory?.length
        ? ["conversation_history:", ...input.conversationHistory.slice(-6).map((item) => `- [${item.role}] ${item.content}`)]
        : []),
      ...(input.ticketContext
        ? [
            `ticket_priority: ${input.ticketContext.priority}`,
            `customer_meta: ${JSON.stringify(input.ticketContext.customerMeta)}`,
            `ticket_history: ${JSON.stringify(input.ticketContext.history.slice(-6))}`
          ]
        : [])
    ].join("\n");

    const parsed = (await this.runJsonPrompt(prompt, `${idempotencyKey}:planner`, runtime, undefined, "planner")) as Partial<SupportCaseFrame>;
    const queryPlan = (parsed.query_plan as unknown as Record<string, unknown> | undefined) ?? undefined;
    return {
      goal: typeof parsed.goal === "string" ? parsed.goal : input.query,
      symptom: typeof parsed.symptom === "string" ? parsed.symptom : input.query,
      object: typeof parsed.object === "string" ? parsed.object : "unspecified",
      action_type: typeof parsed.action_type === "string" ? parsed.action_type : "troubleshooting",
      deployment_model: typeof parsed.deployment_model === "string" ? parsed.deployment_model : "unknown",
      product_area: typeof parsed.product_area === "string" ? parsed.product_area : "general",
      constraints: Array.isArray(parsed.constraints) ? parsed.constraints.map((item) => String(item)) : [],
      missing_critical_info: Array.isArray(parsed.missing_critical_info) ? parsed.missing_critical_info.map((item) => String(item)) : [],
      retrieval_queries: Array.isArray(parsed.retrieval_queries) ? parsed.retrieval_queries.map((item) => String(item)).filter(Boolean) : [input.query],
      query_plan:
        queryPlan && typeof queryPlan === "object"
          ? {
              concept_queries: Array.isArray(queryPlan.concept_queries)
                ? (queryPlan.concept_queries as unknown[]).map((item) => String(item)).filter(Boolean)
                : [],
              object_queries: Array.isArray(queryPlan.object_queries)
                ? (queryPlan.object_queries as unknown[]).map((item) => String(item)).filter(Boolean)
                : [],
              behavior_queries: Array.isArray(queryPlan.behavior_queries)
                ? (queryPlan.behavior_queries as unknown[]).map((item) => String(item)).filter(Boolean)
                : []
            }
          : undefined
    };
  }

  async writeSupportAnswer(
    input: OpenClawSupportWriterInput,
    idempotencyKey: string,
    runtime?: OpenClawRuntimeContext
  ): Promise<DraftSupportAnswer> {
    const compactBundle = compactEvidenceBundle(input.evidenceBundle, {
      primaryLimit: 2,
      supplementalLimit: 1,
      snippetMax: 180
    });
    const prompt = [
      "You are a support engineer agent for ONES.",
      "Return ONLY valid JSON:",
      "direct_answer, claims([{text, kind(verified_fact|grounded_inference|operational_advice|unknown), evidence_ids(string[]), authority(canonical|assistive)}]), next_actions(string[]), unknowns(string[]), escalation_needed(boolean)",
      "Rules:",
      "- Answer the user first. Do not output framework words like verification or evidence gap.",
      "- Claims about APIs, parameters, scopes, permissions, limits, deployment, and versions must be grounded in evidence.",
      "- Use grounded_inference only when multiple canonical snippets strongly imply the conclusion.",
      "- Use operational_advice for safe next-step guidance.",
      "- unknown is for unresolved items that still need confirmation.",
      "- Never say 'refer to the doc' or 'follow the documentation'. State the relevant content directly.",
      `context_type: ${input.contextType}`,
      `language: ${input.language}`,
      `user_query: ${input.query}`,
      `case_frame: ${JSON.stringify(input.caseFrame)}`,
      `evidence_bundle: ${JSON.stringify(compactBundle)}`,
      ...(input.conversationHistory?.length
        ? ["conversation_history:", ...input.conversationHistory.slice(-6).map((item) => `- [${item.role}] ${item.content}`)]
        : [])
    ].join("\n");

    const parsed = (await this.runJsonPrompt(
      prompt,
      `${idempotencyKey}:support-writer`,
      runtime,
      undefined,
      "support-writer"
    )) as Partial<DraftSupportAnswer>;
    return {
      direct_answer: typeof parsed.direct_answer === "string" ? parsed.direct_answer : "",
      claims: Array.isArray(parsed.claims)
        ? parsed.claims
            .map((item) => item as unknown as Record<string, unknown>)
            .map((item): DraftSupportAnswer["claims"][number] => ({
              text: typeof item.text === "string" ? item.text : "",
              kind:
                item.kind === "grounded_inference"
                  ? "grounded_inference"
                  : item.kind === "operational_advice"
                  ? "operational_advice"
                  : item.kind === "unknown"
                  ? "unknown"
                  : "verified_fact",
              evidence_ids: Array.isArray(item.evidence_ids) ? item.evidence_ids.map((value) => String(value)).filter(Boolean) : [],
              authority: item.authority === "assistive" ? "assistive" : "canonical"
            }))
            .filter((item) => item.text)
        : [],
      next_actions: Array.isArray(parsed.next_actions) ? parsed.next_actions.map((item) => String(item)).filter(Boolean) : [],
      unknowns: Array.isArray(parsed.unknowns) ? parsed.unknowns.map((item) => String(item)).filter(Boolean) : [],
      escalation_needed: Boolean(parsed.escalation_needed)
    };
  }

  async verifySupportAnswer(
    input: OpenClawSupportVerifierInput,
    idempotencyKey: string,
    runtime?: OpenClawRuntimeContext
  ): Promise<SupportVerificationResult> {
    const compactBundle = compactEvidenceBundle(input.evidenceBundle, {
      primaryLimit: 2,
      supplementalLimit: 1,
      snippetMax: 140
    });
    const prompt = [
      "Verify whether the support answer is supported by the evidence.",
      "Return ONLY valid JSON:",
      "verdict(verified|partial|unsupported), summary, unsupported_claims(string[]), missing_info(string[]), verified_citation_ids(string[]), verified_claims(string[]), claim_to_citation_map([{text, kind, verdict(verified|supported_inference|unsupported), citation_ids(string[])}])",
      "Rules:",
      "- Capabilities, APIs, parameters, scopes, permissions, limits, version/deployment conclusions must be evidence-backed.",
      "- verified: every factual claim is supported.",
      "- partial: some guidance is supported but some factual claims go beyond evidence.",
      "- unsupported: the core conclusion is not evidence-backed.",
      `language: ${input.language}`,
      `user_query: ${input.query}`,
      `case_frame: ${JSON.stringify(input.caseFrame)}`,
      `evidence_bundle: ${JSON.stringify(compactBundle)}`,
      `draft_support_answer: ${JSON.stringify(compactDraftSupportAnswerForVerification(input.draftSupportAnswer))}`
    ].join("\n");

    return this.parseVerificationResult(
      await this.runJsonPrompt(prompt, `${idempotencyKey}:support-verifier`, runtime, undefined, "support-verifier")
    );
  }

  async writeTriageInsight(
    input: OpenClawSupportWriterInput,
    idempotencyKey: string,
    runtime?: OpenClawRuntimeContext
  ): Promise<TriageSupportInsight> {
    const compactBundle = compactEvidenceBundle(input.evidenceBundle, {
      primaryLimit: 2,
      supplementalLimit: 1,
      snippetMax: 160
    });
    const prompt = [
      "You are first-line ticket triage for ONES.",
      "Return ONLY valid JSON with keys:",
      "direct_answer, recommended_action(resolve|ask_user|escalate), customer_reply, customer_reply_policy(send_now|no_send), support_summary, verified_evidence(string[]), risk_flags(string[]), missing_info(string[]), verifier_verdict(verified|partial|unsupported)",
      "Rules:",
      "- Choose resolve only when the evidence clearly supports a self-serve resolution.",
      "- Choose escalate for product defects, engineering investigation, platform incidents, or evidence indicating R&D ownership.",
      "- Choose ask_user for all other cases, and ask only one high-value missing detail.",
      "- customer_reply must be customer-facing and in English.",
      `language: ${input.language}`,
      `ticket_query: ${input.query}`,
      `case_frame: ${JSON.stringify(input.caseFrame)}`,
      `evidence_bundle: ${JSON.stringify(compactBundle)}`,
      ...(input.ticketContext
        ? [
            `ticket_priority: ${input.ticketContext.priority}`,
            `customer_meta: ${JSON.stringify(input.ticketContext.customerMeta)}`,
            `ticket_history: ${JSON.stringify(input.ticketContext.history.slice(-6))}`
          ]
        : [])
    ].join("\n");

    const parsed = (await this.runJsonPrompt(
      prompt,
      `${idempotencyKey}:triage-writer`,
      runtime,
      undefined,
      "triage-writer"
    )) as Partial<TriageSupportInsight>;
    return {
      direct_answer: typeof parsed.direct_answer === "string" ? parsed.direct_answer : "",
      recommended_action:
        parsed.recommended_action === "resolve" || parsed.recommended_action === "escalate" ? parsed.recommended_action : "ask_user",
      customer_reply: typeof parsed.customer_reply === "string" ? parsed.customer_reply : "",
      customer_reply_policy: parsed.customer_reply_policy === "no_send" ? "no_send" : "send_now",
      support_summary: typeof parsed.support_summary === "string" ? parsed.support_summary : "",
      verified_evidence: Array.isArray(parsed.verified_evidence) ? parsed.verified_evidence.map((item) => String(item)) : [],
      risk_flags: Array.isArray(parsed.risk_flags) ? parsed.risk_flags.map((item) => String(item)) : [],
      missing_info: Array.isArray(parsed.missing_info) ? parsed.missing_info.map((item) => String(item)) : [],
      verifier_verdict:
        parsed.verifier_verdict === "verified" || parsed.verifier_verdict === "partial" ? parsed.verifier_verdict : "unsupported"
    };
  }

  async verifyTriageInsight(
    input: OpenClawSupportVerifierInput,
    idempotencyKey: string,
    runtime?: OpenClawRuntimeContext
  ): Promise<SupportVerificationResult> {
    const compactBundle = compactEvidenceBundle(input.evidenceBundle, {
      primaryLimit: 2,
      supplementalLimit: 1,
      snippetMax: 140
    });
    const prompt = [
      "You verify whether a triage recommendation is supported by the provided evidence.",
      "Return ONLY valid JSON with keys:",
      "verdict(verified|partial|unsupported), summary, unsupported_claims(string[]), missing_info(string[]), verified_citation_ids(string[])",
      "Rules:",
      "- resolve requires verified evidence for a self-serve outcome.",
      "- escalate may be partial when there is strong incident/product-defect evidence even without a direct resolution article.",
      "- ask_user is supported when evidence is missing and the missing detail is explicit.",
      `language: ${input.language}`,
      `user_query: ${input.query}`,
      `case_frame: ${JSON.stringify(input.caseFrame)}`,
      `evidence_bundle: ${JSON.stringify(compactBundle)}`,
      `triage_insight: ${JSON.stringify(compactTriageInsightForVerification(input.triageInsight))}`
    ].join("\n");

    return this.parseVerificationResult(
      await this.runJsonPrompt(prompt, `${idempotencyKey}:triage-verifier`, runtime, undefined, "triage-verifier")
    );
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

    const sessionKey = this.createRunScopedSessionKey(runtime, idempotencyKey, "classify");
    const runId = await this.startChatRun(prompt, idempotencyKey, runtime, undefined, sessionKey);
    await this.waitAgentRun(runId, sessionKey);
    const text = await this.fetchLatestAssistantText(sessionKey);
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

    const sessionKey = this.createRunScopedSessionKey(runtime, idempotencyKey, "ticket-analyze");
    const runId = await this.startChatRun(prompt, idempotencyKey, runtime, input.attachments, sessionKey);
    await this.waitAgentRun(runId, sessionKey);
    const text = await this.fetchLatestAssistantText(sessionKey);
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

    const sessionKey = this.createRunScopedSessionKey(runtime, idempotencyKey, "kb-search");
    const runId = await this.startChatRun(prompt, idempotencyKey, runtime, input.attachments, sessionKey);
    await this.waitAgentRun(runId, sessionKey);
    const text = await this.fetchLatestAssistantText(sessionKey);
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

  private resolveAgentRuntime(runtime?: OpenClawRuntimeContext): { agentId: string; sessionKey: string; model?: string } {
    return {
      agentId: runtime?.agentId?.trim() || env.OPENCLAW_AGENT_ID || "main",
      sessionKey: runtime?.sessionKey?.trim() || env.OPENCLAW_AGENT_SESSION_KEY || `agent:main:${Date.now()}`,
      model: runtime?.model?.trim() || undefined
    };
  }

  private async startAgentRun(
    message: string,
    idempotencyKey: string,
    runtime?: OpenClawRuntimeContext,
    sessionKey?: string
  ): Promise<string> {
    const agentRuntime = this.resolveAgentRuntime(runtime);
    const payload = (await this.callMethod("agent", {
      agentId: agentRuntime.agentId,
      sessionKey: sessionKey ?? agentRuntime.sessionKey,
      message,
      timeout: env.OPENCLAW_AGENT_TIMEOUT_MS,
      idempotencyKey,
      ...(agentRuntime.model ? { model: agentRuntime.model } : {})
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
    attachmentUrls?: string[],
    sessionKey?: string
  ): Promise<string> {
    const agentRuntime = this.resolveAgentRuntime(runtime);
    const attachments = await this.buildChatAttachments(attachmentUrls);
    const payload = (await this.callMethod("chat.send", {
      sessionKey: sessionKey ?? agentRuntime.sessionKey,
      message,
      deliver: false,
      idempotencyKey,
      ...(agentRuntime.model ? { model: agentRuntime.model } : {}),
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

  private async runJsonPrompt(
    message: string,
    idempotencyKey: string,
    runtime?: OpenClawRuntimeContext,
    attachmentUrls?: string[],
    stage: SessionLifecycleStage = "json-prompt"
  ) {
    const startedAt = performance.now();
    const sessionKey = this.createRunScopedSessionKey(runtime, idempotencyKey, stage);
    const sendStartedAt = performance.now();
    const runId = await this.startChatRun(message, idempotencyKey, runtime, attachmentUrls, sessionKey);
    const sendMs = roundMs(performance.now() - sendStartedAt);
    const waitStartedAt = performance.now();
    await this.waitAgentRun(runId, sessionKey);
    const waitMs = roundMs(performance.now() - waitStartedAt);
    const historyStartedAt = performance.now();
    const text = await this.fetchLatestAssistantText(sessionKey);
    const historyMs = roundMs(performance.now() - historyStartedAt);
    const parseStartedAt = performance.now();
    const parsed = this.parseFirstJson(text);
    const parseMs = roundMs(performance.now() - parseStartedAt);
    if (env.OPENCLAW_DEBUG_STAGE_TIMINGS) {
      console.info(
        `[openclaw-stage] stage=${stage} prompt_chars=${message.length} response_chars=${text.length} send_ms=${sendMs} wait_ms=${waitMs} history_ms=${historyMs} parse_ms=${parseMs} total_ms=${roundMs(performance.now() - startedAt)}`
      );
    }
    return parsed;
  }

  private async waitAgentRun(runId: string, sessionKey?: string): Promise<void> {
    try {
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
    } finally {
      if (sessionKey) {
        this.touchManagedSession(sessionKey);
      }
    }
  }

  private async fetchLatestAssistantText(sessionKey: string): Promise<string> {
    try {
      const history = (await this.callMethod("chat.history", {
        sessionKey,
        limit: 4
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
    } finally {
      this.markManagedSessionEnded(sessionKey);
    }
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

  private parseVerificationResult(input: unknown): SupportVerificationResult {
    const parsed = (input ?? {}) as Partial<SupportVerificationResult>;
    return {
      verdict: parsed.verdict === "verified" || parsed.verdict === "partial" ? parsed.verdict : "unsupported",
      summary: typeof parsed.summary === "string" ? parsed.summary : "",
      unsupported_claims: Array.isArray(parsed.unsupported_claims) ? parsed.unsupported_claims.map((item) => String(item)) : [],
      missing_info: Array.isArray(parsed.missing_info) ? parsed.missing_info.map((item) => String(item)) : [],
      verified_citation_ids: Array.isArray(parsed.verified_citation_ids) ? parsed.verified_citation_ids.map((item) => String(item)) : [],
      verified_claims: Array.isArray(parsed.verified_claims) ? parsed.verified_claims.map((item) => String(item)) : [],
      claim_to_citation_map: Array.isArray(parsed.claim_to_citation_map)
        ? parsed.claim_to_citation_map
            .map((item) => item as unknown as Record<string, unknown>)
            .map((item): SupportVerificationResult["claim_to_citation_map"][number] => ({
              text: typeof item.text === "string" ? item.text : "",
              kind:
                item.kind === "grounded_inference"
                  ? "grounded_inference"
                  : item.kind === "operational_advice"
                  ? "operational_advice"
                  : item.kind === "unknown"
                  ? "unknown"
                  : "verified_fact",
              verdict:
                item.verdict === "verified" ? "verified" : item.verdict === "supported_inference" ? "supported_inference" : "unsupported",
              citation_ids: Array.isArray(item.citation_ids) ? item.citation_ids.map((value) => String(value)) : []
            }))
            .filter((item) => item.text)
        : []
    };
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

  private createRunScopedSessionKey(
    runtime: OpenClawRuntimeContext | undefined,
    idempotencyKey: string,
    stage: SessionLifecycleStage
  ): string {
    const baseSessionKey = this.resolveAgentRuntime(runtime).sessionKey;
    const digest = crypto.createHash("sha1").update(`${stage}:${idempotencyKey}:${Date.now()}:${Math.random()}`).digest("hex").slice(0, 12);
    const sessionKey = sanitizeSessionPart(`${baseSessionKey}:run:${stage}:${digest}`);
    this.cleanupManagedSessions();
    managedRunSessions.set(sessionKey, {
      sessionKey,
      baseSessionKey,
      stage,
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      endedAt: null
    });
    return sessionKey;
  }

  private touchManagedSession(sessionKey: string): void {
    const existing = managedRunSessions.get(sessionKey);
    if (!existing) return;
    existing.lastUsedAt = Date.now();
  }

  private markManagedSessionEnded(sessionKey: string): void {
    const existing = managedRunSessions.get(sessionKey);
    if (!existing) return;
    existing.lastUsedAt = Date.now();
    existing.endedAt = Date.now();
    this.cleanupManagedSessions();
  }

  private cleanupManagedSessions(): void {
    const now = Date.now();
    const ttlMs = env.OPENCLAW_RUN_SESSION_TTL_SECONDS * 1000;
    for (const [sessionKey, session] of managedRunSessions.entries()) {
      const referenceTime = session.endedAt ?? session.lastUsedAt;
      if (now - referenceTime > ttlMs) {
        managedRunSessions.delete(sessionKey);
      }
    }

    if (managedRunSessions.size <= env.OPENCLAW_RUN_SESSION_REGISTRY_MAX) return;

    const oldestFirst = [...managedRunSessions.values()].sort((a, b) => {
      const aTime = a.endedAt ?? a.lastUsedAt;
      const bTime = b.endedAt ?? b.lastUsedAt;
      return aTime - bTime;
    });
    const overflow = managedRunSessions.size - env.OPENCLAW_RUN_SESSION_REGISTRY_MAX;
    for (const session of oldestFirst.slice(0, overflow)) {
      managedRunSessions.delete(session.sessionKey);
    }
  }
}
