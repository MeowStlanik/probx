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


export interface MarketObservationPoint {
  value: number;
  at: number;
  provider?: string;
  sourceId?: string;
  sourceHash?: string;
}

export interface MarketObservationEvidence {
  marketId: string;
  marketAddress: string;
  role: "btc" | "weather";
  observationStart: string;
  observationEnd: string;
  status: MarketStatus;
  /** Raw durable oracle prints for this exact round, sorted by provider time. */
  points: MarketObservationPoint[];
  /** The exact start print selected by the resolver (nearest to observationStart). */
  start?: MarketObservationPoint;
  /** The exact end print selected by the resolver (first print at/after observationEnd). */
  end?: MarketObservationPoint;
  /** Preview from start to latest durable print; never presented as final. */
  indicativeOutcome?: Outcome;
  /** On-chain winner. Present only after the market is final. */
  finalOutcome?: Outcome;
  frozen: boolean;
  resolutionTxHash?: string;
  integrityError?: string;
  updatedAt: string;
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
  /** Frozen oracle evidence used for the final on-chain winner. */
  resolutionStartValue?: number;
  resolutionEndValue?: number;
  resolutionStartAt?: number;
  resolutionEndAt?: number;
  resolutionSource?: string;
  resolutionTxHash?: string;
  resolutionFrozen?: boolean;
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
