import type { Market, Outcome } from "./types";

export const MAX_USER_RISK = 100;
export const MAX_PAYOUT = 2_500;
export const MAX_BOOST = 5;
export const BASE_FEE_RATE = 0.003;
export const BOOST_FEE_RATE = 0.004;

export interface Quote {
  price: number;
  payout: number;
  requiredReserve: number;
  fee: number;
  totalDebit: number;
  maxAvailableBoost: number;
  accepted: boolean;
  reason: string;
}

export function quoteTicket(
  market: Market,
  outcome: Outcome,
  riskAmount: number,
  boost: number,
  availableReserve: number
): Quote {
  const price = outcome === "YES" ? market.yesPrice : market.noPrice;
  const normalizedRisk = Number.isFinite(riskAmount) ? Math.max(riskAmount, 0) : 0;
  const normalizedBoost = Number.isFinite(boost) ? Math.max(boost, 1) : 1;
  const payout = roundUsdc((normalizedRisk / price) * normalizedBoost);
  const requiredReserve = roundUsdc(payout - normalizedRisk);
  const fee = calculateFee(normalizedRisk, normalizedBoost);
  const maxAvailableBoost = maxBoost(normalizedRisk, price, availableReserve);

  let accepted = true;
  let reason = "Ready";
  if (normalizedRisk <= 0) {
    accepted = false;
    reason = "Enter an amount";
  } else if (normalizedRisk > MAX_USER_RISK) {
    accepted = false;
    reason = "Max ticket risk is 100 demo USDC";
  } else if (normalizedBoost > MAX_BOOST) {
    accepted = false;
    reason = "Boost cap is 5x";
  } else if (payout > MAX_PAYOUT) {
    accepted = false;
    reason = "Max payout is 2,500 demo USDC";
  } else if (requiredReserve > availableReserve) {
    accepted = false;
    reason = `Reserve shortfall. Max safe boost is ${maxAvailableBoost.toFixed(2)}x`;
  }

  return {
    price,
    payout,
    requiredReserve,
    fee,
    totalDebit: roundUsdc(normalizedRisk + fee),
    maxAvailableBoost,
    accepted,
    reason
  };
}

export function calculateFee(riskAmount: number, boost: number): number {
  const boostPremium = Math.max(boost - 1, 0) * BOOST_FEE_RATE;
  return roundUsdc(riskAmount * (BASE_FEE_RATE + boostPremium));
}

export function maxBoost(riskAmount: number, price: number, availableReserve: number): number {
  if (riskAmount <= 0) return 1;
  const raw = ((riskAmount + availableReserve) * price) / riskAmount;
  return Math.round(Math.min(MAX_BOOST, Math.max(1, raw)) * 100) / 100;
}

export function roundUsdc(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}
