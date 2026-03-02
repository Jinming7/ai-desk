import type { TicketCreateInput } from "../../contracts/tickets.js";
import type { OpenClawAdapter } from "../../infrastructure/openclaw/types.js";
import * as aiService from "../ai/service.js";
import * as ticketsService from "../tickets/service.js";

export async function submitTicketWorkflow(input: TicketCreateInput, adapter: OpenClawAdapter) {
  const ticket = await ticketsService.createTicket(input);
  let triage: unknown = null;
  let triageError: string | null = null;

  try {
    triage = await aiService.runTicketTriage(ticket.id, adapter);
  } catch (error) {
    triageError = (error as Error).message;
  }

  const detail = await ticketsService.getTicketDetail(ticket.id);
  return {
    ticket: detail.ticket,
    triage,
    triageError,
    lifecycle: {
      status: detail.ticket.status,
      assignee: detail.ticket.assignee_name
    }
  };
}
