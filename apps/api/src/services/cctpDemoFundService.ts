/**
 * Server-side CCTP demo fund: burn from CCTP_SOURCE_PRIVATE_KEY on Base Sepolia → mint on Arc.
 *
 * Quota is reserved under a per-address + global distributed lock (not TOCTOU get/check/set).
 * Spent only after a successful mined burn; released on failure before burn.
 */
import {
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  formatUnits,
  getAddress,
  http,
  parseUnits,
  recoverMessageAddress
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import { randomBytes } from "node:crypto";
import { CCTP, quoteForwardingBurn } from "./cctpService.js";
import {
  NamespaceStore,
  acquireLock,
  releaseLock,
  requireDurableKv,
  setIfAbsent
} from "./persistentStore.js";
import { waitSuccessfulReceipt } from "./txReceipt.js";

const FORWARDING_HOOK =
  "0x636374702d666f72776172640000000000000000000000000000000000000000" as const;

type DailyUsage = { day: string; used: string };

const dailyStore = new NamespaceStore<DailyUsage>("cctp-demo-fund-daily");
const globalStore = new NamespaceStore<{ day: string; used: string }>("cctp-demo-fund-global");

function dailyCapUsdc(): bigint {
  return parseUnits((process.env.CCTP_DEMO_DAILY_PER_ADDRESS || "25").trim() || "25", 6);
}

function globalDailyCapUsdc(): bigint {
  return parseUnits((process.env.CCTP_DEMO_DAILY_GLOBAL || "500").trim() || "500", 6);
}

function dayKey(): string {
  return new Date().toISOString().slice(0, 10);
}

async function readUsed(
  store: NamespaceStore<DailyUsage | { day: string; used: string }>,
  key: string
): Promise<bigint> {
  const day = dayKey();
  const row = await store.get(key);
  if (!row || row.day !== day) return 0n;
  try {
    return BigInt(row.used || "0");
  } catch {
    return 0n;
  }
}

async function writeUsed(
  store: NamespaceStore<DailyUsage | { day: string; used: string }>,
  key: string,
  used: bigint
): Promise<void> {
  await store.set(key, { day: dayKey(), used: used.toString() });
}

/** Reserve quota under locks. Returns release() that undoes the reservation. */
async function reserveQuota(
  address: string,
  amount: bigint
): Promise<{ release: () => Promise<void>; finalize: () => Promise<void> }> {
  const addrKey = address.toLowerCase();
  const lockAddr = `cctp-quota-addr:${addrKey}`;
  const lockGlob = "cctp-quota-global";
  const tokenA = randomBytes(8).toString("hex");
  const tokenG = randomBytes(8).toString("hex");

  if (!(await acquireLock(lockAddr, 90_000, tokenA))) {
    throw new Error("Demo fund busy for this address — retry in a moment.");
  }
  if (!(await acquireLock(lockGlob, 90_000, tokenG))) {
    await releaseLock(lockAddr, tokenA);
    throw new Error("Demo treasury busy — retry in a moment.");
  }

  try {
    const perUsed = await readUsed(dailyStore, addrKey);
    const perCap = dailyCapUsdc();
    if (perUsed + amount > perCap) {
      throw new Error(
        `Daily demo fund limit reached for this address (${formatUnits(perCap, 6)} USDC/day).`
      );
    }
    const globUsed = await readUsed(globalStore, "treasury");
    const globCap = globalDailyCapUsdc();
    if (globUsed + amount > globCap) {
      throw new Error(
        `Demo treasury daily global cap reached (${formatUnits(globCap, 6)} USDC).`
      );
    }

    // Soft-reserve (counts against limit until release or finalize).
    await writeUsed(dailyStore, addrKey, perUsed + amount);
    await writeUsed(globalStore, "treasury", globUsed + amount);

    let committed = false;
    return {
      release: async () => {
        if (committed) return;
        try {
          const p = await readUsed(dailyStore, addrKey);
          await writeUsed(dailyStore, addrKey, p > amount ? p - amount : 0n);
          const g = await readUsed(globalStore, "treasury");
          await writeUsed(globalStore, "treasury", g > amount ? g - amount : 0n);
        } finally {
          await releaseLock(lockGlob, tokenG);
          await releaseLock(lockAddr, tokenA);
        }
      },
      finalize: async () => {
        committed = true;
        await releaseLock(lockGlob, tokenG);
        await releaseLock(lockAddr, tokenA);
      }
    };
  } catch (e) {
    await releaseLock(lockGlob, tokenG);
    await releaseLock(lockAddr, tokenA);
    throw e;
  }
}

export function cctpSourceConfigured(): boolean {
  return Boolean(process.env.CCTP_SOURCE_PRIVATE_KEY);
}

export function cctpSourceAddress(): `0x${string}` | null {
  const key = process.env.CCTP_SOURCE_PRIVATE_KEY;
  if (!key) return null;
  try {
    const pk = (key.startsWith("0x") ? key : `0x${key}`) as `0x${string}`;
    return privateKeyToAccount(pk).address;
  } catch {
    return null;
  }
}

const DEMO_FUND_CHAIN_ID = 5042002;
const DEMO_FUND_DOMAIN = "probx";

/** Canonical message for injected-wallet EIP-191 (includes expiry so signatures expire). */
export function demoFundAuthMessage(params: {
  mintTo: string;
  amountUsdc: string;
  nonce: string;
  expiresAt: number;
  chainId?: number;
}): string {
  return [
    "ProbX CCTP Demo Funding",
    `wallet: ${getAddress(params.mintTo)}`,
    `amount: ${params.amountUsdc}`,
    `nonce: ${params.nonce}`,
    `chainId: ${params.chainId ?? DEMO_FUND_CHAIN_ID}`,
    `expiresAt: ${params.expiresAt}`,
    `domain: ${DEMO_FUND_DOMAIN}`
  ].join("\n");
}

/** Consume a one-time nonce after signature validation (atomic SET NX, long TTL). */
async function consumeDemoFundNonce(nonce: string): Promise<void> {
  const n = (nonce || "").trim();
  if (!/^[a-fA-F0-9]{16,64}$/.test(n)) throw new Error("Invalid demo-fund nonce.");
  // Keep nonces for 7 days so signatures cannot be replayed after a short TTL window.
  const ok = await setIfAbsent(`cctp-nonce:${n}`, { usedAt: new Date().toISOString() }, 7 * 24 * 3600);
  if (!ok) throw new Error("Demo-fund nonce already used.");
}

export async function verifyInjectedDemoFundAuth(params: {
  mintTo: string;
  amountUsdc: string;
  nonce: string;
  signature: string;
  expiresAt: number | string;
}): Promise<`0x${string}`> {
  requireDurableKv("CCTP demo fund auth");
  const expiresAt = Number(params.expiresAt);
  if (!Number.isFinite(expiresAt) || expiresAt < Math.floor(Date.now() / 1000)) {
    throw new Error("Demo-fund signature expired. Request a new signature.");
  }
  // Cap challenge lifetime (max 15 minutes from now)
  if (expiresAt > Math.floor(Date.now() / 1000) + 15 * 60) {
    throw new Error("Demo-fund expiresAt too far in the future.");
  }

  const message = demoFundAuthMessage({
    mintTo: params.mintTo,
    amountUsdc: params.amountUsdc,
    nonce: params.nonce,
    expiresAt
  });
  const recovered = await recoverMessageAddress({
    message,
    signature: params.signature as `0x${string}`
  });
  if (getAddress(recovered) !== getAddress(params.mintTo)) {
    throw new Error("Signature does not match mintTo address.");
  }
  // Consume nonce only after signature checks pass (avoids griefing by burning nonces).
  await consumeDemoFundNonce(params.nonce);
  return getAddress(recovered);
}

/**
 * Burn only — client polls GET /api/cctp/status.
 * Caller must already have authorized mintTo (session or EIP-191).
 */
export async function demoFundViaCctp(params: {
  mintTo: string;
  amountUsdc?: string;
}): Promise<{
  mintTo: `0x${string}`;
  amount: string;
  totalBurn: string;
  burnTxHash: `0x${string}`;
  sourceAddress: `0x${string}`;
  status: "burned_pending_mint";
  domain: number;
}> {
  requireDurableKv("CCTP demo fund");
  const key = process.env.CCTP_SOURCE_PRIVATE_KEY;
  if (!key) throw new Error("CCTP_SOURCE_PRIVATE_KEY not set on API.");

  const mintTo = getAddress(params.mintTo);
  const amountHuman = params.amountUsdc ?? "2";
  const amount = parseUnits(amountHuman, 6);
  if (amount <= 0n) throw new Error("amount must be > 0");

  const maxPerCall = parseUnits((process.env.CCTP_DEMO_MAX_PER_CALL || "10").trim() || "10", 6);
  if (amount > maxPerCall) {
    throw new Error(`Demo fund is limited to ${formatUnits(maxPerCall, 6)} USDC per call.`);
  }

  const quota = await reserveQuota(mintTo, amount);
  try {
    const pk = (key.startsWith("0x") ? key : `0x${key}`) as `0x${string}`;
    const account = privateKeyToAccount(pk);
    const rpc = process.env.BASE_SEPOLIA_RPC_URL || CCTP.chains.baseSepolia.rpcUrl;

    const walletClient = createWalletClient({
      account,
      chain: baseSepolia,
      transport: http(rpc)
    });
    const publicClient = createPublicClient({
      chain: baseSepolia,
      transport: http(rpc)
    });

    const quote = await quoteForwardingBurn(amount, CCTP.domains.baseSepolia);
    const totalBurn = BigInt(quote.totalBurn);
    const maxFee = BigInt(quote.maxFee);

    const usdc = CCTP.usdc.baseSepolia;
    const messenger = CCTP.tokenMessengerV2;
    const mintRecipient = `0x${mintTo.slice(2).toLowerCase().padStart(64, "0")}` as `0x${string}`;
    const destinationCaller = `0x${"0".repeat(64)}` as `0x${string}`;

    // Exact allowance for this burn (not unlimited)
    const approveData = encodeFunctionData({
      abi: [
        {
          type: "function",
          name: "approve",
          stateMutability: "nonpayable",
          inputs: [
            { name: "spender", type: "address" },
            { name: "amount", type: "uint256" }
          ],
          outputs: [{ name: "", type: "bool" }]
        }
      ],
      functionName: "approve",
      args: [messenger, totalBurn]
    });

    const approveHash = await walletClient.sendTransaction({ to: usdc, data: approveData });
    await waitSuccessfulReceipt(publicClient, approveHash);

    const burnData = encodeFunctionData({
      abi: [
        {
          type: "function",
          name: "depositForBurnWithHook",
          stateMutability: "nonpayable",
          inputs: [
            { name: "amount", type: "uint256" },
            { name: "destinationDomain", type: "uint32" },
            { name: "mintRecipient", type: "bytes32" },
            { name: "burnToken", type: "address" },
            { name: "destinationCaller", type: "bytes32" },
            { name: "maxFee", type: "uint256" },
            { name: "minFinalityThreshold", type: "uint32" },
            { name: "hookData", type: "bytes" }
          ],
          outputs: []
        }
      ],
      functionName: "depositForBurnWithHook",
      args: [
        totalBurn,
        CCTP.domains.arcTestnet,
        mintRecipient,
        usdc,
        destinationCaller,
        maxFee,
        quote.finalityThreshold || 1000,
        FORWARDING_HOOK
      ]
    });

    const burnTxHash = await walletClient.sendTransaction({ to: messenger, data: burnData });
    await waitSuccessfulReceipt(publicClient, burnTxHash);

    await quota.finalize();
    return {
      mintTo,
      amount: amount.toString(),
      totalBurn: totalBurn.toString(),
      burnTxHash,
      sourceAddress: account.address,
      status: "burned_pending_mint",
      domain: CCTP.domains.baseSepolia
    };
  } catch (e) {
    await quota.release();
    throw e;
  }
}
