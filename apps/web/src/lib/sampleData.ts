import type { LpStats, Market } from "./types";

/**
 * Last-resort offline fallback only — never invent large demo numbers.
 * Live UI should always prefer Arc API / onchain reads.
 */
const now = Date.now();

function iso(offsetMs: number): string {
  return new Date(now + offsetMs).toISOString();
}

// Mirror market-cycle timings (~75s open + 60s obs) so a failed API never looks like "1h markets".
const OPEN_MS = 75_000;
const OBS_MS = 60_000;

export const markets: Market[] = [
  {
    id: "mkt_btc_offline",
    question: "Will BTC finish observation higher than it started?",
    rules: "Offline fallback market. Connect the API to load live Arc markets.",
    category: "crypto-candle",
    status: "OPEN",
    yesPrice: 0.5,
    noPrice: 0.5,
    openTime: iso(-5_000),
    lockTime: iso(OPEN_MS),
    observationStart: iso(OPEN_MS),
    observationEnd: iso(OPEN_MS + OBS_MS),
    resolutionSource: "Coinbase BTC/USD (offline fallback)",
    volume: 0,
    ticketCount: 0,
    maxBoost: 5,
    demoRole: "btc_price"
  },
  {
    id: "mkt_weather_offline",
    question: "Will London temp finish observation higher than it started?",
    rules: "Offline fallback market. Connect the API to load live Arc markets.",
    category: "weather",
    status: "OPEN",
    yesPrice: 0.5,
    noPrice: 0.5,
    openTime: iso(-5_000),
    lockTime: iso(OPEN_MS),
    observationStart: iso(OPEN_MS),
    observationEnd: iso(OPEN_MS + OBS_MS),
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
