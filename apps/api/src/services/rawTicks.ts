/**
 * High-resolution feed ticks with provenance.
 * Prefer Redis ZSET when KV available; file fallback uses append-under-lock.
 *
 * ZSET members are deterministic (no receivedAt) so repeated ingest of the same
 * provider print overwrites instead of amplifying under public load.
 * Prune is score/TTL-based only — never rank-cap that can drop the start print.
 */
import { randomBytes } from "node:crypto";
import {
  NamespaceStore,
  acquireLock,
  isSharedRuntime,
  kvEval,
  persistenceMode,
  releaseLock,
  requireDurableKv
} from "./persistentStore.js";
import { ORACLE_TICK_RETENTION_MS } from "./observationSnapshots.js";

export type RawTick = {
  value: number;
  /** Provider observation time (ms). */
  observedAt: number;
  /** Server receive time (ms). Not part of ZSET identity. */
  receivedAt: number;
  provider: string;
  sourceId?: string;
  /** Optional hash of normalized upstream payload for audit replay. */
  sourceHash?: string;
};

/**
 * Retention is derived, never a standalone literal: the start print must outlive
 * the longest observation window plus its cancel grace. A hand-tuned number here
 * silently decouples from the window constants the moment either one moves.
 */
const TTL_MS = ORACLE_TICK_RETENTION_MS;

const fileStore = new NamespaceStore<{ ticks: RawTick[] }>("raw-ticks-v2");

/**
 * Deterministic ZSET member / file-dedup key: same observation overwrites.
 * receivedAt is intentionally excluded — it changes on every poll.
 */
export function rawTickIdentity(tick: {
  value: number;
  observedAt: number;
  provider: string;
  sourceId?: string;
  sourceHash?: string;
}): string {
  return [
    tick.provider,
    String(tick.observedAt),
    // fixed precision so float noise does not create distinct members
    Number(tick.value).toFixed(8),
    tick.sourceId ?? "",
    tick.sourceHash ?? ""
  ].join("|");
}

function prune(ticks: RawTick[], now: number): RawTick[] {
  const cutoff = now - TTL_MS;
  return ticks.filter(
    (t) =>
      t.observedAt >= cutoff &&
      Number.isFinite(t.value) &&
      Number.isFinite(t.observedAt)
  );
}

function zsetKey(feed: "btc" | "weather"): string {
  return `raw-ticks-z:${feed}`;
}

/** Serialize tick for ZSET member — identity fields only (no receivedAt). */
export function serializeRawTickMember(tick: RawTick): string {
  return JSON.stringify({
    value: tick.value,
    observedAt: tick.observedAt,
    provider: tick.provider,
    sourceId: tick.sourceId,
    sourceHash: tick.sourceHash
  });
}

export function parseRawTickMember(member: string, fallbackReceivedAt = 0): RawTick | null {
  try {
    const o = JSON.parse(member) as Partial<RawTick>;
    if (!Number.isFinite(o.value) || !Number.isFinite(o.observedAt)) return null;
    return {
      value: Number(o.value),
      observedAt: Number(o.observedAt),
      receivedAt: Number.isFinite(o.receivedAt) ? Number(o.receivedAt) : fallbackReceivedAt,
      provider: String(o.provider ?? "unknown"),
      sourceId: o.sourceId,
      sourceHash: o.sourceHash
    };
  } catch {
    return null;
  }
}

