import type {
  TicketAiApplyInput,
  TicketBulkActionInput,
  TicketAssignInput,
  TicketCreateInput,
  TicketInternalTransitionInput,
  TicketReplyInput,
  TicketStatus
} from "../../contracts/tickets.js";
import { canTransition } from "../../domain/state-machine.js";
import * as repo from "./repository.js";
import * as onesSyncService from "../ones-sync/service.js";
import type { TriageSupportInsight } from "../ai/types.js";

export async function createTicket(input: TicketCreateInput) {
  return repo.createTicket(input);
}

export async function listTickets(params: { customerId?: string; status?: TicketStatus; sort: "created_desc" | "updated_desc" }) {
  return repo.listTickets(params);
}

export async function getTicketDetail(id: string) {
  const ticket = await repo.getTicketById(id);
  if (!ticket) {
    throw new Error("Ticket not found");
  }
  const messages = await repo.listTicketMessages(id);
  const latestAi = await repo.getLatestCompletedAiRunResponse(id);
  return {
    ticket: {
      ...ticket,
      triage_reasoning_summary:
        typeof latestAi?.support_insight?.support_summary === "string"
          ? latestAi.support_insight.support_summary
          : latestAi?.reasoning_summary ?? null,
      triage_evidence: Array.isArray(latestAi?.support_insight?.verified_evidence)
        ? (latestAi?.support_insight?.verified_evidence as string[])
        : Array.isArray(latestAi?.evidence)
        ? latestAi.evidence
        : [],
      triage_support_insight: latestAi?.support_insight ?? null,
      triage_verification_summary: latestAi?.verification_summary ?? null,
      triage_case_frame: latestAi?.case_frame ?? null,
      evidence_bundle_digest: latestAi?.evidence_bundle_digest ?? null
    },
    messages
  };
}

export async function addReply(id: string, input: TicketReplyInput) {
  const ticket = await repo.getTicketById(id);
  if (!ticket) {
    throw new Error("Ticket not found");
  }

  await repo.addMessage({
    ticketId: id,
    authorType: input.authorType,
    authorName: input.authorName,
    body: input.body,
    attachments: input.attachments,
    isAiGenerated: false,
    aiConfidence: null
  });

  const dataSourceMode = await onesSyncService.getDataSourceMode();
  if (dataSourceMode === "ones_primary" && ticket.ones_ticket_key && ticket.ones_ticket_type_key) {
    await onesSyncService.updateOnesTicketByFlow({
      flow: "comment",
      ticketTypeKey: ticket.ones_ticket_type_key,
      onesTicketKey: ticket.ones_ticket_key,
      context: {
        body: input.body,
        authorName: input.authorName,
        authorType: input.authorType
      }
    });
  }

  if (input.authorType === "CUSTOMER" && ticket.status === "WAITING_CUSTOMER") {
    if (canTransition("WAITING_CUSTOMER", "IN_PROGRESS")) {
      await repo.transitionTicket(id, "WAITING_CUSTOMER", "IN_PROGRESS");
      await repo.addAuditLog(id, "workflow_stage_changed", "WAITING_CUSTOMER", "IN_PROGRESS", {
        reasonCode: "customer_reply",
        sla_effect: "resume_active_timer"
      });
    }
  }

  if (input.authorType === "AGENT" && (ticket.status === "IN_PROGRESS" || ticket.status === "ESCALATED_RND")) {
    if (canTransition(ticket.status, "WAITING_CUSTOMER")) {
      await repo.transitionTicket(id, ticket.status, "WAITING_CUSTOMER");
      await repo.addAuditLog(id, "workflow_stage_changed", ticket.status, "WAITING_CUSTOMER", {
        reasonCode: "manual_waiting_customer",
        sla_effect: "pause_active_timer"
      });
    }
    await repo.clearAiSuggestionPending(id);
  }
}

export async function closeTicket(id: string) {
  const ticket = await repo.getTicketById(id);
  if (!ticket) {
    throw new Error("Ticket not found");
  }

  if (!canTransition(ticket.status, "CLOSED")) {
    throw new Error(`Invalid transition ${ticket.status} -> CLOSED`);
  }

  await repo.transitionTicket(id, ticket.status, "CLOSED");
}

export async function transition(id: string, to: TicketStatus) {
  const ticket = await repo.getTicketById(id);
  if (!ticket) {
    throw new Error("Ticket not found");
  }
  if (!canTransition(ticket.status, to)) {
    throw new Error(`Invalid transition ${ticket.status} -> ${to}`);
  }
  await repo.transitionTicket(id, ticket.status, to);
}

export async function transitionInternal(id: string, input: TicketInternalTransitionInput) {
  const ticket = await repo.getTicketById(id);
  if (!ticket) {
    throw new Error("Ticket not found");
  }
  if (!canTransition(ticket.status, input.to)) {
    throw new Error(`Invalid transition ${ticket.status} -> ${input.to}`);
  }
  await repo.transitionTicket(id, ticket.status, input.to);
  const dataSourceMode = await onesSyncService.getDataSourceMode();
  if (dataSourceMode === "ones_primary" && ticket.ones_ticket_key && ticket.ones_ticket_type_key) {
    await onesSyncService.updateOnesTicketByFlow({
      flow: "transition",
      ticketTypeKey: ticket.ones_ticket_type_key,
      onesTicketKey: ticket.ones_ticket_key,
      context: {
        toStatus: input.to,
        reasonCode: input.reasonCode
      }
    });
  }
  await repo.addAuditLog(id, "internal_transition", ticket.status, input.to, {
    reasonCode: input.reasonCode,
    sla_effect: input.to === "WAITING_CUSTOMER" ? "pause_active_timer" : "none"
  });
  await repo.clearAiSuggestionPending(id);
}

