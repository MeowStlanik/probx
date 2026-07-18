/**
 * Self-contained HMAC session tokens.
 *
 * Vercel serverless /tmp is per-instance and ephemeral — storing only a
 * server-side hash there made refresh log users out and buyTicket return
 * "expired session". Tokens carry email/address/walletId and verify without
 * shared filesystem state.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

export type SignedSessionPayload = {
  v: 1;
  email: string;
  address: string;
  /** Circle wallet id when provider=circle */
  walletId?: string;
  provider: "circle" | "local";
  /** unix seconds */
  exp: number;
};

const DEFAULT_TTL_SEC = 30 * 24 * 60 * 60; // 30 days

function hmacSecret(): string {
  return (
    process.env.SESSION_HMAC_SECRET ||
    process.env.CIRCLE_ENTITY_SECRET ||
    process.env.ADMIN_SECRET ||
    process.env.CRON_SECRET ||
    "probx-dev-session-hmac"
  );
}

function b64url(buf: Buffer | string): string {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf, "utf8");
  return b.toString("base64url");
}

function signBody(body: string): string {
  return createHmac("sha256", hmacSecret()).update(body).digest("base64url");
}

export function issueSignedSession(input: {
  email: string;
  address: string;
  walletId?: string;
  provider: "circle" | "local";
  ttlSec?: number;
}): string {
  const exp = Math.floor(Date.now() / 1000) + (input.ttlSec ?? DEFAULT_TTL_SEC);
  const payload: SignedSessionPayload = {
    v: 1,
    email: input.email.trim().toLowerCase(),
    address: input.address,
    walletId: input.walletId,
    provider: input.provider,
    exp
  };
  const body = b64url(JSON.stringify(payload));
  const sig = signBody(body);
  return `v1.${body}.${sig}`;
}

export function verifySignedSession(token: string): SignedSessionPayload | null {
  if (!token || typeof token !== "string") return null;
  const parts = token.trim().split(".");
  // v1.<body>.<sig>
  if (parts.length !== 3 || parts[0] !== "v1") return null;
  const [, body, sig] = parts;
  if (!body || !sig) return null;
  const expected = signBody(body);
  try {
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  } catch {
    return null;
  }
  try {
    const json = Buffer.from(body, "base64url").toString("utf8");
    const payload = JSON.parse(json) as SignedSessionPayload;
    if (payload?.v !== 1 || !payload.email || !payload.address) return null;
    if (typeof payload.exp !== "number" || payload.exp < Math.floor(Date.now() / 1000)) {
      return null;
    }
    return {
      ...payload,
      email: payload.email.trim().toLowerCase()
    };
  } catch {
    return null;
  }
}

/** Legacy opaque hex tokens (pre-HMAC) still stored as sha256 hashes. */
export function isLegacyOpaqueToken(token: string): boolean {
  return /^[a-f0-9]{32,128}$/i.test(token.trim()) && !token.includes(".");
}
