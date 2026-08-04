/**
 * Shared admin gate for sensitive API routes (market create/resolve/cancel/reset,
 * manual settle, oracle simulation).
 *
 * Behaviour:
 * - ADMIN_SECRET (or CRON_SECRET as fallback) set  → caller must prove it via
 *   `adminSecret` in the JSON body or `?secret=` / `?admin_secret=` query param.
 * - Nothing configured:
 *   - local/dev → endpoints stay open with a one-time loud warning
 *   - NODE_ENV=production → endpoints stay CLOSED (fail closed)
 */
import { timingSafeEqual } from "node:crypto";

let warnedMissingSecret = false;

function expectedAdminSecret(): string {
  return (process.env.ADMIN_SECRET || process.env.CRON_SECRET || "").trim();
}

/** Shared / production-like hosts must not leave admin open without a secret. */
function isSharedRuntime(): boolean {
  return process.env.NODE_ENV === "production";
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
    if (isSharedRuntime()) {
      if (!warnedMissingSecret) {
        warnedMissingSecret = true;
        console.error(
          "[security] ADMIN_SECRET is not set on a shared/production runtime — admin endpoints are CLOSED. " +
            "Set ADMIN_SECRET (or CRON_SECRET) in the environment."
        );
      }
      return false;
    }
    if (!warnedMissingSecret) {
      warnedMissingSecret = true;
      console.warn(
        "[security] ADMIN_SECRET is not set — admin endpoints (create/resolve/cancel/reset) are OPEN (local dev only). " +
          "Set ADMIN_SECRET before any shared deploy."
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
