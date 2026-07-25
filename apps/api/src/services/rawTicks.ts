/**
 * High-resolution feed ticks (not minute-bucketed chart history).
 * Used to resolve observationStart/End even when the external pinger is ~1/min.
 */
import { NamespaceStore } from "./persistentStore.js";

export type RawTick = { value: number; at: number };

const btcStore = new NamespaceStore<{ ticks: RawTick[] }>("raw-ticks-btc");
const weatherStore = new NamespaceStore<{ ticks: RawTick[] }>("raw-ticks-weather");

const MAX_POINTS = 900; // ~15 min at 1Hz
const TTL_MS = 15 * 60_000;

function prune(ticks: RawTick[], now: number): RawTick[] {
  const cutoff = now - TTL_MS;
  const kept = ticks.filter((t) => t.at >= cutoff && Number.isFinite(t.value) && Number.isFinite(t.at));
  return kept.length > MAX_POINTS ? kept.slice(-MAX_POINTS) : kept;
}

async function load(store: NamespaceStore<{ ticks: RawTick[] }>): Promise<RawTick[]> {
  const row = await store.get("series");
  return Array.isArray(row?.ticks) ? row!.ticks : [];
}

async function save(store: NamespaceStore<{ ticks: RawTick[] }>, ticks: RawTick[]): Promise<void> {
  await store.set("series", { ticks });
}

export async function pushRawTick(
  feed: "btc" | "weather",
  value: number,
  atMs = Date.now()
): Promise<void> {
  if (!Number.isFinite(value) || !Number.isFinite(atMs)) return;
  const store = feed === "btc" ? btcStore : weatherStore;
  const now = Date.now();
  const ticks = prune(await load(store), now);
  const last = ticks[ticks.length - 1];
  // Dedupe same-second spam
  if (last && Math.abs(last.at - atMs) < 400) {
    ticks[ticks.length - 1] = { value, at: Math.max(last.at, atMs) };
  } else {
    ticks.push({ value, at: atMs });
  }
  await save(store, prune(ticks, now));
}

export async function getRawTicks(feed: "btc" | "weather"): Promise<RawTick[]> {
  const store = feed === "btc" ? btcStore : weatherStore;
  return prune(await load(store), Date.now());
}

/** Nearest raw tick within maxDistanceMs of target time. */
export function nearestRawTick(
  ticks: RawTick[],
  t: number,
  maxDistanceMs: number
): { value: number; at: number; dist: number } | undefined {
  if (!ticks.length || !Number.isFinite(t) || t <= 0) return undefined;
  let best: { value: number; at: number; dist: number } | undefined;
  for (const p of ticks) {
    const dist = Math.abs(p.at - t);
    if (dist > maxDistanceMs) continue;
    if (!best || dist < best.dist) best = { value: p.value, at: p.at, dist };
  }
  return best;
}
