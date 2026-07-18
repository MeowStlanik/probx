import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { decryptSecret, encryptSecret, isEncrypted } from "./keyEncryption.js";
import {
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  getAddress,
  http,
  type Abi
} from "viem";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import {
  createOrResumeCircleSession,
  getCircleSessionPublic,
  isCircleConfigured,
  listCircleSessions,
  writeContractViaCircle,
  circleStatus
} from "./circleWalletService.js";
import { getMonorepoRoot, runtimeFile } from "../runtimePaths.js";
import { issueSignedSession, isLegacyOpaqueToken, verifySignedSession } from "./signedSession.js";

const rootDir = getMonorepoRoot();
const storePath = runtimeFile("session-wallets.json");

type SessionRecord = {
  email: string;
  address: `0x${string}`;
  privateKey: `0x${string}`;
  sessionTokenHash: string;
  createdAt: string;
  lastSeenAt: string;
};

type SessionStore = {
  version: 1;
  sessions: Record<string, SessionRecord>;
};

const arcChainId = Number(process.env.NEXT_PUBLIC_CHAIN_ID ?? process.env.CHAIN_ID ?? "5042002");
const arcRpcUrl =
  process.env.ARC_RPC_URL ||
  process.env.NEXT_PUBLIC_ARC_RPC_URL ||
  "https://rpc.testnet.arc.network";

const arcChain = {
  id: arcChainId,
  name: "Arc Testnet",
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
  rpcUrls: { default: { http: [arcRpcUrl] } }
} as const;

/** Contracts the embedded session wallet may call on Arc. */
function allowedTargets(): Set<string> {
  const raw = [
    process.env.NEXT_PUBLIC_USDC_ADDRESS,
    process.env.NEXT_PUBLIC_MICRO_BOOST_ENGINE_ADDRESS,
    process.env.NEXT_PUBLIC_LIQUIDITY_POOL_ADDRESS,
    process.env.NEXT_PUBLIC_MARKET_FACTORY_ADDRESS,
    "0x3600000000000000000000000000000000000000",
    "0xA30dbf33d9ffbB6b3de349dEFDac434A73b9202b",
    "0x65F3E2F861FC3E00d1b234A7661BdFfA3e85f4b2",
    "0x4BF56aFB15BEAED7ffD74486631a1F87338241B3",
    "0x664443918C5755ee89d334E4ADE703d8Cd2ce900",
    "0xB254Ba5A7914D7ddCa1d1434886Ee38847D5F41d",
    "0x3B89C6bec72B7AA3d17197311113c903725073Ca",
    "0x7d9bc15ED51bb1eF353220Bc7d74d74EA499af32",
    "0x5c65D662F875623A1aCD5f4A276dBcE6384d00A7",
    // CCTP MessageTransmitterV2 on Arc (mint path if ever used)
    "0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275"
  ].filter(Boolean) as string[];

  const set = new Set<string>();
  const add = (value?: string) => {
    if (!value) return;
    try {
      set.add(getAddress(value));
    } catch {
      // skip
    }
  };

  for (const value of raw) add(value);

  // deployment.json (web + docs)
  for (const rel of [
    "apps/web/src/lib/deployment.json",
    "docs/DEPLOYMENT_ARC_TESTNET.json"
  ]) {
    try {
      const path = join(rootDir, rel);
      if (!existsSync(path)) continue;
      const dep = JSON.parse(readFileSync(path, "utf8")) as Record<string, string>;
      for (const key of [
        "usdc",
        "liquidityPool",
        "insuranceFund",
        "feeRouter",
        "positionTicket",
        "microBoostEngine",
        "oracleAdapter",
        "marketFactory",
        "demoMarket"
      ]) {
        add(dep[key]);
      }
    } catch {
      // ignore
    }
  }

  // Allow markets seen in ticket openings / UI state
  for (const rel of [".runtime/ticket-openings.json", ".runtime/market-ui-state.json"]) {
    try {
      const path = join(rootDir, rel);
      if (!existsSync(path)) continue;
      const text = readFileSync(path, "utf8");
      const matches = text.match(/0x[a-fA-F0-9]{40}/g) ?? [];
      for (const m of matches) add(m);
    } catch {
      // ignore
    }
  }

  return set;
}

