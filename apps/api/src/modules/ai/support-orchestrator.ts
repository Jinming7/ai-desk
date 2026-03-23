import crypto from "node:crypto";
import { env } from "../../config/env.js";
import type { OpenClawAdapter } from "../../infrastructure/openclaw/types.js";
import { getSupportAgentRegistry, buildSupportAgentRuntime, type SupportAgentRole } from "./agent-registry.js";
import { SearchOrchestrator } from "./search-orchestrator.js";
import { runSupportSearchAgent } from "./support-agent.js";
import type {
  SearchModeResult,
  SearchReference,
  StructuredSearchAnswer,
  SupportAnswer,
  SupportCaseFrame,
  SupportConversationTurn,
  SupportEvidenceBundle,
  SupportVerificationResult
} from "./types.js";

type RouterOutput = {
  route: "api" | "howto" | "behavior" | "troubleshooting" | "incident" | "product_defect";
  case_type: string;
  resolution_goal: string;
  required_specialists: Array<"api_specialist" | "howto_specialist" | "behavior_specialist" | "troubleshooting_specialist">;
  clarification_needed: boolean;
  risk_level: "low" | "medium" | "high";
};

type EvidencePlannerOutput = {
  evidence_plan: string;
  queries: string[];
  sources: string[];
  blocking_unknowns: string[];
};

type SpecialistOutput = {
  findings: string[];
  supported_claims: string[];
  unsafe_claims: string[];
  next_checks: string[];
  missing_inputs: string[];
};

type SupportPlannerOutput = {
  case_frame: SupportCaseFrame;
  working_hypotheses: string[];
  candidate_actions: string[];
  confirmed_facts: string[];
};

type EvidenceJudgeOutput = {
  verdict: "verified" | "partial" | "unsupported";
  summary: string;
  claim_map: Array<{
    text: string;
    kind: "verified_fact" | "grounded_inference" | "operational_advice" | "unknown";
    verdict: "verified" | "supported_inference" | "unsupported";
    citation_ids: string[];
  }>;
  evidence_gaps: string[];
  handoff_threshold_reached: boolean;
};

type CitationCuratorOutput = {
  user_visible_citations: string[];
  internal_supporting_evidence: string[];
  evidence_sources: string[];
};

type AnswerComposerOutput = {
  mode: SupportAnswer["mode"];
  direct_answer: string;
  why: string[];
  what_to_do_now: string[];
  still_need_to_confirm: string[];
  structured_answer?: StructuredSearchAnswer;
};

type OrchestrationStage = {
  name: string;
  agent_id?: string;
  status: "completed" | "fallback" | "skipped";
  duration_ms?: number;
};

function stableHash(input: unknown): string {
  return crypto.createHash("sha256").update(JSON.stringify(input)).digest("hex");
}

function uniqueStrings(values: Array<string | null | undefined>, limit = 8): string[] {
  const seen = new Set<string>();
  const output: string[] = [];
  for (const item of values) {
    const value = String(item ?? "").trim();
    if (!value || seen.has(value)) continue;
    seen.add(value);
    output.push(value);
    if (output.length >= limit) break;
  }
  return output;
}

