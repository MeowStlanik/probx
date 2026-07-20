import { db } from "../db/client.js";
import { buildLpStats } from "../services/lpStatsService.js";
import { getAggregateStats, getOnchainLpStats, onchainEnabled } from "../services/onchainService.js";

export async function lpStats() {
  const aggregate = onchainEnabled() ? await getAggregateStats().catch(() => null) : null;
  const extra = aggregate
    ? {
        totalVolume: aggregate.totalVolume,
        totalTickets: aggregate.totalTickets,
        totalResolved: aggregate.totalResolved
      }
    : {};

  if (onchainEnabled()) {
    try {
      const stats = await getOnchainLpStats();
      return { ...stats, simulated: false, ...extra };
    } catch {
      return { ...buildLpStats(db.lp, db.tickets), simulated: true, ...extra };
    }
  }
  return { ...buildLpStats(db.lp, db.tickets), simulated: true, ...extra };
}