function loadStore(): SessionStore {
  try {
    if (!existsSync(storePath)) return { version: 1, sessions: {} };
    const raw = JSON.parse(readFileSync(storePath, "utf8")) as SessionStore;
    if (!raw?.sessions) return { version: 1, sessions: {} };
    // Private keys are encrypted at rest (enc1:...). Legacy plaintext records
    // still decrypt fine and are migrated to encrypted form on the next save.
    // Per-record try/catch: a wrong/rotated encryption key must NOT wipe the
    // whole store (the record simply fails later with a clear error).
    for (const record of Object.values(raw.sessions)) {
      if (typeof record?.privateKey === "string") {
        try {
          record.privateKey = decryptSecret(record.privateKey) as `0x${string}`;
        } catch {
          // keep the raw value; integrity check will reject it on use
        }
      }
    }
    return raw;
  } catch {
    return { version: 1, sessions: {} };
  }
}

function saveStore(store: SessionStore): void {
  mkdirSync(dirname(storePath), { recursive: true });
  const toWrite: SessionStore = {
    ...store,
    sessions: Object.fromEntries(
      Object.entries(store.sessions).map(([email, record]) => [
        email,
        {
          ...record,
          privateKey: isEncrypted(record.privateKey)
            ? record.privateKey
            : (encryptSecret(record.privateKey) as `0x${string}`)
        }
      ])
    )
  };
  writeFileSync(storePath, JSON.stringify(toWrite, null, 2));
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

function publicSession(record: SessionRecord, sessionToken?: string) {
  return {
    mode: "embedded" as const,
    provider: "local-dev-controlled-eoa",
    note: "Local embedded EOA (set CIRCLE_* for Circle Developer-Controlled Wallets).",
    email: record.email,
    address: record.address,
    sessionToken: sessionToken ?? undefined,
    createdAt: record.createdAt
  };
}

export async function createOrResumeSession(emailInput: string, opts?: { otpVerified?: boolean }) {
  const otpRequired = process.env.EMAIL_OTP_REQUIRED !== "0";
  if (otpRequired && !opts?.otpVerified) {
    throw new Error("Email verification required. Request a code first, then verify.");
  }

  if (isCircleConfigured()) {
    return createOrResumeCircleSession(emailInput);
  }

  const email = normalizeEmail(emailInput);
  if (!isValidEmail(email)) {
    throw new Error("Enter a valid email address.");
  }

  const store = loadStore();
  const existing = store.sessions[email];
  const now = new Date().toISOString();

  if (existing) {
    existing.lastSeenAt = now;
    existing.sessionTokenHash = existing.sessionTokenHash || hashToken(`local:${email}`);
    store.sessions[email] = existing;
    saveStore(store);
    const sessionToken = issueSignedSession({
      email,
      address: existing.address,
      provider: "local"
    });
    return publicSession(existing, sessionToken);
  }

  const privateKey = generatePrivateKey();
  const account = privateKeyToAccount(privateKey);
  const record: SessionRecord = {
    email,
    address: account.address,
    privateKey,
    sessionTokenHash: hashToken(`local:${email}`),
    createdAt: now,
    lastSeenAt: now
  };
  store.sessions[email] = record;
  saveStore(store);
  const sessionToken = issueSignedSession({
    email,
    address: record.address,
    provider: "local"
  });
  return publicSession(record, sessionToken);
}

function requireSession(emailInput: string, sessionToken: string): SessionRecord {
  const email = normalizeEmail(emailInput);
  const token = (sessionToken || "").trim();
  const store = loadStore();

  const signed = verifySignedSession(token);
  if (signed) {
    if (signed.provider !== "local") {
      throw new Error("Invalid session provider for local wallet.");
    }
    if (signed.email !== email) {
      throw new Error("Session email mismatch. Sign in with email again.");
    }
    const record = store.sessions[email];
    if (!record) {
      throw new Error(
        "Local wallet keys not available on this server instance. Sign in with email again."
      );
    }
    if (getAddress(record.address) !== getAddress(signed.address)) {
      throw new Error("Session wallet address mismatch. Sign in with email again.");
    }
    record.lastSeenAt = new Date().toISOString();
    store.sessions[email] = record;
    try {
      saveStore(store);
    } catch {
      /* ignore */
    }
    return record;
  }

  if (isLegacyOpaqueToken(token)) {
    const record = store.sessions[email];
    if (!record) throw new Error("Session not found. Sign in with email again.");
    if (record.sessionTokenHash !== hashToken(token)) {
      throw new Error("Invalid or expired session token. Sign in again (session upgraded).");
    }
    record.lastSeenAt = new Date().toISOString();
    store.sessions[email] = record;
    saveStore(store);
    return record;
  }

  throw new Error("Invalid or expired session token. Sign in with email again.");
}

export function getSessionPublic(emailInput: string, sessionToken: string) {
  if (isCircleConfigured()) {
    try {
      return getCircleSessionPublic(emailInput, sessionToken);
    } catch {
      // fall through to local only if not a Circle session
    }
  }
  const record = requireSession(emailInput, sessionToken);
  return publicSession(record);
}

export type WriteContractBody = {
  email: string;
  sessionToken: string;
  address: string;
  abi: Abi;
  functionName: string;
  args?: unknown[];
  value?: string;
};

export async function writeContractForSession(body: WriteContractBody): Promise<{
  hash: `0x${string}`;
  from: `0x${string}`;
  circleTxId?: string;
}> {
  const target = getAddress(body.address);
  const allow = allowedTargets();
  if (!allow.has(target)) {
    throw new Error(`Contract ${target} is not allowlisted for embedded wallet writes.`);
  }

  if (isCircleConfigured()) {
    try {
      return await writeContractViaCircle(body);
    } catch (error) {
      // If this email is local-only (created before Circle), fall back.
      const message = error instanceof Error ? error.message : String(error);
      if (!message.includes("Circle session not found")) throw error;
    }
  }

  const record = requireSession(body.email, body.sessionToken);
  const account = privateKeyToAccount(record.privateKey);
  if (getAddress(account.address) !== getAddress(record.address)) {
    throw new Error("Session wallet integrity check failed.");
  }

  const walletClient = createWalletClient({
    account,
    chain: arcChain,
    transport: http(arcRpcUrl)
  });
  const publicClient = createPublicClient({
    chain: arcChain,
    transport: http(arcRpcUrl)
  });

  const revivedArgs = (body.args ?? []).map((value) => {
    if (typeof value === "string" && /^-?\d+$/.test(value)) {
      try {
        return BigInt(value);
      } catch {
        return value;
      }
    }
    return value;
  });

  const data = encodeFunctionData({
    abi: body.abi,
    functionName: body.functionName,
    args: revivedArgs as never
  });

  const hash = await walletClient.sendTransaction({
    to: target,
    data,
    value: body.value ? BigInt(body.value) : 0n
  });

  try {
    await publicClient.waitForTransactionReceipt({ hash, timeout: 60_000 });
  } catch {
    // client will poll separately
  }

  return { hash, from: account.address };
}

export function listSessionCount(): number {
  const local = Object.keys(loadStore().sessions).length;
  const circle = isCircleConfigured() ? listCircleSessions() : 0;
  return local + circle;
}

export function walletModeInfo() {
  const circle = circleStatus();
  return {
    embeddedEnabled: true,
    circleApiConfigured: circle.configured,
    circle,
    provider: circle.configured ? "circle-developer-controlled" : "local-dev-controlled-eoa",
    auth: {
      model: "email-otp-then-dev-controlled-wallet",
      emailOtpRequired: process.env.EMAIL_OTP_REQUIRED !== "0",
      circleOwnsKeys: circle.configured
    },
    paymaster: false,
    gas: "User pays Arc USDC gas (native). No paymaster.",
    sessions: listSessionCount()
  };
}
