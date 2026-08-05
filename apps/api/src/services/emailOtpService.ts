import { createHmac, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { runtimeFile } from "../runtimePaths.js";

const otpPath = runtimeFile("email-otps.json");

type OtpRecord = {
  email: string;
  codeHash: string;
  expiresAt: number;
  attempts: number;
  createdAt: string;
};

type OtpStore = {
  version: 1;
  byEmail: Record<string, OtpRecord>;
};

const OTP_TTL_MS = 10 * 60_000;
const MAX_ATTEMPTS = 5;

/**
 * Distributed OTP rate limits (Redis INCR + TTL when KV is configured).
 * Falls back to process-local counters only in local-dev without KV.
 */
const OTP_REQUEST_WINDOW_SEC = 10 * 60;
const OTP_REQUEST_MAX_PER_EMAIL = 3;
const OTP_REQUEST_MAX_PER_IP = 20;
const OTP_REQUEST_MAX_GLOBAL = 30;
const OTP_VERIFY_WINDOW_SEC = 10 * 60;

const localOtpCounters = new Map<string, { count: number; resetAt: number }>();

async function incrWithTtl(
  key: string,
  windowSec: number
): Promise<number> {
  const { kvEval, persistenceMode, isSharedRuntime } = await import("./persistentStore.js");
  if (persistenceMode() === "kv") {
    try {
      const n = await kvEval<number>(
        `
        local c = redis.call('INCR', KEYS[1])
        if c == 1 then
          redis.call('EXPIRE', KEYS[1], ARGV[1])
        end
        return c
        `,
        [key],
        [String(windowSec)]
      );
      return typeof n === "number" ? n : Number(n) || 0;
    } catch {
      // Production: never silently fall back to process-local counters.
      if (isSharedRuntime()) {
        throw new Error("Login rate limit store unavailable. Try again in a moment.");
      }
      /* local dev: fall through */
    }
  } else if (isSharedRuntime()) {
    // Shared host without KV: fail closed rather than per-instance memory counters.
    throw new Error(
      "Login rate limits require durable KV (AIVEN_VALKEY_URL or legacy Upstash REST) on shared deploys."
    );
  }
  const now = Date.now();
  const cur = localOtpCounters.get(key);
  if (!cur || cur.resetAt <= now) {
    localOtpCounters.set(key, { count: 1, resetAt: now + windowSec * 1000 });
    return 1;
  }
  cur.count += 1;
  return cur.count;
}

async function clearCounter(key: string): Promise<void> {
  try {
    const { kvEval, persistenceMode } = await import("./persistentStore.js");
    if (persistenceMode() === "kv") {
      await kvEval(`return redis.call('DEL', KEYS[1])`, [key], []);
      return;
    }
  } catch {
    /* ignore */
  }
  localOtpCounters.delete(key);
}

async function enforceOtpRequestRateLimit(
  email: string,
  meta?: { ip?: string; fingerprint?: string }
): Promise<void> {
  const e = email.trim().toLowerCase();
  const emailCount = await incrWithTtl(`otp-rl:req:email:${e}`, OTP_REQUEST_WINDOW_SEC);
  if (emailCount > OTP_REQUEST_MAX_PER_EMAIL) {
    throw new Error("Too many codes requested for this email. Wait a few minutes and try again.");
  }
  if (meta?.ip) {
    const ipCount = await incrWithTtl(
      `otp-rl:req:ip:${meta.ip.slice(0, 64)}`,
      OTP_REQUEST_WINDOW_SEC
    );
    if (ipCount > OTP_REQUEST_MAX_PER_IP) {
      throw new Error("Too many login codes from this network. Try again in a few minutes.");
    }
  }
  if (meta?.fingerprint) {
    const fpCount = await incrWithTtl(
      `otp-rl:req:fp:${meta.fingerprint.slice(0, 80)}`,
      OTP_REQUEST_WINDOW_SEC
    );
    if (fpCount > OTP_REQUEST_MAX_PER_EMAIL + 2) {
      throw new Error("Too many login codes from this device. Try again in a few minutes.");
    }
  }
  const globalCount = await incrWithTtl("otp-rl:req:global", OTP_REQUEST_WINDOW_SEC);
  if (globalCount > OTP_REQUEST_MAX_GLOBAL) {
    throw new Error("Too many login codes requested right now. Try again in a few minutes.");
  }
}

async function enforceOtpVerifyAttemptLimit(email: string): Promise<void> {
  const e = email.trim().toLowerCase();
  const attempts = await incrWithTtl(`otp-rl:verify:${e}`, OTP_VERIFY_WINDOW_SEC);
  if (attempts > MAX_ATTEMPTS) {
    throw new Error("Too many incorrect codes. Request a new code and try again.");
  }
}

async function clearOtpVerifyAttempts(email: string): Promise<void> {
  await clearCounter(`otp-rl:verify:${email.trim().toLowerCase()}`);
}

function loadStore(): OtpStore {
  try {
    if (!existsSync(otpPath)) return { version: 1, byEmail: {} };
    return JSON.parse(readFileSync(otpPath, "utf8")) as OtpStore;
  } catch {
    return { version: 1, byEmail: {} };
  }
}

function saveStore(store: OtpStore): void {
  mkdirSync(dirname(otpPath), { recursive: true });
  writeFileSync(otpPath, JSON.stringify(store, null, 2));
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

/**
 * Keyed hash of the OTP code. Previously this was a raw sha256(email:code),
 * which let anyone offline-brute-force the 6-digit code from the otpToken
 * payload (returned to the client) and bypass email verification entirely.
 * HMAC with a server-side secret makes the codeHash useless without the secret.
 */
function hashCode(email: string, code: string): string {
  return createHmac("sha256", otpHmacSecret()).update(`${email}:${code}`).digest("hex");
}

const DEV_OTP_FALLBACK = "probx-dev-otp-hmac-change-me";

function isSharedRuntime(): boolean {
  return process.env.NODE_ENV === "production";
}

/**
 * Shared secret for signed OTP tokens (must be identical on every production instance).
 * Prefer a dedicated OTP_HMAC_SECRET; other env keys are emergency fallbacks only.
 * The hard-coded dev string is rejected on shared/production runtimes.
 */
function otpHmacSecret(): string {
  const secret = (
    process.env.OTP_HMAC_SECRET ||
    process.env.CIRCLE_ENTITY_SECRET ||
    process.env.CIRCLE_API_KEY ||
    ""
  ).trim();

  if (secret) return secret;

  if (isSharedRuntime()) {
    throw new Error(
      "OTP_HMAC_SECRET is required on shared/production runtimes (no public fallback secret)."
    );
  }

  if (!warnedDefaultSecret) {
    warnedDefaultSecret = true;
    console.warn(
      "[security] OTP_HMAC_SECRET is not set — OTP tokens signed with the local-dev fallback secret. " +
        "Set OTP_HMAC_SECRET before any shared deploy."
    );
  }
  return DEV_OTP_FALLBACK;
}

let warnedDefaultSecret = false;

/** Stateless OTP challenge suitable for multi-instance deployments. Includes jti for single-use. */
function makeOtpToken(email: string, codeHash: string, expiresAt: number): string {
  const jti = randomBytes(16).toString("hex");
  const payload = Buffer.from(
    JSON.stringify({ e: email, h: codeHash, x: expiresAt, j: jti }),
    "utf8"
  ).toString("base64url");
  const sig = createHmac("sha256", otpHmacSecret()).update(payload).digest("base64url");
  return `${payload}.${sig}`;
}

function parseOtpToken(
  token: string
): { email: string; codeHash: string; expiresAt: number; jti?: string } | null {
  const parts = String(token || "").split(".");
  if (parts.length !== 2) return null;
  const [payload, sig] = parts;
  const expected = createHmac("sha256", otpHmacSecret()).update(payload).digest("base64url");
  try {
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
    const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as {
      e?: string;
      h?: string;
      x?: number;
      j?: string;
    };
    if (!data.e || !data.h || !Number.isFinite(data.x)) return null;
    return {
      email: data.e,
      codeHash: data.h,
      expiresAt: Number(data.x),
      jti: typeof data.j === "string" ? data.j : undefined
    };
  } catch {
    return null;
  }
}

/** Atomically mark OTP jti used (SET NX). Returns false if already consumed. */
async function consumeOtpJti(jti: string): Promise<boolean> {
  const { setIfAbsent, requireDurableKv } = await import("./persistentStore.js");
  requireDurableKv("OTP single-use");
  return setIfAbsent(`otp-jti:${jti}`, { usedAt: new Date().toISOString() }, 24 * 3600);
}

function gmailApiConfig(): {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  senderEmail: string;
  senderName: string;
} | null {
  const clientId = (process.env.GMAIL_OAUTH_CLIENT_ID || "").trim();
  const clientSecret = (process.env.GMAIL_OAUTH_CLIENT_SECRET || "").trim();
  const refreshToken = (process.env.GMAIL_OAUTH_REFRESH_TOKEN || "").trim();
  const senderEmail = (process.env.GMAIL_SENDER_EMAIL || "").trim().toLowerCase();
  const senderName = (process.env.GMAIL_SENDER_NAME || "ProbX Arc").trim();
  if (!clientId || !clientSecret || !refreshToken || !isValidEmail(senderEmail)) return null;
  return { clientId, clientSecret, refreshToken, senderEmail, senderName };
}

function hasEmailProvider(): boolean {
  return gmailApiConfig() !== null;
}

/**
 * Dev echo: show code in API response.
 * - EMAIL_OTP_DEV_ECHO=1 force on
 * - EMAIL_OTP_DEV_ECHO=0 force off
 * - default: on when Gmail API is not configured
 */
export function otpDevEchoEnabled(): boolean {
  if (process.env.EMAIL_OTP_DEV_ECHO === "0") return false;
  if (process.env.EMAIL_OTP_DEV_ECHO === "1") return true;
  return !hasEmailProvider();
}

type GmailAccessToken = { value: string; expiresAt: number };
let cachedGmailAccessToken: GmailAccessToken | null = null;

async function getGmailAccessToken(forceRefresh = false): Promise<string> {
  const config = gmailApiConfig();
  if (!config) throw new Error("Gmail API credentials are incomplete.");

  const now = Date.now();
  if (!forceRefresh && cachedGmailAccessToken && cachedGmailAccessToken.expiresAt > now + 60_000) {
    return cachedGmailAccessToken.value;
  }

  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      refresh_token: config.refreshToken,
      grant_type: "refresh_token"
    })
  });
  const body = (await response.json().catch(() => ({}))) as {
    access_token?: string;
    expires_in?: number;
    error?: string;
    error_description?: string;
  };
  if (!response.ok || !body.access_token) {
    const detail = body.error_description || body.error || `HTTP ${response.status}`;
    throw new Error(`Google OAuth token refresh failed: ${String(detail).slice(0, 220)}`);
  }

  cachedGmailAccessToken = {
    value: body.access_token,
    expiresAt: now + Math.max(60, Number(body.expires_in) || 3600) * 1000
  };
  return body.access_token;
}

