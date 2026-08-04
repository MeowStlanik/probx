/**
 * Durable key/value store for wallet mappings and transaction records.
 *
 * Production uses Upstash Redis over HTTPS so state survives Railway restarts
 * and remains safe if the service is scaled beyond one process. Local
 * development falls back to JSON files in the runtime directory.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { runtimeFile } from "../runtimePaths.js";

type KvConfig = { url: string; token: string };

function kvConfig(): KvConfig | null {
  const url = process.env.UPSTASH_REDIS_REST_URL || "";
  const token = process.env.UPSTASH_REDIS_REST_TOKEN || "";
  if (!url || !token) return null;
  return { url: url.replace(/\/$/, ""), token };
}

export function persistenceMode(): "kv" | "file" {
  return kvConfig() ? "kv" : "file";
}

/** True when process-local state is unsafe for production guarantees. */
export function isSharedRuntime(): boolean {
  return process.env.NODE_ENV === "production";
}

/**
 * Fail closed for security-critical paths (CCTP faucet, session revoke, OTP jti)
 * when durable KV is not configured on a shared runtime.
 */
export function requireDurableKv(feature: string): void {
  if (!isSharedRuntime()) return;
  if (persistenceMode() !== "kv") {
    throw new Error(
      `${feature} requires durable KV (UPSTASH_REDIS_REST_URL) in production.`
    );
  }
}

/** Shared lock name for market creation by role — tour + cycle must use the same key. */
export function marketCreateLockKey(role: "btc" | "weather"): string {
  return `market-create:${role}`;
}

async function kvCommand<T = unknown>(cfg: KvConfig, command: unknown[]): Promise<T | null> {
  const res = await fetch(cfg.url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${cfg.token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(command)
  });
  if (!res.ok) {
    throw new Error(`KV command failed: HTTP ${res.status}`);
  }
  const json = (await res.json()) as { result?: T; error?: string };
  if (json.error) throw new Error(`KV error: ${json.error}`);
  return (json.result ?? null) as T | null;
}

/** Run a Redis EVAL script when KV is configured. */
export async function kvEval<T = unknown>(
  script: string,
  keys: string[],
  args: string[]
): Promise<T | null> {
  const cfg = kvConfig();
  if (!cfg) throw new Error("KV not configured");
  return kvCommand<T>(cfg, ["EVAL", script, String(keys.length), ...keys, ...args]);
}

/**
 * Atomic CCTP quota reservation: both caps are checked, both counters are advanced,
 * and the reservation record is written in a single Lua call. Splitting the record
 * write out of the transaction leaks quota — counters move, then the record write
 * fails, and nothing is left to tell release()/finalize() what to undo.
 */
export async function atomicIncrQuota(params: {
  addrKey: string;
  day: string;
  amount: string;
  perCap: string;
  globCap: string;
  reservationId: string;
  reservationJson: string;
}): Promise<{ ok: boolean; reason?: string; perUsed?: string; globUsed?: string }> {
  const cfg = kvConfig();
  if (!cfg) {
    return { ok: false, reason: "no-kv" };
  }
  // KEYS: per, glob, reservations  ARGV: day, amount, perCap, globCap, ttlSec, resId, resJson
  const result = await kvCommand<string>(cfg, [
    "EVAL",
    `
    local day = ARGV[1]
    local amount = tonumber(ARGV[2])
    local perCap = tonumber(ARGV[3])
    local globCap = tonumber(ARGV[4])
    local ttlSec = tonumber(ARGV[5])
    local resId = ARGV[6]
    local resJson = ARGV[7]
    local perRaw = redis.call('HGET', KEYS[1], day)
    local globRaw = redis.call('HGET', KEYS[2], day)
    local perUsed = tonumber(perRaw or '0')
    local globUsed = tonumber(globRaw or '0')
    if perUsed + amount > perCap then
      return cjson.encode({ok=false, reason='per-cap'})
    end
    if globUsed + amount > globCap then
      return cjson.encode({ok=false, reason='glob-cap'})
    end
    local perNew = perUsed + amount
    local globNew = globUsed + amount
    redis.call('HSET', KEYS[1], day, tostring(perNew))
    redis.call('HSET', KEYS[2], day, tostring(globNew))
    -- Reservation lands in the same transaction as the counters it accounts for.
    redis.call('HSET', KEYS[3], resId, resJson)
    -- Refresh TTL on every write so active days stay; idle hashes free after ~48h.
    redis.call('EXPIRE', KEYS[1], ttlSec)
    redis.call('EXPIRE', KEYS[2], ttlSec)
    return cjson.encode({ok=true, perUsed=tostring(perNew), globUsed=tostring(globNew)})
    `,
    "3",
    `cctp-quota-per:${params.addrKey}`,
    "cctp-quota-glob",
    "cctp-quota-reservations",
    params.day,
    params.amount,
    params.perCap,
    params.globCap,
    String(48 * 3600),
    params.reservationId,
    params.reservationJson
  ]);
  try {
    return JSON.parse(String(result ?? "{}")) as {
      ok: boolean;
      reason?: string;
      perUsed?: string;
      globUsed?: string;
    };
  } catch {
    return { ok: false, reason: "parse" };
  }
}

