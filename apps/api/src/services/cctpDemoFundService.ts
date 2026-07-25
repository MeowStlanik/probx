/** Server-side CCTP fund: burn from CCTP_SOURCE_PRIVATE_KEY on Base Sepolia → mint on Arc. */
import {
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  formatUnits,
  getAddress,
  http,
  parseUnits
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import { CCTP, quoteForwardingBurn } from "./cctpService.js";
import { NamespaceStore } from "./persistentStore.js";

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

async function enforceDemoFundCaps(address: string, amount: bigint): Promise<void> {
  const day = new Date().toISOString().slice(0, 10);
  const addrKey = address.toLowerCase();

  const per = (await dailyStore.get(addrKey)) ?? { day, used: "0" };
  const perUsed = per.day === day ? BigInt(per.used || "0") : 0n;
  const perCap = dailyCapUsdc();
  if (perUsed + amount > perCap) {
    throw new Error(
      `Daily demo fund limit reached for this address (${formatUnits(perCap, 6)} USDC/day). Try again tomorrow.`
    );
  }

  const glob = (await globalStore.get("treasury")) ?? { day, used: "0" };
  const globUsed = glob.day === day ? BigInt(glob.used || "0") : 0n;
  const globCap = globalDailyCapUsdc();
  if (globUsed + amount > globCap) {
    throw new Error(
      `Demo treasury daily global cap reached (${formatUnits(globCap, 6)} USDC). Try again later.`
    );
  }

  await dailyStore.set(addrKey, { day, used: (perUsed + amount).toString() });
  await globalStore.set("treasury", { day, used: (globUsed + amount).toString() });
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

/**
 * Burn only — do not wait for mint (Vercel maxDuration ~60s).
 * Client polls GET /api/cctp/status with burnTxHash.
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
  await enforceDemoFundCaps(mintTo, amount);

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

  const maxApproval = 2n ** 256n - 1n;
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
    args: [messenger, maxApproval]
  });

  const approveHash = await walletClient.sendTransaction({
    to: usdc,
    data: approveData
  });
  const approveReceipt = await publicClient.waitForTransactionReceipt({ hash: approveHash });
  if (approveReceipt.status !== "success") {
    throw new Error("USDC approve on Base Sepolia failed.");
  }

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

  const burnTxHash = await walletClient.sendTransaction({
    to: messenger,
    data: burnData
  });
  const burnReceipt = await publicClient.waitForTransactionReceipt({ hash: burnTxHash });
  if (burnReceipt.status !== "success") {
    throw new Error(`CCTP burn reverted: ${burnTxHash}`);
  }

  // Return immediately — client polls /api/cctp/status (avoids Vercel 60s kill mid-wait).
  return {
    mintTo,
    amount: amount.toString(),
    totalBurn: totalBurn.toString(),
    burnTxHash,
    sourceAddress: account.address,
    status: "burned_pending_mint",
    domain: CCTP.domains.baseSepolia
  };
}