function cleanHeader(value: string): string {
  return value.replace(/[\r\n]+/g, " ").trim();
}

function encodeMimeHeader(value: string): string {
  const clean = cleanHeader(value);
  return /^[\x20-\x7e]*$/.test(clean)
    ? clean
    : `=?UTF-8?B?${Buffer.from(clean, "utf8").toString("base64")}?=`;
}

function base64MimeBody(value: string): string {
  const encoded = Buffer.from(value, "utf8").toString("base64");
  return encoded.match(/.{1,76}/g)?.join("\r\n") || "";
}

function createGmailRawMessage(input: {
  fromEmail: string;
  fromName: string;
  to: string;
  subject: string;
  text: string;
  html: string;
}): string {
  const boundary = `probx_${randomBytes(12).toString("hex")}`;
  const mime = [
    `From: ${encodeMimeHeader(input.fromName)} <${cleanHeader(input.fromEmail)}>`,
    `To: ${cleanHeader(input.to)}`,
    `Subject: ${encodeMimeHeader(input.subject)}`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
    "",
    base64MimeBody(input.text),
    `--${boundary}`,
    'Content-Type: text/html; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
    "",
    base64MimeBody(input.html),
    `--${boundary}--`,
    ""
  ].join("\r\n");
  return Buffer.from(mime, "utf8").toString("base64url");
}

