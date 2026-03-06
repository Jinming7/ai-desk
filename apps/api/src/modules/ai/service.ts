import { canTransition } from "../../domain/state-machine.js";
import type { OpenClawAdapter, OpenClawAnalyzeOutput, OpenClawDecisionAction } from "../../infrastructure/openclaw/types.js";
import { env } from "../../config/env.js";
import crypto from "node:crypto";
import * as aiRepo from "./repository.js";
import { SearchOrchestrator } from "./search-orchestrator.js";
import type { SearchModeResult } from "./types.js";
import * as tickets from "../tickets/repository.js";
import * as settings from "../settings/repository.js";

function normalizeAction(action: string): OpenClawDecisionAction {
  if (action === "ask_info") return "ask_user";
  if (action === "auto_resolve") return "resolve";
  if (action === "none") return "none";
  if (action === "escalate" || action === "ask_user" || action === "resolve") return action;
  return "ask_user";
}

function containsCjk(text: string): boolean {
  return /[\u3400-\u9FBF]/.test(text);
}

function normalizeReplyToEnglish(action: OpenClawDecisionAction, text: string): string {
  const trimmed = text.trim();
  if (!trimmed) {
    if (action === "none") return "";
    return action === "resolve"
      ? "Thanks for your report. We have applied a fix and marked this ticket as resolved. Please verify and let us know if you still see the issue."
      : action === "escalate"
      ? "Thanks for your report. This issue requires deeper investigation, so I have escalated it to our R&D team."
      : "Thanks for contacting support. I need a bit more detail to proceed. Please share expected behavior, actual behavior, exact steps, and any error logs or screenshots.";
  }
  if (containsCjk(trimmed)) {
    if (action === "resolve") {
      return "Thanks for your report. We have completed the fix and set this ticket to resolved. Please confirm whether the issue is solved.";
    }
    if (action === "escalate") {
      return "Thanks for your report. We need deeper technical analysis, so this ticket has been escalated to our R&D team.";
    }
    return action === "none"
      ? ""
      : "Thanks for contacting support. Your ticket currently lacks actionable details. Please provide the exact issue, expected result, actual result, and reproduction steps.";
  }
  return trimmed;
}

function normalizeAnalyzeOutput(raw: OpenClawAnalyzeOutput): OpenClawAnalyzeOutput & { fallback_applied: boolean } {
  const normalizedAction = normalizeAction(raw.action);
  const fallbackApplied = raw.action !== normalizedAction || raw.action === undefined || raw.action === null;
  const reply = normalizeReplyToEnglish(normalizedAction, raw.reply);
  return {
    ...raw,
    action: normalizedAction,
    reply,
    fallback_applied: fallbackApplied
  };
}

export async function runSearchMode(query: string, adapter: OpenClawAdapter): Promise<SearchModeResult> {
  const orchestrator = new SearchOrchestrator(adapter);
  const response = await orchestrator.search(query, `search-${Date.now()}`);

  const suggestedNextStep = response.unresolvedReasonCode ? "submit_ticket" : "self_serve";
  const sessionId = await aiRepo.createSearchSession({
    query: response.query,
    answer: response.answer,
    confidence: response.confidence,
    retrievalStatus: response.retrievalStatus,
    unresolvedReasonCode: response.unresolvedReasonCode,
    suggestedNextStep
  });

  if (response.references.length) {
    await aiRepo.saveSearchReferences(sessionId, response.references);
  }

  await aiRepo.logMetric({
    sessionId,
    name: "hit_rate",
    value: response.references.length > 0 ? 1 : 0,
    payload: { retrievalStatus: response.retrievalStatus }
  });
  await aiRepo.logMetric({
    sessionId,
    name: "citation_coverage",
    value: response.references.length,
    payload: { queryLength: response.query.length }
  });
  await aiRepo.logMetric({
    sessionId,
    name: "fallback_rate",
    value: response.unresolvedReasonCode ? 1 : 0,
    payload: { reasonCode: response.unresolvedReasonCode }
  });

  return {
    session_id: sessionId,
    answer: response.answer,
    confidence: response.confidence,
    suggested_next_step: suggestedNextStep,
    retrieval_status: response.retrievalStatus,
    unresolved_reason_code: response.unresolvedReasonCode,
    references: response.references,
    citations: response.references.map((item) => ({
      id: item.documentId,
      title: item.title,
      excerpt: item.snippet,
      score: item.score,
      source_url: item.sourceUrl,
      retrieved_at: item.retrievedAt
    }))
  };
}