function normalizeComparableText(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

function overlapsUnsupportedClaim(text: string, unsupportedClaims: string[]): boolean {
  const normalizedText = normalizeComparableText(text);
  if (!normalizedText) return false;
  return unsupportedClaims.some((claim) => {
    const normalizedClaim = normalizeComparableText(claim);
    return normalizedClaim && (normalizedText.includes(normalizedClaim) || normalizedClaim.includes(normalizedText));
  });
}

function filterUnsupported(items: string[], unsupportedClaims: string[]): string[] {
  return items.filter((item) => !overlapsUnsupportedClaim(item, unsupportedClaims));
}

function buildEvidenceBundle(input: {
  references: SearchReference[];
  confidence: number;
  fallbackUsed: boolean;
  resolvedQueries: string[];
  caseFrame: SupportCaseFrame;
}): SupportEvidenceBundle {
  return {
    primary: input.references.slice(0, 4),
    supplemental: input.references.slice(4, 8),
    evidence_gaps: input.caseFrame.missing_critical_info.slice(0, 4),
    confidence: input.confidence,
    fallbackUsed: input.fallbackUsed,
    resolvedQueries: input.resolvedQueries
  };
}

function canonicalDocsPath(input?: string): string {
  return String(input ?? "")
    .trim()
    .replace(/^i18n\/[^/]+\/docusaurus-plugin-content-docs-open-docs\/current\//i, "open-docs/docs/")
    .replace(/^i18n\/[^/]+\/docusaurus-plugin-content-docs\/current\//i, "docs/");
}

function buildCitations(references: SearchReference[], visibleIds: string[]) {
  const allowAll = visibleIds.length === 0;
  const allowed = new Set(visibleIds);
  const deduped = new Map<string, SearchReference>();
  for (const item of references) {
    if (!item.sourceUrl || item.authority === "disabled_for_user") continue;
    if (!allowAll && !allowed.has(item.documentId)) continue;
    const key = [canonicalDocsPath(item.path) || item.sourceUrl || item.documentId, item.headingPath || "ROOT"].join("::");
    const previous = deduped.get(key);
    if (!previous || item.score > previous.score) {
      deduped.set(key, item);
    }
  }
  return [...deduped.values()].slice(0, 4).map((item) => ({
    id: item.documentId,
    title: item.title,
    excerpt: item.snippet,
    score: item.score,
    source_url: item.sourceUrl,
    retrieved_at: item.retrievedAt,
    repo: item.repo,
    path: item.path,
    commit_sha: item.commitSha
  }));
}

function determineMode(input: {
  verification: SupportVerificationResult;
  references: SearchReference[];
  currentRound: number;
  missingInfo: string[];
  handoffThresholdReached: boolean;
}): SupportAnswer["mode"] {
  const supported = input.verification.claim_to_citation_map.filter(
    (claim) => claim.verdict === "verified" || claim.verdict === "supported_inference"
  );
  if (input.verification.verdict === "verified" && input.missingInfo.length === 0 && supported.length > 0) {
    return "grounded";
  }
  if (supported.length > 0) {
    return "partial";
  }
  if (input.handoffThresholdReached) {
    return "handoff";
  }
  if (input.missingInfo.length > 0 && input.currentRound < env.AI_SEARCH_MAX_CLARIFICATION_ROUNDS) {
    return "clarification";
  }
  if (!input.references.length && input.currentRound >= env.AI_SEARCH_MAX_CLARIFICATION_ROUNDS) {
    return "handoff";
  }
  return input.references.length > 0 ? "clarification" : "handoff";
}

function buildSupportAnswer(input: {
  mode: SupportAnswer["mode"];
  composer: AnswerComposerOutput;
  verification: SupportVerificationResult;
  missingInfo: string[];
}): SupportAnswer {
  const supportedClaims = input.verification.claim_to_citation_map
    .filter((claim) => claim.verdict === "verified" || claim.verdict === "supported_inference")
    .map((claim) => claim.text);
  return {
    mode: input.mode,
    direct_answer: input.composer.direct_answer.trim(),
    why: uniqueStrings([...input.composer.why, ...supportedClaims], 6),
    what_to_do_now: uniqueStrings(filterUnsupported(input.composer.what_to_do_now, input.verification.unsupported_claims), 6),
    still_need_to_confirm: input.mode === "grounded" ? [] : uniqueStrings([...input.composer.still_need_to_confirm, ...input.missingInfo], 5)
  };
}

function buildStructuredAnswer(input: { mode: SupportAnswer["mode"]; supportAnswer: SupportAnswer; composer?: StructuredSearchAnswer }): StructuredSearchAnswer {
  if (input.composer) return input.composer;
  return {
    summary: input.supportAnswer.direct_answer,
    assessment: input.supportAnswer.why.join(" ") || undefined,
    steps: input.supportAnswer.what_to_do_now,
    validation: input.mode === "handoff" ? input.supportAnswer.still_need_to_confirm : [],
    required_inputs: input.mode === "clarification" ? input.supportAnswer.still_need_to_confirm : [],
    style: input.mode === "clarification" ? "clarification" : input.mode === "grounded" ? "kb_answer" : "diagnosis"
  };
}

function parseRouterOutput(input: unknown, query: string): RouterOutput {
  const parsed = (input ?? {}) as Partial<RouterOutput>;
  const route = parsed.route;
  const validRoute =
    route === "api" || route === "howto" || route === "behavior" || route === "troubleshooting" || route === "incident" || route === "product_defect"
      ? route
      : /api|openapi|scope|endpoint|token/i.test(query)
      ? "api"
      : /如何|怎么|how to|where|步骤/i.test(query)
      ? "howto"
      : /error|failed|失败|报错|异常|timeout|404|401|403|500/i.test(query)
      ? "troubleshooting"
      : "behavior";
  const required = Array.isArray(parsed.required_specialists) ? parsed.required_specialists : [];
  const normalizedRequired = required
    .map((item) => String(item))
    .filter((item): item is RouterOutput["required_specialists"][number] =>
      ["api_specialist", "howto_specialist", "behavior_specialist", "troubleshooting_specialist"].includes(item)
    );
  const fallbackSpecialist =
    validRoute === "api"
      ? "api_specialist"
      : validRoute === "howto"
      ? "howto_specialist"
      : validRoute === "behavior"
      ? "behavior_specialist"
      : "troubleshooting_specialist";
  return {
    route: validRoute,
    case_type: String(parsed.case_type ?? validRoute),
    resolution_goal: String(parsed.resolution_goal ?? query.trim()),
    required_specialists: normalizedRequired.length ? normalizedRequired : [fallbackSpecialist],
    clarification_needed: Boolean(parsed.clarification_needed),
    risk_level: parsed.risk_level === "high" || parsed.risk_level === "medium" ? parsed.risk_level : "low"
  };
}

function parseEvidencePlannerOutput(input: unknown, query: string): EvidencePlannerOutput {
  const parsed = (input ?? {}) as Partial<EvidencePlannerOutput>;
  return {
    evidence_plan: String(parsed.evidence_plan ?? "Gather public evidence first, then diagnose unresolved gaps."),
    queries: Array.isArray(parsed.queries) ? parsed.queries.map((item) => String(item)).filter(Boolean) : [query],
    sources: Array.isArray(parsed.sources) ? parsed.sources.map((item) => String(item)).filter(Boolean) : ["public_docs", "github_kb"],
    blocking_unknowns: Array.isArray(parsed.blocking_unknowns) ? parsed.blocking_unknowns.map((item) => String(item)).filter(Boolean) : []
  };
}

function parseSpecialistOutput(input: unknown): SpecialistOutput {
  const parsed = (input ?? {}) as Partial<SpecialistOutput>;
  return {
    findings: Array.isArray(parsed.findings) ? parsed.findings.map((item) => String(item)).filter(Boolean) : [],
    supported_claims: Array.isArray(parsed.supported_claims) ? parsed.supported_claims.map((item) => String(item)).filter(Boolean) : [],
    unsafe_claims: Array.isArray(parsed.unsafe_claims) ? parsed.unsafe_claims.map((item) => String(item)).filter(Boolean) : [],
    next_checks: Array.isArray(parsed.next_checks) ? parsed.next_checks.map((item) => String(item)).filter(Boolean) : [],
    missing_inputs: Array.isArray(parsed.missing_inputs) ? parsed.missing_inputs.map((item) => String(item)).filter(Boolean) : []
  };
}

function parseSupportPlannerOutput(input: unknown, query: string, evidencePlan: EvidencePlannerOutput): SupportPlannerOutput {
  const parsed = (input ?? {}) as Partial<SupportPlannerOutput> & { case_frame?: Partial<SupportCaseFrame> };
  const caseFrame: Partial<SupportCaseFrame> = parsed.case_frame ?? {};
  return {
    case_frame: {
      goal: String(caseFrame.goal ?? query.trim()),
      symptom: String(caseFrame.symptom ?? query.trim()),
      object: String(caseFrame.object ?? "support_case"),
      action_type: String(caseFrame.action_type ?? "troubleshooting"),
      deployment_model: String(caseFrame.deployment_model ?? "unknown"),
      product_area: String(caseFrame.product_area ?? "general"),
      constraints: Array.isArray(caseFrame.constraints) ? caseFrame.constraints.map((item: unknown) => String(item)) : [],
      missing_critical_info: Array.isArray(caseFrame.missing_critical_info)
        ? caseFrame.missing_critical_info.map((item: unknown) => String(item))
        : evidencePlan.blocking_unknowns,
      retrieval_queries: Array.isArray(caseFrame.retrieval_queries)
        ? caseFrame.retrieval_queries.map((item: unknown) => String(item)).filter(Boolean)
        : evidencePlan.queries,
      query_plan:
        caseFrame.query_plan && typeof caseFrame.query_plan === "object"
          ? {
              concept_queries: Array.isArray(caseFrame.query_plan.concept_queries)
                ? caseFrame.query_plan.concept_queries.map((item: unknown) => String(item))
                : [],
              object_queries: Array.isArray(caseFrame.query_plan.object_queries)
                ? caseFrame.query_plan.object_queries.map((item: unknown) => String(item))
                : [],
              behavior_queries: Array.isArray(caseFrame.query_plan.behavior_queries)
                ? caseFrame.query_plan.behavior_queries.map((item: unknown) => String(item))
                : []
            }
          : undefined
    },
    working_hypotheses: Array.isArray(parsed.working_hypotheses) ? parsed.working_hypotheses.map((item) => String(item)).filter(Boolean) : [],
    candidate_actions: Array.isArray(parsed.candidate_actions) ? parsed.candidate_actions.map((item) => String(item)).filter(Boolean) : [],
    confirmed_facts: Array.isArray(parsed.confirmed_facts) ? parsed.confirmed_facts.map((item) => String(item)).filter(Boolean) : []
  };
}

function parseEvidenceJudgeOutput(input: unknown): EvidenceJudgeOutput {
  const parsed = (input ?? {}) as Partial<EvidenceJudgeOutput>;
  return {
    verdict: parsed.verdict === "verified" || parsed.verdict === "partial" ? parsed.verdict : "unsupported",
    summary: String(parsed.summary ?? ""),
    claim_map: Array.isArray(parsed.claim_map)
      ? parsed.claim_map
          .map((item) => item as Record<string, unknown>)
          .map((item) => ({
            text: String(item.text ?? ""),
            kind: (
                item.kind === "grounded_inference"
                  ? "grounded_inference"
                  : item.kind === "operational_advice"
                  ? "operational_advice"
                  : item.kind === "unknown"
                  ? "unknown"
                  : "verified_fact") as "verified_fact" | "grounded_inference" | "operational_advice" | "unknown",
            verdict: (
                item.verdict === "verified" ? "verified" : item.verdict === "supported_inference" ? "supported_inference" : "unsupported"
            ) as "verified" | "supported_inference" | "unsupported",
            citation_ids: Array.isArray(item.citation_ids) ? item.citation_ids.map((value) => String(value)).filter(Boolean) : []
          }))
          .filter((item) => item.text)
      : [],
    evidence_gaps: Array.isArray(parsed.evidence_gaps) ? parsed.evidence_gaps.map((item) => String(item)).filter(Boolean) : [],
    handoff_threshold_reached: Boolean(parsed.handoff_threshold_reached)
  };
}

function parseCitationCuratorOutput(input: unknown, references: SearchReference[]): CitationCuratorOutput {
  const parsed = (input ?? {}) as Partial<CitationCuratorOutput>;
  return {
    user_visible_citations: Array.isArray(parsed.user_visible_citations)
      ? parsed.user_visible_citations.map((item) => String(item)).filter(Boolean)
      : references.slice(0, 3).map((item) => item.documentId),
    internal_supporting_evidence: Array.isArray(parsed.internal_supporting_evidence)
      ? parsed.internal_supporting_evidence.map((item) => String(item)).filter(Boolean)
      : [],
    evidence_sources: Array.isArray(parsed.evidence_sources)
      ? parsed.evidence_sources.map((item) => String(item)).filter(Boolean)
      : uniqueStrings(references.map((item) => item.sourceType || item.repo || "public_docs"), 6)
  };
}

function parseAnswerComposerOutput(input: unknown): AnswerComposerOutput {
  const parsed = (input ?? {}) as Partial<AnswerComposerOutput>;
  const mode =
    parsed.mode === "grounded" || parsed.mode === "partial" || parsed.mode === "clarification" ? parsed.mode : "handoff";
  return {
    mode,
    direct_answer: String(parsed.direct_answer ?? ""),
    why: Array.isArray(parsed.why) ? parsed.why.map((item) => String(item)).filter(Boolean) : [],
    what_to_do_now: Array.isArray(parsed.what_to_do_now) ? parsed.what_to_do_now.map((item) => String(item)).filter(Boolean) : [],
    still_need_to_confirm: Array.isArray(parsed.still_need_to_confirm)
      ? parsed.still_need_to_confirm.map((item) => String(item)).filter(Boolean)
      : [],
    structured_answer:
      parsed.structured_answer && typeof parsed.structured_answer === "object"
        ? {
            summary: String(parsed.structured_answer.summary ?? parsed.direct_answer ?? ""),
            assessment: parsed.structured_answer.assessment ? String(parsed.structured_answer.assessment) : undefined,
            steps: Array.isArray(parsed.structured_answer.steps)
              ? parsed.structured_answer.steps.map((item) => String(item)).filter(Boolean)
              : [],
            validation: Array.isArray(parsed.structured_answer.validation)
              ? parsed.structured_answer.validation.map((item) => String(item)).filter(Boolean)
              : [],
            required_inputs: Array.isArray(parsed.structured_answer.required_inputs)
              ? parsed.structured_answer.required_inputs.map((item) => String(item)).filter(Boolean)
              : undefined,
            style:
              parsed.structured_answer.style === "clarification" || parsed.structured_answer.style === "diagnosis"
                ? parsed.structured_answer.style
                : "kb_answer"
          }
        : undefined
  };
}

async function runRole(
  adapter: OpenClawAdapter,
  role: SupportAgentRole,
  caseId: string,
  prompt: string,
  idempotencyKey: string,
  stages: OrchestrationStage[],
  attachments?: string[]
): Promise<unknown> {
  if (!adapter.runAgentJson) {
    stages.push({ name: role, status: "skipped" });
    return null;
  }
  const registry = getSupportAgentRegistry();
  const runtime = buildSupportAgentRuntime({ registry, role, caseId });
  const startedAt = performance.now();
  try {
    const result = await adapter.runAgentJson(
      {
        prompt,
        attachments,
        runtime,
        stage: role,
        preferAgentRpc: true
      },
      `${idempotencyKey}:${role}`
    );
    stages.push({
      name: role,
      agent_id: runtime.agentId,
      status: "completed",
      duration_ms: Math.max(0, Math.round(performance.now() - startedAt))
    });
    return result;
  } catch {
    stages.push({
      name: role,
      agent_id: runtime.agentId,
      status: "fallback",
      duration_ms: Math.max(0, Math.round(performance.now() - startedAt))
    });
    return null;
  }
}

function toVerification(judge: EvidenceJudgeOutput, planner: SupportPlannerOutput, specialists: SpecialistOutput[]): SupportVerificationResult {
  const missing = uniqueStrings([
    ...judge.evidence_gaps,
    ...planner.case_frame.missing_critical_info,
    ...specialists.flatMap((item) => item.missing_inputs)
  ]);
  const supportedClaims = judge.claim_map.filter((item) => item.verdict !== "unsupported").map((item) => item.text);
  return {
    verdict: judge.verdict,
    summary: judge.summary,
    unsupported_claims: judge.claim_map.filter((item) => item.verdict === "unsupported").map((item) => item.text),
    missing_info: missing,
    verified_citation_ids: uniqueStrings(judge.claim_map.flatMap((item) => item.citation_ids), 12),
    verified_claims: uniqueStrings(supportedClaims, 10),
    claim_to_citation_map: judge.claim_map
  };
}

function selectSpecialists(router: RouterOutput): Array<SupportAgentRole> {
  return router.required_specialists.slice(0, 2);
}

export async function runMultiAgentSupportSearch(input: {
  caseId: string;
  query: string;
  language: "zh" | "en";
  currentRound: number;
  conversationHistory: SupportConversationTurn[];
  adapter: OpenClawAdapter;
  attachments?: string[];
  idempotencyKey: string;
}): Promise<{
  result: SearchModeResult;
  caseFrame: SupportCaseFrame;
  evidenceBundle: SupportEvidenceBundle;
  verification: SupportVerificationResult;
}> {
  if (!input.adapter.runAgentJson) {
    const fallback = await runSupportSearchAgent({
      query: input.query,
      language: input.language,
      currentRound: input.currentRound,
      conversationHistory: input.conversationHistory,
      adapter: input.adapter,
      attachments: input.attachments,
      idempotencyKey: input.idempotencyKey
    });
    return {
      result: {
        ...fallback.result,
        case_id: input.caseId
      },
      caseFrame: fallback.caseFrame,
      evidenceBundle: fallback.evidenceBundle,
      verification: fallback.verification
    };
  }

  const stages: OrchestrationStage[] = [];
  const registry = getSupportAgentRegistry();
  const orchestrator = new SearchOrchestrator(input.adapter);
  const conversationSummary = input.conversationHistory
    .slice(-8)
    .map((item) => `[${item.role}] ${item.content}`)
    .join("\n");

  const router = parseRouterOutput(
    await runRole(
      input.adapter,
      "router",
      input.caseId,
      [
        "You route support cases for ONES.",
        'Return ONLY valid JSON with keys: route(api|howto|behavior|troubleshooting|incident|product_defect), case_type, resolution_goal, required_specialists(string[]), clarification_needed(boolean), risk_level(low|medium|high)',
        `language: ${input.language}`,
        `user_query: ${input.query}`,
        conversationSummary ? `conversation:\n${conversationSummary}` : ""
      ]
        .filter(Boolean)
        .join("\n"),
      input.idempotencyKey,
      stages,
      input.attachments
    ),
    input.query
  );

  const evidencePlan = parseEvidencePlannerOutput(
    await runRole(
      input.adapter,
      "evidence_planner",
      input.caseId,
      [
        "You plan evidence gathering for a support case.",
        'Return ONLY valid JSON with keys: evidence_plan, queries(string[]), sources(string[]), blocking_unknowns(string[])',
        "Prefer public docs and GitHub KB for user-visible evidence, but include internal context sources when useful for diagnosis.",
        `router_route: ${router.route}`,
        `case_type: ${router.case_type}`,
        `resolution_goal: ${router.resolution_goal}`,
        `user_query: ${input.query}`,
        conversationSummary ? `conversation:\n${conversationSummary}` : ""
      ]
        .filter(Boolean)
        .join("\n"),
      input.idempotencyKey,
      stages
    ),
    input.query
  );

  const evidenceCollection = await orchestrator.collectEvidence({
    queries: uniqueStrings([input.query, ...evidencePlan.queries], 6),
    idempotencyKey: `${input.idempotencyKey}:evidence`,
    answerLanguage: input.language,
    attachments: input.attachments
  });

  const specialists = selectSpecialists(router);
  const specialistOutputs = await Promise.all(
    specialists.map(async (role) =>
      parseSpecialistOutput(
        await runRole(
          input.adapter,
          role,
          input.caseId,
          [
            "You are a domain specialist for ONES support.",
            "Return ONLY valid JSON with keys: findings(string[]), supported_claims(string[]), unsafe_claims(string[]), next_checks(string[]), missing_inputs(string[])",
            `specialist: ${role}`,
            `user_query: ${input.query}`,
            `router_route: ${router.route}`,
            `evidence_plan: ${evidencePlan.evidence_plan}`,
            `evidence_refs: ${JSON.stringify(evidenceCollection.references.slice(0, 4).map((item) => ({
              id: item.documentId,
              title: item.title,
              snippet: item.snippet,
              sourceUrl: item.sourceUrl
            })))}`,
            conversationSummary ? `conversation:\n${conversationSummary}` : ""
          ]
            .filter(Boolean)
            .join("\n"),
          input.idempotencyKey,
          stages
        )
      )
    )
  );

  const planner = parseSupportPlannerOutput(
    await runRole(
      input.adapter,
      "planner",
      input.caseId,
      [
        "You consolidate specialist findings into a support case frame.",
        'Return ONLY valid JSON with keys: case_frame({goal,symptom,object,action_type,deployment_model,product_area,constraints(string[]),missing_critical_info(string[]),retrieval_queries(string[]),query_plan({concept_queries:string[],object_queries:string[],behavior_queries:string[]})}), working_hypotheses(string[]), candidate_actions(string[]), confirmed_facts(string[])',
        `user_query: ${input.query}`,
        `router: ${JSON.stringify(router)}`,
        `evidence_plan: ${JSON.stringify(evidencePlan)}`,
        `specialist_outputs: ${JSON.stringify(specialistOutputs)}`
      ].join("\n"),
      input.idempotencyKey,
      stages
    ),
    input.query,
    evidencePlan
  );

  const evidenceBundle = buildEvidenceBundle({
    references: evidenceCollection.references,
    confidence: evidenceCollection.confidence,
    fallbackUsed: evidenceCollection.fallbackUsed,
    resolvedQueries: evidenceCollection.resolvedQueries,
    caseFrame: planner.case_frame
  });

  const judge = parseEvidenceJudgeOutput(
    await runRole(
      input.adapter,
      "evidence_judge",
      input.caseId,
      [
        "You judge whether the case has enough support evidence for a customer-facing answer.",
        'Return ONLY valid JSON with keys: verdict(verified|partial|unsupported), summary, claim_map([{text,kind,verdict,citation_ids(string[])}]), evidence_gaps(string[]), handoff_threshold_reached(boolean)',
        `case_frame: ${JSON.stringify(planner.case_frame)}`,
        `confirmed_facts: ${JSON.stringify(planner.confirmed_facts)}`,
        `specialist_outputs: ${JSON.stringify(specialistOutputs)}`,
        `evidence_bundle: ${JSON.stringify({
          primary: evidenceBundle.primary.slice(0, 4).map((item) => ({
            documentId: item.documentId,
            title: item.title,
            snippet: item.snippet,
            sourceUrl: item.sourceUrl
          })),
          supplemental: evidenceBundle.supplemental.slice(0, 2).map((item) => ({
            documentId: item.documentId,
            title: item.title,
            snippet: item.snippet,
            sourceUrl: item.sourceUrl
          }))
        })}`
      ].join("\n"),
      input.idempotencyKey,
      stages
    )
  );

  const verification = toVerification(judge, planner, specialistOutputs);
  const curator = parseCitationCuratorOutput(
    await runRole(
      input.adapter,
      "citation_curator",
      input.caseId,
      [
        "You curate user-visible citations for ONES support answers.",
        'Return ONLY valid JSON with keys: user_visible_citations(string[]), internal_supporting_evidence(string[]), evidence_sources(string[])',
        `verification: ${JSON.stringify(verification)}`,
        `references: ${JSON.stringify(evidenceCollection.references.slice(0, 6).map((item) => ({
          documentId: item.documentId,
          title: item.title,
          sourceUrl: item.sourceUrl,
          sourceType: item.sourceType,
          repo: item.repo
        })))}`
      ].join("\n"),
      input.idempotencyKey,
      stages
    ),
    evidenceCollection.references
  );

  const missingInfo = uniqueStrings([
    ...verification.missing_info,
    ...planner.case_frame.missing_critical_info,
    ...specialistOutputs.flatMap((item) => item.missing_inputs)
  ]);
  const mode = determineMode({
    verification,
    references: evidenceCollection.references,
    currentRound: input.currentRound + 1,
    missingInfo,
    handoffThresholdReached: judge.handoff_threshold_reached || router.route === "incident" || router.route === "product_defect"
  });
  const composer = parseAnswerComposerOutput(
    await runRole(
      input.adapter,
      "answer_composer",
      input.caseId,
      [
        "You compose the final support answer for the customer.",
        'Return ONLY valid JSON with keys: mode(grounded|partial|clarification|handoff), direct_answer, why(string[]), what_to_do_now(string[]), still_need_to_confirm(string[]), structured_answer({summary,assessment,steps(string[]),validation(string[]),required_inputs(string[]),style(kb_answer|diagnosis|clarification)})',
        "Preserve concrete, case-specific language. Do not use generic filler. Ask only one targeted clarification if needed.",
        `language: ${input.language}`,
        `target_mode: ${mode}`,
        `router: ${JSON.stringify(router)}`,
        `case_frame: ${JSON.stringify(planner.case_frame)}`,
        `verification: ${JSON.stringify(verification)}`,
        `confirmed_facts: ${JSON.stringify(planner.confirmed_facts)}`,
        `candidate_actions: ${JSON.stringify(uniqueStrings([...planner.candidate_actions, ...specialistOutputs.flatMap((item) => item.next_checks)], 6))}`,
        `missing_info: ${JSON.stringify(missingInfo)}`,
        `user_visible_citations: ${JSON.stringify(curator.user_visible_citations)}`
      ].join("\n"),
      input.idempotencyKey,
      stages
    )
  );

  const supportAnswer = buildSupportAnswer({
    mode,
    composer,
    verification,
    missingInfo
  });
  const structuredAnswer = buildStructuredAnswer({
    mode,
    supportAnswer,
    composer: composer.structured_answer
  });
  const citations = buildCitations([...evidenceBundle.primary, ...evidenceBundle.supplemental], curator.user_visible_citations);
  const clarificationRound =
    mode === "clarification"
      ? input.currentRound + 1
      : mode === "handoff" && missingInfo.length > 0
      ? Math.min(env.AI_SEARCH_MAX_CLARIFICATION_ROUNDS, input.currentRound + 1)
      : 0;

  const state =
    mode === "clarification"
      ? input.currentRound > 0
        ? "CLARIFICATION_IN_PROGRESS"
        : "CLARIFICATION_REQUIRED"
      : mode === "handoff"
      ? "TICKET_HANDOFF_RECOMMENDED"
      : "GROUNDABLE_ANSWER_READY";
  const unresolvedReasonCode =
    evidenceCollection.retrievalStatus === "kb_unavailable"
      ? "KB_RETRIEVAL_UNAVAILABLE"
      : mode === "handoff"
      ? evidenceCollection.references.length
        ? "LOW_CONFIDENCE"
        : "NO_MATCHING_KB"
      : mode === "clarification" && evidenceCollection.references.length === 0
      ? "NO_MATCHING_KB"
      : null;

  const orchestrationTrace = {
    route: router.route,
    case_type: router.case_type,
    mode,
    agent_ids: uniqueStrings(stages.map((item) => item.agent_id), 24),
    session_keys: uniqueStrings(
      ["router", "evidence_planner", ...specialists, "planner", "evidence_judge", "citation_curator", "answer_composer"].map((role) =>
        buildSupportAgentRuntime({ registry, role: role as SupportAgentRole, caseId: input.caseId }).sessionKey
      ),
      24
    ),
    stages
  };

  return {
    caseFrame: planner.case_frame,
    evidenceBundle,
    verification,
    result: {
      session_id: input.caseId,
      case_id: input.caseId,
      answer: supportAnswer.direct_answer,
      answer_language: input.language,
      case_frame: planner.case_frame,
      support_answer: supportAnswer,
      verification,
      structured_answer: structuredAnswer,
      confidence: evidenceCollection.confidence,
      suggested_next_step: mode === "handoff" ? "submit_ticket" : "self_serve",
      retrieval_status:
        evidenceCollection.retrievalStatus === "kb_unavailable"
          ? "kb_unavailable"
          : evidenceCollection.references.length > 0
          ? "grounded"
          : "no_results",
      unresolved_reason_code: unresolvedReasonCode,
      references: [...evidenceBundle.primary, ...evidenceBundle.supplemental],
      citations,
      state,
      clarification_round: clarificationRound,
      show_create_ticket_now: mode === "handoff",
      follow_up_question: mode === "clarification" ? missingInfo[0] ?? supportAnswer.still_need_to_confirm[0] ?? null : null,
      orchestration_trace: orchestrationTrace,
      specialists_used: specialists,
      confirmed_facts: uniqueStrings([...planner.confirmed_facts, ...verification.verified_claims], 10),
      evidence_sources: curator.evidence_sources,
      internal_diagnostics: {
        router,
        evidence_plan: evidencePlan,
        working_hypotheses: planner.working_hypotheses,
        candidate_actions: planner.candidate_actions,
        internal_supporting_evidence: curator.internal_supporting_evidence,
        evidence_bundle_digest: stableHash(evidenceBundle)
      }
    }
  };
}