async function postGmailMessage(accessToken: string, raw: string): Promise<Response> {
  return fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ raw })
  });
}

async function sendViaGmailApi(
  to: string,
  subject: string,
  text: string,
  html: string
): Promise<{ sent: boolean; via: string; error?: string }> {
  const config = gmailApiConfig();
  if (!config) {
    return {
      sent: false,
      via: "gmail-api",
      error:
        "Set GMAIL_OAUTH_CLIENT_ID, GMAIL_OAUTH_CLIENT_SECRET, GMAIL_OAUTH_REFRESH_TOKEN and GMAIL_SENDER_EMAIL."
    };
  }

  try {
    const raw = createGmailRawMessage({
      fromEmail: config.senderEmail,
      fromName: config.senderName,
      to,
      subject,
      text,
      html
    });
    let accessToken = await getGmailAccessToken();
    let response = await postGmailMessage(accessToken, raw);
    if (response.status === 401) {
      cachedGmailAccessToken = null;
      accessToken = await getGmailAccessToken(true);
      response = await postGmailMessage(accessToken, raw);
    }
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      return {
        sent: false,
        via: "gmail-api",
        error: `Gmail API HTTP ${response.status}: ${body.slice(0, 240)}`
      };
    }
    return { sent: true, via: "gmail-api" };
  } catch (error) {
    return {
      sent: false,
      via: "gmail-api",
      error: error instanceof Error ? error.message : "Gmail API request failed"
    };
  }
}

