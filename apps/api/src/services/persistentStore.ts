/**
 * Durable key/value store for wallet mappings and transaction records.
 *
 * Production (Vercel) uses a REST KV — Vercel KV / Upstash Redis — so that the
 * email -> walletId/address mapping survives cold starts, redeploys, and
 * multi-instance fan-out. The previous /tmp JSON file is per-instance and
 * ephemeral, which is exactly the failure this store removes.
 *
 * If no KV env is present (local dev), it transparently falls back to a JSON
 * file under the runtime dir so nothing breaks and behaviour is unchanged.
 *
 * No new npm dependency: the KV is reached over its REST API with fetch.
 * Supported env shapes:
 *   - Vercel KV / Upstash Redis REST:
 *       KV_REST_API_URL + KV_REST_API_TOKEN
 *       (or UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN)
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { runtimeFile } from "../runtimePaths.js";

type KvConfig = { url: string; token: string };

function kvConfig(): KvConfig | null {
  const url =
    process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || "";
  const token =
    process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || "";
  if (!url || !token) return null;
  return { url: url.replace(/\/$/, ""), token };
}

export function persistenceMode(): "kv" | "file" {
  return kvConfig() ? "kv" : "file";
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
