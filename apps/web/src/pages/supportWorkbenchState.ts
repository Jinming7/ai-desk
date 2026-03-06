export type SmartQueue = "sla_at_risk" | "ai_suggested" | "new_assigned" | "waiting_my_reply" | "my_all" | "resolved";

export interface SupportWorkbenchState {
  queue: SmartQueue;
  selectedTicketId: string | null;
}

export type SupportWorkbenchAction =
  | { type: "queue_selected"; queue: SmartQueue }
  | { type: "ticket_selected"; ticketId: string | null };

export function reduceWorkbenchState(
  state: SupportWorkbenchState,
  action: SupportWorkbenchAction
): SupportWorkbenchState {
  if (action.type === "queue_selected") {
    return { queue: action.queue, selectedTicketId: null };
  }
  return { ...state, selectedTicketId: action.ticketId };
}
