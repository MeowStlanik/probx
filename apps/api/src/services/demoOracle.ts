import type { Market, OracleEvent, Outcome } from "../db/schema.js";

const signals = ["GREEN", "RED", "EVEN_SIGNAL", "ODD_SIGNAL", "FIGHTER_A_STRIKE", "FIGHTER_B_STRIKE"];

export function simulateOracleEvent(market: Market, id: string): OracleEvent {
  const signal = chooseSignal(market);
  return {
    id,
    marketId: market.id,
    signal,
    outcome: outcomeFromSignal(market, signal),
    createdAt: new Date().toISOString()
  };
}

export function outcomeFromSignal(market: Market, signal: string): Outcome {
  if (market.category === "demo-signal") return signal === "GREEN" ? "YES" : "NO";
  if (market.category === "crypto-candle") return signal === "GREEN" ? "YES" : "NO";
  if (market.category === "arc-block") return signal === "EVEN_SIGNAL" ? "YES" : "NO";
  if (market.category === "simulated-sports") return signal === "FIGHTER_A_STRIKE" ? "YES" : "NO";
  return "NO";
}

function chooseSignal(market: Market): string {
  if (market.category === "arc-block") return Math.random() > 0.5 ? "EVEN_SIGNAL" : "ODD_SIGNAL";
  if (market.category === "simulated-sports") return Math.random() > 0.5 ? "FIGHTER_A_STRIKE" : "FIGHTER_B_STRIKE";
  return signals[Math.random() > 0.5 ? 0 : 1];
}
