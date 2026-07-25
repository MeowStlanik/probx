/**
 * Observation snapshots with provenance. End samples only at/after observationEnd.
 * Frozen after successful on-chain resolve; never mutated again.
 *
 * Grace / distance are role-aware: weather uses Open-Meteo’s 15-minute grid,
 * so a 45s BTC-style grace always cancels weather markets.
 */
import { randomBytes } from "node:crypto";
import { NamespaceStore, acquireLock, releaseLock, requireDurableKv } from "./persistentStore.js";

export type TickProvenance = {
  value: number;
  observedAt: number;
  /**
   * Server ingest time. Optional because ZSET identity deliberately excludes it
   * (same print must overwrite, not accumulate) — so a tick read back from Redis
   * cannot recover it. Left undefined rather than defaulted, so frozen evidence
   * never asserts an ingest time the oracle did not actually record.
   */
  receivedAt?: number;
  provider: string;
  sourceId?: string;
  /** SHA-256 of the normalized provider reading — lets a payout be re-derived. */
  sourceHash?: string;
};

export type ObservationSnapshot = {
  market: string;
  role: "btc" | "weather";
  startValue?: number;
  startTimestamp?: number;
  endValue?: number;
  endTimestamp?: number;
  startSource?: TickProvenance;
  endSource?: TickProvenance;
  source: string;
  updatedAt: string;
  frozen?: boolean;
  frozenAt?: string;
  resolutionTxHash?: string;
  outcome?: "YES" | "NO";
  onchainStatus?: number;
};

const store = new NamespaceStore<ObservationSnapshot>("observation-snapshots-v2");

/** Open-Meteo minutely_15 / current.time grid. */
export const WEATHER_PROVIDER_INTERVAL_MS = 15 * 60_000;

/** BTC: sub-second feed, short grace after observationEnd. */
export const BTC_SNAPSHOT_GRACE_MS = 45_000;
export const BTC_SNAPSHOT_MAX_DIST_MS = 35_000;

/**
 * Weather: next provider print after observationEnd arrives up to one full interval later
 * (mean ~7.5 min, worst case ~15 min). Grace ≥ interval + small buffer so we wait for it
 * instead of cancelling. Max distance matches one interval so firstTickAtOrAfter can accept it.
 */
export const WEATHER_SNAPSHOT_GRACE_MS = WEATHER_PROVIDER_INTERVAL_MS + 60_000; // 16 min
export const WEATHER_SNAPSHOT_MAX_DIST_MS = WEATHER_PROVIDER_INTERVAL_MS + 60_000; // 16 min

/**
 * Reference-market observation windows. Kept here, next to the grace constants,
 * because raw-tick retention is derived from them — see ORACLE_TICK_RETENTION_MS.
 * Weather spans two provider intervals so start and end land in different prints.
 */
export const BTC_OBSERVATION_MS = 60_000;
export const WEATHER_OBSERVATION_MS = 2 * WEATHER_PROVIDER_INTERVAL_MS; // 30 min

/**
 * How long a raw tick must stay queryable.
 *
 * The start print is sampled at observationStart but is only read back at resolve,
 * which happens no earlier than observationEnd and as late as observationEnd + grace.
 * If retention is shorter than window + grace, nearestRawTick() can never find the
 * start boundary and the raw-tick fallback is dead by construction — the snapshot
 * store becomes the single point of failure. Retention must therefore dominate the
 * worst-case window, with slack for worker jitter and cold starts.
 */
export const ORACLE_TICK_RETENTION_MS =
  Math.max(
    BTC_OBSERVATION_MS + BTC_SNAPSHOT_GRACE_MS,
    WEATHER_OBSERVATION_MS + WEATHER_SNAPSHOT_GRACE_MS
  ) + 5 * 60_000;

/** @deprecated Use snapshotGraceMs(role). Kept as BTC default for accidental imports. */
export const SNAPSHOT_GRACE_MS = BTC_SNAPSHOT_GRACE_MS;

/** Max age for a weather sample to count as a fresh observation (ms). */
export const WEATHER_STALE_MS = 20 * 60_000;

export function snapshotGraceMs(role: "btc" | "weather"): number {
  return role === "weather" ? WEATHER_SNAPSHOT_GRACE_MS : BTC_SNAPSHOT_GRACE_MS;
}

export function snapshotMaxDistanceMs(role: "btc" | "weather"): number {
  return role === "weather" ? WEATHER_SNAPSHOT_MAX_DIST_MS : BTC_SNAPSHOT_MAX_DIST_MS;
}

/**
 * Binary condition for reference markets: end strictly above start → YES, else NO.
 * Flat print (end === start) is an explicit NO — not an accident of `>` comparison.
 */
