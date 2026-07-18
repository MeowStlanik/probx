export type Outcome = "YES" | "NO";
export type MarketStatus = "CREATED" | "OPEN" | "LOCKED" | "OBSERVATION" | "RESOLVED" | "CANCELLED" | "ARCHIVED";

export interface Market {
  id: string;
  question: string;
  rules: string;
  category: "demo-signal" | "crypto-candle" | "weather" | "simulated-sports" | "arc-block";
  status: MarketStatus;
  yesPrice: number;
  noPrice: number;
  /** Fixed on-chain ticket seed prices used for payout math. */
  ticketYesPrice?: number;
  ticketNoPrice?: number;
  openTime: string;
  lockTime: string;
  observationStart: string;
  observationEnd: string;
  resolutionSource: string;
  winningOutcome?: Outcome;
  volume: number;
  ticketCount?: number;
  yesVolume?: number;
  noVolume?: number;
  maxBoost: number;
  rulesHash: string;
  contractAddress?: string;
  demoRole?: "open" | "btc_price" | "london_weather" | "near_lock" | "resolved" | "legacy";
}

export interface Ticket {
  id: string;
  owner: string;
  marketId: string;
  outcome: Outcome;
  riskAmount: number;
  boost: number;
  quotedPrice: number;
  payout: number;
  requiredReserve: number;
  fee: number;
  status: "OPEN" | "SETTLED" | "CANCELLED";
  marketQuestion?: string;
  marketStatus?: MarketStatus;
  winningOutcome?: Outcome;
  claimable?: boolean;
  claimAmount?: number;
  claimLabel?: string;
  result?: "WIN" | "LOSS" | "REFUND";
  createdAt: string;
  settledAt?: string;
  openReferencePrice?: number;
  openReferenceFeed?: "btc" | "weather" | "none";
  openReferenceLabel?: string;
  openThreshold?: number;
  openReferenceSource?: string;
}

export interface OracleEvent {
  id: string;
  marketId: string;
  signal: string;
  outcome: Outcome;
  createdAt: string;
}

export interface PriceQuote {
  marketId: string;
  outcome: Outcome;
  riskAmount: number;
  boost: number;
  payout: number;
  requiredReserve: number;
  fee: number;
  accepted: boolean;
  reason: string;
  maxAvailableBoost: number;
}

export interface LpSnapshot {
  tvl: number;
  reservedLiquidity: number;
  lockedUserRisk: number;
  availableLiquidity: number;
  feesEarned: number;
  dailyVolume: number;
  simulatedApy: number;
  /** True when values come from the demo in-memory snapshot, not the on-chain vault. */
  simulated?: boolean;
}
