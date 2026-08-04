import { getAutoResolveWorkerStatus, startAutoResolveWorker } from "./autoResolveWorker.js";
import { runMarketCycleOnce } from "./marketCycleWorker.js";
import {
  getOracleSnapshotWorkerStatus,
  startOracleSnapshotWorker
} from "./oracleSnapshotWorker.js";

type BackgroundState = {
  started: boolean;
  enabled: boolean;
  startedAt?: string;
  marketTimer?: NodeJS.Timeout;
  marketIntervalMs?: number;
  marketRunning: boolean;
  lastMarketRunAt?: string;
  lastMarketSuccessAt?: string;
  lastMarketError?: string;
};

const globalState = globalThis as typeof globalThis & {
  __probxBackgroundState?: BackgroundState;
};

function state(): BackgroundState {
  return (globalState.__probxBackgroundState ??= {
    started: false,
    enabled: false,
    marketRunning: false
  });
}

/**
 * Production workers are opt-in. This prevents a Vercel UI deployment from starting
 * short-lived oracle timers while Railway is the real backend.
 */
export function backgroundWorkersEnabled(): boolean {
  const value = (process.env.BACKGROUND_WORKERS_ENABLED ?? "").trim();
  if (value === "1") return true;
  if (value === "0") return false;
  return process.env.NODE_ENV !== "production";
}

/** Start long-lived workers once per Node.js process (Railway or standalone API). */
export function startBackgroundWorkers(): void {
  const current = state();
  if (current.started) return;
  current.started = true;
  current.enabled = backgroundWorkersEnabled();
  current.startedAt = new Date().toISOString();

  if (!current.enabled) {
    console.log(
      "[workers] disabled: set BACKGROUND_WORKERS_ENABLED=1 on the persistent Railway service"
    );
    return;
  }

  console.log("[workers] starting persistent Railway workers");
  startOracleSnapshotWorker();
  startAutoResolveWorker();

  if (process.env.MARKET_CYCLE_ENABLED === "0") {
    console.log("[market-cycle] background timer disabled via MARKET_CYCLE_ENABLED=0");
    return;
  }

  const configuredInterval = Number(process.env.MARKET_CYCLE_INTERVAL_MS ?? 30_000);
  // Continuous markets should not sit empty for a minute. The 30s ceiling also
  // keeps the legacy cycle-level snapshot fallback inside BTC's 35s boundary.
  const safeInterval = Number.isFinite(configuredInterval)
    ? Math.min(30_000, Math.max(10_000, configuredInterval))
    : 30_000;
  current.marketIntervalMs = safeInterval;

  console.log(`[market-cycle] background timer every ${safeInterval}ms`);
  void runMarketCycleTracked("initial");
  current.marketTimer = setInterval(() => {
    void runMarketCycleTracked("timer");
  }, safeInterval);
  current.marketTimer.unref?.();
}

async function runMarketCycleTracked(source: "initial" | "timer"): Promise<void> {
  const current = state();
  if (current.marketRunning) return;
  current.marketRunning = true;
  current.lastMarketRunAt = new Date().toISOString();
  try {
    const result = await runMarketCycleOnce();
    if (result.ok || result.skipped === "already-running" || result.skipped === "distributed-lock") {
      current.lastMarketSuccessAt = new Date().toISOString();
      current.lastMarketError = undefined;
    } else {
      current.lastMarketError = result.errors.join("; ") || result.skipped || "market cycle failed";
      console.error(`[market-cycle] ${source} run incomplete`, result);
    }
  } catch (error) {
    current.lastMarketError = error instanceof Error ? error.message : String(error);
    console.error(`[market-cycle] ${source} run failed`, error);
  } finally {
    current.marketRunning = false;
  }
}

export function getBackgroundWorkerStatus() {
  const current = state();
  return {
    enabled: current.enabled,
    started: current.started,
    startedAt: current.startedAt,
    marketCycle: {
      started: Boolean(current.marketTimer),
      running: current.marketRunning,
      intervalMs: current.marketIntervalMs,
      lastRunAt: current.lastMarketRunAt,
      lastSuccessAt: current.lastMarketSuccessAt,
      lastError: current.lastMarketError
    },
    oracleSnapshot: getOracleSnapshotWorkerStatus(),
    autoResolve: getAutoResolveWorkerStatus()
  };
}
