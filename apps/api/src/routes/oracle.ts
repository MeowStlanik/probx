import { db, nextId } from "../db/client.js";
import type { Outcome } from "../db/schema.js";
import { simulateOracleEvent } from "../services/demoOracle.js";
import { cancelMarketOnchain, onchainEnabled, resolveMarketOnchain, resolveReferenceMarketOnchain } from "../services/onchainService.js";
import { cancelTicketsForMarket, settleTicketsForMarket } from "./tickets.js";

export function simulateEvent(marketId: string) {
  const market = db.markets.find((item) => item.id === marketId);
  if (!market) return undefined;
  const event = simulateOracleEvent(market, nextId("evt", db.oracleEvents));
  db.oracleEvents.push(event);
  return event;
}

export async function resolveMarket(marketId: string, outcome?: Outcome) {
  if (onchainEnabled() && outcome) {
    try {
      return await resolveMarketOnchain(marketId, outcome);
    } catch (error) {
      return { error: error instanceof Error ? error.message : "onchain resolve failed" };
    }
  }

  const market = db.markets.find((item) => item.id === marketId);
  if (!market) return undefined;
  const finalOutcome = outcome ?? simulateEvent(marketId)?.outcome ?? "NO";
  market.status = "RESOLVED";
  market.winningOutcome = finalOutcome;
  const settledTickets = settleTicketsForMarket(marketId);
  return { market, settledTickets };
}

export async function resolveReferenceMarket(marketId: string) {
  if (onchainEnabled()) {
    try {
      return await resolveReferenceMarketOnchain(marketId);
    } catch (error) {
      return { error: error instanceof Error ? error.message : "onchain reference resolve failed" };
    }
  }

  return { error: "Reference resolve is only available for onchain demo markets." };
}

export async function cancelMarket(marketId: string, reason = "demo oracle unavailable") {
  if (onchainEnabled()) {
    try {
      return await cancelMarketOnchain(marketId, reason);
    } catch (error) {
      return { error: error instanceof Error ? error.message : "onchain cancel failed" };
    }
  }

  const market = db.markets.find((item) => item.id === marketId);
  if (!market) return undefined;
  market.status = "CANCELLED";
  const cancelledTickets = cancelTicketsForMarket(marketId);
  return { market, reason, cancelledTickets };
}
