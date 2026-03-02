import * as tickets from "../tickets/repository.js";
import { canTransition } from "../../domain/state-machine.js";
import type { OpenClawAdapter } from "../../infrastructure/openclaw/types.js";

export async function runAiReview(ticketId: string, adapter: OpenClawAdapter) {
  const ticket = await tickets.getTicketById(ticketId);
  if (!ticket) {
    throw new Error("Ticket not found");
  }

  if (ticket.status === "NEW" && canTransition("NEW", "AI_REVIEWING")) {
    await tickets.transitionTicket(ticketId, "NEW", "AI_REVIEWING");
  }

  const history = (await tickets.listTicketMessages(ticketId)).map((m) => ({
    author: m.author_name,
    body: m.body,
    at: m.created_at
  }));

  const aiRunSeq = await tickets.bumpAiRunSeq(ticketId);
  const idempotencyKey = `${ticketId}-${aiRunSeq}`;

  const input = {
    ticket_id: ticket.ticket_no,
    title: ticket.title,
    description: ticket.description,
    priority: ticket.priority,
    customer_meta: {
      customerId: ticket.customer_id,
      customerName: ticket.customer_name
    },
    history
  };

  const runId = await tickets.createAiRun({
    ticketId,
    idempotencyKey,
    payload: input
  });

  try {
    const result = await adapter.analyzeTicket(input, idempotencyKey);

    await tickets.completeAiRun(runId, result as unknown as Record<string, unknown>);
    await tickets.addMessage({
      ticketId,
      authorType: "AI_AGENT",
      authorName: "OpenClaw AI Agent",
      body: result.reply,
      attachments: [],
      isAiGenerated: true,
      aiConfidence: result.confidence
    });

    if (result.action === "escalate") {
      if (canTransition(ticket.status, "ESCALATED")) {
        await tickets.transitionTicket(ticketId, ticket.status, "ESCALATED");
      }
      await tickets.setTicketAssignee(ticketId, "HUMAN_TEAM", "R&D Team");
    }

    if (result.action === "ask_info") {
      const refreshed = await tickets.getTicketById(ticketId);
      if (refreshed && canTransition(refreshed.status, "WAITING_CUSTOMER")) {
        await tickets.transitionTicket(ticketId, refreshed.status, "WAITING_CUSTOMER");
      }
    }

    if (result.action === "auto_resolve") {
      const refreshed = await tickets.getTicketById(ticketId);
      if (refreshed && canTransition(refreshed.status, "RESOLVED")) {
        await tickets.transitionTicket(ticketId, refreshed.status, "RESOLVED");
      }
    }

    return result;
  } catch (error) {
    await tickets.failAiRun(runId, (error as Error).message);
    throw error;
  }
}
