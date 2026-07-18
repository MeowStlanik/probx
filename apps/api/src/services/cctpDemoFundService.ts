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
import { CCTP, quoteForwardingBurn, fetchIrisMessage } from "./cctpService.js";

const FORWARDING_HOOK =
  "0x636374702d666f72776172640000000000000000000000000000000000000000" as const;

/** Per-address daily demo-fund usage, keyed by UTC day (best-effort, in-memory). */
const demoFundDailyUsage = new Map<string, bigint>();

function dailyCapUsdc(): bigint {
  return parseUnits((process.env.CCTP_DEMO_DAILY_PER_ADDRESS || "25").trim() || "25", 6);
}

function enforceDemoFundDailyCap(address: string, amount: bigint): void {
  const cap = dailyCapUsdc();
  const day = new Date().toISOString().slice(0, 10);
  const key = `${day}:${address.toLowerCase()}`;
  const used = demoFundDailyUsage.get(key) ?? 0n;
  if (used + amount > cap) {
    throw new Error(
      `Daily demo fund limit reached for this address (${formatUnits(cap, 6)} USDC/day). Try again tomorrow.`
    );
  }
  demoFundDailyUsage.set(key, used + amount);
  // Keep the map bounded.
  if (demoFundDailyUsage.size > 5_000) {
    for (const staleKey of [...demoFundDailyUsage.keys()].slice(0, 1_000)) {
      demoFundDailyUsage.delete(staleKey);
    }
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

export async function demoFundViaCctp(params: {
  mintTo: string;
  amountUsdc?: string;
}): Promise<{
  mintTo: `0x${string}`;
  amount: string;
  totalBurn: string;
  burnTxHash: `0x${string}`;
  forwardTxHash?: string;
  sourceAddress: `0x${string}`;
  status: string;
}> {
  const key = process.env.CCTP_SOURCE_PRIVATE_KEY;
  if (!key) throw new Error("CCTP_SOURCE_PRIVATE_KEY not set on API.");

  const mintTo = getAddress(params.mintTo);
  const amountHuman = params.amountUsdc ?? "2";
  const amount = parseUnits(amountHuman, 6);
  if (amount <= 0n) throw new Error("amount must be > 0");

  // Treasury protection: the demo fund is a public endpoint, so cap both the
  // per-call size and the per-address daily total (best-effort, in-memory).
  const maxPerCall = parseUnits((process.env.CCTP_DEMO_MAX_PER_CALL || "10").trim() || "10", 6);
  if (amount > maxPerCall) {
    throw new Error(`Demo fund is limited to ${formatUnits(maxPerCall, 6)} USDC per call.`);
  }
  enforceDemoFundDailyCap(mintTo, amount);

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
  await publicClient.waitForTransactionReceipt({ hash: burnTxHash });

  let forwardTxHash: string | undefined;
  const started = Date.now();
  while (Date.now() - started < 6 * 60_000) {
    const status = await fetchIrisMessage(CCTP.domains.baseSepolia, burnTxHash);
    if (status.status === "forwarded" && status.forwardTxHash) {
      forwardTxHash = status.forwardTxHash;
      break;
    }
    await new Promise((r) => setTimeout(r, 5000));
  }

  return {
    mintTo,
    amount: amount.toString(),
    totalBurn: totalBurn.toString(),
    burnTxHash,
    forwardTxHash,
    sourceAddress: account.address,
    status: forwardTxHash ? "forwarded" : "burned_pending_mint"
  };
}
