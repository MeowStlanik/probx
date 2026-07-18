import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { initiateDeveloperControlledWalletsClient } from "@circle-fin/developer-controlled-wallets";
import { encodeFunctionData, getAddress, type Abi } from "viem";
import { runtimeFile } from "../runtimePaths.js";
import { issueSignedSession, isLegacyOpaqueToken, verifySignedSession } from "./signedSession.js";

const mapPath = runtimeFile("circle-wallet-map.json");

type CircleMapRecord = {
  email: string;
  walletId: string;
  address: `0x${string}`;
  blockchain: string;
  sessionTokenHash: string;
  createdAt: string;
  lastSeenAt: string;
};

type CircleMapStore = {
  version: 1;
  walletSetId: string;
  byEmail: Record<string, CircleMapRecord>;
};

type CircleClient = ReturnType<typeof initiateDeveloperControlledWalletsClient>;

let clientSingleton: CircleClient | null = null;

export function isCircleConfigured(): boolean {
  return Boolean(
    process.env.CIRCLE_API_KEY &&
      process.env.CIRCLE_ENTITY_SECRET &&
      process.env.CIRCLE_WALLET_SET_ID
  );
}

export function circleStatus() {
  return {
    configured: isCircleConfigured(),
    hasApiKey: Boolean(process.env.CIRCLE_API_KEY),
    hasEntitySecret: Boolean(process.env.CIRCLE_ENTITY_SECRET),
    hasWalletSetId: Boolean(process.env.CIRCLE_WALLET_SET_ID),
    walletSetId: process.env.CIRCLE_WALLET_SET_ID || null,
    blockchain: "ARC-TESTNET",
    accountType: "EOA",
    paymaster: false
  };
}

function getClient(): CircleClient {
  if (!isCircleConfigured()) {
    throw new Error("Circle is not fully configured (need API key + entity secret + wallet set id).");
  }
  if (!clientSingleton) {
    clientSingleton = initiateDeveloperControlledWalletsClient({
      apiKey: process.env.CIRCLE_API_KEY!,
      entitySecret: process.env.CIRCLE_ENTITY_SECRET!
    });
  }
  return clientSingleton;
}

function loadMap(): CircleMapStore {
  try {
    if (!existsSync(mapPath)) {
      return {
        version: 1,
        walletSetId: process.env.CIRCLE_WALLET_SET_ID || "",
        byEmail: {}
      };
    }
    return JSON.parse(readFileSync(mapPath, "utf8")) as CircleMapStore;
  } catch {
    return {
      version: 1,
      walletSetId: process.env.CIRCLE_WALLET_SET_ID || "",
      byEmail: {}
    };
  }
}

