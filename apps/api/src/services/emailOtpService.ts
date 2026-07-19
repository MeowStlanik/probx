import { createHash, createHmac, randomInt, timingSafeEqual } from "node:crypto";
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
 * Best-effort in-memory rate limit for OTP requests (per email + global).
 * Prevents using our SMTP/provider as a mail-bomb relay. In-memory is fine:
 * serverless instances each enforce their own window, which still caps abuse.
 */
const OTP_REQUEST_WINDOW_MS = 10 * 60_000;
const OTP_REQUEST_MAX_PER_EMAIL = 3;
const OTP_REQUEST_MAX_GLOBAL = 30;
const otpRequestLog: { perEmail: Map<string, number[]>; global: number[] } = {
  perEmail: new Map(),
  global: []
};

function pruneOld(timestamps: number[], now: number): number[] {
  return timestamps.filter((at) => now - at < OTP_REQUEST_WINDOW_MS);
}

function enforceOtpRequestRateLimit(email: string): void {
  const now = Date.now();
  const emailLog = pruneOld(otpRequestLog.perEmail.get(email) ?? [], now);
  otpRequestLog.global = pruneOld(otpRequestLog.global, now);

  if (emailLog.length >= OTP_REQUEST_MAX_PER_EMAIL) {
    throw new Error("Too many codes requested for this email. Wait a few minutes and try again.");
  }
  if (otpRequestLog.global.length >= OTP_REQUEST_MAX_GLOBAL) {
    throw new Error("Too many login codes requested right now. Try again in a few minutes.");
  }
  emailLog.push(now);
  otpRequestLog.perEmail.set(email, emailLog);
  otpRequestLog.global.push(now);
}

/**
 * Best-effort in-memory limit on VERIFY attempts per email. The stateless
 * otpToken path (primary on Vercel) has no server-side record, so without this
 * an attacker holding the token could brute-force the 6-digit code with
 * unlimited tries inside the 10-minute TTL. MAX_ATTEMPTS previously only
 * protected the local file-store fallback. In-memory is per-instance
 * (best-effort on serverless) but raises the cost enormously vs. unlimited.
 */
const otpVerifyLog: Map<string, number[]> = new Map();

function enforceOtpVerifyAttemptLimit(email: string): void {
  const now = Date.now();
  const attempts = pruneOld(otpVerifyLog.get(email) ?? [], now);
  if (attempts.length >= MAX_ATTEMPTS) {
    throw new Error("Too many incorrect codes. Request a new code and try again.");
  }
  attempts.push(now);
  otpVerifyLog.set(email, attempts);
}

function clearOtpVerifyAttempts(email: string): void {
  otpVerifyLog.delete(email);
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

/**
 * Shared secret for signed OTP tokens (must be identical on every Vercel instance).
 * Prefer a dedicated OTP_HMAC_SECRET in Vercel env; other keys are fallbacks only.
 */
function otpHmacSecret(): string {
  const secret = (
    process.env.OTP_HMAC_SECRET ||
    process.env.CIRCLE_ENTITY_SECRET ||
    process.env.CIRCLE_API_KEY ||
    process.env.BREVO_API_KEY ||
    process.env.SMTP_PASS ||
    "probx-dev-otp-hmac-change-me"
  ).trim();
  const resolved = secret || "probx-dev-otp-hmac-change-me";
  if (resolved === "probx-dev-otp-hmac-change-me" && !warnedDefaultSecret) {
    warnedDefaultSecret = true;
    console.warn(
      "[security] OTP_HMAC_SECRET is not set — OTP tokens signed with the public fallback secret. " +
        "Set OTP_HMAC_SECRET in any shared environment."
    );
  }
  return resolved;
}

let warnedDefaultSecret = false;

/** Stateless OTP challenge — survives multi-instance /tmp on Vercel. */
function makeOtpToken(email: string, codeHash: string, expiresAt: number): string {
  const payload = Buffer.from(JSON.stringify({ e: email, h: codeHash, x: expiresAt }), "utf8").toString(
    "base64url"
  );
  const sig = createHmac("sha256", otpHmacSecret()).update(payload).digest("base64url");
  return `${payload}.${sig}`;
}

function parseOtpToken(token: string): { email: string; codeHash: string; expiresAt: number } | null {
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
    };
    if (!data.e || !data.h || !Number.isFinite(data.x)) return null;
    return { email: data.e, codeHash: data.h, expiresAt: Number(data.x) };
  } catch {
    return null;
  }
}

