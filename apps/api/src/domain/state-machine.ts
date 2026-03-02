import type { TicketStatus } from "../contracts/tickets.js";

const transitions: Record<TicketStatus, TicketStatus[]> = {
  OPEN: ["IN_PROGRESS", "ESCALATED_RND"],
  IN_PROGRESS: ["WAITING_CUSTOMER", "ESCALATED_RND", "RESOLVED"],
  WAITING_CUSTOMER: ["IN_PROGRESS", "RESOLVED", "ESCALATED_RND"],
  ESCALATED_RND: ["IN_PROGRESS", "WAITING_CUSTOMER", "RESOLVED"],
  RESOLVED: ["CLOSED", "IN_PROGRESS"],
  CLOSED: []
};

export function canTransition(from: TicketStatus, to: TicketStatus): boolean {
  return transitions[from].includes(to);
}
