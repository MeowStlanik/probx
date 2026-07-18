import type { LpSnapshot, Market, OracleEvent, Ticket } from "./schema.js";
import { seedMarkets } from "./seed.js";

export interface DemoDb {
  markets: Market[];
  tickets: Ticket[];
  oracleEvents: OracleEvent[];
  lp: LpSnapshot;
}

export const db: DemoDb = {
  markets: seedMarkets(),
  tickets: [],
  oracleEvents: [],
  lp: {
    tvl: 1_000_000,
    reservedLiquidity: 124_000,
    lockedUserRisk: 18_400,
    availableLiquidity: 857_600,
    feesEarned: 7_840,
    dailyVolume: 300_000,
    simulatedApy: 54.75
  }
};

export function nextId(prefix: string, list: { id: string }[]): string {
  return `${prefix}_${String(list.length + 1).padStart(4, "0")}`;
}