export function resolveOutcomeFromPrints(
  startValue: number,
  endValue: number
): { outcome: "YES" | "NO"; tie: boolean } {
  if (endValue > startValue) return { outcome: "YES", tie: false };
  if (endValue < startValue) return { outcome: "NO", tie: false };
  return { outcome: "NO", tie: true };
}

function key(market: string): string {
  return market.trim().toLowerCase();
}

export async function getObservationSnapshot(market: string): Promise<ObservationSnapshot | null> {
  return store.get(key(market));
}

async function withSnapLock<T>(
  marketKey: string,
  fn: () => Promise<T>
): Promise<T | null> {
  const lockTok = randomBytes(6).toString("hex");
  const lockName = `obs-snap:${marketKey}`;
  let got = await acquireLock(lockName, 8_000, lockTok);
  if (!got) {
    await new Promise((r) => setTimeout(r, 30));
    got = await acquireLock(lockName, 8_000, lockTok);
  }
  if (!got) return null;
  try {
    return await fn();
  } finally {
    await releaseLock(lockName, lockTok).catch(() => undefined);
  }
}

export async function recordObservationSample(input: {
  market: string;
  role: "btc" | "weather";
  value: number;
  atMs: number;
  obsStartMs: number;
  obsEndMs: number;
  source: string;
  maxDistanceMs?: number;
  provenance?: Partial<TickProvenance>;
}): Promise<ObservationSnapshot | null> {
  const maxDist = input.maxDistanceMs ?? snapshotMaxDistanceMs(input.role);
  const k = key(input.market);

  return withSnapLock(k, async () => {
    const existing =
      (await store.get(k)) ??
      ({
        market: k,
        role: input.role,
        source: input.source,
        updatedAt: new Date().toISOString()
      } satisfies ObservationSnapshot);

    if (existing.frozen) return existing;

    const prov: TickProvenance = {
      value: input.value,
      observedAt: input.provenance?.observedAt ?? input.atMs,
      receivedAt: input.provenance?.receivedAt ?? Date.now(),
      provider: input.provenance?.provider ?? input.source,
      sourceId: input.provenance?.sourceId,
      // Without this the digest is dropped here and frozen evidence for live samples
      // carries no way to re-derive the reading it was based on.
      sourceHash: input.provenance?.sourceHash
    };

    const next: ObservationSnapshot = {
      ...existing,
      role: input.role,
      source: input.source || existing.source,
      updatedAt: new Date().toISOString()
    };

    // Start: near observationStart (absolute distance).
    if (
      Number.isFinite(input.obsStartMs) &&
      input.obsStartMs > 0 &&
      Math.abs(input.atMs - input.obsStartMs) <= maxDist
    ) {
      if (next.startValue === undefined) {
        next.startValue = input.value;
        next.startTimestamp = input.atMs;
        next.startSource = prov;
      } else if (
        next.startTimestamp !== undefined &&
        Math.abs(input.atMs - input.obsStartMs) < Math.abs(next.startTimestamp - input.obsStartMs)
      ) {
        next.startValue = input.value;
        next.startTimestamp = input.atMs;
        next.startSource = prov;
      }
    }

    // End: ONLY samples with timestamp >= observationEnd (never pre-end values).
    if (
      Number.isFinite(input.obsEndMs) &&
      input.obsEndMs > 0 &&
      input.atMs >= input.obsEndMs &&
      input.atMs - input.obsEndMs <= maxDist
    ) {
      const dist = input.atMs - input.obsEndMs;
      if (next.endValue === undefined) {
        next.endValue = input.value;
        next.endTimestamp = input.atMs;
        next.endSource = prov;
      } else if (
        next.endTimestamp !== undefined &&
        dist < next.endTimestamp - input.obsEndMs
      ) {
        next.endValue = input.value;
        next.endTimestamp = input.atMs;
        next.endSource = prov;
      }
    }

    await store.set(k, next);
    return next;
  });
}

export async function applyBoundaryFromRawTicks(input: {
  market: string;
  role: "btc" | "weather";
  obsStartMs: number;
  obsEndMs: number;
  open?: TickProvenance;
  close?: TickProvenance;
  source: string;
}): Promise<ObservationSnapshot | null> {
  const k = key(input.market);

  return withSnapLock(k, async () => {
    const existing =
      (await store.get(k)) ??
      ({
        market: k,
        role: input.role,
        source: input.source,
        updatedAt: new Date().toISOString()
      } satisfies ObservationSnapshot);

    if (existing.frozen) return existing;

    const next: ObservationSnapshot = {
      ...existing,
      role: input.role,
      source: input.source || existing.source,
      updatedAt: new Date().toISOString()
    };

    if (input.open) {
      const dist = Math.abs(input.open.observedAt - input.obsStartMs);
      if (
        next.startValue === undefined ||
        (next.startTimestamp !== undefined &&
          dist < Math.abs(next.startTimestamp - input.obsStartMs))
      ) {
        next.startValue = input.open.value;
        next.startTimestamp = input.open.observedAt;
        next.startSource = input.open;
      }
    }

    // Close must be at or after observationEnd.
    if (input.close && input.close.observedAt >= input.obsEndMs) {
      const dist = input.close.observedAt - input.obsEndMs;
      if (
        next.endValue === undefined ||
        (next.endTimestamp !== undefined && dist < next.endTimestamp - input.obsEndMs)
      ) {
        next.endValue = input.close.value;
        next.endTimestamp = input.close.observedAt;
        next.endSource = input.close;
      }
    }

    await store.set(k, next);
    return next;
  });
}