function hasSmtpConfig(): boolean {
  if ((process.env.SMTP_URL || "").trim()) return true;
  return Boolean(
    (process.env.SMTP_HOST || process.env.BREVO_SMTP_HOST || "").trim() &&
      (process.env.SMTP_USER || process.env.BREVO_SMTP_USER || "").trim() &&
      (process.env.SMTP_PASS || process.env.BREVO_SMTP_PASS || process.env.SMTP_PASSWORD || "").trim()
  );
}

function hasEmailProvider(): boolean {
  return Boolean(
    process.env.RESEND_API_KEY ||
      process.env.BREVO_API_KEY ||
      process.env.SENDINBLUE_API_KEY ||
      hasSmtpConfig()
  );
}

/**
 * Dev echo: show code in API response.
 * - EMAIL_OTP_DEV_ECHO=1 force on
 * - EMAIL_OTP_DEV_ECHO=0 force off
 * - default: on when no email provider is configured
 */
export function otpDevEchoEnabled(): boolean {
  if (process.env.EMAIL_OTP_DEV_ECHO === "0") return false;
  if (process.env.EMAIL_OTP_DEV_ECHO === "1") return true;
  return !hasEmailProvider();
}

async function sendOtpEmail(email: string, code: string): Promise<{ sent: boolean; via?: string; error?: string }> {
  const subject = "ProbX Arc login code";
  const text = `Your ProbX verification code is ${code}. It expires in 10 minutes.\n\nIf you did not request this, ignore this email.`;
  const html = `<p>Your ProbX verification code is <strong style="font-size:1.25rem;letter-spacing:0.12em">${code}</strong>.</p><p>It expires in 10 minutes.</p>`;

  // 1) Personal SMTP first (Gmail App Password lands better than free Brevo shared IPs)
  if (hasSmtpConfig()) {
    const smtpResult = await sendViaSmtp(email, subject, text, html);
    if (smtpResult.sent) return smtpResult;
    // Do NOT silently fall through to Brevo — that fakes "emailSent" while Gmail never received mail.
    // Only fall through if SMTP was not intended as primary (no SMTP_HOST set to gmail/brevo explicitly).
    const host = (process.env.SMTP_HOST || process.env.BREVO_SMTP_HOST || "").toLowerCase();
    if (host.includes("gmail") || host.includes("google") || process.env.SMTP_STRICT === "1") {
      return smtpResult;
    }
    if (!process.env.BREVO_API_KEY && !process.env.RESEND_API_KEY && !process.env.SENDINBLUE_API_KEY) {
      return smtpResult;
    }
  }

  // 2) Brevo REST API (xkeysib-…) — accepted by Brevo, but Gmail often delays/spam free senders
  const brevoKey = (process.env.BREVO_API_KEY || process.env.SENDINBLUE_API_KEY || "").trim();
  if (brevoKey) {
    const fromEmail = (process.env.BREVO_FROM_EMAIL || process.env.EMAIL_FROM || "").trim();
    const fromName = (process.env.BREVO_FROM_NAME || "ProbX Arc").trim();
    if (!fromEmail || !fromEmail.includes("@")) {
      return {
        sent: false,
        via: "brevo",
        error: "Set BREVO_FROM_EMAIL to a sender you verified in Brevo (e.g. your Gmail)."
      };
    }
    try {
      const response = await fetch("https://api.brevo.com/v3/smtp/email", {
        method: "POST",
        headers: {
          "api-key": brevoKey,
          "Content-Type": "application/json",
          Accept: "application/json"
        },
        body: JSON.stringify({
          sender: { name: fromName, email: fromEmail },
          to: [{ email }],
          subject,
          textContent: text,
          htmlContent: html
        })
      });
      if (!response.ok) {
        const body = await response.text().catch(() => "");
        return { sent: false, via: "brevo", error: `Brevo HTTP ${response.status}: ${body.slice(0, 220)}` };
      }
      return { sent: true, via: "brevo" };
    } catch (error) {
      return {
        sent: false,
        via: "brevo",
        error: error instanceof Error ? error.message : "Brevo request failed"
      };
    }
  }

  // 3) Resend — test mode only delivers to the Resend account owner unless domain is verified
  const resendKey = (process.env.RESEND_API_KEY || "").trim();
  if (resendKey) {
    const from =
      (process.env.RESEND_FROM || process.env.EMAIL_FROM || "ProbX Arc <onboarding@resend.dev>").trim();
    try {
      const response = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${resendKey}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ from, to: [email], subject, text, html })
      });
      if (!response.ok) {
        const body = await response.text().catch(() => "");
        return { sent: false, via: "resend", error: `Resend HTTP ${response.status}: ${body.slice(0, 200)}` };
      }
      return { sent: true, via: "resend" };
    } catch (error) {
      return {
        sent: false,
        via: "resend",
        error: error instanceof Error ? error.message : "Resend request failed"
      };
    }
  }

  return {
    sent: false,
    error:
      "no email provider (set SMTP_HOST/USER/PASS for Brevo SMTP, or BREVO_API_KEY, or RESEND_API_KEY)"
  };
}