async function sendOtpEmail(
  email: string,
  code: string
): Promise<{ sent: boolean; via?: string; error?: string }> {
  const subject = "ProbX Arc login code";
  const text = `Your ProbX verification code is ${code}. It expires in 10 minutes.\n\nIf you did not request this, ignore this email.`;
  const html = `<p>Your ProbX verification code is <strong style="font-size:1.25rem;letter-spacing:0.12em">${code}</strong>.</p><p>It expires in 10 minutes.</p>`;

  if (!hasEmailProvider()) {
    return {
      sent: false,
      via: "gmail-api",
      error: "Gmail API is not configured."
    };
  }
  return sendViaGmailApi(email, subject, text, html);
}

export async function requestEmailOtp(
  emailInput: string,
  meta?: { ip?: string; fingerprint?: string }
): Promise<{
  email: string;
  expiresInSec: number;
  message: string;
  /** Signed challenge — must be sent back with verify (required on multi-instance deployments). */
  otpToken: string;
  emailSent?: boolean;
}> {
  const email = normalizeEmail(emailInput);
  if (!isValidEmail(email)) throw new Error("Enter a valid email address.");
  await enforceOtpRequestRateLimit(email, meta);

  const code = String(randomInt(100_000, 999_999));
  const codeHash = hashCode(email, code);
  const expiresAt = Date.now() + OTP_TTL_MS;
  const otpToken = makeOtpToken(email, codeHash, expiresAt);

  // Best-effort local store (single process / local dev). Production verification uses otpToken.
  try {
    const store = loadStore();
    store.byEmail[email] = {
      email,
      codeHash,
      expiresAt,
      attempts: 0,
      createdAt: new Date().toISOString()
    };
    saveStore(store);
  } catch {
    // ignore best-effort local file store failures
  }

  console.log(`[email-otp] ${email} code issued (ttl ${OTP_TTL_MS / 1000}s, token issued)`);

  const delivery = await sendOtpEmail(email, code);
  if (delivery.sent) {
    console.log(`[email-otp] sent via ${delivery.via} → ${email}`);
  } else if (delivery.error) {
    console.warn(`[email-otp] delivery failed: ${delivery.error}`);
  }

  // Never return the OTP to the client UI — code only goes by email (and server logs).
  let message: string;
  if (delivery.sent) {
    message = `We sent a code to ${email}. Check inbox and Spam/Promotions.`;
  } else if (/only send testing emails|verify a domain/i.test(delivery.error ?? "")) {
    message =
      "Email provider blocked this recipient. Verify your domain or use an allowed test address.";
  } else if (hasEmailProvider()) {
    message = `Could not send email (${shortProviderError(delivery.error)}). Try again in a moment.`;
  } else {
    message = "Email is not configured on the server. Set the Gmail API OAuth variables.";
  }

  return {
    email,
    expiresInSec: Math.floor(OTP_TTL_MS / 1000),
    message,
    otpToken,
    emailSent: delivery.sent
  };
}

