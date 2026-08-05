/**
 * Audit D: OTP request rate limits must accept IP/fingerprint meta and enforce them.
 * On shared runtime without KV, fail closed (not silent process-local).
 */
import assert from "node:assert/strict";
import { requestEmailOtp } from "./emailOtpService.js";

/**
 * Next.js types NODE_ENV as a readonly literal union, and this file is inside the web
 * tsconfig's include, so assigning to process.env directly makes `pnpm lint` fail even
 * though the test itself runs fine. Mutate through a plain-record alias instead.
 */
const mutableEnv = process.env as Record<string, string | undefined>;


async function main() {
  // Local development: IP bucket is wired and counts independently of email.
  // Use unique emails so per-email (3/10m) does not mask the IP path.
  const ip = `203.0.113.${Date.now() % 200}`;
  const prevNodeEnv = process.env.NODE_ENV;
  mutableEnv.NODE_ENV = "development";
  process.env.EMAIL_OTP_DEV_ECHO = "1";
  // Ensure OTP secret path works locally
  if (!process.env.OTP_HMAC_SECRET) process.env.OTP_HMAC_SECRET = "test-otp-hmac-secret-for-unit";

  let ipBlocked = false;
  // Per-IP max is 20 / 10 min — drive past it with distinct emails.
  for (let i = 0; i < 22; i++) {
    try {
      await requestEmailOtp(`rl-ip-${i}-${Date.now()}@example.com`, { ip });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/network|this network/i.test(msg)) {
        ipBlocked = true;
        break;
      }
      // Other errors (global cap etc.) still prove meta was consumed if we get past email limit.
      if (/right now|global/i.test(msg) && i >= 20) {
        ipBlocked = true;
        break;
      }
      throw e;
    }
  }
  assert.equal(
    ipBlocked,
    true,
    "IP rate limit must fire when meta.ip is passed (was dead code before)"
  );

  // Fingerprint path
  const fp = `fp-test-${Date.now()}`;
  let fpBlocked = false;
  for (let i = 0; i < 8; i++) {
    try {
      await requestEmailOtp(`rl-fp-${i}-${Date.now()}@example.com`, {
        ip: `198.51.100.${i}`,
        fingerprint: fp
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/device|fingerprint/i.test(msg) || /network/i.test(msg) || /right now/i.test(msg)) {
        fpBlocked = true;
        break;
      }
      // per-email is 3 — use unique emails so this is fp or global
      throw e;
    }
  }
  // Fingerprint limit is MAX_PER_EMAIL+2 = 5 — should trip.
  assert.equal(fpBlocked, true, "fingerprint rate limit must be reachable via requestEmailOtp meta");

  // Shared runtime without KV must fail closed on rate-limit path.
  mutableEnv.NODE_ENV = "production";
  // Ensure no KV
  const kvEnvNames = [
    "AIVEN_VALKEY_URL",
    "VALKEY_URL",
    "REDIS_URL",
    "UPSTASH_REDIS_REST_URL",
    "UPSTASH_REDIS_REST_TOKEN"
  ] as const;
  const savedKvEnv = Object.fromEntries(
    kvEnvNames.map((name) => [name, process.env[name]])
  ) as Record<(typeof kvEnvNames)[number], string | undefined>;
  for (const name of kvEnvNames) delete mutableEnv[name];
  // OTP_HMAC_SECRET required on shared — already set
  let failedClosed = false;
  try {
    await requestEmailOtp(`shared-${Date.now()}@example.com`, { ip: "1.2.3.4" });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/KV|rate limit|durable/i.test(msg)) failedClosed = true;
    else throw e;
  }
  assert.equal(failedClosed, true, "shared runtime without KV must refuse OTP rate-limit path");

  // restore
  if (prevNodeEnv === undefined) delete mutableEnv.NODE_ENV;
  else mutableEnv.NODE_ENV = prevNodeEnv;
  for (const name of kvEnvNames) {
    const value = savedKvEnv[name];
    if (value === undefined) delete mutableEnv[name];
    else mutableEnv[name] = value;
  }

  console.log("emailOtpRateLimit tests passed");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
