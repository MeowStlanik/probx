import { createHash } from "node:crypto";
import { initiateDeveloperControlledWalletsClient } from "@circle-fin/developer-controlled-wallets";
import { encodeFunctionData, getAddress, type Abi } from "viem";
import { NamespaceStore } from "./persistentStore.js";
import { issueSignedSession, isLegacyOpaqueToken, verifySignedSession } from "./signedSession.js";

const BLOCKCHAIN = "ARC-TESTNET" as const;
// USDC (native precompile) on Arc testnet — used for Circle token transfers.
const ARC_USDC_ADDRESS = "0x3600000000000000000000000000000000000000";

type CircleMapRecord = {
  email: string;
  walletId: string;
  address: `0x${string}`;
  blockchain: string;
  refId: string;
  sessionTokenHash: string;
  createdAt: string;
  lastSeenAt: string;
};

type CircleClient = ReturnType<typeof initiateDeveloperControlledWalletsClient>;

// Durable email -> wallet mapping (Vercel KV in prod, file fallback locally).
// This replaces the previous per-instance /tmp JSON, so the same email keeps
// the same Circle wallet across cold starts, redeploys and logouts.
const walletMap = new NamespaceStore<CircleMapRecord>("circle-wallet-map");

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
    blockchain: BLOCKCHAIN,
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

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Deterministic Circle refId for an email — lets us recover the wallet later. */
function refIdForEmail(email: string): string {
  return `probx:${createHash("sha256").update(email).digest("hex").slice(0, 24)}`;
}

/**
 * Recover the wallet for an email from Circle itself when the local mapping is
 * missing (e.g. fresh instance, KV flushed). We look it up by the deterministic
 * refId in our wallet set, so we never create a duplicate wallet for the same
 * email.
 */
async function recoverFromCircle(email: string): Promise<CircleMapRecord | null> {
  const refId = refIdForEmail(email);
  const walletSetId = process.env.CIRCLE_WALLET_SET_ID!;
  try {
    const client = getClient();
    const response = await client.listWallets({ walletSetId, refId });
    const wallet = response.data?.wallets?.find((w) => w.refId === refId) ?? response.data?.wallets?.[0];
    if (!wallet?.id || !wallet.address) return null;
    const now = new Date().toISOString();
    const record: CircleMapRecord = {
      email,
      walletId: wallet.id,
      address: getAddress(wallet.address),
      blockchain: wallet.blockchain || BLOCKCHAIN,
      refId,
      sessionTokenHash: hashToken(`circle:${email}`),
      createdAt: (wallet as { createDate?: string }).createDate || now,
      lastSeenAt: now
    };
    await walletMap.set(email, record);
    return record;
  } catch {
    return null;
  }
}