function saveMap(store: CircleMapStore): void {
  mkdirSync(dirname(mapPath), { recursive: true });
  writeFileSync(mapPath, JSON.stringify(store, null, 2));
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export async function createOrResumeCircleSession(emailInput: string) {
  if (!isCircleConfigured()) {
    throw new Error("Circle Wallets not configured.");
  }
  const email = normalizeEmail(emailInput);
  if (!isValidEmail(email)) throw new Error("Enter a valid email address.");

  const store = loadMap();
  const now = new Date().toISOString();
  const existing = store.byEmail[email];

  if (existing) {
    existing.lastSeenAt = now;
    // Keep last hash slot as a soft marker; auth is HMAC token (multi-instance safe).
    existing.sessionTokenHash = existing.sessionTokenHash || hashToken(`circle:${email}`);
    store.byEmail[email] = existing;
    saveMap(store);
    const sessionToken = issueSignedSession({
      email,
      address: existing.address,
      walletId: existing.walletId,
      provider: "circle"
    });
    return publicCircleSession(existing, sessionToken);
  }

  const client = getClient();
  const walletSetId = process.env.CIRCLE_WALLET_SET_ID!;
  // Unique refId for Circle metadata; email also stored locally.
  const refId = `probx:${createHash("sha256").update(email).digest("hex").slice(0, 24)}`;

  const walletResponse = await client.createWallets({
    walletSetId,
    blockchains: ["ARC-TESTNET"],
    count: 1,
    accountType: "EOA",
    metadata: [{ name: email.slice(0, 48), refId }]
  });

  const wallet = walletResponse.data?.wallets?.[0];
  if (!wallet?.id || !wallet.address) {
    throw new Error("Circle createWallets returned no wallet.");
  }

  const record: CircleMapRecord = {
    email,
    walletId: wallet.id,
    address: getAddress(wallet.address),
    blockchain: wallet.blockchain || "ARC-TESTNET",
    sessionTokenHash: hashToken(`circle:${email}`),
    createdAt: now,
    lastSeenAt: now
  };
  store.walletSetId = walletSetId;
  store.byEmail[email] = record;
  saveMap(store);
  const sessionToken = issueSignedSession({
    email,
    address: record.address,
    walletId: record.walletId,
    provider: "circle"
  });
  return publicCircleSession(record, sessionToken);
}

function publicCircleSession(record: CircleMapRecord, sessionToken?: string) {
  return {
    mode: "embedded" as const,
    provider: "circle-developer-controlled",
    note: "Circle Developer-Controlled EOA on ARC-TESTNET.",
    email: record.email,
    address: record.address,
    walletId: record.walletId,
    blockchain: record.blockchain,
    sessionToken: sessionToken ?? undefined,
    createdAt: record.createdAt
  };
}

function requireCircleSession(emailInput: string, sessionToken: string): CircleMapRecord {
  const email = normalizeEmail(emailInput);
  const token = (sessionToken || "").trim();

  // 1) HMAC tokens work on any instance without /tmp session map.
  const signed = verifySignedSession(token);
  if (signed) {
    if (signed.provider !== "circle") {
      throw new Error("Invalid session provider for Circle wallet.");
    }
    if (signed.email !== email) {
      throw new Error("Session email mismatch. Sign in with email again.");
    }
    if (!signed.walletId) {
      throw new Error("Session missing Circle wallet id. Sign in with email again.");
    }
    const address = getAddress(signed.address);
    const store = loadMap();
    const existing = store.byEmail[email];
    const record: CircleMapRecord = existing
      ? {
          ...existing,
          address,
          walletId: signed.walletId,
          lastSeenAt: new Date().toISOString()
        }
      : {
          email,
          walletId: signed.walletId,
          address,
          blockchain: "ARC-TESTNET",
          sessionTokenHash: hashToken(`circle:${email}`),
          createdAt: new Date().toISOString(),
          lastSeenAt: new Date().toISOString()
        };
    store.byEmail[email] = record;
    try {
      saveMap(store);
    } catch {
      // /tmp full — still allow the request using token payload
    }
    return record;
  }

  // 2) Legacy opaque tokens (pre-HMAC) — need the instance map.
  if (isLegacyOpaqueToken(token)) {
    const store = loadMap();
    const record = store.byEmail[email];
    if (!record) throw new Error("Circle session not found. Sign in with email again.");
    if (record.sessionTokenHash !== hashToken(token)) {
      throw new Error("Invalid or expired session token. Sign in again (session upgraded).");
    }
    record.lastSeenAt = new Date().toISOString();
    store.byEmail[email] = record;
    saveMap(store);
    return record;
  }

  throw new Error("Invalid or expired session token. Sign in with email again.");
}

export function getCircleSessionPublic(emailInput: string, sessionToken: string) {
  return publicCircleSession(requireCircleSession(emailInput, sessionToken));
}

export type CircleWriteBody = {
  email: string;
  sessionToken: string;
  address: string;
  abi: Abi;
  functionName: string;
  args?: unknown[];
  value?: string;
};

function reviveAbiArgs(args: unknown[] | undefined): unknown[] {
  return (args ?? []).map((value) => {
    // Client serializes bigint as decimal strings; revive for viem encode.
    if (typeof value === "string" && /^-?\d+$/.test(value)) {
      try {
        return BigInt(value);
      } catch {
        return value;
      }
    }
    if (Array.isArray(value)) return reviveAbiArgs(value);
    return value;
  });
}

export async function writeContractViaCircle(body: CircleWriteBody): Promise<{
  hash: `0x${string}`;
  from: `0x${string}`;
  circleTxId?: string;
}> {
  const record = requireCircleSession(body.email, body.sessionToken);
  const target = getAddress(body.address);
  const client = getClient();
  const args = reviveAbiArgs(body.args as unknown[] | undefined);

  let callData: `0x${string}`;
  try {
    callData = encodeFunctionData({
      abi: body.abi,
      functionName: body.functionName,
      args: args as never
    });
  } catch (error) {
    throw new Error(
      `Failed to encode ${body.functionName}: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  let created: Awaited<ReturnType<CircleClient["createContractExecutionTransaction"]>>;
  try {
    created = await client.createContractExecutionTransaction({
      walletId: record.walletId,
      contractAddress: target,
      callData,
      fee: {
        type: "level",
        config: { feeLevel: "MEDIUM" }
      }
    });
  } catch (error) {
    const detail =
      error && typeof error === "object" && "response" in error
        ? JSON.stringify((error as { response?: { data?: unknown } }).response?.data ?? {})
        : error instanceof Error
          ? error.message
          : String(error);
    throw new Error(
      `Circle signing failed: ${detail || "unknown"}. Wallet needs Arc USDC for gas (native).`
    );
  }

  const circleTxId = (created.data as { id?: string } | undefined)?.id;
  if (!circleTxId) {
    throw new Error("Circle contract execution did not return a transaction id.");
  }

  try {
    const waited = await client.getTransaction({
      id: circleTxId,
      waitForTxHash: true
    });

    const tx = waited.data?.transaction as
      | { txHash?: string; state?: string; errorReason?: string }
      | undefined;
    const hash = tx?.txHash as `0x${string}` | undefined;
    if (!hash) {
      throw new Error(
        `Circle tx ${circleTxId} has no hash (state=${tx?.state ?? "unknown"}${
          tx?.errorReason ? `, ${tx.errorReason}` : ""
        }).`
      );
    }
    return { hash, from: record.address, circleTxId };
  } catch (error) {
    if (error instanceof Error && error.message.includes("Circle tx")) throw error;
    throw new Error(
      `Circle tx ${circleTxId} wait failed: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

export function listCircleSessions(): number {
  return Object.keys(loadMap().byEmail).length;
}
