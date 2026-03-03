import type { TicketCreateInput } from "../../contracts/tickets.js";
import type { OpenClawAdapter } from "../../infrastructure/openclaw/types.js";
import * as aiService from "../ai/service.js";
import * as ticketsService from "../tickets/service.js";
import * as ticketsRepo from "../tickets/repository.js";
import * as settingsRepo from "../settings/repository.js";

export async function submitTicketWorkflow(input: TicketCreateInput, adapter: OpenClawAdapter) {
  const ticket = await ticketsService.createTicket(input);
  let triage: unknown = null;
  let triageError: string | null = null;

  const aiMode = await settingsRepo.getAiAgentMode();
  if (!aiMode.enabled) {
    if (ticket.status === "OPEN") {
      await ticketsRepo.transitionTicket(ticket.id, "OPEN", "IN_PROGRESS");
    }
    await ticketsRepo.setTicketAssignee(ticket.id, "RND_TEAM", "R&D Team");
    await ticketsRepo.addAuditLog(ticket.id, "ai_bypassed_manual_mode", "OPEN", "IN_PROGRESS", {
      reason: "ai_agent_disabled",
      assignee: "R&D Team"
    });

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
