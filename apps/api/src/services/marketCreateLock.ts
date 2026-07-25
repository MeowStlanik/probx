/**
 * Single entry point for creating BTC / weather markets.
 * Tour + market-cycle MUST share these lock keys so they cannot double-create.
 */
import { randomBytes } from "node:crypto";
import { acquireLock, marketCreateLockKey, releaseLock } from "./persistentStore.js";

export type MarketCreateRole = "btc" | "weather";

export async function withMarketCreateLock<T>(
  role: MarketCreateRole,
  fn: () => Promise<T>
): Promise<T> {
  const key = marketCreateLockKey(role);
  const token = randomBytes(8).toString("hex");
  const got = await acquireLock(key, 90_000, token);
  if (!got) {
    throw new Error(`market create lock busy: ${role}`);
  }
  try {
    return await fn();
  } finally {
    await releaseLock(key, token).catch(() => undefined);
  }
}