export async function atomicDecrQuota(params: {
  addrKey: string;
  day: string;
  amount: string;
}): Promise<void> {
  const cfg = kvConfig();
  if (!cfg) return;
  await kvCommand(cfg, [
    "EVAL",
    `
    local day = ARGV[1]
    local amount = tonumber(ARGV[2])
    local perRaw = redis.call('HGET', KEYS[1], day)
    local globRaw = redis.call('HGET', KEYS[2], day)
    local perUsed = math.max(0, tonumber(perRaw or '0') - amount)
    local globUsed = math.max(0, tonumber(globRaw or '0') - amount)
    redis.call('HSET', KEYS[1], day, tostring(perUsed))
    redis.call('HSET', KEYS[2], day, tostring(globUsed))
    return 1
    `,
    "2",
    `cctp-quota-per:${params.addrKey}`,
    "cctp-quota-glob",
    params.day,
    params.amount
  ]);
}

/**
 * A namespaced document store. Each namespace maps to one JSON file locally,
 * and to one Redis hash (HSET/HGETALL) on KV. Values are JSON-serialised.
 */
export class NamespaceStore<V> {
  private readonly namespace: string;
  private readonly filePath: string;

  constructor(namespace: string) {
    this.namespace = namespace;
    this.filePath = runtimeFile(`${namespace}.json`);
  }

  private readFile(): Record<string, V> {
    try {
      if (!existsSync(this.filePath)) return {};
      const raw = JSON.parse(readFileSync(this.filePath, "utf8")) as {
        entries?: Record<string, V>;
      };
      return raw.entries ?? {};
    } catch {
      return {};
    }
  }

  private writeFile(entries: Record<string, V>): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    writeFileSync(this.filePath, JSON.stringify({ version: 1, entries }, null, 2));
  }

  async get(key: string): Promise<V | null> {
    const cfg = kvConfig();
    if (cfg) {
      const raw = await kvCommand<string>(cfg, ["HGET", this.namespace, key]);
      if (raw == null) return null;
      try {
        return JSON.parse(raw) as V;
      } catch {
        return null;
      }
    }
    const entries = this.readFile();
    return key in entries ? entries[key]! : null;
  }

  async set(key: string, value: V): Promise<void> {
    const cfg = kvConfig();
    if (cfg) {
      await kvCommand(cfg, ["HSET", this.namespace, key, JSON.stringify(value)]);
      return;
    }
    const entries = this.readFile();
    entries[key] = value;
    this.writeFile(entries);
  }

  async delete(key: string): Promise<void> {
    const cfg = kvConfig();
    if (cfg) {
      await kvCommand(cfg, ["HDEL", this.namespace, key]);
      return;
    }
    const entries = this.readFile();
    delete entries[key];
    this.writeFile(entries);
  }

  async all(): Promise<Record<string, V>> {
    const cfg = kvConfig();
    if (cfg) {
      const flat = await kvCommand<string[]>(cfg, ["HGETALL", this.namespace]);
      const out: Record<string, V> = {};
      if (Array.isArray(flat)) {
        for (let i = 0; i + 1 < flat.length; i += 2) {
          const k = flat[i]!;
          try {
            out[k] = JSON.parse(flat[i + 1]!) as V;
          } catch {
            /* skip malformed */
          }
        }
      }
      return out;
    }
    return this.readFile();
  }

  async count(): Promise<number> {
    const cfg = kvConfig();
    if (cfg) {
      const n = await kvCommand<number>(cfg, ["HLEN", this.namespace]);
      return typeof n === "number" ? n : 0;
    }
    return Object.keys(this.readFile()).length;
  }
}

