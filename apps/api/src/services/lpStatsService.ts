import type { LpSnapshot, Ticket } from "../db/schema.js";

export function buildLpStats(lp: LpSnapshot, tickets: Ticket[]): LpSnapshot {
  const openTickets = tickets.filter((ticket) => ticket.status === "OPEN");
  const reservedLiquidity = openTickets.reduce((sum, ticket) => sum + ticket.requiredReserve, lp.reservedLiquidity);
  const lockedUserRisk = openTickets.reduce((sum, ticket) => sum + ticket.riskAmount, lp.lockedUserRisk);
  const dailyVolume = Math.max(lp.dailyVolume, tickets.reduce((sum, ticket) => sum + ticket.riskAmount, 0));
  const netLpTakeRate = 0.005;
  const simulatedApy = lp.tvl === 0 ? 0 : ((dailyVolume * netLpTakeRate * 365) / lp.tvl) * 100;

  return {
    ...lp,
    reservedLiquidity,
    lockedUserRisk,
    availableLiquidity: Math.max(lp.tvl - reservedLiquidity - lockedUserRisk, 0),
    dailyVolume,
    simulatedApy: Math.round(simulatedApy * 100) / 100
  };
}
