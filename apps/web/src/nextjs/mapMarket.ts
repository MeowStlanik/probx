import { normalizeDisplayOdds } from "@/lib/format";
import type { Market, Ticket } from "@/lib/types";
import type { MarketStage } from "./theme";
import type { MarketDetail, MarketSummary, Position } from "./types";

/**
 * Lifecycle from wall-clock timestamps.
 * Bar: OPEN 47% · LOCK 14% · OBSERVE 28% · RESOLVE 11% (matches MarketCard labels).
 * On-chain status alone lags after lock — bar + pill track wall clock.
 */
export function deriveLifecycle(
  market: Market,
  now: number = Date.now()
): { stage: MarketStage; nowPct: number; secondsToNextStage: number } {
  const open = Date.parse(market.openTime || "") || now;
  const lock = Date.parse(market.lockTime || "") || open + 60_000;
  const obsStart = Date.parse(market.observationStart || "") || lock + 10_000;
  const obsEnd = Date.parse(market.observationEnd || "") || obsStart + 60_000;

  const finished =
    market.status === "RESOLVED" ||
    market.status === "CANCELLED" ||
    market.status === "ARCHIVED";
  if (finished || now >= obsEnd) {
    return { stage: "RESOLVE", nowPct: 96, secondsToNextStage: 0 };
  }

  const sec = (t: number) => Math.max(0, Math.ceil((t - now) / 1000));
  const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

  // OPEN: open → lock  (0–47%)
  if (now < lock) {
    const t = clamp01((now - open) / Math.max(1, lock - open));
    return { stage: "OPEN", nowPct: t * 47, secondsToNextStage: sec(lock) };
  }

  // LOCK: lock → observationStart (47–61%)
  if (now < obsStart) {
    const t = clamp01((now - lock) / Math.max(1, obsStart - lock));
    return { stage: "LOCK", nowPct: 47 + t * 14, secondsToNextStage: sec(obsStart) };
  }

  // OBSERVE: observationStart → observationEnd (61–89%)
  const t = clamp01((now - obsStart) / Math.max(1, obsEnd - obsStart));
  return { stage: "OBSERVE", nowPct: 61 + t * 28, secondsToNextStage: sec(obsEnd) };
}

/** Map app MarketStatus → design lifecycle stage (prefer wall-clock via deriveLifecycle). */
export function marketStage(status: Market["status"], market?: Market, now?: number): MarketStage {
  if (market) return deriveLifecycle(market, now).stage;
  switch (status) {
    case "OPEN":
    case "CREATED":
      return "OPEN";
    case "LOCKED":
      return "LOCK";
    case "OBSERVATION":
      return "OBSERVE";
    case "RESOLVED":
    case "CANCELLED":
    case "ARCHIVED":
      return "RESOLVE";
    default:
      return "OPEN";
  }
}

/** Progress marker on the 5-segment lifecycle bar (0–100). */
export function marketNowPct(market: Market, now: number = Date.now()): number {
  return deriveLifecycle(market, now).nowPct;
}

export function secondsToNextStage(market: Market, now: number = Date.now()): number {
  return deriveLifecycle(market, now).secondsToNextStage;
}

export function categoryLabel(market: Market): string {
  // Design format: "Crypto · Coinbase", "Weather · Open-Meteo", "Network · Arcscan"
  if (market.demoRole === "btc_price" || market.category === "crypto-candle") return "Crypto · Coinbase";
  if (market.demoRole === "london_weather" || market.category === "weather") return "Weather · Open-Meteo";
  if (market.category === "arc-block") return "Network · Arcscan";
  if (market.category === "demo-signal") return "Demo · Arc";
  return market.category.replace(/-/g, " ");
}

