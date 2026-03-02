export type TicketStatus = "OPEN" | "IN_PROGRESS" | "WAITING_CUSTOMER" | "ESCALATED_RND" | "RESOLVED" | "CLOSED";

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
  author_type: "CUSTOMER" | "AGENT";
  body: string;
  is_ai_generated: boolean;
  created_at: string;
}

export interface AgentQueueTicket {
  id: string;
  ticket_no: string;
  title: string;
  customer_name: string;
  status: TicketStatus;
  assignee_name: string;
  created_at: string;
  updated_at: string;
  sla_due_at: string | null;
  triage_reasoning_summary: string | null;
  triage_evidence: string[] | null;
  triage_confidence: number | null;
  handoff_reason_code: string | null;
}
