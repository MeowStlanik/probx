import { captureObservationSnapshots, onchainEnabled } from "./onchainService.js";

const DEFAULT_INTERVAL_MS = 7_000;

type SnapshotWorkerState = {
  timer?: NodeJS.Timeout;
  running: boolean;
  startedAt?: string;
  lastRunAt?: string;
  lastSuccessAt?: string;
  lastUpdated?: number;
  lastError?: string;
  intervalMs?: number;
};

const globalState = globalThis as typeof globalThis & {
  __probxOracleSnapshotWorker?: SnapshotWorkerState;
};

function state(): SnapshotWorkerState {
  return (globalState.__probxOracleSnapshotWorker ??= { running: false });
}

/**
 * Capture oracle boundary samples independently from the slower market-creation loop.
 * BTC accepts samples only within 35s of each boundary, so a 55s market-cycle timer
 * can miss a boundary even when the process is healthy. This worker prevents that.
 */
export function startOracleSnapshotWorker(): void {
  const current = state();
  if (current.timer) return;
  if (process.env.ORACLE_SNAPSHOT_ENABLED === "0") {
    console.log("[oracle-snapshot] disabled via ORACLE_SNAPSHOT_ENABLED=0");
    return;
  }
  if (!onchainEnabled()) {
    console.log("[oracle-snapshot] skipped: onchain deployment not configured");
    return;
  }

  const configured = Number(process.env.ORACLE_SNAPSHOT_INTERVAL_MS ?? DEFAULT_INTERVAL_MS);
  const intervalMs = Number.isFinite(configured)
    ? Math.min(10_000, Math.max(2_000, configured))
    : DEFAULT_INTERVAL_MS;

  current.startedAt = new Date().toISOString();
  current.intervalMs = intervalMs;
  console.log(`[oracle-snapshot] worker started (every ${intervalMs}ms)`);

  void runOracleSnapshotOnce();
  current.timer = setInterval(() => {
    void runOracleSnapshotOnce();
  }, intervalMs);
  current.timer.unref?.();
}

export async function runOracleSnapshotOnce(): Promise<{ updated: number; skipped?: string }> {
  const current = state();
  if (current.running) return { updated: 0, skipped: "already-running" };
  current.running = true;
  current.lastRunAt = new Date().toISOString();
  try {
    const result = await captureObservationSnapshots();
    current.lastSuccessAt = new Date().toISOString();
    current.lastUpdated = result.updated;
    current.lastError = undefined;
    return result;
  } catch (error) {
    current.lastError = error instanceof Error ? error.message : String(error);
    console.error("[oracle-snapshot] capture failed", error);
    return { updated: 0 };
  } finally {
    current.running = false;
  }
}

export function getOracleSnapshotWorkerStatus() {
  const current = state();
  return {
    started: Boolean(current.timer),
    running: current.running,
    intervalMs: current.intervalMs,
    startedAt: current.startedAt,
    lastRunAt: current.lastRunAt,
    lastSuccessAt: current.lastSuccessAt,
    lastUpdated: current.lastUpdated,
    lastError: current.lastError
  };
}