export async function pushRawTick(
  feed: "btc" | "weather",
  value: number,
  observedAtMs: number,
  meta?: {
    provider?: string;
    sourceId?: string;
    receivedAt?: number;
    sourceHash?: string;
  }
): Promise<void> {
  if (!Number.isFinite(value) || !Number.isFinite(observedAtMs)) return;
  const receivedAt = meta?.receivedAt ?? Date.now();
  const tick: RawTick = {
    value,
    observedAt: observedAtMs,
    receivedAt,
    provider: meta?.provider ?? (feed === "btc" ? "coinbase" : "open-meteo"),
    sourceId: meta?.sourceId,
    sourceHash: meta?.sourceHash
  };

  if (persistenceMode() === "kv") {
    // ZADD score=observedAt member=stable JSON (no receivedAt) → overwrite same print.
    // Prune only by score/TTL — never by rank (rank prune washed start snapshots under load).
    try {
      await kvEval(
        // KEYS[1]=zset ARGV[1]=score ARGV[2]=member ARGV[3]=cutoff
        `
        redis.call('ZADD', KEYS[1], ARGV[1], ARGV[2])
        redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', ARGV[3])
        return redis.call('ZCARD', KEYS[1])
        `,
        [zsetKey(feed)],
        [String(observedAtMs), serializeRawTickMember(tick), String(Date.now() - TTL_MS)]
      );
      return;
    } catch (err) {
      // A transient Redis failure must not silently downgrade the oracle to per-instance
      // files on a shared deploy: each serverless instance would then resolve from its
      // own private tick history. Fail loudly here; only local dev may fall back.
      if (isSharedRuntime()) {
        throw new Error(
          `Oracle tick write failed and file fallback is not safe on a shared runtime: ${
            err instanceof Error ? err.message : String(err)
          }`
        );
      }
    }
  }

  // File / fallback: append under lock; skip entirely if lock busy (no lost-update race).
  const lockTok = randomBytes(6).toString("hex");
  const lockKey = `raw-tick-append:${feed}`;
  let gotLock = await acquireLock(lockKey, 5_000, lockTok);
  if (!gotLock) {
    // Short retry once — prefer skip over unlocked RMW.
    await new Promise((r) => setTimeout(r, 25));
    gotLock = await acquireLock(lockKey, 5_000, lockTok);
    if (!gotLock) return;
  }
  try {
    const row = (await fileStore.get(feed)) ?? { ticks: [] as RawTick[] };
    const ticks = prune(row.ticks ?? [], Date.now());
    const id = rawTickIdentity(tick);
    const idx = ticks.findIndex((t) => rawTickIdentity(t) === id);
    if (idx >= 0) {
      // Identical reading re-ingested — refresh in place, nothing is lost.
      ticks[idx] = tick;
    } else {
      // A near-duplicate with a *different* value is a corrected reading, not a repeat.
      // Overwriting it here made the file backend disagree with KV (which keeps both)
      // and silently rewrote a number a payout may already rest on. Keep both and let
      // the selection policy decide; conflicts must be visible, not erased.
      const near = ticks.find(
        (t) => t.provider === tick.provider && Math.abs(t.observedAt - observedAtMs) < 400
      );
      if (near && near.value !== tick.value) {
        console.warn(
          `[oracle] conflicting ${feed} reading at ${new Date(observedAtMs).toISOString()}: ` +
            `kept ${near.value} (first seen), also observed ${tick.value} from ${tick.provider}`
        );
      }
      ticks.push(tick);
    }
    ticks.sort((a, b) => a.observedAt - b.observedAt);
    await fileStore.set(feed, { ticks: prune(ticks, Date.now()) });
  } finally {
    await releaseLock(lockKey, lockTok).catch(() => undefined);
  }
}

export async function getRawTicks(feed: "btc" | "weather"): Promise<RawTick[]> {
  if (persistenceMode() === "kv") {
    try {
      const cutoff = Date.now() - TTL_MS;
      const members = await kvEval<string[]>(
        `return redis.call('ZRANGEBYSCORE', KEYS[1], ARGV[1], '+inf')`,
        [zsetKey(feed)],
        [String(cutoff)]
      );
      if (Array.isArray(members)) {
        return members
          .map((m) => parseRawTickMember(m))
          .filter((t): t is RawTick => Boolean(t && Number.isFinite(t.value)));
      }
    } catch (err) {
      // Same reasoning as pushRawTick: resolving from a per-instance file while KV is
      // merely unreachable would decide payouts from a partial view of the feed.
      if (isSharedRuntime()) {
        throw new Error(
          `Oracle tick read failed and file fallback is not safe on a shared runtime: ${
            err instanceof Error ? err.message : String(err)
          }`
        );
      }
    }
  }
  const row = await fileStore.get(feed);
  return prune(row?.ticks ?? [], Date.now());
}

/** First tick with observedAt >= t, within maxDistance after t. */
/**
 * Conflict policy for two readings that sit at the same distance from the boundary
 * (same observedAt, different value — a provider correction, or two providers).
 *
 * The winner is the lexicographically smaller identity. That is arbitrary but *stable*:
 * it does not depend on Redis member ordering or on file insertion order, so both
 * backends and every replay pick the same print. Relying on storage order instead would
 * let the same evidence resolve differently depending on where it was read from.
 */
function tickBreaksTie(candidate: RawTick, incumbent: RawTick): boolean {
  return rawTickIdentity(candidate) < rawTickIdentity(incumbent);
}

export function firstTickAtOrAfter(
  ticks: RawTick[],
  t: number,
  maxDistanceMs: number
): { value: number; at: number; dist: number; tick: RawTick } | undefined {
  if (!ticks.length || !Number.isFinite(t)) return undefined;
  let best: { value: number; at: number; dist: number; tick: RawTick } | undefined;
  for (const p of ticks) {
    if (p.observedAt < t) continue;
    const dist = p.observedAt - t;
    if (dist > maxDistanceMs) continue;
    if (!best || dist < best.dist || (dist === best.dist && tickBreaksTie(p, best.tick))) {
      best = { value: p.value, at: p.observedAt, dist, tick: p };
    }
  }
  return best;
}

/** Nearest tick by absolute distance (for start boundary). */
export function nearestRawTick(
  ticks: RawTick[],
  t: number,
  maxDistanceMs: number
): { value: number; at: number; dist: number; tick: RawTick } | undefined {
  if (!ticks.length || !Number.isFinite(t)) return undefined;
  let best: { value: number; at: number; dist: number; tick: RawTick } | undefined;
  for (const p of ticks) {
    const dist = Math.abs(p.observedAt - t);
    if (dist > maxDistanceMs) continue;
    if (!best || dist < best.dist || (dist === best.dist && tickBreaksTie(p, best.tick))) {
      best = { value: p.value, at: p.observedAt, dist, tick: p };
    }
  }
  return best;
}

export function requireOracleKv(): void {
  requireDurableKv("oracle raw ticks / snapshots");
}
