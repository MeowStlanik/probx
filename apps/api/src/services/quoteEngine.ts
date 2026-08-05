import type { Market, Outcome, PriceQuote } from "../db/schema.js";

export const MAX_USER_RISK = 100;
export const MAX_PAYOUT = 2_500;
export const MAX_BOOST = 5;
/** Book overround (YES+NO quoted sum). 1.08 ⇒ 8% margin in prices. */
export const PRICE_MARGIN = 0.08;
/** Boost covered by margin alone ≈ 1 + margin; higher boost is intentional LP spend. */
export const ECONOMIC_MAX_BOOST = 1 + PRICE_MARGIN;
export const BASE_FEE_RATE = 0.003;
/** Per unit of boost above 1x (was 0.004). Aligns with engine BOOST_FEE_BPS = 400. */
export const BOOST_FEE_RATE = 0.04;

export interface QuoteInput {
  market: Market;
  outcome: Outcome;
  riskAmount: number;
  boost: number;
  availableReserve: number;
}

export function priceForOutcome(market: Market, outcome: Outcome): number {
  return outcome === "YES" ? market.yesPrice : market.noPrice;
}

export function calculateFee(riskAmount: number, boost: number): number {
  const boostPremium = Math.max(boost - 1, 0) * BOOST_FEE_RATE;
  return roundUsdc(riskAmount * (BASE_FEE_RATE + boostPremium));
}

export function quoteTicket(input: QuoteInput): PriceQuote {
  const price = priceForOutcome(input.market, input.outcome);
  const riskAmount = Math.max(input.riskAmount, 0);
  const boost = Math.max(input.boost, 1);
  const payout = roundUsdc((riskAmount / price) * boost);
  const requiredReserve = roundUsdc(Math.max(0, payout - riskAmount));
  const fee = calculateFee(riskAmount, boost);
  const maxAvailableBoost = maxBoost(riskAmount, price, input.availableReserve);

  let accepted = true;
  let reason = "OK";

  if (riskAmount <= 0) {
    accepted = false;
    reason = "ZERO_RISK";
  } else if (riskAmount > MAX_USER_RISK) {
    accepted = false;
    reason = "RISK_CAP";
  } else if (boost > MAX_BOOST) {
    accepted = false;
    reason = "BOOST_CAP";
  } else if (payout > MAX_PAYOUT) {
    accepted = false;
    reason = "PAYOUT_CAP";
  } else if (requiredReserve > input.availableReserve) {
    accepted = false;
    reason = "INSUFFICIENT_RESERVE";
  }

  return {
    marketId: input.market.id,
    outcome: input.outcome,
    riskAmount,
    boost,
    payout,
    requiredReserve,
    fee,
    accepted,
    reason,
    maxAvailableBoost
  };
}

export function maxBoost(riskAmount: number, price: number, availableReserve: number): number {
  if (riskAmount <= 0) return 1;
  // LP capacity ceiling. Never advertise more than LP can actually reserve —
  // otherwise the UI offers a boost that quoteTicket() rejects with
  // INSUFFICIENT_RESERVE. Matches on-chain maxAvailableBoost (floors at 1x)
  // and web quote.ts. ECONOMIC_MAX_BOOST stays a display hint, not capacity.
  const fromLp = ((riskAmount + availableReserve) * price) / riskAmount;
  return roundBoost(Math.min(MAX_BOOST, Math.max(1, fromLp)));
}

/**
 * Apply the same integer overround math as MicroMarket._setQuotedFromMid().
 * The constructor accepts a fair mid in [5%, 95%]. Quoted prices are multiplied
 * by OVERROUND_BPS, floored like Solidity integer division, capped at 0.999999
 * for QuoteMath, and floored at 0.05. They are not capped at 0.95.
 */
export function applyPriceMargin(
  fairYes: number,
  margin = PRICE_MARGIN
): { yesPrice: number; noPrice: number } {
  const priceScale = 1_000_000;
  const minPrice = 50_000;
  const maxQuotedPrice = priceScale - 1;
  const midYes = Math.min(950_000, Math.max(50_000, Math.round(fairYes * priceScale)));
  const midNo = priceScale - midYes;
  const overroundBps = Math.round((1 + margin) * 10_000);

  const quote = (mid: number): number => {
    const scaled = Math.floor((mid * overroundBps) / 10_000);
    return Math.min(maxQuotedPrice, Math.max(minPrice, scaled)) / priceScale;
  };

  return {
    yesPrice: quote(midYes),
    noPrice: quote(midNo)
  };
}

export function roundUsdc(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

export function roundBoost(value: number): number {
  return Math.round(value * 100) / 100;
}
