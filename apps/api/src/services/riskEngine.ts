import type { LpSnapshot, Market, Outcome, PriceQuote, Ticket } from "../db/schema.js";

const MAX_MARKET_RESERVE_RATE = 0.02;
const MAX_OUTCOME_RESERVE_RATE = 0.01;
const MAX_USER_RESERVE_RATE = 0.0025;

export interface RiskCheckInput {
  market: Market;
  quote: PriceQuote;
  tickets: Ticket[];
  lp: LpSnapshot;
  userAddress?: string;
}

export function applyExposureChecks(input: RiskCheckInput): PriceQuote {
  if (!input.quote.accepted) return input.quote;

  const marketTickets = input.tickets.filter((ticket) => ticket.marketId === input.market.id && ticket.status === "OPEN");
  const userTickets = input.userAddress
    ? input.tickets.filter((ticket) => ticket.owner.toLowerCase() === input.userAddress?.toLowerCase() && ticket.status === "OPEN")
    : [];
  const outcomeTickets = marketTickets.filter((ticket) => ticket.outcome === input.quote.outcome);

  const marketReserve = sumReserve(marketTickets) + input.quote.requiredReserve;
  const outcomeReserve = sumReserve(outcomeTickets) + input.quote.requiredReserve;
  const userReserve = sumReserve(userTickets) + input.quote.requiredReserve;

  if (marketReserve > input.lp.tvl * MAX_MARKET_RESERVE_RATE) {
    return { ...input.quote, accepted: false, reason: "MARKET_RESERVE_CAP" };
  }

  if (outcomeReserve > input.lp.tvl * MAX_OUTCOME_RESERVE_RATE) {
    return { ...input.quote, accepted: false, reason: "OUTCOME_RESERVE_CAP" };
  }

  if (userReserve > input.lp.tvl * MAX_USER_RESERVE_RATE) {
    return { ...input.quote, accepted: false, reason: "USER_RESERVE_CAP" };
  }

  if (!marketSolventAfter(input.market.id, input.quote.outcome, input.quote, input.tickets)) {
    return { ...input.quote, accepted: false, reason: "MARKET_SOLVENCY" };
  }

  return input.quote;
}

export function marketSolventAfter(marketId: string, outcome: Outcome, quote: PriceQuote, tickets: Ticket[]): boolean {
  const openTickets = tickets.filter((ticket) => ticket.marketId === marketId && ticket.status === "OPEN");
  const totalUserRisk = openTickets.reduce((sum, ticket) => sum + ticket.riskAmount, quote.riskAmount);
  const lpReserveAllocated = openTickets.reduce((sum, ticket) => sum + ticket.requiredReserve, quote.requiredReserve);
  const payoutIfYes =
    openTickets.filter((ticket) => ticket.outcome === "YES").reduce((sum, ticket) => sum + ticket.payout, 0) +
    (outcome === "YES" ? quote.payout : 0);
  const payoutIfNo =
    openTickets.filter((ticket) => ticket.outcome === "NO").reduce((sum, ticket) => sum + ticket.payout, 0) +
    (outcome === "NO" ? quote.payout : 0);

  return Math.max(payoutIfYes, payoutIfNo) <= totalUserRisk + lpReserveAllocated;
}

function sumReserve(tickets: Ticket[]): number {
  return tickets.reduce((sum, ticket) => sum + ticket.requiredReserve, 0);
}
