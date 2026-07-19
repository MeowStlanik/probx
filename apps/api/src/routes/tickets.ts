import { db } from "../db/client.js";
import type { Ticket } from "../db/schema.js";
import { onchainEnabled, settleMarketTicketsOnchain, ticketsForUserOnchain } from "../services/onchainService.js";

export async function ticketsForUser(address: string): Promise<Ticket[]> {
  if (onchainEnabled()) {
    try {
      return await ticketsForUserOnchain(address);
    } catch (error) {
      console.error("[tickets] onchain portfolio read failed", error);
      // Prefer empty array over 500 — client shows empty / local cache, not a hard error page.
      return db.tickets.filter((ticket) => ticket.owner.toLowerCase() === address.toLowerCase());
    }
  }
  return db.tickets.filter((ticket) => ticket.owner.toLowerCase() === address.toLowerCase());
}

export async function settleMarketTickets(marketId: string) {
  if (onchainEnabled()) {
    try {
      return await settleMarketTicketsOnchain(marketId);
    } catch (error) {
      return { error: error instanceof Error ? error.message : "onchain ticket settlement failed" };
    }
  }
  return settleTicketsForMarket(marketId);
}

export function settleTicketsForMarket(marketId: string): Ticket[] {
  const market = db.markets.find((item) => item.id === marketId);
  if (!market || market.status !== "RESOLVED" || !market.winningOutcome) return [];

  const settled: Ticket[] = [];
  for (const ticket of db.tickets) {
    if (ticket.marketId !== marketId || ticket.status !== "OPEN") continue;
    ticket.status = "SETTLED";
    ticket.result = ticket.outcome === market.winningOutcome ? "WIN" : "LOSS";
    ticket.settledAt = new Date().toISOString();
    settled.push(ticket);
  }
  return settled;
}

export function cancelTicketsForMarket(marketId: string): Ticket[] {
  const cancelled: Ticket[] = [];
  for (const ticket of db.tickets) {
    if (ticket.marketId !== marketId || ticket.status !== "OPEN") continue;
    ticket.status = "CANCELLED";
    ticket.result = "REFUND";
    ticket.settledAt = new Date().toISOString();
    cancelled.push(ticket);
  }
  return cancelled;
}
