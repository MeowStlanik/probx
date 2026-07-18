import type { Market, MarketStatus } from "../db/schema.js";

export function deriveMarketStatus(market: Market, now = new Date()): MarketStatus {
  if (market.status === "RESOLVED" || market.status === "CANCELLED" || market.status === "ARCHIVED") {
    return market.status;
  }

  const time = now.getTime();
  if (time < new Date(market.openTime).getTime()) return "CREATED";
  if (time < new Date(market.lockTime).getTime()) return "OPEN";
  if (time < new Date(market.observationEnd).getTime()) return "OBSERVATION";
  return "LOCKED";
}

export function refreshMarket(market: Market): Market {
  return { ...market, status: deriveMarketStatus(market) };
}
