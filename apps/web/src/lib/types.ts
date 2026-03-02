export type TicketStatus = "NEW" | "AI_REVIEWING" | "WAITING_CUSTOMER" | "ESCALATED" | "RESOLVED" | "CLOSED";

export interface Ticket {
  id: string;
  ticket_no: string;
  title: string;
  status: TicketStatus;
  assignee_name: string;
  customer_name: string;
  updated_at: string;
  created_at: string;
  sla_due_at: string;
}

export interface TicketMessage {
  id: string;
  author_name: string;
  author_type: "CUSTOMER" | "AGENT" | "AI_AGENT";
  body: string;
  is_ai_generated: boolean;
  created_at: string;
}
