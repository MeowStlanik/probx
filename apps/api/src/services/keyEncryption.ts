/**
 * AES-256-GCM at-rest encryption for server-side secrets (session wallet keys).
 *
 * Threat model: the runtime JSON store (`.runtime/*.json` locally, `/tmp` on
 * Vercel) may leak without env vars leaking. Private keys must not sit there
 * in plaintext. Values are encrypted with a key derived (scrypt) from
 * SESSION_WALLET_SECRET / OTP_HMAC_SECRET / CIRCLE_* env, falling back to a
 * random key persisted in a separate 0600 file next to the data.
 *
 * Format: `enc1:<iv b64>:<authTag b64>:<ciphertext b64>`.
 * Legacy plaintext values pass through decryptSecret() unchanged so existing
 * stores keep working and are migrated on the next save.
 */
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { runtimeFile } from "../runtimePaths.js";

const PREFIX = "enc1";
const SCRYPT_SALT = "probx-session-wallet-v1";

let cachedKey: Buffer | null = null;
let warnedFallback = false;

function encryptionSecret(): string {
  const fromEnv = (
    process.env.SESSION_WALLET_SECRET ||
    process.env.OTP_HMAC_SECRET ||
    process.env.CIRCLE_ENTITY_SECRET ||
    process.env.CIRCLE_API_KEY ||
    ""
  ).trim();
  if (fromEnv) return fromEnv;

  // No env secret: persist a random key in a SEPARATE file from the data, so a
  // leak of session-wallets.json alone no longer exposes private keys.
  const keyPath = runtimeFile("session-wallet-key");
  try {
    if (existsSync(keyPath)) {
      const existing = readFileSync(keyPath, "utf8").trim();
      if (existing) return existing;
    }
    const generated = randomBytes(32).toString("hex");
    writeFileSync(keyPath, generated, { mode: 0o600 });
    try {
      chmodSync(keyPath, 0o600);
    } catch {
      // best effort on Windows
    }
    if (!warnedFallback) {
      warnedFallback = true;
      console.warn(
        "[security] SESSION_WALLET_SECRET not set — session keys encrypted with a random key " +
          "persisted in the runtime dir. Set SESSION_WALLET_SECRET in env for stable multi-instance deploys."
      );
    }
    return generated;
  } catch {
    // Read-only fs: ephemeral key for this process (sessions not decryptable after cold start).
    return randomBytes(32).toString("hex");
  }
}

function derivedKey(): Buffer {
  if (!cachedKey) {
    cachedKey = scryptSync(encryptionSecret(), SCRYPT_SALT, 32);
  }
  return cachedKey;
}

export function isEncrypted(payload: string): boolean {
  return payload.startsWith(`${PREFIX}:`);
}

export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", derivedKey(), iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [PREFIX, iv.toString("base64"), tag.toString("base64"), encrypted.toString("base64")].join(":");
}

export function decryptSecret(payload: string): string {
  if (!isEncrypted(payload)) return payload; // legacy plaintext — migrated on next save
  const parts = payload.split(":");
  if (parts.length !== 4) throw new Error("Corrupt encrypted secret payload.");
  const [, ivB64, tagB64, dataB64] = parts;
  const decipher = createDecipheriv("aes-256-gcm", derivedKey(), Buffer.from(ivB64, "base64"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(dataB64, "base64")), decipher.final()]).toString("utf8");
}
