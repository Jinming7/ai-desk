import type { TicketCreateInput, TicketReplyInput, TicketStatus } from "../../contracts/tickets.js";
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

  if (ticket.status === "WAITING_CUSTOMER") {
    if (canTransition("WAITING_CUSTOMER", "IN_PROGRESS")) {
      await repo.transitionTicket(id, "WAITING_CUSTOMER", "IN_PROGRESS");
    }
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