async function sendViaSmtp(
  to: string,
  subject: string,
  text: string,
  html: string
): Promise<{ sent: boolean; via?: string; error?: string }> {
  try {
    const nodemailer = await import("nodemailer");
    const host = (process.env.SMTP_HOST || process.env.BREVO_SMTP_HOST || "smtp-relay.brevo.com").trim();
    const port = Number(process.env.SMTP_PORT || process.env.BREVO_SMTP_PORT || "587");
    const user = (process.env.SMTP_USER || process.env.BREVO_SMTP_USER || "").trim();
    const pass = (
      process.env.SMTP_PASS ||
      process.env.SMTP_PASSWORD ||
      process.env.BREVO_SMTP_PASS ||
      ""
    ).trim();
    const smtpUrl = (process.env.SMTP_URL || "").trim();

    const fromEmail = (
      process.env.BREVO_FROM_EMAIL ||
      process.env.EMAIL_FROM ||
      process.env.SMTP_FROM ||
      user
    ).trim();
    const fromName = (process.env.BREVO_FROM_NAME || process.env.SMTP_FROM_NAME || "ProbX Arc").trim();
    if (!fromEmail.includes("@")) {
      return {
        sent: false,
        via: "smtp",
        error: "Set BREVO_FROM_EMAIL / EMAIL_FROM to your verified sender (e.g. stlanik95@gmail.com)."
      };
    }

    const transport = smtpUrl
      ? nodemailer.createTransport(smtpUrl)
      : nodemailer.createTransport({
          host,
          port: Number.isFinite(port) ? port : 587,
          secure: port === 465,
          auth: user && pass ? { user, pass } : undefined
        });

    await transport.sendMail({
      from: `${fromName} <${fromEmail}>`,
      to,
      subject,
      text,
      html
    });
    return { sent: true, via: "smtp" };
  } catch (error) {
    return {
      sent: false,
      via: "smtp",
      error: error instanceof Error ? error.message : "SMTP send failed"
    };
  }
}

export async function requestEmailOtp(emailInput: string): Promise<{
  email: string;
  expiresInSec: number;
  message: string;
  /** Signed challenge — must be sent back with verify (required on Vercel multi-instance). */
  otpToken: string;
  emailSent?: boolean;
}> {
  const email = normalizeEmail(emailInput);
  if (!isValidEmail(email)) throw new Error("Enter a valid email address.");
  enforceOtpRequestRateLimit(email);

  const code = String(randomInt(100_000, 999_999));
  const codeHash = hashCode(email, code);
  const expiresAt = Date.now() + OTP_TTL_MS;
  const otpToken = makeOtpToken(email, codeHash, expiresAt);

  // Best-effort local store (single process / local dev). Vercel verify uses otpToken.
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
    // ignore file store failures on serverless
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
    message = "Email is not configured on the server. Ask the host to set SMTP/API keys.";
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

export function consumeEmailOtp(emailInput: string, codeInput: string, otpToken?: string): string {
  const email = normalizeEmail(emailInput);
  const code = String(codeInput ?? "").trim();
  if (!isValidEmail(email)) throw new Error("Enter a valid email address.");
  if (!/^\d{6}$/.test(code)) throw new Error("Enter the 6-digit verification code.");

  // Signed token from request-otp (JSON body and/or HttpOnly cookie). Required on Vercel.
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
    enforceOtpVerifyAttemptLimit(email);
    if (parsed.codeHash !== hashCode(email, code)) throw new Error("Invalid code. Try again.");
    clearOtpVerifyAttempts(email);
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

  // Fallback: local file store (single-instance / local API only — not reliable on Vercel).
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
