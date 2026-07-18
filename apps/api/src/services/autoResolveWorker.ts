import {
  getOnchainMarket,
  listOnchainMarkets,
  onchainEnabled,
  resolveReferenceMarketOnchain,
  settleMarketTicketsOnchain
} from "./onchainService.js";


const DEFAULT_INTERVAL_MS = 3_000;
const inFlight = new Set<string>();
const recentlyAttempted = new Map<string, number>();
const COOLDOWN_MS = 4_000;

let timer: NodeJS.Timeout | undefined;
let running = false;

/**
 * Periodically resolves BTC/weather reference markets from live feeds once the
 * observation window has ended. Manual (demo signal) markets are left alone.
 */
export function startAutoResolveWorker(): void {
  if (timer) return;
  if (process.env.AUTO_RESOLVE_ENABLED === "0") {
    console.log("[auto-resolve] disabled via AUTO_RESOLVE_ENABLED=0");
    return;
  }
  if (!onchainEnabled()) {
    console.log("[auto-resolve] skipped: onchain deployment not configured");
    return;
  }
  if (
    !(
      process.env.ORACLE_PRIVATE_KEY ||
      process.env.DEPLOYER_PRIVATE_KEY ||
      process.env.ARC_DEPLOYER_PRIVATE_KEY ||
      process.env.PRIVATE_KEY
    )
  ) {
    console.log("[auto-resolve] skipped: ORACLE_PRIVATE_KEY / DEPLOYER_PRIVATE_KEY / PRIVATE_KEY not set");
    return;
  }

  const intervalMs = Number(process.env.AUTO_RESOLVE_INTERVAL_MS ?? DEFAULT_INTERVAL_MS);
  const safeInterval = Number.isFinite(intervalMs) && intervalMs >= 2_000 ? intervalMs : DEFAULT_INTERVAL_MS;

  console.log(`[auto-resolve] worker started (every ${safeInterval}ms)`);
  void tick().catch((error) => {
    console.error("[auto-resolve] initial tick failed", error);
  });
  timer = setInterval(() => {
    void tick().catch((error) => {
      console.error("[auto-resolve] tick failed", error);
    });
  }, safeInterval);
  // Allow the process to exit even if the timer is still scheduled.
  timer.unref?.();
}

export function stopAutoResolveWorker(): void {
  if (timer) {
    clearInterval(timer);
    timer = undefined;
  }
}

/** One resolve pass (used by Vercel Cron / on-demand). */
export async function runAutoResolveOnce(): Promise<{ checked: number; attempted: number }> {
  return tick();
}

async function tick(): Promise<{ checked: number; attempted: number }> {
  if (running) return { checked: 0, attempted: 0 };
  running = true;
  let checked = 0;
  let attempted = 0;
  try {
    const markets = await listOnchainMarkets();
    const now = Date.now();

    for (const market of markets) {
      checked += 1;
      if (!isAutoResolvableRole(market.demoRole, market.category)) continue;
      if (!isResolvableStatus(market.status)) continue;

      // Ready once observation ends; fall back to lock + 15s for older markets.
      const observationEnd = Date.parse(market.observationEnd || "");
      const lockTime = Date.parse(market.lockTime || "");
      const readyAt = Number.isFinite(observationEnd)
        ? observationEnd
        : Number.isFinite(lockTime)
          ? lockTime + 15_000
          : Number.NaN;
      if (!Number.isFinite(readyAt) || now < readyAt) continue;

      const key = (market.contractAddress ?? market.id).toLowerCase();
      if (inFlight.has(key)) continue;

      const lastAttempt = recentlyAttempted.get(key) ?? 0;
      if (now - lastAttempt < COOLDOWN_MS) continue;

      // Skip markets without a parseable numeric threshold (manual/template junk).
      if (!hasParseableThreshold(market.demoRole, market.category, market.question)) {
        continue;
      }

      inFlight.add(key);
      recentlyAttempted.set(key, now);
      attempted += 1;
      try {
        console.log(`[auto-resolve] resolving ${market.demoRole ?? market.category} market ${market.id}`);
        const result = await resolveReferenceMarketOnchain(market.id);
        if (result && "error" in result && result.error) {
          console.warn(`[auto-resolve] ${market.id}: ${result.error}`);
        } else if (result && "outcome" in result) {
          const txHash = result && "hash" in result ? String(result.hash ?? "n/a") : "n/a";
          console.log(
            `[auto-resolve] ${market.id} -> ${result.outcome} (observed ${formatNum(result.observedValue)} vs ${formatNum(result.threshold)}; tx ${txHash})`
          );
          // Release LP reserve / pay winners so vault liquidity returns after the market ends.
          try {
            const settled = await settleMarketTicketsOnchain(market.id);
            if (settled && "settledCount" in settled) {
              console.log(`[auto-resolve] settled ${settled.settledCount ?? 0} ticket(s) for ${market.id}`);
            }
          } catch (settleError) {
            console.warn(`[auto-resolve] settle-after-resolve failed for ${market.id}`, settleError);
          }
        }
      } catch (error) {
        console.error(`[auto-resolve] failed for ${market.id}`, error);
      } finally {
        inFlight.delete(key);
      }
    }
  } finally {
    running = false;
  }
  return { checked, attempted };
}

function isAutoResolvableRole(
  role: string | undefined,
  category: string | undefined
): boolean {
  return (
    role === "btc_price"
    || role === "london_weather"
    || category === "crypto-candle"
    || category === "weather"
  );
}

function isResolvableStatus(status: string): boolean {
  return status === "OPEN" || status === "LOCKED" || status === "OBSERVATION";
}

function hasParseableThreshold(
  role: string | undefined,
  category: string | undefined,
  question: string
): boolean {
  if (role === "btc_price" || category === "crypto-candle") {
    return /above\s+\$?[\d,]+(?:\.\d+)?/i.test(question);
  }
  if (role === "london_weather" || category === "weather") {
    return /at least\s+-?[\d.]+\s*C/i.test(question);
  }
  return false;
}

function formatNum(value: unknown): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "-";
  return value.toLocaleString("en-US", { maximumFractionDigits: 3 });
}

/** Exposed for tests / admin health. */
export async function autoResolvePreview(marketId: string) {
  const market = await getOnchainMarket(marketId);
  if (!market) return { error: "market not found" };
  return {
    marketId: market.id,
    role: market.demoRole,
    status: market.status,
    autoResolvable: isAutoResolvableRole(market.demoRole, market.category),
    hasThreshold: hasParseableThreshold(market.demoRole, market.category, market.question),
    readyAt: market.observationEnd || market.lockTime,
    ready: Date.now() >= Date.parse(market.observationEnd || market.lockTime)
  };
}
