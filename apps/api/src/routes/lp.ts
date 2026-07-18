import { db } from "../db/client.js";
import { buildLpStats } from "../services/lpStatsService.js";
import { getOnchainLpStats, onchainEnabled } from "../services/onchainService.js";

export async function lpStats() {
  if (onchainEnabled()) {
    try {
      const stats = await getOnchainLpStats();
      return { ...stats, simulated: false };
    } catch {
      return { ...buildLpStats(db.lp, db.tickets), simulated: true };
    }
  }
  return { ...buildLpStats(db.lp, db.tickets), simulated: true };
}