function shortProviderError(error?: string): string {
  if (!error) return "send failed";
  // Keep UI readable — drop giant JSON tails
  const m = error.match(/message":"([^"]+)"/);
  if (m?.[1]) return m[1].slice(0, 140);
  return error.slice(0, 140);
}

export async function consumeEmailOtp(
  emailInput: string,
  codeInput: string,
  otpToken?: string
): Promise<string> {
  const email = normalizeEmail(emailInput);
  const code = String(codeInput ?? "").trim();
  if (!isValidEmail(email)) throw new Error("Enter a valid email address.");
  if (!/^\d{6}$/.test(code)) throw new Error("Enter the 6-digit verification code.");

  // Signed token from request-otp (JSON body and/or HttpOnly cookie). Required in production.
  const token = String(otpToken ?? "").trim();
  if (token) {
    const parsed = parseOtpToken(token);
    if (!parsed) {
      throw new Error(
        "Login session is invalid or expired. Press Code again in this same browser tab, then enter the new email code."
      );
    }
    if (parsed.email !== email) {
      throw new Error("Email does not match the code request. Use the same email you requested the code for.");
    }
    if (Date.now() > parsed.expiresAt) throw new Error("Code expired. Request a new one.");
    // Count the attempt BEFORE comparing so wrong guesses burn tries (stateless
    // token path had no attempt cap at all — see enforceOtpVerifyAttemptLimit).
    await enforceOtpVerifyAttemptLimit(email);
    if (parsed.codeHash !== hashCode(email, code)) throw new Error("Invalid code. Try again.");
    // Single-use: mark jti consumed (durable when KV is configured).
    if (parsed.jti) {
      const firstUse = await consumeOtpJti(parsed.jti);
      if (!firstUse) {
        throw new Error("This login code was already used. Request a new code.");
      }
    }
    await clearOtpVerifyAttempts(email);
    // Clear optional local store entry
    try {
      const store = loadStore();
      delete store.byEmail[email];
      saveStore(store);
    } catch {
      // ignore
    }
    return email;
  }

  // Fallback: local file store (single-instance / local API only).
  const store = loadStore();
  const record = store.byEmail[email];
  if (!record) {
    throw new Error(
      "Login session missing. Request a new code in this browser (do not switch devices/tabs), wait for the email, then enter the 6-digit code."
    );
  }
  if (Date.now() > record.expiresAt) {
    delete store.byEmail[email];
    saveStore(store);
    throw new Error("Code expired. Request a new one.");
  }
  if (record.attempts >= MAX_ATTEMPTS) {
    delete store.byEmail[email];
    saveStore(store);
    throw new Error("Too many attempts. Request a new code.");
  }

  record.attempts += 1;
  if (record.codeHash !== hashCode(email, code)) {
    store.byEmail[email] = record;
    saveStore(store);
    throw new Error("Invalid code. Try again.");
  }

  delete store.byEmail[email];
  saveStore(store);
  return email;
}
