import type {
  TicketBulkActionInput,
  TicketAssignInput,
  TicketCreateInput,
  TicketInternalTransitionInput,
  TicketReplyInput,
  TicketStatus
} from "../../contracts/tickets.js";
import { canTransition } from "../../domain/state-machine.js";
import * as repo from "./repository.js";

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
  return { ticket, messages };
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
