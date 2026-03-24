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
  OpenClawSupportEvidencePlannerInput,
  OpenClawSupportEvidenceSelectorInput,
  OpenClawSupportPlannerInput,
  OpenClawSupportRouterInput,
  OpenClawSupportSpecialistInput,
  OpenClawSupportVerifierInput,
  OpenClawSupportWriterInput,
  OpenClawSearchAnswerInput,
  OpenClawSearchAnswerOutput,
  OpenClawSearchInput,
  OpenClawSearchOutput
} from "./types.js";
import type {
  DraftSupportAnswer,
  SpecialistDraftAnswer,
  SupportAnswer,
  SupportCaseFrame,
  SupportEvidencePlan,
  SupportEvidenceBundle,
  SupportEvidenceSelection,
  SupportQuestionRoute,
  SupportVerificationResult,
  TriageSupportInsight
} from "../../modules/ai/types.js";
import { resolveStageSpecificAgent } from "../../modules/ai/agent-router.js";

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
  | "router"
  | "evidence-planner"
  | "planner"
  | "support-evidence-selector"
  | "api-specialist"
  | "howto-specialist"
  | "behavior-specialist"
  | "troubleshooting-specialist"
  | "evidence-judge"
  | "citation-curator"
  | "answer-composer"
  | "support-writer"
  | "support-verifier"
  | "support-citation-binder"
  | "support-citation-selector"
  | "support-answer-composer"
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
    sourceType: reference.sourceType,
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

