import type { TicketStatus } from "../contracts/tickets.js";

const transitions: Record<TicketStatus, TicketStatus[]> = {
  NEW: ["AI_REVIEWING", "ESCALATED"],
  AI_REVIEWING: ["WAITING_CUSTOMER", "ESCALATED", "RESOLVED"],
  WAITING_CUSTOMER: ["AI_REVIEWING", "RESOLVED", "ESCALATED"],
  ESCALATED: ["WAITING_CUSTOMER", "RESOLVED"],
  RESOLVED: ["CLOSED", "WAITING_CUSTOMER"],
  CLOSED: []
};

export function canTransition(from: TicketStatus, to: TicketStatus): boolean {
  return transitions[from].includes(to);
}
