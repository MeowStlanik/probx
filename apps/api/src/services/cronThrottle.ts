/**
 * Best-effort in-memory throttle for cron/cycle endpoints.
 *
 * The market cycle is deliberately callable without a secret (the client
 * heartbeat drives it on Vercel Hobby, where cron runs only once a day).
 * Without a throttle, spamming the endpoint burns oracle gas on every call.
 * One run per window per instance keeps the heartbeat design intact while
 * capping abuse. Callers that present a valid CRON_SECRET bypass the throttle.
 */
const lastRunByKey = new Map<string, number>();

const DEFAULT_WINDOW_MS = 15_000;

/**
 * Returns true when the call should be SKIPPED (throttled).
 * The throttle window can be tuned with CRON_THROTTLE_MS (min 5s).
 */
export function cronThrottled(key: string): boolean {
  const configured = Number(process.env.CRON_THROTTLE_MS ?? DEFAULT_WINDOW_MS);
  const windowMs = Number.isFinite(configured) && configured >= 5_000 ? configured : DEFAULT_WINDOW_MS;
  const now = Date.now();
  const last = lastRunByKey.get(key) ?? 0;
  if (now - last < windowMs) return true;
  lastRunByKey.set(key, now);
  // Bound the map.
  if (lastRunByKey.size > 100) {
    for (const stale of [...lastRunByKey.keys()].slice(0, 50)) lastRunByKey.delete(stale);
  }
  return false;
}
