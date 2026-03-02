import { pool } from "../../db/client.js";
import { canTransition } from "../../domain/state-machine.js";
import type { OpenClawAdapter, OpenClawAnalyzeOutput, OpenClawDecisionAction } from "../../infrastructure/openclaw/types.js";
import * as tickets from "../tickets/repository.js";

interface SearchModeResultItem {
  id: string;
  title: string;
  excerpt: string;
  score: number;
  domain: string;
}

export interface SearchModeResult {
  answer: string;
  citations: SearchModeResultItem[];
  suggested_next_step: "self_serve" | "submit_ticket";
}

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

export async function runSearchMode(query: string): Promise<SearchModeResult> {
  const result = await pool.query<{
    id: string;
    title: string;
    content: string;
    domain: string;
    score: number;
  }>(
    `SELECT id, title, content, domain, ts_rank(to_tsvector('english', content), plainto_tsquery('english', $1)) AS score
     FROM knowledge_documents
     WHERE domain = 'public_kb' AND visibility = 'customer' AND quality = 'verified'
       AND (to_tsvector('english', title || ' ' || content) @@ plainto_tsquery('english', $1))
     ORDER BY score DESC, created_at DESC
     LIMIT 5`,
    [query]
  );

  const citations: SearchModeResultItem[] = result.rows.map((row) => ({
    id: row.id,
    title: row.title,
    excerpt: row.content.slice(0, 180),
    score: Number(row.score) || 0,
    domain: row.domain
  }));

  if (!citations.length) {
    return {
      answer: "I could not find a verified knowledge base article for this issue. Please submit a ticket and include your environment details and error message.",
      citations: [],
      suggested_next_step: "submit_ticket"
    };
  }

  const top = citations[0];
  return {
    answer: `I found guidance in "${top.title}". Start with the documented steps. If this does not resolve your issue, submit a ticket from the same page for deeper investigation.`,
    citations,
    suggested_next_step: "self_serve"
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
    await tickets.failAiRun(runId, (error as Error).message);
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
        error: (error as Error).message
      });
    }
    throw error;
  }
}
