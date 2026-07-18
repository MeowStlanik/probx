import type { Market } from "../db/schema.js";

export function demoFeedLabel(market: Market): string {
  if (market.category === "crypto-candle") return "Mock BTC/USD candle feed";
  if (market.category === "arc-block") return "Arc block signal simulator";
  if (market.category === "simulated-sports") return "Simulated strike feed";
  return "GREEN/RED demo oracle";
}

export function nextDemoPrice(seed = Date.now()): { open: number; close: number } {
  const open = 67_000 + (seed % 400);
  const close = open + ((seed % 2 === 0 ? 1 : -1) * (25 + (seed % 90)));
  return { open, close };
}