export function toMarketSummary(market: Market, now: number = Date.now()): MarketSummary {
  const { yes, no } = normalizeDisplayOdds(market.yesPrice, market.noPrice);
  const yesVol = market.yesVolume ?? market.volume * yes;
  const noVol = market.noVolume ?? market.volume * no;
  const volSum = yesVol + noVol;
  const yesVolPct = volSum > 0 ? (yesVol / volSum) * 100 : 50;
  const tickets = market.ticketCount ?? 0;
  const volNum = Math.round(market.volume || 0);
  const vol = volNum.toLocaleString("en-US");

  const life = deriveLifecycle(market, now);
  // Plain language — "0 tickets · 0 USDC vol" read as garbage on empty markets
  const stats =
    tickets === 0 && volNum === 0
      ? "No bets yet"
      : tickets === 0
        ? `${vol} USDC volume`
        : volNum === 0
          ? `${tickets} ticket${tickets === 1 ? "" : "s"}`
          : `${tickets} ticket${tickets === 1 ? "" : "s"} · ${vol} USDC volume`;

  return {
    id: market.id,
    question: market.question,
    category: categoryLabel(market),
    yesPct: yes,
    noPct: no,
    yesVolPct,
    stats,
    stage: life.stage,
    secondsToNextStage: life.secondsToNextStage,
    nowPct: life.nowPct
  };
}

export function toMarketDetail(market: Market, priceHistory: number[] = [], now: number = Date.now()): MarketDetail {
  const summary = toMarketSummary(market, now);
  const { yes } = normalizeDisplayOdds(market.yesPrice, market.noPrice);
  const fairMid = (market.yesPrice + (1 - market.noPrice)) / 2 || yes;
  // Lightweight sparkline samples from current yes (live chart uses MarketLiveChart separately)
  const history =
    priceHistory.length > 0
      ? priceHistory
      : Array.from({ length: 24 }, (_, i) => {
          const t = i / 23;
          return Math.min(0.95, Math.max(0.05, yes * (0.92 + t * 0.08)));
        });

  let chartFeed: "btc" | "weather" | "none" = "none";
  if (market.demoRole === "btc_price" || market.category === "crypto-candle") chartFeed = "btc";
  else if (market.demoRole === "london_weather" || market.category === "weather") chartFeed = "weather";

  return {
    ...summary,
    resolutionSource: market.resolutionSource || "Oracle",
    marketAddress: market.contractAddress || market.id,
    priceHistory: history,
    fairMid: Number.isFinite(fairMid) ? fairMid : yes,
    quotedYes: market.ticketYesPrice ?? market.yesPrice ?? yes,
    boostFeeRate: 0.02,
    maxBoost: Math.min(5, Math.max(1, Number(market.maxBoost) || 5)),
    chartFeed,
    rawMarketId: market.id
  };
}

export function ticketToPosition(ticket: Ticket): Position {
  let status: Position["status"] = "Open";
  if (ticket.result === "LOSS") {
    status = "Lost";
  } else if (ticket.result === "WIN" && ticket.claimable) {
    status = "Won · unclaimed";
  } else if (ticket.result === "WIN" && !ticket.claimable && ticket.status === "SETTLED") {
    status = "Claimed";
  } else if (ticket.result === "REFUND" && ticket.claimable) {
    status = "Won · unclaimed";
  } else if (ticket.result === "REFUND") {
    status = "Claimed";
  } else if (ticket.status === "SETTLED") {
    status = "Claimed";
  } else if (ticket.claimable && ticket.result === "WIN") {
    status = "Won · unclaimed";
  }

  // Only wins/refunds with money to claim — never a green Claim on a loss.
  const canClaim =
    Boolean(ticket.claimable) && (ticket.result === "WIN" || ticket.result === "REFUND");

  return {
    id: ticket.id,
    market: ticket.marketQuestion,
    marketId: ticket.marketId,
    side: ticket.outcome,
    stake: `${ticket.riskAmount.toFixed(2)} USDC`,
    boost: `${ticket.boost.toFixed(1)}×`,
    // For losses show $0.00 claimable payout, not the theoretical max payout
    payout:
      ticket.result === "LOSS"
        ? "0.00 USDC"
        : `${(ticket.result === "REFUND" ? ticket.riskAmount : ticket.payout).toFixed(2)} USDC`,
    status,
    canClaim
  };
}

/** Format USDC amounts — default 2 decimals (pool TVL, reserved, available, …). */
export function moneyUsdc(value: number, digits = 2): string {
  return `${value.toLocaleString("en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits
  })} USDC`;
}
