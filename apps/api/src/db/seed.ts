import type { Market } from "./schema.js";
import { applyPriceMargin, ECONOMIC_MAX_BOOST } from "../services/quoteEngine.js";

const now = Date.now();

function iso(offsetMs: number): string {
  return new Date(now + offsetMs).toISOString();
}

function withMargin(fairYes: number): Pick<Market, "yesPrice" | "noPrice" | "maxBoost"> {
  const { yesPrice, noPrice } = applyPriceMargin(fairYes);
  return { yesPrice, noPrice, maxBoost: Math.min(5, Math.max(ECONOMIC_MAX_BOOST, 1.08)) };
}

export function seedMarkets(): Market[] {
  return [
    {
      id: "mkt_demo_green",
      question: "Will the next demo signal be GREEN?",
      rules: "YES if Demo Oracle emits GREEN during the observation window. NO if it emits RED or no GREEN before timeout.",
      category: "demo-signal",
      status: "OPEN",
      ...withMargin(0.4),
      openTime: iso(-5_000),
      lockTime: iso(20_000),
      observationStart: iso(30_000),
      observationEnd: iso(50_000),
      resolutionSource: "Demo Oracle",
      volume: 42_700,
      rulesHash: "0xdemo-green"
    },
    {
      id: "mkt_btc_candle",
      question: "Will the BTC/USD 1-minute demo candle close green?",
      rules: "YES if the simulated close price is greater than the simulated open price. NO otherwise.",
      category: "crypto-candle",
      status: "OPEN",
      ...withMargin(0.5),
      openTime: iso(-10_000),
      lockTime: iso(35_000),
      observationStart: iso(45_000),
      observationEnd: iso(95_000),
      resolutionSource: "Mock Price Feed",
      volume: 68_100,
      rulesHash: "0xbtc-demo-candle"
    },
    {
      id: "mkt_arc_even",
      question: "Will the next 8 Arc demo blocks contain an even-numbered signal?",
      rules: "YES if the deterministic demo simulator emits an even signal during the block window. NO if odd.",
      category: "arc-block",
      status: "LOCKED",
      ...withMargin(0.5),
      openTime: iso(-40_000),
      lockTime: iso(-5_000),
      observationStart: iso(5_000),
      observationEnd: iso(35_000),
      resolutionSource: "Arc Block Demo Oracle",
      volume: 21_300,
      rulesHash: "0xarc-even"
    },
    {
      id: "mkt_demo_strike",
      question: "Will Fighter A land the next demo strike?",
      rules: "Simulation only. YES if the event feed emits FIGHTER_A_STRIKE. NO for FIGHTER_B_STRIKE or timeout.",
      category: "simulated-sports",
      status: "OPEN",
      ...withMargin(0.47),
      openTime: iso(-2_000),
      lockTime: iso(25_000),
      observationStart: iso(35_000),
      observationEnd: iso(55_000),
      resolutionSource: "Demo Event Feed",
      volume: 9_400,
      rulesHash: "0xstrike-demo"
    }
  ];
}
