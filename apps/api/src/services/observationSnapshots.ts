/**
 * Immutable observation snapshots for BTC/weather markets.
 * Resolve uses start/end prints near observationStart/End — never live worker price.
 * After resolve, records are frozen and never overwritten.
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
  /** Once true, never mutate start/end (auditable evidence). */
  frozen?: boolean;
  frozenAt?: string;
  resolutionTxHash?: string;
  outcome?: "YES" | "NO";
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
  obsStartMs: number;
  obsEndMs: number;
  source: string;
  maxDistanceMs?: number;
}): Promise<ObservationSnapshot> {
  const maxDist = input.maxDistanceMs ?? 35_000;
  const k = key(input.market);
  const existing =
    (await store.get(k)) ??
    ({
      market: k,
      role: input.role,
      source: input.source,
      updatedAt: new Date().toISOString()
    } satisfies ObservationSnapshot);

  // Never mutate frozen resolution evidence.
  if (existing.frozen) return existing;

  const next: ObservationSnapshot = {
    ...existing,
    role: input.role,
    source: input.source || existing.source,
    updatedAt: new Date().toISOString()
  };

  if (
    next.startValue === undefined &&
    Number.isFinite(input.obsStartMs) &&
    input.obsStartMs > 0 &&
    Math.abs(input.atMs - input.obsStartMs) <= maxDist
  ) {
    next.startValue = input.value;
    next.startTimestamp = input.atMs;
  }

  // Set end only once (first acceptable sample after end − window). Do not replace
  // with "closer" samples after resolve — that breaks audit trail.
  if (
    next.endValue === undefined &&
    Number.isFinite(input.obsEndMs) &&
    input.obsEndMs > 0 &&
    input.atMs >= input.obsEndMs - maxDist &&
    Math.abs(input.atMs - input.obsEndMs) <= maxDist
  ) {
    next.endValue = input.value;
    next.endTimestamp = input.atMs;
  }

  await store.set(k, next);
  return next;
}

/** Force start/end from raw ticks (idempotent; no-op if frozen). */
export async function applyBoundaryFromRawTicks(input: {
  market: string;
  role: "btc" | "weather";
  obsStartMs: number;
  obsEndMs: number;
  open?: { value: number; at: number };
  close?: { value: number; at: number };
  source: string;
}): Promise<ObservationSnapshot> {
  const k = key(input.market);
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
  if (input.open && next.startValue === undefined) {
    next.startValue = input.open.value;
    next.startTimestamp = input.open.at;
  }
  if (input.close && next.endValue === undefined) {
    next.endValue = input.close.value;
    next.endTimestamp = input.close.at;
  }
  await store.set(k, next);
  return next;
}

export async function freezeObservationSnapshot(input: {
  market: string;
  outcome: "YES" | "NO";
  resolutionTxHash?: string;
  startValue: number;
  startTimestamp: number;
  endValue: number;
  endTimestamp: number;
  source: string;
  role: "btc" | "weather";
}): Promise<ObservationSnapshot> {
  const k = key(input.market);
  const frozen: ObservationSnapshot = {
    market: k,
    role: input.role,
    startValue: input.startValue,
    startTimestamp: input.startTimestamp,
    endValue: input.endValue,
    endTimestamp: input.endTimestamp,
    source: input.source,
    updatedAt: new Date().toISOString(),
    frozen: true,
    frozenAt: new Date().toISOString(),
    resolutionTxHash: input.resolutionTxHash,
    outcome: input.outcome
  };
  await store.set(k, frozen);
  return frozen;
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
  maxDistanceMs = 35_000
): { ok: true; start: number; end: number; startAt: number; endAt: number } | { ok: false; reason: string } {
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
  return {
    ok: true,
    start: snap.startValue as number,
    end: snap.endValue as number,
    startAt: snap.startTimestamp,
    endAt: snap.endTimestamp
  };
}

/** Grace after observationEnd before canceling for missing snapshots (ms). */
export const SNAPSHOT_GRACE_MS = 45_000;
