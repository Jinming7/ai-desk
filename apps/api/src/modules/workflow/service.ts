import type { TicketCreateInput } from "../../contracts/tickets.js";
import type { OpenClawAdapter } from "../../infrastructure/openclaw/types.js";
import * as aiService from "../ai/service.js";
import * as ticketsService from "../tickets/service.js";
import * as ticketsRepo from "../tickets/repository.js";
import * as settingsRepo from "../settings/repository.js";
import * as onesSyncService from "../ones-sync/service.js";

export async function submitTicketWorkflow(input: TicketCreateInput, adapter: OpenClawAdapter) {
  const ticket = await ticketsService.createTicket(input);
  let triage: unknown = null;
  let triageError: string | null = null;
  let onesSyncError: string | null = null;

  const dataSourceMode = await onesSyncService.getDataSourceMode();

  if (input.onesTicketTypeKey) {
    const allowed = await onesSyncService.isCustomerTicketTypeAllowed(input.onesTicketTypeKey);
    if (!allowed) {
      await ticketsRepo.deleteTicket(ticket.id);
      throw new Error(`Ticket type ${input.onesTicketTypeKey} is not allowed for customer portal`);
    }
    try {
      const config = await onesSyncService.getConfig();
      const ones = await onesSyncService.createOnesTicket({
        ticketTypeKey: input.onesTicketTypeKey,
        context: {
          title: input.title,
          description: input.description,
          customer: input.customer,
          projectKey: config?.onesProjectKey ?? null,
          fields: input.onesFields ?? {}
        }
      });
      await ticketsRepo.setTicketOnesSyncResult(ticket.id, { status: "synced", key: ones.key, error: null });
    } catch (error) {
      onesSyncError = (error as Error).message;
      await ticketsRepo.setTicketOnesSyncResult(ticket.id, { status: "failed", key: null, error: onesSyncError });
      await ticketsRepo.deleteTicket(ticket.id);
      throw new Error(`ONES sync failed: ${onesSyncError}`);
    }
  } else if (dataSourceMode === "ones_primary") {
    await ticketsRepo.deleteTicket(ticket.id);
    throw new Error("ONES primary mode requires onesTicketTypeKey for ticket creation");
  } else {
    await ticketsRepo.setTicketOnesSyncResult(ticket.id, { status: "not_configured", key: null, error: null });
  }

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
      onesSyncError,
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
    onesSyncError,
    lifecycle: {
      status: detail.ticket.status,
      assignee: detail.ticket.assignee_name
    }
  };
}