/**
 * Distributed lock via Redis SET NX PX when KV is configured.
 * Falls back to a process-local Map for single-instance dev.
 */
const localLocks = new Map<string, { token: string; expiresAt: number }>();

export async function acquireLock(
  key: string,
  ttlMs: number,
  token: string
): Promise<boolean> {
  const cfg = kvConfig();
  if (cfg) {
    // SET key token NX PX ttl
    const result = await kvCommand<string | null>(cfg, [
      "SET",
      `lock:${key}`,
      token,
      "NX",
      "PX",
      String(ttlMs)
    ]);
    return result === "OK";
  }
  const now = Date.now();
  const cur = localLocks.get(key);
  if (cur && cur.expiresAt > now) return false;
  localLocks.set(key, { token, expiresAt: now + ttlMs });
  return true;
}

/**
 * Extend a lock we still hold. Returns false if the lease was lost (expired and
 * possibly taken over), so a long operation can detect it is no longer the owner
 * instead of continuing to act as if it were.
 */
export async function renewLock(
  key: string,
  ttlMs: number,
  token: string
): Promise<boolean> {
  const cfg = kvConfig();
  if (cfg) {
    try {
      const res = await kvCommand<number>(cfg, [
        "EVAL",
        "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('pexpire', KEYS[1], ARGV[2]) else return 0 end",
        "1",
        `lock:${key}`,
        token,
        String(ttlMs)
      ]);
      return Number(res) === 1;
    } catch {
      return false;
    }
  }
  const cur = localLocks.get(key);
  if (cur?.token !== token) return false;
  localLocks.set(key, { token, expiresAt: Date.now() + ttlMs });
  return true;
}

export async function releaseLock(key: string, token: string): Promise<void> {
  const cfg = kvConfig();
  if (cfg) {
    // Atomic compare-and-delete (Lua) so we never drop another worker's lock.
    try {
      await kvCommand(cfg, [
        "EVAL",
        "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end",
        "1",
        `lock:${key}`,
        token
      ]);
    } catch {
      // Fallback if EVAL blocked: best-effort GET/DEL
      const current = await kvCommand<string | null>(cfg, ["GET", `lock:${key}`]);
      if (current === token) await kvCommand(cfg, ["DEL", `lock:${key}`]);
    }
    return;
  }
  const cur = localLocks.get(key);
  if (cur?.token === token) localLocks.delete(key);
}

/**
 * Atomic set-if-absent with optional TTL (seconds). Returns true if we set the key.
 * Used for OTP jti / nonces single-use consume.
 */
export async function setIfAbsent(
  key: string,
  value: unknown,
  ttlSec = 3600
): Promise<boolean> {
  const cfg = kvConfig();
  const serialized = JSON.stringify(value);
  if (cfg) {
    const result = await kvCommand<string | null>(cfg, [
      "SET",
      key,
      serialized,
      "NX",
      "EX",
      String(ttlSec)
    ]);
    return result === "OK";
  }
  // File fallback: use a dedicated namespace entry
  const store = new NamespaceStore<{ v: unknown; exp: number }>("set-if-absent");
  const existing = await store.get(key);
  const now = Date.now();
  if (existing && existing.exp > now) return false;
  await store.set(key, { v: value, exp: now + ttlSec * 1000 });
  return true;
}