export async function createOrResumeCircleSession(emailInput: string) {
  if (!isCircleConfigured()) {
    throw new Error("Circle Wallets not configured.");
  }
  const email = normalizeEmail(emailInput);
  if (!isValidEmail(email)) throw new Error("Enter a valid email address.");

  const now = new Date().toISOString();
  let existing = await walletMap.get(email);

  // Local mapping missing? Try to recover the existing wallet from Circle first,
  // so logout / session expiry never mints a second wallet for the same email.
  if (!existing) {
    existing = await recoverFromCircle(email);
  }

  if (existing) {
    existing.lastSeenAt = now;
    existing.sessionTokenHash = existing.sessionTokenHash || hashToken(`circle:${email}`);
    existing.refId = existing.refId || refIdForEmail(email);
    await walletMap.set(email, existing);
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
  const refId = refIdForEmail(email);

  const walletResponse = await client.createWallets({
    walletSetId,
    blockchains: [BLOCKCHAIN],
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
    blockchain: wallet.blockchain || BLOCKCHAIN,
    refId,
    sessionTokenHash: hashToken(`circle:${email}`),
    createdAt: now,
    lastSeenAt: now
  };
  await walletMap.set(email, record);
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

async function requireCircleSession(emailInput: string, sessionToken: string): Promise<CircleMapRecord> {
  const email = normalizeEmail(emailInput);
  const token = (sessionToken || "").trim();

  // 1) HMAC tokens work on any instance without a shared session map.
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
    const existing = await walletMap.get(email);
    const record: CircleMapRecord = existing
      ? { ...existing, address, walletId: signed.walletId, lastSeenAt: new Date().toISOString() }
      : {
          email,
          walletId: signed.walletId,
          address,
          blockchain: BLOCKCHAIN,
          refId: refIdForEmail(email),
          sessionTokenHash: hashToken(`circle:${email}`),
          createdAt: new Date().toISOString(),
          lastSeenAt: new Date().toISOString()
        };
    await walletMap.set(email, record).catch(() => undefined);
    return record;
  }

  // 2) Legacy opaque tokens (pre-HMAC) — need the durable map.
  if (isLegacyOpaqueToken(token)) {
    let record = await walletMap.get(email);
    if (!record) record = await recoverFromCircle(email);
    if (!record) throw new Error("Circle session not found. Sign in with email again.");
    if (record.sessionTokenHash !== hashToken(token)) {
      throw new Error("Invalid or expired session token. Sign in again (session upgraded).");
    }
    record.lastSeenAt = new Date().toISOString();
    await walletMap.set(email, record);
    return record;
  }

  throw new Error("Invalid or expired session token. Sign in with email again.");
}

export async function getCircleSessionPublic(emailInput: string, sessionToken: string) {
  return publicCircleSession(await requireCircleSession(emailInput, sessionToken));
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

/** Poll a Circle transaction id until it has a txHash or reaches a terminal state. */
async function waitForCircleHash(client: CircleClient, circleTxId: string): Promise<{
  hash?: `0x${string}`;
  state?: string;
  errorReason?: string;
}> {
  const waited = await client.getTransaction({ id: circleTxId, waitForTxHash: true });
  const tx = waited.data?.transaction as
    | { txHash?: string; state?: string; errorReason?: string }
    | undefined;
  return {
    hash: tx?.txHash as `0x${string}` | undefined,
    state: tx?.state,
    errorReason: tx?.errorReason
  };
}

export async function writeContractViaCircle(body: CircleWriteBody): Promise<{
  hash: `0x${string}`;
  from: `0x${string}`;
  circleTxId?: string;
}> {
  const record = await requireCircleSession(body.email, body.sessionToken);
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
      fee: { type: "level", config: { feeLevel: "MEDIUM" } }
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
    const { hash, state, errorReason } = await waitForCircleHash(client, circleTxId);
    if (!hash) {
      throw new Error(
        `Circle tx ${circleTxId} has no hash (state=${state ?? "unknown"}${errorReason ? `, ${errorReason}` : ""}).`
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

/**
 * Transfer USDC from the session's Circle wallet to another Arc address.
 * amount is a decimal USDC string (e.g. "1.5").
 */
export async function transferUsdcViaCircle(body: {
  email: string;
  sessionToken: string;
  destinationAddress: string;
  amount: string;
}): Promise<{ hash: `0x${string}`; from: `0x${string}`; circleTxId?: string }> {
  const record = await requireCircleSession(body.email, body.sessionToken);
  const client = getClient();

  let destination: `0x${string}`;
  try {
    destination = getAddress(body.destinationAddress);
  } catch {
    throw new Error("Enter a valid destination address (0x…).");
  }
  if (getAddress(record.address) === destination) {
    throw new Error("Destination is your own wallet.");
  }
  const amount = (body.amount || "").trim();
  if (!/^\d+(\.\d+)?$/.test(amount) || Number(amount) <= 0) {
    throw new Error("Enter a valid amount greater than 0.");
  }

  let created: Awaited<ReturnType<CircleClient["createTransaction"]>>;
  try {
    created = await client.createTransaction({
      walletId: record.walletId,
      tokenAddress: ARC_USDC_ADDRESS,
      destinationAddress: destination,
      amount: [amount],
      fee: { type: "level", config: { feeLevel: "MEDIUM" } }
    });
  } catch (error) {
    const detail =
      error && typeof error === "object" && "response" in error
        ? JSON.stringify((error as { response?: { data?: unknown } }).response?.data ?? {})
        : error instanceof Error
          ? error.message
          : String(error);
    throw new Error(`Circle transfer failed: ${detail || "unknown"}. Wallet needs Arc USDC for gas.`);
  }

  const circleTxId = (created.data as { id?: string } | undefined)?.id;
  if (!circleTxId) {
    throw new Error("Circle transfer did not return a transaction id.");
  }

  const { hash, state, errorReason } = await waitForCircleHash(client, circleTxId);
  if (!hash) {
    throw new Error(
      `Circle transfer ${circleTxId} has no hash (state=${state ?? "unknown"}${errorReason ? `, ${errorReason}` : ""}).`
    );
  }
  return { hash, from: record.address, circleTxId };
}

export async function listCircleSessions(): Promise<number> {
  return walletMap.count();
}
