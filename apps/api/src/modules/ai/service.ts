import { canTransition } from "../../domain/state-machine.js";
import type { OpenClawAdapter, OpenClawAnalyzeOutput, OpenClawDecisionAction } from "../../infrastructure/openclaw/types.js";
import * as aiRepo from "./repository.js";
import { SearchOrchestrator } from "./search-orchestrator.js";
import type { SearchModeResult } from "./types.js";
import * as tickets from "../tickets/repository.js";

function normalizeAction(action: string): OpenClawDecisionAction {
  if (action === "ask_info") return "ask_user";
  if (action === "auto_resolve") return "resolve";
  if (action === "escalate" || action === "ask_user" || action === "resolve" || action === "none") return action;
  return "ask_user";
}

function normalizeAnalyzeOutput(raw: OpenClawAnalyzeOutput): OpenClawAnalyzeOutput {
  return {
    ...raw,
    action: normalizeAction(raw.action)
  };
}

function isOpenClawScopeOrAuthError(message: string): boolean {
  const text = message.toLowerCase();
  return text.includes("missing scope") || text.includes("token mismatch") || text.includes("auth_token_mismatch");
}

function localTriageFallback(input: { title: string; description: string }): OpenClawAnalyzeOutput {
  const content = `${input.title} ${input.description}`;
  const escalate = /urgent|production|outage|incident|failed|error/i.test(content);
  if (escalate) {
    return {
      action: "escalate",
      confidence: 0.52,
      reply: "",
      reasoning_summary: "OpenClaw permission degraded; fallback policy escalated high-risk wording.",
      evidence: ["fallback_policy"],
      risk_flags: ["possible_prod_impact"]
    };
  }
  return {
    action: "ask_user",
    confidence: 0.41,
    reply: "Thanks for the report. Please share exact error message, timestamp, and environment details so our support team can continue.",
    reasoning_summary: "OpenClaw permission degraded; fallback policy requested additional details.",
    evidence: ["fallback_policy"],
    risk_flags: []
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

    await tickets.completeAiRun(runId, result as unknown as Record<string, unknown>);

    if (result.action === "escalate") {
      const latest = await tickets.getTicketById(ticketId);
      if (latest && canTransition(latest.status, "ESCALATED_RND")) {
        await tickets.transitionTicket(ticketId, latest.status, "ESCALATED_RND");
      }
      await tickets.setTicketAssignee(ticketId, "RND_TEAM", "R&D Team");
      await tickets.addAuditLog(ticketId, "ai_triage_escalated", null, null, {
        reason: "model_escalation",
        reasonCode: "ai_model_escalation",
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

    if (result.action === "none") {
      await tickets.addAuditLog(ticketId, "ai_triage_no_action", null, null, {
        confidence: result.confidence,
        evidence: result.evidence
      });
      return result;
    }

    if (result.reply.trim()) {
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
    if (latest && canTransition(latest.status, "WAITING_CUSTOMER")) {
      await tickets.transitionTicket(ticketId, latest.status, "WAITING_CUSTOMER");
    }

    await tickets.setTicketAssignee(ticketId, "SUPPORT_TEAM", "Support Team");
    await tickets.addAuditLog(ticketId, "ai_triage_replied", null, "WAITING_CUSTOMER", {
      action: result.action,
      stage: "waiting_customer",
      status: "WAITING_CUSTOMER",
      assignee: "Support Team",
      customer_message_policy: "reply_from_support_team",
      sla_effect: "pause_active_timer",
      confidence: result.confidence,
      evidence: result.evidence
    });

    return result;
  } catch (error) {
    const message = (error as Error).message;
    await tickets.failAiRun(runId, message);

    if (isOpenClawScopeOrAuthError(message)) {
      const fallback = localTriageFallback({ title: input.title, description: input.description });
      await tickets.completeAiRun(runId, {
        ...fallback,
        fallback_mode: "scope_or_auth_degraded",
        original_error: message
      });

      if (fallback.action === "escalate") {
        const latest = await tickets.getTicketById(ticketId);
        if (latest && latest.status !== "ESCALATED_RND" && canTransition(latest.status, "ESCALATED_RND")) {
          await tickets.transitionTicket(ticketId, latest.status, "ESCALATED_RND");
          await tickets.setTicketAssignee(ticketId, "RND_TEAM", "R&D Team");
          await tickets.addAuditLog(ticketId, "ai_triage_fallback_escalated", latest.status, "ESCALATED_RND", {
            reason: "openclaw_scope_or_auth_error",
            reasonCode: "integration_failure",
            stage: "escalated_rnd",
            status: "ESCALATED_RND",
            assignee: "R&D Team",
            customer_message_policy: "none",
            sla_effect: "continue_active_timer",
            error: message
          });
        }
        return fallback;
      }

      await tickets.addMessage({
        ticketId,
        authorType: "AGENT",
        authorName: "Support Team",
        body: fallback.reply,
        attachments: [],
        isAiGenerated: true,
        aiConfidence: fallback.confidence
      });
      const latest = await tickets.getTicketById(ticketId);
      if (latest && canTransition(latest.status, "WAITING_CUSTOMER")) {
        await tickets.transitionTicket(ticketId, latest.status, "WAITING_CUSTOMER");
      }
      await tickets.setTicketAssignee(ticketId, "SUPPORT_TEAM", "Support Team");
      await tickets.addAuditLog(ticketId, "ai_triage_fallback_replied", null, "WAITING_CUSTOMER", {
        reason: "openclaw_scope_or_auth_error",
        reasonCode: "integration_failure",
        stage: "waiting_customer",
        status: "WAITING_CUSTOMER",
        assignee: "Support Team",
        customer_message_policy: "reply_from_support_team",
        sla_effect: "pause_active_timer",
        error: message
      });
      return fallback;
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