export async function assign(id: string, input: TicketAssignInput) {
  const ticket = await repo.getTicketById(id);
  if (!ticket) {
    throw new Error("Ticket not found");
  }
  await repo.setTicketAssignee(id, input.assigneeType, input.assigneeName);
  await repo.addAuditLog(id, "assignee_changed", null, null, {
    assigneeType: input.assigneeType,
    assigneeName: input.assigneeName,
    reasonCode: input.reasonCode
  });
  await repo.clearAiSuggestionPending(id);
}

export async function applyBulkAction(input: TicketBulkActionInput) {
  const results: Array<{ id: string; ok: boolean; error?: string }> = [];
  for (const ticketId of input.ticketIds) {
    try {
      if (input.action === "assign") {
        if (!input.assigneeType || !input.assigneeName) {
          throw new Error("assigneeType and assigneeName are required for assign");
        }
        await assign(ticketId, {
          assigneeType: input.assigneeType,
          assigneeName: input.assigneeName,
          reasonCode: "manual_claim"
        });
      } else if (input.action === "priority") {
        if (!input.priority) {
          throw new Error("priority is required for priority action");
        }
        await repo.setTicketPriority(ticketId, input.priority);
        await repo.addAuditLog(ticketId, "priority_changed", null, null, {
          priority: input.priority,
          actor: input.actor
        });
      } else if (input.action === "escalate") {
        const ticket = await repo.getTicketById(ticketId);
        if (!ticket) throw new Error("Ticket not found");
        if (canTransition(ticket.status, "ESCALATED_RND")) {
          await repo.transitionTicket(ticketId, ticket.status, "ESCALATED_RND");
        }
        await repo.setTicketAssignee(ticketId, "RND_TEAM", "R&D Team");
        await repo.addAuditLog(ticketId, "bulk_escalated_rnd", ticket.status, "ESCALATED_RND", { actor: input.actor });
      }
      results.push({ id: ticketId, ok: true });
    } catch (error) {
      results.push({ id: ticketId, ok: false, error: (error as Error).message });
    }
  }
  return {
    total: input.ticketIds.length,
    success: results.filter((r) => r.ok).length,
    failed: results.filter((r) => !r.ok).length,
    results
  };
}

export async function applyLatestAiSuggestion(id: string, input: TicketAiApplyInput) {
  const ticket = await repo.getTicketById(id);
  if (!ticket) {
    throw new Error("Ticket not found");
  }
  if (input.traceId && ticket.ai_last_trace_id && input.traceId !== ticket.ai_last_trace_id) {
    throw Object.assign(new Error("AI suggestion is stale"), { statusCode: 409 });
  }

  const latestAi = await repo.getLatestCompletedAiRunResponse(id);
  const insight = (latestAi?.support_insight ?? null) as TriageSupportInsight | null;
  if (!insight) {
    throw Object.assign(new Error("AI suggestion is not available"), { statusCode: 400 });
  }

  const action = insight.recommended_action;
  const replyPolicy = insight.customer_reply_policy ?? (action === "escalate" ? "no_send" : "send_now");
  const reply = insight.customer_reply?.trim() ?? "";
  let messagePosted = false;

  if ((action === "ask_user" || action === "resolve") && replyPolicy === "send_now" && reply) {
    await addReply(id, {
      body: reply,
      authorType: "AGENT",
      authorName: "Support Team",
      attachments: []
    });
    messagePosted = true;
  }

  if (action === "resolve") {
    const latest = await repo.getTicketById(id);
    if (latest && latest.status !== "RESOLVED" && canTransition(latest.status, "RESOLVED")) {
      await transitionInternal(id, {
        to: "RESOLVED",
        reasonCode: "manual_resolution"
      });
    }
  } else if (action === "escalate") {
    const latest = await repo.getTicketById(id);
    if (latest && latest.status !== "ESCALATED_RND" && canTransition(latest.status, "ESCALATED_RND")) {
      await transitionInternal(id, {
        to: "ESCALATED_RND",
        reasonCode: "manual_escalation"
      });
    }
    await assign(id, {
      assigneeType: "RND_TEAM",
      assigneeName: "R&D Team",
      reasonCode: "manual_escalation"
    });
  } else if (!messagePosted) {
    const latest = await repo.getTicketById(id);
    if (latest && latest.status !== "WAITING_CUSTOMER" && canTransition(latest.status, "WAITING_CUSTOMER")) {
      await transitionInternal(id, {
        to: "WAITING_CUSTOMER",
        reasonCode: "manual_waiting_customer"
      });
    }
  }

  const detail = await getTicketDetail(id);
  return {
    appliedAction: action,
    traceId: ticket.ai_last_trace_id,
    messagePosted,
    ticket: detail.ticket
  };
}
