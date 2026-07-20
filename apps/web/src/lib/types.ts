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
  /** Fixed on-chain seed ticket prices (payout math). */
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
  rulesHash?: string;
  contractAddress?: string;
  demoRole?: "open" | "btc_price" | "london_weather" | "near_lock" | "resolved" | "legacy";
}

export interface Ticket {
  id: string;
  marketId: string;
  marketQuestion: string;
  outcome: Outcome;
  riskAmount: number;
  boost: number;
  payout: number;
  requiredReserve: number;
  status: "OPEN" | "SETTLED" | "CANCELLED";
  marketStatus?: MarketStatus;
  winningOutcome?: Outcome;
  claimable?: boolean;
  claimAmount?: number;
  claimLabel?: string;
  result?: "WIN" | "LOSS" | "REFUND";
  createdAt: string;
  /** Live reference (BTC USD / London °C) snapshot when the ticket was opened. */
  openReferencePrice?: number;
  openReferenceFeed?: "btc" | "weather" | "none";
  openReferenceLabel?: string;
  openThreshold?: number;
  openReferenceSource?: string;
}

export interface LpStats {
  tvl: number;
  reservedLiquidity: number;
  lockedUserRisk: number;
  availableLiquidity: number;
  feesEarned: number;
  dailyVolume: number;
  simulatedApy: number;
  /** True when numbers come from the in-memory demo snapshot, not the on-chain vault. */
  simulated?: boolean;
  /** Aggregate stats across ALL markets (including resolved/hidden). */
  totalVolume?: number;
  totalTickets?: number;
  totalResolved?: number;
}
