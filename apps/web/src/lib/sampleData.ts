import type { LpStats, Market } from "./types";

/**
 * Last-resort offline fallback only — never invent large demo numbers.
 * Live UI should always prefer Arc API / onchain reads.
 */
const now = Date.now();

function iso(offsetMs: number): string {
  return new Date(now + offsetMs).toISOString();
}

export const markets: Market[] = [
  {
    id: "mkt_btc_offline",
    question: "Will BTC/USD be above the live Coinbase threshold during the observation window?",
    rules: "Offline fallback market. Connect the API to load live Arc markets.",
    category: "crypto-candle",
    status: "OPEN",
    yesPrice: 0.5,
    noPrice: 0.5,
    openTime: iso(-5_000),
    lockTime: iso(3_600_000),
    observationStart: iso(3_600_000),
    observationEnd: iso(3_660_000),
    resolutionSource: "Coinbase BTC/USD (offline fallback)",
    volume: 0,
    ticketCount: 0,
    maxBoost: 5,
    demoRole: "btc_price"
  },
  {
    id: "mkt_weather_offline",
    question: "Will London temperature stay at or above the live Open-Meteo reading?",
    rules: "Offline fallback market. Connect the API to load live Arc markets.",
    category: "weather",
    status: "OPEN",
    yesPrice: 0.5,
    noPrice: 0.5,
    openTime: iso(-5_000),
    lockTime: iso(3_600_000),
    observationStart: iso(3_600_000),
    observationEnd: iso(3_660_000),
    resolutionSource: "Open-Meteo London (offline fallback)",
    volume: 0,
    ticketCount: 0,
    maxBoost: 5,
    demoRole: "london_weather"
  }
];

export const emptyLpStats: LpStats = {
  tvl: 0,
  reservedLiquidity: 0,
  lockedUserRisk: 0,
  availableLiquidity: 0,
  feesEarned: 0,
  dailyVolume: 0,
  simulatedApy: 0
};

/** @deprecated use emptyLpStats */
export const lpStats = emptyLpStats;

export const tickets = [];