/**
 * Freeze only after successful on-chain resolve. Uses SET NX semantics:
 * if already frozen, leave unchanged.
 */
export async function freezeObservationSnapshot(input: {
  market: string;
  outcome: "YES" | "NO";
  resolutionTxHash: string;
  startValue: number;
  startTimestamp: number;
  endValue: number;
  endTimestamp: number;
  source: string;
  role: "btc" | "weather";
  onchainStatus: number;
  startSource?: TickProvenance;
  endSource?: TickProvenance;
}): Promise<ObservationSnapshot> {
  requireDurableKv("oracle resolution freeze");
  const k = key(input.market);
  const lockTok = randomBytes(8).toString("hex");
  if (!(await acquireLock(`obs-freeze:${k}`, 15_000, lockTok))) {
    const existing = await store.get(k);
    if (existing?.frozen) return existing;
    throw new Error("Could not acquire snapshot freeze lock");
  }
  try {
    const existing = await store.get(k);
    if (existing?.frozen) return existing;

    const frozen: ObservationSnapshot = {
      market: k,
      role: input.role,
      startValue: input.startValue,
      startTimestamp: input.startTimestamp,
      endValue: input.endValue,
      endTimestamp: input.endTimestamp,
      startSource: input.startSource,
      endSource: input.endSource,
      source: input.source,
      updatedAt: new Date().toISOString(),
      frozen: true,
      frozenAt: new Date().toISOString(),
      resolutionTxHash: input.resolutionTxHash,
      outcome: input.outcome,
      onchainStatus: input.onchainStatus
    };
    await store.set(k, frozen);
    return frozen;
  } finally {
    await releaseLock(`obs-freeze:${k}`, lockTok).catch(() => undefined);
  }
}

export function valueNearTimeWithin(
  history: Array<{ value: number; at: number }> | undefined,
  t: number,
  maxDistanceMs: number
): { value: number; at: number; dist: number } | undefined {
  if (!history?.length || !Number.isFinite(t) || t <= 0) return undefined;
  let best: { value: number; at: number; dist: number } | undefined;
  for (const p of history) {
    if (!Number.isFinite(p?.value) || !Number.isFinite(p?.at)) continue;
    const dist = Math.abs(p.at - t);
    if (dist > maxDistanceMs) continue;
    if (!best || dist < best.dist) best = { value: p.value, at: p.at, dist };
  }
  return best;
}

export function snapshotReadyForResolve(
  snap: ObservationSnapshot | null | undefined,
  obsStartMs: number,
  obsEndMs: number,
  maxDistanceMs = BTC_SNAPSHOT_MAX_DIST_MS
):
  | {
      ok: true;
      start: number;
      end: number;
      startAt: number;
      endAt: number;
      startSource?: TickProvenance;
      endSource?: TickProvenance;
    }
  | { ok: false; reason: string } {
  if (!snap) return { ok: false, reason: "No observation snapshot stored for market" };
  if (!Number.isFinite(snap.startValue) || snap.startTimestamp === undefined) {
    return { ok: false, reason: "Missing observation start snapshot" };
  }
  if (!Number.isFinite(snap.endValue) || snap.endTimestamp === undefined) {
    return { ok: false, reason: "Missing observation end snapshot" };
  }
  // End must be at or after observationEnd
  if (snap.endTimestamp < obsEndMs) {
    return { ok: false, reason: "End snapshot is before observationEnd" };
  }
  if (Math.abs(snap.startTimestamp - obsStartMs) > maxDistanceMs) {
    return { ok: false, reason: "Start snapshot too far from observationStart" };
  }
  if (snap.endTimestamp - obsEndMs > maxDistanceMs) {
    return { ok: false, reason: "End snapshot too far after observationEnd" };
  }
  return {
    ok: true,
    start: snap.startValue as number,
    end: snap.endValue as number,
    startAt: snap.startTimestamp,
    endAt: snap.endTimestamp,
    startSource: snap.startSource,
    endSource: snap.endSource
  };
}
