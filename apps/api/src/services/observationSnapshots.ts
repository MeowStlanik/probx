/**
 * Immutable observation snapshots for BTC/weather markets.
 * Resolve must use startValue @ observationStart and endValue @ observationEnd —
 * never "current feed price when the worker happened to run".
 */
import { NamespaceStore } from "./persistentStore.js";

export type ObservationSnapshot = {
  market: string;
  role: "btc" | "weather";
  startValue?: number;
  startTimestamp?: number;
  endValue?: number;
  endTimestamp?: number;
  source: string;
  updatedAt: string;
};

const store = new NamespaceStore<ObservationSnapshot>("observation-snapshots");

function key(market: string): string {
  return market.trim().toLowerCase();
}

export async function getObservationSnapshot(market: string): Promise<ObservationSnapshot | null> {
  return store.get(key(market));
}

export async function recordObservationSample(input: {
  market: string;
  role: "btc" | "weather";
  value: number;
  atMs: number;
  /** observationStart / observationEnd unix ms */
  obsStartMs: number;
  obsEndMs: number;
  source: string;
  /** Max distance from target boundary to accept sample (default 10s for BTC). */
  maxDistanceMs?: number;
}): Promise<ObservationSnapshot> {
  const maxDist = input.maxDistanceMs ?? 10_000;
  const k = key(input.market);
  const existing =
    (await store.get(k)) ??
    ({
      market: k,
      role: input.role,
      source: input.source,
      updatedAt: new Date().toISOString()
    } satisfies ObservationSnapshot);

  const next: ObservationSnapshot = {
    ...existing,
    role: input.role,
    source: input.source || existing.source,
    updatedAt: new Date().toISOString()
  };

  // Capture start if we don't have one and sample is near obsStart.
  if (
    next.startValue === undefined &&
    Number.isFinite(input.obsStartMs) &&
    input.obsStartMs > 0 &&
    Math.abs(input.atMs - input.obsStartMs) <= maxDist
  ) {
    next.startValue = input.value;
    next.startTimestamp = input.atMs;
  }

  // Capture / refresh end once we're at or past obsEnd (nearest sample within window).
  if (Number.isFinite(input.obsEndMs) && input.obsEndMs > 0 && input.atMs >= input.obsEndMs - maxDist) {
    const dist = Math.abs(input.atMs - input.obsEndMs);
    const prevDist =
      next.endTimestamp !== undefined ? Math.abs(next.endTimestamp - input.obsEndMs) : Number.POSITIVE_INFINITY;
    if (dist <= maxDist && dist <= prevDist) {
      next.endValue = input.value;
      next.endTimestamp = input.atMs;
    }
  }

  await store.set(k, next);
  return next;
}

/** Closest sample within maxDistanceMs of target time; undefined if none close enough. */
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
  maxDistanceMs = 10_000
): { ok: true; start: number; end: number } | { ok: false; reason: string } {
  if (!snap) return { ok: false, reason: "No observation snapshot stored for market" };
  if (!Number.isFinite(snap.startValue) || snap.startTimestamp === undefined) {
    return { ok: false, reason: "Missing observation start snapshot" };
  }
  if (!Number.isFinite(snap.endValue) || snap.endTimestamp === undefined) {
    return { ok: false, reason: "Missing observation end snapshot" };
  }
  if (Math.abs(snap.startTimestamp - obsStartMs) > maxDistanceMs) {
    return { ok: false, reason: "Start snapshot too far from observationStart" };
  }
  if (Math.abs(snap.endTimestamp - obsEndMs) > maxDistanceMs) {
    return { ok: false, reason: "End snapshot too far from observationEnd" };
  }
  return { ok: true, start: snap.startValue as number, end: snap.endValue as number };
}
