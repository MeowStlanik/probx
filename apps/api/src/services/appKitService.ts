/**
 * Circle App Kit helpers (Send / Bridge) for ProbX.
 *
 * Uses @circle-fin/app-kit + @circle-fin/adapter-viem-v2 so DeFi-track
 * "App Kits" criterion is covered without rewriting all wallet UX.
 *
 * Optional `CIRCLE_KIT_KEY` / `NEXT_PUBLIC_CIRCLE_KIT_KEY` enables authenticated
 * kit features (swap / advanced). Send on Arc works without it.
 */
import { AppKit } from "@circle-fin/app-kit";
import { createViemAdapterFromPrivateKey } from "@circle-fin/adapter-viem-v2";

const ARC_CHAIN = "Arc_Testnet" as const;
const ETH_SEPOLIA = "Ethereum_Sepolia" as const;
const BASE_SEPOLIA = "Base_Sepolia" as const;

let kitSingleton: AppKit | null = null;

function getKit(): AppKit {
  if (!kitSingleton) kitSingleton = new AppKit();
  return kitSingleton;
}

function kitKey(): string | undefined {
  const key = (
    process.env.CIRCLE_KIT_KEY ||
    process.env.NEXT_PUBLIC_CIRCLE_KIT_KEY ||
    process.env.KIT_KEY ||
    ""
  ).trim();
  return key || undefined;
}

function normalizePk(privateKey: string): `0x${string}` {
  return (privateKey.startsWith("0x") ? privateKey : `0x${privateKey}`) as `0x${string}`;
}

/**
 * Send USDC on Arc Testnet via App Kit (same-chain).
 * Returns the primary tx hash when available.
 */
export async function sendUsdcViaAppKit(params: {
  privateKey: string;
  to: string;
  amount: string;
}): Promise<{ hash: `0x${string}`; provider: "app-kit" }> {
  const kit = getKit();
  const adapter = createViemAdapterFromPrivateKey({
    privateKey: normalizePk(params.privateKey)
  });

  const result = await kit.send({
    from: { adapter, chain: ARC_CHAIN },
    to: params.to,
    amount: params.amount,
    token: "USDC"
  });

  const hash = extractHash(result);
  if (!hash) {
    throw new Error("App Kit send completed but no transaction hash was returned.");
  }
  return { hash, provider: "app-kit" };
}

/**
 * Bridge USDC → Arc via App Kit (CCTP under the hood).
 * source: Ethereum_Sepolia | Base_Sepolia
 *
 * Pass `recipientAddress` when mint must land on a different Arc wallet than the
 * signing key (e.g. demo treasury burns, user email wallet receives).
 */
export async function bridgeUsdcToArcViaAppKit(params: {
  privateKey: string;
  amount: string;
  source?: "Ethereum_Sepolia" | "Base_Sepolia";
  /** Arc mint destination; defaults to the signer address from privateKey. */
  recipientAddress?: string;
}): Promise<{ result: unknown; provider: "app-kit-bridge" }> {
  const kit = getKit();
  const adapter = createViemAdapterFromPrivateKey({
    privateKey: normalizePk(params.privateKey)
  });
  const source = params.source ?? ETH_SEPOLIA;
  const recipient = (params.recipientAddress || "").trim();

  const result = await kit.bridge({
    from: { adapter, chain: source },
    to: recipient
      ? { adapter, chain: ARC_CHAIN, recipientAddress: recipient }
      : { adapter, chain: ARC_CHAIN },
    amount: params.amount,
    token: "USDC"
  });

  return { result, provider: "app-kit-bridge" };
}

export function appKitStatus() {
  return {
    available: true,
    kitKeyConfigured: Boolean(kitKey()),
    packages: ["@circle-fin/app-kit", "@circle-fin/adapter-viem-v2"],
    sendChain: ARC_CHAIN,
    bridgeSources: [BASE_SEPOLIA, ETH_SEPOLIA]
  };
}

function extractHash(result: unknown): `0x${string}` | null {
  if (!result || typeof result !== "object") return null;
  const r = result as Record<string, unknown>;
  // Common shapes across kit versions
  for (const key of ["txHash", "hash", "transactionHash"]) {
    const v = r[key];
    if (typeof v === "string" && v.startsWith("0x")) return v as `0x${string}`;
  }
  const steps = r.steps ?? r.transactions ?? r.txs;
  if (Array.isArray(steps)) {
    for (const step of steps) {
      if (step && typeof step === "object") {
        const s = step as Record<string, unknown>;
        for (const key of ["txHash", "hash", "transactionHash"]) {
          const v = s[key];
          if (typeof v === "string" && v.startsWith("0x")) return v as `0x${string}`;
        }
      }
    }
  }
  // Nested result
  if (r.result && typeof r.result === "object") {
    return extractHash(r.result);
  }
  return null;
}
