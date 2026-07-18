import type { MarketStage, Side } from './theme';

export type { MarketStage, Side };

export interface MarketSummary {
  id: string;
  question: string;
  category: string;
  yesPct: number; // 0-1
  noPct: number; // 0-1
  yesVolPct: number; // 0-100, share of volume on YES for the vol bar
  stats: string; // "142 tickets · 4,820 USDC vol"
  stage: MarketStage;
  secondsToNextStage: number;
  nowPct: number; // 0-100 position on the lifecycle bar
}

export interface MarketDetail extends MarketSummary {
  resolutionSource: string;
  marketAddress: string;
  priceHistory: number[]; // yes price samples, 0-1, oldest first
  fairMid: number;
  quotedYes: number;
  boostFeeRate: number;
  /** On-chain max Micro Boost (typically up to 5). */
  maxBoost: number;
  /** For live feed chart (btc / weather). */
  chartFeed?: "btc" | "weather" | "none";
  /** Raw app market id for chart component. */
  rawMarketId?: string;
}

export interface ActivityRow {
  time: string;
  side: Side;
  stake: string;
  boost: string;
  payout: string;
  tx: string;
  txHref: string;
}

export interface AllocationRow {
  id?: string;
  time: string;
  market: string;
  side: Side;
  amount: string;
  status: 'Active' | 'Released';
}

export interface Position {
  id: string;
  market: string;
  side: Side;
  stake: string;
  boost: string;
  payout: string;
  status: 'Open' | 'Won · unclaimed' | 'Claimed' | 'Lost';
  canClaim: boolean;
  txHref?: string;
}

export interface CctpStep {
  n: string;
  label: string;
  desc: string;
  status: 'idle' | 'pending' | 'confirmed';
  tx?: string;
  txHref?: string;
}

export interface WalletState {
  connected: boolean;
  address?: string;
  balance?: string; // formatted USDC
  wrongNetwork?: boolean;
}

export type LoadState = 'live' | 'loading' | 'empty' | 'error';
