import Redis from "ioredis";
import { randomUUID } from "node:crypto";

const url = String(process.env.AIVEN_VALKEY_URL || process.env.VALKEY_URL || "").trim();
if (!url) {
  console.error("Set AIVEN_VALKEY_URL (recommended) or VALKEY_URL before running this check.");
  process.exit(2);
}
if (!url.startsWith("rediss://")) {
  console.error("The Aiven service URI must start with rediss:// (TLS).");
  process.exit(2);
}

const client = new Redis(url, {
  lazyConnect: true,
  connectTimeout: 10_000,
  maxRetriesPerRequest: 1,
  enableReadyCheck: true
});

const prefix = `probx:smoke:${randomUUID()}`;
const lockKey = `${prefix}:lock`;
const hashKey = `${prefix}:hash`;
const zsetKey = `${prefix}:zset`;

try {
  await client.connect();
  const pong = await client.ping();
  if (pong !== "PONG") throw new Error(`Unexpected PING response: ${pong}`);

  const lock = await client.set(lockKey, "token", "NX", "PX", 30_000);
  if (lock !== "OK") throw new Error("SET NX PX failed");

  const renewed = await client.eval(
    "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('pexpire', KEYS[1], ARGV[2]) else return 0 end",
    1,
    lockKey,
    "token",
    "30000"
  );
  if (Number(renewed) !== 1) throw new Error("EVAL/PEXPIRE lock renewal failed");

  await client.hset(hashKey, "field", JSON.stringify({ ok: true }));
  const hashValue = await client.hget(hashKey, "field");
  if (hashValue !== '{"ok":true}') throw new Error("HSET/HGET failed");

  await client.zadd(zsetKey, Date.now(), JSON.stringify({ t: "tick" }));
  const zsetValues = await client.zrangebyscore(zsetKey, "-inf", "+inf");
  if (zsetValues.length !== 1) throw new Error("ZADD/ZRANGEBYSCORE failed");

  console.log("Aiven Valkey smoke check passed: PING, SET NX PX, EVAL, hashes and sorted sets.");
} finally {
  try {
    await client.del(lockKey, hashKey, zsetKey);
  } catch {
    // Best-effort cleanup only.
  }
  client.disconnect(false);
}