export async function runTicketTriage(ticketId: string, adapter: OpenClawAdapter) {
  const ticket = await tickets.getTicketById(ticketId);
  if (!ticket) {
    throw new Error("Ticket not found");
  }

  if ((ticket.status === "OPEN" || ticket.status === "WAITING_CUSTOMER") && canTransition(ticket.status, "IN_PROGRESS")) {
    await tickets.transitionTicket(ticketId, ticket.status, "IN_PROGRESS");
  }

  const refreshedTicket = await tickets.getTicketById(ticketId);
  if (!refreshedTicket) {
    throw new Error("Ticket not found");
  }

  const history = (await tickets.listTicketMessages(ticketId)).map((m) => ({
    author: m.author_name,
    body: m.body,
    at: m.created_at
  }));

  const aiRunSeq = await tickets.bumpAiRunSeq(ticketId);
  const idempotencyKey = `${ticketId}-${aiRunSeq}`;

  const input = {
    ticket_id: refreshedTicket.ticket_no,
    title: refreshedTicket.title,
    description: refreshedTicket.description,
    priority: refreshedTicket.priority,
    customer_meta: {
      customerId: refreshedTicket.customer_id,
      customerName: refreshedTicket.customer_name
    },
    history
  };

  const runId = await tickets.createAiRun({
    ticketId,
    idempotencyKey,
    payload: input
  });

  try {
    const rawResult = await adapter.analyzeTicket(input, idempotencyKey);
    const result = normalizeAnalyzeOutput(rawResult);
    const traceId = `${ticketId}:${idempotencyKey}:${Date.now()}`;
    const promptHash = crypto
      .createHash("sha256")
      .update(JSON.stringify(input))
      .digest("hex");
    const aiMode = await settings.getAiAgentMode();
    const modelName = process.env.OPENCLAW_AGENT_ID || "openclaw-agent";

    await tickets.finalizeAiRun(runId, {
      response: result as unknown as Record<string, unknown>,
      traceId,
      action: result.action,
      model: modelName,
      confidence: result.confidence,
      evidence: result.evidence,
      fallbackApplied: result.fallback_applied,
      promptHash
    });
    await tickets.setTicketAiSnapshot(ticketId, {
      traceId,
      action: result.action,
      confidence: result.confidence,
      model: modelName,
      fallbackApplied: result.fallback_applied,
      aiModeSnapshot: aiMode.enabled ? "AI_ON" : "AI_OFF"
    });

    if (result.action === "escalate") {
      const latest = await tickets.getTicketById(ticketId);
      if (latest && canTransition(latest.status, "ESCALATED_RND")) {
        await tickets.transitionTicket(ticketId, latest.status, "ESCALATED_RND");
      }
      await tickets.setTicketAssignee(ticketId, "RND_TEAM", "R&D Team");
      await tickets.addAuditLog(ticketId, "ai_triage_escalated", null, null, {
        reason: "model_escalation",
        reasonCode: "ai_model_escalation",
        traceId,
        stage: "escalated_rnd",
        status: "ESCALATED_RND",
        assignee: "R&D Team",
        customer_message_policy: "none",
        sla_effect: "continue_active_timer",
        confidence: result.confidence,
        evidence: result.evidence
      });
      return result;
    }

    const shouldReplyToCustomer = result.reply.trim().length > 0;
    if (shouldReplyToCustomer) {
      await tickets.addMessage({
        ticketId,
        authorType: "AGENT",
        authorName: "Support Team",
        body: result.reply,
        attachments: [],
        isAiGenerated: true,
        aiConfidence: result.confidence
      });
    }

    const latest = await tickets.getTicketById(ticketId);
    if (shouldReplyToCustomer && latest && canTransition(latest.status, "WAITING_CUSTOMER")) {
      await tickets.transitionTicket(ticketId, latest.status, "WAITING_CUSTOMER");
    }

    if (shouldReplyToCustomer) {
      await tickets.setTicketAssignee(ticketId, "SUPPORT_TEAM", "Support Team");
      await tickets.addAuditLog(ticketId, "ai_triage_replied", null, "WAITING_CUSTOMER", {
        action: result.action,
        traceId,
        stage: "waiting_customer",
        status: "WAITING_CUSTOMER",
        assignee: "Support Team",
        customer_message_policy: "reply_from_support_team",
        sla_effect: "pause_active_timer",
        confidence: result.confidence,
        evidence: result.evidence
      });
      return result;
    }

    if (result.action === "none") {
      await tickets.addAuditLog(ticketId, "ai_triage_no_action", null, null, {
        action: "none",
        traceId,
        stage: "triage_no_action",
        confidence: result.confidence,
        evidence: result.evidence
      });
    }

    return result;
  } catch (error) {
    const message = (error as Error).message;
    await tickets.failAiRun(runId, message);

    if (env.DISABLE_AI_TRIAGE_FALLBACK) {
      const latest = await tickets.getTicketById(ticketId);
      if (latest && latest.status !== "ESCALATED_RND" && canTransition(latest.status, "ESCALATED_RND")) {
        await tickets.transitionTicket(ticketId, latest.status, "ESCALATED_RND");
        await tickets.setTicketAssignee(ticketId, "RND_TEAM", "R&D Team");
      }
      await tickets.addAuditLog(ticketId, "ai_triage_escalated", null, "ESCALATED_RND", {
        reason: "openclaw_failure",
        reasonCode: "integration_failure",
        stage: "escalated_rnd",
        status: "ESCALATED_RND",
        assignee: "R&D Team",
        customer_message_policy: "none",
        sla_effect: "continue_active_timer",
        error: message
      });
      throw error;
    }

    const latest = await tickets.getTicketById(ticketId);
    if (latest && latest.status !== "ESCALATED_RND" && canTransition(latest.status, "ESCALATED_RND")) {
      await tickets.transitionTicket(ticketId, latest.status, "ESCALATED_RND");
      await tickets.setTicketAssignee(ticketId, "RND_TEAM", "R&D Team");
      await tickets.addAuditLog(ticketId, "ai_triage_fallback_escalated", latest.status, "ESCALATED_RND", {
        reason: "openclaw_failure",
        reasonCode: "integration_failure",
        stage: "escalated_rnd",
        status: "ESCALATED_RND",
        assignee: "R&D Team",
        customer_message_policy: "none",
        sla_effect: "continue_active_timer",
        error: message
      });
    }
    throw error;
  }
}
