/**
 * Shared admin gate for sensitive API routes (market create/resolve/cancel/reset,
 * manual settle, oracle simulation).
 *
 * Behaviour:
 * - ADMIN_SECRET (or CRON_SECRET as fallback) set  → caller must prove it via
 *   `adminSecret` in the JSON body or `?secret=` / `?admin_secret=` query param.
 * - Nothing configured → endpoints stay open (local dev convenience) with a
 *   one-time loud warning. Production MUST set ADMIN_SECRET.
 */
import { timingSafeEqual } from "node:crypto";

let warnedMissingSecret = false;

function expectedAdminSecret(): string {
  return (process.env.ADMIN_SECRET || process.env.CRON_SECRET || "").trim();
}

export function adminSecretConfigured(): boolean {
  return Boolean(expectedAdminSecret());
}

export function isAdminAuthorized(input: {
  searchParams?: URLSearchParams;
  body?: Record<string, unknown>;
}): boolean {
  const expected = expectedAdminSecret();
  if (!expected) {
    if (!warnedMissingSecret) {
      warnedMissingSecret = true;
      console.warn(
        "[security] ADMIN_SECRET is not set — admin endpoints (create/resolve/cancel/reset) are OPEN. " +
          "Set ADMIN_SECRET in production."
      );
    }
    return true;
  }

  const provided = extractProvidedSecret(input);
  if (!provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function extractProvidedSecret(input: {
  searchParams?: URLSearchParams;
  body?: Record<string, unknown>;
}): string {
  const fromBody = input.body?.adminSecret ?? input.body?.admin_secret;
  if (typeof fromBody === "string" && fromBody.trim()) return fromBody.trim();
  const fromQuery =
    input.searchParams?.get("adminSecret") ??
    input.searchParams?.get("admin_secret") ??
    input.searchParams?.get("secret");
  return (fromQuery ?? "").trim();
}
