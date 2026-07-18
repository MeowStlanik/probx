import type { DemoDb } from "../db/client.js";
import { nextId } from "../db/client.js";
import { simulateOracleEvent } from "./demoOracle.js";

export function resolveExpiredDemoMarkets(db: DemoDb): void {
  const now = Date.now();
  for (const market of db.markets) {
    if ((market.status === "LOCKED" || market.status === "OBSERVATION") && new Date(market.observationEnd).getTime() <= now) {
      const event = simulateOracleEvent(market, nextId("evt", db.oracleEvents));
      db.oracleEvents.push(event);
      market.status = "RESOLVED";
      market.winningOutcome = event.outcome;
    }
  }
}
