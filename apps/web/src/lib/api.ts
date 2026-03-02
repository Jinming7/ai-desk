import type { Ticket, TicketMessage } from "./types";

const API = import.meta.env.VITE_API_BASE_URL || "http://localhost:4000";

export async function listTickets(customerId?: string): Promise<Ticket[]> {
  const query = customerId ? `?customerId=${encodeURIComponent(customerId)}` : "";
  const res = await fetch(`${API}/api/v1/tickets${query}`);
  if (!res.ok) throw new Error("Failed to load tickets");
  const data = await res.json();
  return data.tickets;
}

export async function getTicketDetail(id: string): Promise<{ ticket: Ticket; messages: TicketMessage[] }> {
  const res = await fetch(`${API}/api/v1/tickets/${id}`);
  if (!res.ok) throw new Error("Failed to load ticket detail");
  return res.json();
}

export async function createTicket(payload: {
  title: string;
  description: string;
  serviceCategory: "technical_support" | "feature_consulting" | "account_issue";
}) {
  const res = await fetch(`${API}/api/v1/tickets`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      ...payload,
      priority: "P3",
      customer: {
        id: "customer_demo",
        name: "Acme User"
      }
    })
  });

  if (!res.ok) throw new Error("Failed to create ticket");
  return res.json();
}