function extractQueryFocusTerms(input: { query: string; caseFrame?: SupportCaseFrame }) {
  const candidates = [
    input.query,
    input.caseFrame?.object,
    input.caseFrame?.product_area,
    input.caseFrame?.action_type,
    ...(input.caseFrame?.query_plan?.concept_queries ?? []),
    ...(input.caseFrame?.query_plan?.object_queries ?? [])
  ]
    .map((item) => String(item ?? "").trim())
    .filter(Boolean)
    .join(" ");

  const ascii = [...candidates.matchAll(/[A-Za-z0-9:_./-]{3,}/g)].map((match) => match[0]);
  const cjk = [...candidates.matchAll(/[\u4e00-\u9fff]{2,}/g)].map((match) => match[0]);
  return [...new Set([...ascii, ...cjk])].slice(0, 12);
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

function compactSpecialistDraftAnswer(answer?: SpecialistDraftAnswer) {
  if (!answer) return undefined;
  return {
    question_type: answer.question_type,
    render_variant: answer.render_variant,
    direct_answer: answer.direct_answer,
    claims: answer.claims.slice(0, 6),
    next_actions: answer.next_actions.slice(0, 4),
    unknowns: answer.unknowns.slice(0, 3),
    api_method: answer.api_method,
    api_path: answer.api_path,
    required_params: answer.required_params?.slice(0, 6),
    auth_scope: answer.auth_scope?.slice(0, 4),
    response_field_hint: answer.response_field_hint,
    important_note: answer.important_note,
    related_variant: answer.related_variant,
    steps: answer.steps?.slice(0, 5),
    prerequisites: answer.prerequisites?.slice(0, 4),
    limits_or_notes: answer.limits_or_notes?.slice(0, 4),
    most_likely_explanation: answer.most_likely_explanation,
    confirmed_facts: answer.confirmed_facts?.slice(0, 4),
    what_to_check_next: answer.what_to_check_next?.slice(0, 4),
    most_likely_causes: answer.most_likely_causes?.slice(0, 4),
    recommended_checks: answer.recommended_checks?.slice(0, 5),
    required_followup_info: answer.required_followup_info?.slice(0, 4),
    when_to_handoff: answer.when_to_handoff,
    escalation_needed: answer.escalation_needed
  };
}

function normalizeQuestionType(value: unknown): SupportQuestionRoute["question_type"] {
  switch (value) {
    case "api_endpoint_lookup":
    case "api_field_lookup":
    case "api_scope_auth":
    case "how_to_product":
    case "why_behavior":
    case "troubleshooting":
    case "config_setup":
    case "capability_confirmation":
    case "data_export_reporting":
      return value;
    default:
      return "troubleshooting";
  }
}

function specialistFromQuestionType(questionType: SupportQuestionRoute["question_type"]): SupportQuestionRoute["specialist_agent"] {
  switch (questionType) {
    case "api_endpoint_lookup":
    case "api_field_lookup":
    case "api_scope_auth":
      return "api-specialist";
    case "how_to_product":
    case "config_setup":
    case "data_export_reporting":
      return "howto-specialist";
    case "why_behavior":
    case "capability_confirmation":
      return "behavior-specialist";
    default:
      return "troubleshooting-specialist";
  }
}

function renderVariantFromQuestionType(
  questionType: SupportQuestionRoute["question_type"]
): SpecialistDraftAnswer["render_variant"] {
  switch (questionType) {
    case "api_endpoint_lookup":
    case "api_field_lookup":
    case "api_scope_auth":
      return "api";
    case "how_to_product":
    case "config_setup":
    case "data_export_reporting":
      return "how_to";
    case "why_behavior":
    case "capability_confirmation":
      return "behavior";
    default:
      return "troubleshooting";
  }
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

function resolveRuntimeTimeoutMs(runtime?: OpenClawRuntimeContext): number {
  const configured = Number(runtime?.timeoutMs);
  if (!Number.isFinite(configured) || configured <= 0) {
    return env.OPENCLAW_AGENT_TIMEOUT_MS;
  }
  return Math.max(1000, Math.min(env.OPENCLAW_AGENT_TIMEOUT_MS, Math.round(configured)));
}

export class WsOpenClawAdapter implements OpenClawAdapter {
  private consecutiveFailures = 0;
  private readonly requestedScopes = env.OPENCLAW_REQUEST_SCOPES.split(",").map((item) => item.trim()).filter(Boolean);

  async healthCheck(input?: { agentIds?: string[] }) {
    const configuredAgents = [...new Set((input?.agentIds ?? []).map((item) => String(item).trim()).filter(Boolean))];
    try {
      await this.connectOnly();
      const registry = (await this.callMethod("agents.list", {}, Math.min(env.OPENCLAW_METHOD_TIMEOUT_MS, 10000))) as {
        agents?: Array<{ id?: string }>;
      } | null;
      const liveAgents = new Set(
        Array.isArray(registry?.agents) ? registry.agents.map((item) => String(item?.id ?? "").trim()).filter(Boolean) : []
      );
      const reachableAgents = configuredAgents.filter((agentId) => liveAgents.has(agentId));
      const unreachableAgents = configuredAgents
        .filter((agentId) => !liveAgents.has(agentId))
        .map((agentId) => ({ agentId, detail: "Agent is not present in live OpenClaw registry" }));
      return {
        ok: unreachableAgents.length === 0,
        mode: "ws" as const,
        detail:
          unreachableAgents.length === 0
            ? "Connected to OpenClaw gateway and all configured agents are reachable"
            : "Connected to OpenClaw gateway but some configured agents are unreachable",
        configuredAgents,
        reachableAgents,
        unreachableAgents
      };
    } catch (error) {
      return {
        ok: false,
        mode: "ws" as const,
        detail: (error as Error).message,
        configuredAgents,
        reachableAgents: [],
        unreachableAgents: configuredAgents.map((agentId) => ({
          agentId,
          detail: (error as Error).message
        }))
      };
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
      await this.waitAgentRun(runId, sessionKey, runtime);
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
      "- Extract the main product object or syntax subject explicitly when the query names one, for example ONESQL, JQL, OpenAPI, comment, issue, scope, or OAuth.",
      "- Prefer a specific object and product_area over generic values like unspecified or general whenever the query makes them clear.",
      "- Translate business-facing nouns into the documentation nouns when useful for retrieval, for example defect or bug may map to issue, and current status may map to issue details plus status field.",
      "- Propose 2 to 4 retrieval queries optimized for a documentation knowledge base.",
      "- Only put genuinely blocking items into missing_critical_info. If a useful best-effort answer can still be given from the current docs, do not block on extra clarification.",
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

  async routeSupportQuestion(
    input: OpenClawSupportRouterInput,
    idempotencyKey: string,
    runtime?: OpenClawRuntimeContext
  ): Promise<SupportQuestionRoute> {
    const prompt = [
      "You are the Router Agent for a support engineer system.",
      "Return ONLY valid JSON with keys: question_type, user_goal, answer_contract, specialist_agent, routing_confidence",
      "question_type must be one of: api_endpoint_lookup, api_field_lookup, api_scope_auth, how_to_product, why_behavior, troubleshooting, config_setup, capability_confirmation, data_export_reporting.",
      "specialist_agent must be one of: api-specialist, howto-specialist, behavior-specialist, troubleshooting-specialist.",
      "answer_contract should be a concise description of what a useful customer-facing answer must contain for this question.",
      "Rules:",
      "- API endpoint/path/field/scope questions must route to an API specialist.",
      "- How-to/setup/export workflow questions must route to a How-To specialist.",
      "- Questions asking why, expected behavior, rules, or whether behavior is intended must route to a Behavior specialist.",
      "- Error, failure, or not-working questions must route to a Troubleshooting specialist unless they are clearly endpoint lookup questions.",
      "- Keep user_goal concise and customer-oriented.",
      `context_type: ${input.contextType}`,
      `language: ${input.language}`,
      `user_query: ${input.query}`,
      ...(input.conversationHistory?.length
        ? ["conversation_history:", ...input.conversationHistory.slice(-6).map((item) => `- [${item.role}] ${item.content}`)]
        : [])
    ].join("\n");

    const parsed = (await this.runJsonPrompt(prompt, `${idempotencyKey}:router`, runtime, undefined, "router")) as Record<string, unknown>;
    const question_type = normalizeQuestionType(parsed.question_type);
    return {
      question_type,
      user_goal: typeof parsed.user_goal === "string" ? parsed.user_goal : input.query,
      answer_contract:
        typeof parsed.answer_contract === "string"
          ? parsed.answer_contract
          : question_type.startsWith("api_")
          ? "Provide the exact API endpoint details first."
          : "Provide the most useful support answer first.",
      specialist_agent:
        parsed.specialist_agent === "api-specialist" ||
        parsed.specialist_agent === "howto-specialist" ||
        parsed.specialist_agent === "behavior-specialist" ||
        parsed.specialist_agent === "troubleshooting-specialist"
          ? parsed.specialist_agent
          : specialistFromQuestionType(question_type),
      routing_confidence:
        typeof parsed.routing_confidence === "number" && Number.isFinite(parsed.routing_confidence)
          ? Math.max(0, Math.min(1, parsed.routing_confidence))
          : 0.72
    };
  }

  async planSupportEvidence(
    input: OpenClawSupportEvidencePlannerInput,
    idempotencyKey: string,
    runtime?: OpenClawRuntimeContext
  ): Promise<SupportEvidencePlan> {
    const prompt = [
      "You are the Evidence Planner Agent for a support engineer system.",
      "Return ONLY valid JSON with keys: query_plan({concept_queries:string[], object_queries:string[], behavior_queries:string[]}), evidence_priority(string[]), required_doc_kinds(string[])",
      "Rules:",
      "- Tailor retrieval to the routed question type and user goal.",
      "- Prefer object-specific and documentation-specific queries over generic restatements.",
      "- required_doc_kinds should be short labels such as openapi/api, syntax_reference, product_guide, permissions, rules, troubleshooting.",
      "- For API questions, prioritize openapi/api and schema/field documentation.",
      "- For API questions with nearby variants, include both the likely primary operation query and the nearby variant query. Example: current status versus status list.",
      "- For why/behavior questions, prioritize rules, limitations, and product-guide documents.",
      "- For syntax or capability questions, include the exact product syntax term in the queries and prioritize syntax/reference docs before UI behavior docs.",
      "- For how-to questions, prioritize product-guide and step-by-step docs.",
      `context_type: ${input.contextType}`,
      `language: ${input.language}`,
      `user_query: ${input.query}`,
      `route: ${JSON.stringify(input.route)}`,
      ...(input.conversationHistory?.length
        ? ["conversation_history:", ...input.conversationHistory.slice(-6).map((item) => `- [${item.role}] ${item.content}`)]
        : [])
    ].join("\n");

    const parsed = (await this.runJsonPrompt(
      prompt,
      `${idempotencyKey}:evidence-planner`,
      runtime,
      undefined,
      "evidence-planner"
    )) as Record<string, unknown>;
    const query_plan = (parsed.query_plan as Record<string, unknown> | undefined) ?? {};
    return {
      query_plan: {
        concept_queries: Array.isArray(query_plan.concept_queries)
          ? query_plan.concept_queries.map((item) => String(item)).filter(Boolean)
          : [],
        object_queries: Array.isArray(query_plan.object_queries)
          ? query_plan.object_queries.map((item) => String(item)).filter(Boolean)
          : [],
        behavior_queries: Array.isArray(query_plan.behavior_queries)
          ? query_plan.behavior_queries.map((item) => String(item)).filter(Boolean)
          : []
      },
      evidence_priority: Array.isArray(parsed.evidence_priority)
        ? parsed.evidence_priority.map((item) => String(item)).filter(Boolean)
        : [],
      required_doc_kinds: Array.isArray(parsed.required_doc_kinds)
        ? parsed.required_doc_kinds.map((item) => String(item)).filter(Boolean)
        : []
    };
  }

  async writeApiSpecialistAnswer(
    input: OpenClawSupportSpecialistInput,
    idempotencyKey: string,
    runtime?: OpenClawRuntimeContext
  ): Promise<SpecialistDraftAnswer> {
    return this.runSpecialistPrompt(
      "api-specialist",
      [
        "You are the API Specialist Agent for ONES support.",
        "Return ONLY valid JSON with keys:",
        "question_type, render_variant, direct_answer, claims([{text, kind(verified_fact|grounded_inference|operational_advice|unknown), evidence_ids(string[]), authority(canonical|assistive)}]), next_actions(string[]), unknowns(string[]), escalation_needed(boolean), api_method, api_path, required_params(string[]), auth_scope(string[]), response_field_hint, important_note, related_variant",
        "Rules:",
        "- Answer the user's API question directly first.",
        "- If the evidence contains a likely exact operation doc, answer with that operation first instead of asking for clarification.",
        "- For endpoint lookup, field lookup, and scope questions, provide the exact endpoint details when evidence supports them.",
        "- If there is a nearby ambiguity, such as current status versus status list, keep the most likely primary answer in direct_answer and put the nearby variant in related_variant or important_note.",
        "- For field lookup questions, prefer the operation whose response schema returns the current object details when the user asks for a current value.",
        "- Use claims with evidence_ids for the primary route and for any nearby variant that is also evidenced.",
        "- Keep wording polite, direct, and useful.",
        "- Do not output internal reasoning labels."
      ],
      input,
      idempotencyKey,
      runtime
    );
  }

  async writeHowToSpecialistAnswer(
    input: OpenClawSupportSpecialistInput,
    idempotencyKey: string,
    runtime?: OpenClawRuntimeContext
  ): Promise<SpecialistDraftAnswer> {
    return this.runSpecialistPrompt(
      "howto-specialist",
      [
        "You are the How-To Specialist Agent for ONES support.",
        "Return ONLY valid JSON with keys:",
        "question_type, render_variant, direct_answer, claims([{text, kind(verified_fact|grounded_inference|operational_advice|unknown), evidence_ids(string[]), authority(canonical|assistive)}]), next_actions(string[]), unknowns(string[]), escalation_needed(boolean), steps(string[]), prerequisites(string[]), limits_or_notes(string[])",
        "Rules:",
        "- Provide a practical customer-facing answer first.",
        "- Prefer concrete actions, settings, paths, or operations over abstract summaries.",
        "- Keep wording polite and professional."
      ],
      input,
      idempotencyKey,
      runtime
    );
  }

  async writeBehaviorSpecialistAnswer(
    input: OpenClawSupportSpecialistInput,
    idempotencyKey: string,
    runtime?: OpenClawRuntimeContext
  ): Promise<SpecialistDraftAnswer> {
    return this.runSpecialistPrompt(
      "behavior-specialist",
      [
        "You are the Behavior Specialist Agent for ONES support.",
        "Return ONLY valid JSON with keys:",
        "question_type, render_variant, direct_answer, claims([{text, kind(verified_fact|grounded_inference|operational_advice|unknown), evidence_ids(string[]), authority(canonical|assistive)}]), next_actions(string[]), unknowns(string[]), escalation_needed(boolean), most_likely_explanation, confirmed_facts(string[]), what_to_check_next(string[])",
        "Rules:",
        "- Answer the user's why/behavior question directly.",
        "- If the retrieved docs support a narrow conclusion, state that narrow conclusion directly instead of escalating immediately.",
        "- When the question is about supported syntax or documented capability, prefer syntax/reference docs over UI guidance, and keep the claim narrow.",
        "- It is acceptable to use grounded_inference for the most likely explanation, but never present an inference as documented fact.",
        "- Keep the tone polite, measured, and useful."
      ],
      input,
      idempotencyKey,
      runtime
    );
  }

  async writeTroubleshootingSpecialistAnswer(
    input: OpenClawSupportSpecialistInput,
    idempotencyKey: string,
    runtime?: OpenClawRuntimeContext
  ): Promise<SpecialistDraftAnswer> {
    return this.runSpecialistPrompt(
      "troubleshooting-specialist",
      [
        "You are the Troubleshooting Specialist Agent for ONES support.",
        "Return ONLY valid JSON with keys:",
        "question_type, render_variant, direct_answer, claims([{text, kind(verified_fact|grounded_inference|operational_advice|unknown), evidence_ids(string[]), authority(canonical|assistive)}]), next_actions(string[]), unknowns(string[]), escalation_needed(boolean), most_likely_causes(string[]), recommended_checks(string[]), required_followup_info(string[]), when_to_handoff",
        "Rules:",
        "- Start with the most useful diagnosis or support conclusion you can defend.",
        "- Focus on practical checks and follow-up details.",
        "- Keep the tone polite and concise."
      ],
      input,
      idempotencyKey,
      runtime
    );
  }

  async selectSupportEvidence(
    input: OpenClawSupportEvidenceSelectorInput,
    idempotencyKey: string,
    runtime?: OpenClawRuntimeContext
  ): Promise<SupportEvidenceSelection> {
    const candidates = input.references.slice(0, 8).map((reference) => ({
      documentId: reference.documentId,
      title: reference.title,
      headingPath: reference.headingPath,
      path: reference.path,
      snippet: reference.snippet.slice(0, 220),
      score: reference.score,
      sourceType: reference.sourceType,
      supportMetadata: compactSupportMetadata(reference.supportMetadata)
    }));
    const prompt = [
      "You are an evidence selector for a support engineer agent.",
      "Return ONLY valid JSON with keys: primary_ids(string[]), supplemental_ids(string[]), rejected_ids(string[])",
      "Rules:",
      "- Select only documentation chunks that directly help answer the user's question.",
      "- Prioritize sources that explicitly discuss the queried object, rule, syntax, API, scope, or behavior.",
      "- Follow case_frame.required_doc_kinds strictly when strong matches exist.",
      "- For how_to_product, config_setup, and data_export_reporting: if both product guides and deployment runbooks are present, choose the document that gives the most direct executable procedure for the user’s stated task as primary.",
      "- For how_to_product, config_setup, and data_export_reporting: keep deployment/private_deployment troubleshooting docs as primary only when the user question itself is clearly infra/deployment-oriented or the candidate directly matches the reported symptom; otherwise keep them supplemental.",
      "- Use supportMetadata.deployment_model, product_area, evidence_kind, prerequisites, and limitations when deciding which evidence is the best fit.",
      "- For api_field_lookup, prefer the operation that returns the current object details; list or enum endpoints should be supplemental unless the question explicitly asks for the list.",
      "- For capability_confirmation and why_behavior about syntax or operators, prefer syntax/reference docs before general product guides.",
      "- Reject tangential sources even if they are from the same product area.",
      "- primary_ids should contain the strongest 1 to 3 evidence ids.",
      "- supplemental_ids may contain up to 2 additional evidence ids that add useful context.",
      "- Do not include the same id in multiple arrays.",
      `context_type: ${input.contextType}`,
      `language: ${input.language}`,
      `user_query: ${input.query}`,
      `query_focus_terms: ${JSON.stringify(extractQueryFocusTerms({ query: input.query, caseFrame: input.caseFrame }))}`,
      `case_frame: ${JSON.stringify(input.caseFrame)}`,
      `candidate_evidence: ${JSON.stringify(candidates)}`
    ].join("\n");

    const parsed = (await this.runJsonPrompt(
      prompt,
      `${idempotencyKey}:support-evidence-selector`,
      runtime,
      undefined,
      "support-evidence-selector"
    )) as Partial<SupportEvidenceSelection>;
    const primaryIds = Array.isArray(parsed.primary_ids) ? parsed.primary_ids.map((item) => String(item)).filter(Boolean) : [];
    const supplementalIds = Array.isArray(parsed.supplemental_ids)
      ? parsed.supplemental_ids.map((item) => String(item)).filter(Boolean)
      : [];
    const selected = new Set(primaryIds);
    const dedupedSupplemental = supplementalIds.filter((item) => !selected.has(item));
    const accepted = new Set([...primaryIds, ...dedupedSupplemental]);
    return {
      primary_ids: primaryIds.slice(0, 3),
      supplemental_ids: dedupedSupplemental.slice(0, 2),
      rejected_ids: Array.isArray(parsed.rejected_ids)
        ? parsed.rejected_ids.map((item) => String(item)).filter((item) => !accepted.has(item))
        : candidates.map((item) => item.documentId).filter((item) => !accepted.has(item))
    };
  }

  async writeSupportAnswer(
    input: OpenClawSupportWriterInput,
    idempotencyKey: string,
    runtime?: OpenClawRuntimeContext
  ): Promise<DraftSupportAnswer> {
    const compactBundle = compactEvidenceBundle(input.evidenceBundle, {
      primaryLimit: 3,
      supplementalLimit: 2,
      snippetMax: 260
    });
    const prompt = [
      "You are a support engineer agent for ONES.",
      "Return ONLY valid JSON:",
      "direct_answer, claims([{text, kind(verified_fact|grounded_inference|operational_advice|unknown), evidence_ids(string[]), authority(canonical|assistive)}]), next_actions(string[]), unknowns(string[]), escalation_needed(boolean)",
      "Rules:",
      "- Answer the user's actual question first in a support engineer style.",
      "- Organize your answer as: direct answer, why you think so, what to do now, and what is still unconfirmed.",
      "- Use polite, professional, and measured wording.",
      "- Be helpful and respectful. Do not sound abrupt, dismissive, or overly certain.",
      "- Do not output framework words like verification or evidence gap.",
      "- Claims about APIs, parameters, scopes, permissions, limits, deployment, and versions must be grounded in evidence.",
      "- Every verified_fact or grounded_inference claim MUST include evidence_ids from the evidence bundle.",
      "- If you conclude that a syntax clause, API capability, or query behavior is supported or documented, attach the exact evidence_ids that mention it.",
      "- If you cannot attach evidence_ids for a factual capability claim, do not state that claim as fact.",
      "- Use grounded_inference only when multiple canonical snippets strongly imply the conclusion.",
      "- Use operational_advice for safe next-step guidance.",
      "- unknown is for unresolved items that still need confirmation.",
      "- Never say 'refer to the doc' or 'follow the documentation'. State the relevant content directly.",
      `context_type: ${input.contextType}`,
      `language: ${input.language}`,
      `user_query: ${input.query}`,
      `query_focus_terms: ${JSON.stringify(extractQueryFocusTerms({ query: input.query, caseFrame: input.caseFrame }))}`,
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

  async judgeSupportAnswer(
    input: OpenClawSupportVerifierInput,
    idempotencyKey: string,
    runtime?: OpenClawRuntimeContext
  ): Promise<SupportVerificationResult> {
    const compactBundle = compactEvidenceBundle(input.evidenceBundle, {
      primaryLimit: 3,
      supplementalLimit: 2,
      snippetMax: 220
    });
    const prompt = [
      "You are the Evidence Judge Agent for a support engineer system.",
      "Return ONLY valid JSON:",
      "verdict(verified|partial|unsupported), summary, unsupported_claims(string[]), missing_info(string[]), verified_citation_ids(string[]), display_citation_ids(string[]), verified_claims(string[]), claim_to_citation_map([{text, kind, verdict(verified|supported_inference|unsupported), citation_ids(string[])}])",
      "Rules:",
      "- Judge each claim strictly against the evidence bundle.",
      "- verified_fact and grounded_inference claims require directly relevant citation ids.",
      "- operational_advice may survive only if it does not depend on unsupported facts.",
      "- Do not preserve broad claims when only a narrower claim is supported; narrow them instead and keep citation ids.",
      "- If an API operation doc clearly answers the main question, preserve that supported claim even if a nearby variant remains unresolved.",
      "- If the docs support a useful partial answer, keep the useful supported claim and move the unresolved part into missing_info instead of rejecting the whole answer.",
      "- display_citation_ids may be empty here; they will be curated later.",
      `language: ${input.language}`,
      `user_query: ${input.query}`,
      `query_focus_terms: ${JSON.stringify(extractQueryFocusTerms({ query: input.query, caseFrame: input.caseFrame }))}`,
      `case_frame: ${JSON.stringify(input.caseFrame)}`,
      `evidence_bundle: ${JSON.stringify(compactBundle)}`,
      `draft_support_answer: ${JSON.stringify(compactSpecialistDraftAnswer(input.draftSupportAnswer as SpecialistDraftAnswer | undefined))}`
    ].join("\n");
    return this.parseVerificationResult(
      await this.runJsonPrompt(prompt, `${idempotencyKey}:evidence-judge`, runtime, undefined, "evidence-judge")
    );
  }

  async verifySupportAnswer(
    input: OpenClawSupportVerifierInput,
    idempotencyKey: string,
    runtime?: OpenClawRuntimeContext
  ): Promise<SupportVerificationResult> {
    const compactBundle = compactEvidenceBundle(input.evidenceBundle, {
      primaryLimit: 3,
      supplementalLimit: 2,
      snippetMax: 220
    });
    const prompt = [
      "Verify whether the support answer is supported by the evidence.",
      "Return ONLY valid JSON:",
      "verdict(verified|partial|unsupported), summary, unsupported_claims(string[]), missing_info(string[]), verified_citation_ids(string[]), display_citation_ids(string[]), verified_claims(string[]), claim_to_citation_map([{text, kind, verdict(verified|supported_inference|unsupported), citation_ids(string[])}])",
      "Rules:",
      "- Capabilities, APIs, parameters, scopes, permissions, limits, version/deployment conclusions must be evidence-backed.",
      "- A verified or supported_inference claim MUST include at least one directly relevant citation id from the evidence bundle.",
      "- Tangential or merely same-domain documents must not be used as citations.",
      "- For claims about what the retrieved documentation does or does not show, cite the relevant syntax/reference document ids directly. If a syntax reference enumerates supported operators or clauses and does not mention ORDER BY / GROUP BY, that syntax reference can support a narrowly phrased claim like 'the retrieved syntax reference does not show ORDER BY / GROUP BY'.",
      "- When the evidence supports a limited conclusion, keep the claim narrow and still attach the best matching citation ids. Do not drop citation ids just because the claim is conservative.",
      "- unsupported_claims should contain only claims that truly cannot be supported from the evidence bundle.",
      "- display_citation_ids must contain only the 1 to 3 canonical citation ids that should be shown to the user.",
      "- Every display_citation_id must directly support at least one surviving verified or supported_inference claim.",
      "- verified: every factual claim is supported.",
      "- partial: some guidance is supported but some factual claims go beyond evidence.",
      "- unsupported: the core conclusion is not evidence-backed.",
      `language: ${input.language}`,
      `user_query: ${input.query}`,
      `query_focus_terms: ${JSON.stringify(extractQueryFocusTerms({ query: input.query, caseFrame: input.caseFrame }))}`,
      `case_frame: ${JSON.stringify(input.caseFrame)}`,
      `evidence_bundle: ${JSON.stringify(compactBundle)}`,
      `draft_support_answer: ${JSON.stringify(compactDraftSupportAnswerForVerification(input.draftSupportAnswer))}`
    ].join("\n");

    return this.parseVerificationResult(
      await this.runJsonPrompt(prompt, `${idempotencyKey}:support-verifier`, runtime, undefined, "support-verifier")
    );
  }

  async bindSupportCitations(
    input: OpenClawSupportVerifierInput,
    idempotencyKey: string,
    runtime?: OpenClawRuntimeContext
  ): Promise<SupportVerificationResult> {
    const compactBundle = compactEvidenceBundle(input.evidenceBundle, {
      primaryLimit: 3,
      supplementalLimit: 2,
      snippetMax: 220
    });
    const prompt = [
      "You are a citation binder for a support engineer agent.",
      "Return ONLY valid JSON:",
      "verdict(verified|partial|unsupported), summary, unsupported_claims(string[]), missing_info(string[]), verified_citation_ids(string[]), display_citation_ids(string[]), verified_claims(string[]), claim_to_citation_map([{text, kind, verdict(verified|supported_inference|unsupported), citation_ids(string[])}])",
      "Rules:",
      "- Focus on binding the draft claims to the strongest evidence ids from the evidence bundle.",
      "- Prefer narrow, documentation-backed claims over broad unsupported claims.",
      "- If a syntax/reference document enumerates supported syntax and does not mention ORDER BY / GROUP BY, you may cite it for a narrow claim such as 'the retrieved syntax reference does not show ORDER BY / GROUP BY'.",
      "- Any verified or supported_inference claim MUST include at least one citation id from the evidence bundle.",
      "- unsupported_claims should only list claims that cannot be supported even after narrowing them.",
      "- display_citation_ids must contain only the 1 to 3 canonical citation ids that should be shown to the user.",
      `language: ${input.language}`,
      `user_query: ${input.query}`,
      `query_focus_terms: ${JSON.stringify(extractQueryFocusTerms({ query: input.query, caseFrame: input.caseFrame }))}`,
      `case_frame: ${JSON.stringify(input.caseFrame)}`,
      `evidence_bundle: ${JSON.stringify(compactBundle)}`,
      `draft_support_answer: ${JSON.stringify(compactDraftSupportAnswerForVerification(input.draftSupportAnswer))}`
    ].join("\n");

    return this.parseVerificationResult(
      await this.runJsonPrompt(prompt, `${idempotencyKey}:support-citation-binder`, runtime, undefined, "support-citation-binder")
    );
  }

  async selectDisplayCitations(
    input: import("./types.js").OpenClawSupportCitationSelectorInput,
    idempotencyKey: string,
    runtime?: OpenClawRuntimeContext
  ): Promise<{ display_citation_ids: string[] }> {
    const compactBundle = compactEvidenceBundle(input.evidenceBundle, {
      primaryLimit: 3,
      supplementalLimit: 2,
      snippetMax: 220
    });
    const supportedClaims = input.supportedClaims.map((claim) => ({
      text: claim.text,
      kind: claim.kind,
      citation_ids: claim.citation_ids
    }));
    const prompt = [
      "You are a display-citation selector for a support engineer agent.",
      "Return ONLY valid JSON with key: display_citation_ids(string[])",
      "Rules:",
      "- Select only 1 to 3 canonical citation ids that most directly support the final user-visible answer.",
      "- Prefer citations that directly discuss the same object, syntax, API, scope, or behavior as the user query.",
      "- Reject tangential same-domain documents.",
      "- Every selected citation id must support at least one supported claim.",
      "- Prefer citations that best support the direct answer first, then the why section.",
      `language: ${input.language}`,
      `user_query: ${input.query}`,
      `query_focus_terms: ${JSON.stringify(extractQueryFocusTerms({ query: input.query, caseFrame: input.caseFrame }))}`,
      `case_frame: ${JSON.stringify(input.caseFrame)}`,
      `supported_claims: ${JSON.stringify(supportedClaims)}`,
      `evidence_bundle: ${JSON.stringify(compactBundle)}`
    ].join("\n");

    const parsed = (await this.runJsonPrompt(
      prompt,
      `${idempotencyKey}:support-citation-selector`,
      runtime,
      undefined,
      "support-citation-selector"
    )) as { display_citation_ids?: unknown };
    return {
      display_citation_ids: Array.isArray(parsed.display_citation_ids)
        ? parsed.display_citation_ids.map((item) => String(item)).filter(Boolean).slice(0, 3)
        : []
    };
  }

  async curateSupportCitations(
    input: import("./types.js").OpenClawSupportCitationSelectorInput,
    idempotencyKey: string,
    runtime?: OpenClawRuntimeContext
  ): Promise<{ display_citation_ids: string[] }> {
    const compactBundle = compactEvidenceBundle(input.evidenceBundle, {
      primaryLimit: 3,
      supplementalLimit: 2,
      snippetMax: 220
    });
    const supportedClaims = input.supportedClaims.map((claim) => ({
      text: claim.text,
      kind: claim.kind,
      citation_ids: claim.citation_ids
    }));
    const prompt = [
      "You are the Citation Curator Agent for a support engineer system.",
      "Return ONLY valid JSON with key: display_citation_ids(string[])",
      "Rules:",
      "- Select 1 to 3 canonical citations that most directly support the final customer-facing answer.",
      "- Prefer citations that support the direct answer first, then the next most important section.",
      "- Do not include tangential same-domain docs.",
      `language: ${input.language}`,
      `user_query: ${input.query}`,
      `query_focus_terms: ${JSON.stringify(extractQueryFocusTerms({ query: input.query, caseFrame: input.caseFrame }))}`,
      `case_frame: ${JSON.stringify(input.caseFrame)}`,
      `supported_claims: ${JSON.stringify(supportedClaims)}`,
      `evidence_bundle: ${JSON.stringify(compactBundle)}`
    ].join("\n");
    const parsed = (await this.runJsonPrompt(
      prompt,
      `${idempotencyKey}:citation-curator`,
      runtime,
      undefined,
      "citation-curator"
    )) as { display_citation_ids?: unknown };
    return {
      display_citation_ids: Array.isArray(parsed.display_citation_ids)
        ? parsed.display_citation_ids.map((item) => String(item)).filter(Boolean).slice(0, 3)
        : []
    };
  }

  async composeSupportAnswer(
    input: import("./types.js").OpenClawSupportAnswerComposerInput,
    idempotencyKey: string,
    runtime?: OpenClawRuntimeContext
  ): Promise<{
    direct_answer: string;
    why: string[];
    what_to_do_now: string[];
    still_need_to_confirm: string[];
  }> {
    const prompt = [
      "You are a polite support engineer for ONES.",
      "Return ONLY valid JSON with keys: direct_answer, why(string[]), what_to_do_now(string[]), still_need_to_confirm(string[])",
      "Rules:",
      "- Use only the supported claims and approved next actions below. Do not restate unsupported conclusions.",
      "- Be polite, professional, and measured.",
      "- Answer the user's question first.",
      "- If the user asks whether something is supported, documented, or expected, start with a direct verdict such as 'Yes', 'No', or 'I could not confirm from the current documentation', then explain briefly.",
      "- For partial mode, clearly state what you could confirm and what is still unconfirmed.",
      "- For partial mode, do not start with generic wording like 'I can confirm part of the answer'. State the actual supported or unsupported conclusion directly.",
      "- why should explain the answer briefly using the supported claims.",
      "- what_to_do_now should contain practical next steps only.",
      "- still_need_to_confirm should include only unresolved items.",
      "- Do not mention verification, unsupported claims, or internal system language.",
      `language: ${input.language}`,
      `mode: ${input.mode}`,
      `user_query: ${input.query}`,
      `case_frame: ${JSON.stringify(input.caseFrame)}`,
      `supported_claims: ${JSON.stringify(
        input.supportedClaims.map((claim) => ({
          text: claim.text,
          kind: claim.kind
        }))
      )}`,
      `next_actions: ${JSON.stringify(input.nextActions)}`,
      `unknowns: ${JSON.stringify(input.unknowns)}`
    ].join("\n");

    const parsed = (await this.runJsonPrompt(
      prompt,
      `${idempotencyKey}:support-answer-composer`,
      runtime,
      undefined,
      "support-answer-composer"
    )) as Record<string, unknown>;
    return {
      direct_answer: typeof parsed.direct_answer === "string" ? parsed.direct_answer : "",
      why: Array.isArray(parsed.why) ? parsed.why.map((item) => String(item)).filter(Boolean) : [],
      what_to_do_now: Array.isArray(parsed.what_to_do_now)
        ? parsed.what_to_do_now.map((item) => String(item)).filter(Boolean)
        : [],
      still_need_to_confirm: Array.isArray(parsed.still_need_to_confirm)
        ? parsed.still_need_to_confirm.map((item) => String(item)).filter(Boolean)
        : []
    };
  }

  async composeCustomerAnswer(
    input: import("./types.js").OpenClawSupportAnswerComposerInput,
    idempotencyKey: string,
    runtime?: OpenClawRuntimeContext
  ): Promise<Omit<SupportAnswer, "mode">> {
    const prompt = [
      "You are the Answer Composer Agent for a customer-facing support engineer system.",
      "Return ONLY valid JSON with keys: question_type, render_variant, direct_answer, sections([{kind,title,body?,items?,method?,path?,required_params?,auth_scope?,response_field_hint?,important_note?,related_variant?}]), why(string[]), what_to_do_now(string[]), still_need_to_confirm(string[])",
      "Rules:",
      "- The answer must be customer-facing and useful.",
      "- Do not output internal reasoning labels like verification, unsupported claims, evidence gap, or why this is still needed.",
      "- Use polite, professional, and measured wording.",
      "- The content must adapt to the routed question type.",
      "- API answers should prioritize the exact endpoint details first, and they should answer the likely primary route before mentioning nearby variants.",
      "- For API answers, do not start with generic uncertainty if there is at least one supported operation or field answer. State that supported answer directly and then note the nearby variant or remaining uncertainty.",
      "- Why answers should prioritize the most likely explanation first.",
      "- For behavior/capability answers, do not start with generic partial wording like 'I can confirm part of the answer'. State the narrow supported conclusion directly.",
      "- How-to answers should prioritize steps and prerequisites.",
      "- Troubleshooting answers should prioritize recommended checks and follow-up info.",
      `language: ${input.language}`,
      `mode: ${input.mode}`,
      `route: ${JSON.stringify(input.route)}`,
      `case_frame: ${JSON.stringify(input.caseFrame)}`,
      `draft_support_answer: ${JSON.stringify(compactSpecialistDraftAnswer(input.draftSupportAnswer))}`,
      `supported_claims: ${JSON.stringify(
        input.supportedClaims.map((claim) => ({
          text: claim.text,
          kind: claim.kind
        }))
      )}`,
      `next_actions: ${JSON.stringify(input.nextActions)}`,
      `unknowns: ${JSON.stringify(input.unknowns)}`
    ].join("\n");
    const parsed = (await this.runJsonPrompt(
      prompt,
      `${idempotencyKey}:answer-composer`,
      runtime,
      undefined,
      "answer-composer"
    )) as Record<string, unknown>;
    return {
      question_type: normalizeQuestionType(parsed.question_type ?? input.route.question_type),
      render_variant:
        parsed.render_variant === "api" ||
        parsed.render_variant === "how_to" ||
        parsed.render_variant === "behavior" ||
        parsed.render_variant === "troubleshooting" ||
        parsed.render_variant === "clarification" ||
        parsed.render_variant === "handoff"
          ? parsed.render_variant
          : input.draftSupportAnswer?.render_variant ?? renderVariantFromQuestionType(input.route.question_type),
      direct_answer: typeof parsed.direct_answer === "string" ? parsed.direct_answer : "",
      sections: Array.isArray(parsed.sections)
        ? parsed.sections
            .map((item) => item as Record<string, unknown>)
            .map((item) => {
              if (item.kind === "api_card") {
                return {
                  kind: "api_card" as const,
                  title: typeof item.title === "string" ? item.title : "API",
                  method: typeof item.method === "string" ? item.method : "",
                  path: typeof item.path === "string" ? item.path : "",
                  required_params: Array.isArray(item.required_params) ? item.required_params.map((x) => String(x)).filter(Boolean) : [],
                  auth_scope: Array.isArray(item.auth_scope) ? item.auth_scope.map((x) => String(x)).filter(Boolean) : [],
                  response_field_hint: typeof item.response_field_hint === "string" ? item.response_field_hint : undefined,
                  important_note: typeof item.important_note === "string" ? item.important_note : undefined,
                  related_variant: typeof item.related_variant === "string" ? item.related_variant : undefined
                };
              }
              if (item.kind === "bullet_list") {
                return {
                  kind: "bullet_list" as const,
                  title: typeof item.title === "string" ? item.title : "",
                  items: Array.isArray(item.items) ? item.items.map((x) => String(x)).filter(Boolean) : []
                };
              }
              return {
                kind: "paragraph" as const,
                title: typeof item.title === "string" ? item.title : "",
                body: typeof item.body === "string" ? item.body : ""
              };
            })
            .filter((item) => item.title && (item.kind !== "paragraph" || item.body))
        : [],
      why: Array.isArray(parsed.why) ? parsed.why.map((item) => String(item)).filter(Boolean) : [],
      what_to_do_now: Array.isArray(parsed.what_to_do_now) ? parsed.what_to_do_now.map((item) => String(item)).filter(Boolean) : [],
      still_need_to_confirm: Array.isArray(parsed.still_need_to_confirm)
        ? parsed.still_need_to_confirm.map((item) => String(item)).filter(Boolean)
        : []
    };
  }

  async writeTriageInsight(
    input: OpenClawSupportWriterInput,
    idempotencyKey: string,
    runtime?: OpenClawRuntimeContext
  ): Promise<TriageSupportInsight> {
    const compactBundle = compactEvidenceBundle(input.evidenceBundle, {
      primaryLimit: 3,
      supplementalLimit: 2,
      snippetMax: 240
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
      primaryLimit: 3,
      supplementalLimit: 2,
      snippetMax: 220
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
    await this.waitAgentRun(runId, sessionKey, runtime);
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

  private async runSpecialistPrompt(
    stage: "api-specialist" | "howto-specialist" | "behavior-specialist" | "troubleshooting-specialist",
    promptLines: string[],
    input: OpenClawSupportSpecialistInput,
    idempotencyKey: string,
    runtime?: OpenClawRuntimeContext
  ): Promise<SpecialistDraftAnswer> {
    const compactBundle = compactEvidenceBundle(input.evidenceBundle, {
      primaryLimit: 3,
      supplementalLimit: 2,
      snippetMax: 260
    });
    const prompt = [
      ...promptLines,
      `language: ${input.language}`,
      `user_query: ${input.query}`,
      `route: ${JSON.stringify(input.route)}`,
      `query_focus_terms: ${JSON.stringify(extractQueryFocusTerms({ query: input.query, caseFrame: input.caseFrame }))}`,
      `case_frame: ${JSON.stringify(input.caseFrame)}`,
      `evidence_bundle: ${JSON.stringify(compactBundle)}`,
      ...(input.conversationHistory?.length
        ? ["conversation_history:", ...input.conversationHistory.slice(-6).map((item) => `- [${item.role}] ${item.content}`)]
        : [])
    ].join("\n");
    const parsed = (await this.runJsonPrompt(prompt, `${idempotencyKey}:${stage}`, runtime, undefined, stage)) as Record<string, unknown>;
    return {
      question_type: normalizeQuestionType(parsed.question_type ?? input.route.question_type),
      render_variant:
        parsed.render_variant === "api" ||
        parsed.render_variant === "how_to" ||
        parsed.render_variant === "behavior" ||
        parsed.render_variant === "troubleshooting" ||
        parsed.render_variant === "clarification" ||
        parsed.render_variant === "handoff"
          ? parsed.render_variant
          : renderVariantFromQuestionType(input.route.question_type),
      direct_answer: typeof parsed.direct_answer === "string" ? parsed.direct_answer : "",
      claims: Array.isArray(parsed.claims)
        ? parsed.claims
            .map((item) => item as Record<string, unknown>)
            .map((item) => ({
              text: typeof item.text === "string" ? item.text : "",
              kind: (item.kind === "grounded_inference"
                ? "grounded_inference"
                : item.kind === "operational_advice"
                ? "operational_advice"
                : item.kind === "unknown"
                ? "unknown"
                : "verified_fact") as SpecialistDraftAnswer["claims"][number]["kind"],
              evidence_ids: Array.isArray(item.evidence_ids) ? item.evidence_ids.map((value) => String(value)).filter(Boolean) : [],
              authority: (item.authority === "assistive" ? "assistive" : "canonical") as SpecialistDraftAnswer["claims"][number]["authority"]
            }))
            .filter((item) => item.text)
        : [],
      next_actions: Array.isArray(parsed.next_actions) ? parsed.next_actions.map((item) => String(item)).filter(Boolean) : [],
      unknowns: Array.isArray(parsed.unknowns) ? parsed.unknowns.map((item) => String(item)).filter(Boolean) : [],
      escalation_needed: Boolean(parsed.escalation_needed),
      api_method: typeof parsed.api_method === "string" ? parsed.api_method : undefined,
      api_path: typeof parsed.api_path === "string" ? parsed.api_path : undefined,
      required_params: Array.isArray(parsed.required_params) ? parsed.required_params.map((item) => String(item)).filter(Boolean) : undefined,
      auth_scope: Array.isArray(parsed.auth_scope) ? parsed.auth_scope.map((item) => String(item)).filter(Boolean) : undefined,
      response_field_hint: typeof parsed.response_field_hint === "string" ? parsed.response_field_hint : undefined,
      important_note: typeof parsed.important_note === "string" ? parsed.important_note : undefined,
      related_variant: typeof parsed.related_variant === "string" ? parsed.related_variant : undefined,
      steps: Array.isArray(parsed.steps) ? parsed.steps.map((item) => String(item)).filter(Boolean) : undefined,
      prerequisites: Array.isArray(parsed.prerequisites) ? parsed.prerequisites.map((item) => String(item)).filter(Boolean) : undefined,
      limits_or_notes: Array.isArray(parsed.limits_or_notes) ? parsed.limits_or_notes.map((item) => String(item)).filter(Boolean) : undefined,
      most_likely_explanation:
        typeof parsed.most_likely_explanation === "string" ? parsed.most_likely_explanation : undefined,
      confirmed_facts: Array.isArray(parsed.confirmed_facts) ? parsed.confirmed_facts.map((item) => String(item)).filter(Boolean) : undefined,
      what_to_check_next: Array.isArray(parsed.what_to_check_next)
        ? parsed.what_to_check_next.map((item) => String(item)).filter(Boolean)
        : undefined,
      most_likely_causes: Array.isArray(parsed.most_likely_causes)
        ? parsed.most_likely_causes.map((item) => String(item)).filter(Boolean)
        : undefined,
      recommended_checks: Array.isArray(parsed.recommended_checks)
        ? parsed.recommended_checks.map((item) => String(item)).filter(Boolean)
        : undefined,
      required_followup_info: Array.isArray(parsed.required_followup_info)
        ? parsed.required_followup_info.map((item) => String(item)).filter(Boolean)
        : undefined,
      when_to_handoff: typeof parsed.when_to_handoff === "string" ? parsed.when_to_handoff : undefined
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
    await this.waitAgentRun(runId, sessionKey, runtime);
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
    await this.waitAgentRun(runId, sessionKey, runtime);
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
    const stage = runtime?.stage;
    const stageSpecific =
      stage
        ? resolveStageSpecificAgent(stage, runtime)
        : {
            agentId: runtime?.agentId?.trim() || env.OPENCLAW_AGENT_ID?.trim() || "main",
            model: runtime?.model?.trim() || undefined
          };
    const preferredAgentId = stageSpecific.agentId;
    const preferredModel = stageSpecific.model;
    const preferredSessionKey =
      runtime?.sessionKey?.trim() ||
      `${env.OPENCLAW_AGENT_SESSION_PREFIX?.trim() || "nf"}:${stage ?? "session"}:${Date.now()}`;
    return {
      agentId: preferredAgentId,
      sessionKey: preferredSessionKey.startsWith("agent:")
        ? preferredSessionKey
        : `agent:${preferredAgentId}:${sanitizeSessionPart(preferredSessionKey)}`,
      model: preferredModel
    };
  }

  private async startAgentRun(
    message: string,
    idempotencyKey: string,
    runtime?: OpenClawRuntimeContext,
    sessionKey?: string
  ): Promise<string> {
    const agentRuntime = this.resolveAgentRuntime(runtime);
    const timeoutMs = resolveRuntimeTimeoutMs(runtime);
    const payload = (await this.callMethod("agent", {
      agentId: agentRuntime.agentId,
      sessionKey: sessionKey ?? agentRuntime.sessionKey,
      message,
      timeout: timeoutMs,
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
    await this.waitAgentRun(runId, sessionKey, runtime);
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

  private async waitAgentRun(runId: string, sessionKey?: string, runtime?: OpenClawRuntimeContext): Promise<void> {
    const timeoutMs = resolveRuntimeTimeoutMs(runtime);
    try {
      const payload = (await this.callMethod(
        "agent.wait",
        { runId, timeoutMs },
        timeoutMs + 2000
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
      display_citation_ids: Array.isArray((parsed as Record<string, unknown>).display_citation_ids)
        ? ((parsed as Record<string, unknown>).display_citation_ids as unknown[]).map((item) => String(item))
        : [],
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
