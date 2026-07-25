/**
 * Browser-side Circle App Kit helpers (Send / Bridge / Unified Balance).
 * DeFi-track: App Kits for payment + liquidity workflows.
 */
"use client";

import { AppKit } from "@circle-fin/app-kit";
import { createViemAdapterFromProvider } from "@circle-fin/adapter-viem-v2";

export type AppKitSourceChain = "Base_Sepolia" | "Ethereum_Sepolia";

const ARC = "Arc_Testnet" as const;

let kitSingleton: AppKit | null = null;

function kit(): AppKit {
  if (!kitSingleton) kitSingleton = new AppKit();
  return kitSingleton;
}

function kitKey(): string | undefined {
  const k = (process.env.NEXT_PUBLIC_CIRCLE_KIT_KEY || "").trim();
  return k || undefined;
}

export function appKitClientStatus() {
  return {
    available: typeof window !== "undefined",
    kitKeyConfigured: Boolean(kitKey()),
    bridgeSources: ["Base_Sepolia", "Ethereum_Sepolia"] as AppKitSourceChain[],
    dest: ARC
  };
}

async function browserAdapter() {
  if (typeof window === "undefined" || !window.ethereum) {
    throw new Error("Browser wallet (MetaMask / injected) is required for App Kit.");
  }
  return createViemAdapterFromProvider({ provider: window.ethereum as never });
}

function pickHash(result: unknown): `0x${string}` | null {
  if (!result || typeof result !== "object") return null;
  const r = result as Record<string, unknown>;
  for (const key of ["txHash", "hash", "transactionHash", "burnTxHash", "sourceTxHash"]) {
    const v = r[key];
    if (typeof v === "string" && v.startsWith("0x")) return v as `0x${string}`;
  }
  for (const nest of ["steps", "transactions", "txs", "result"]) {
    const v = r[nest];
    if (Array.isArray(v)) {
      for (const step of v) {
        const h = pickHash(step);
        if (h) return h;
      }
    } else if (v && typeof v === "object") {
      const h = pickHash(v);
      if (h) return h;
    }
  }
  return null;
}

/** Same-chain USDC send on Arc via App Kit. */
export async function appKitSendUsdc(params: {
  to: string;
  amount: string;
}): Promise<{ hash: `0x${string}`; raw: unknown }> {
  const adapter = await browserAdapter();
  const result = await kit().send({
    from: { adapter, chain: ARC },
    to: params.to,
    amount: params.amount,
    token: "USDC"
  });
  const hash = pickHash(result);
  if (!hash) throw new Error("App Kit send returned no tx hash.");
  return { hash, raw: result };
}

/**
 * Bridge USDC from Base/Eth Sepolia → Arc Testnet via App Kit (CCTP under the hood).
 * Mint lands on the connected browser wallet address on Arc (adapter destination).
 */
export async function appKitBridgeToArc(params: {
  source: AppKitSourceChain;
  amount: string;
  onProgress?: (msg: string) => void;
}): Promise<{ hash: `0x${string}` | null; raw: unknown }> {
  const adapter = await browserAdapter();
  params.onProgress?.(`App Kit bridge ${params.source} → Arc_Testnet…`);

  const k = kit();
  const unsubs: Array<() => void> = [];
  try {
    const on = (event: string, label: string) => {
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const off = (k as any).on?.(event, (payload: unknown) => {
          params.onProgress?.(label);
          void payload;
        });
        if (typeof off === "function") unsubs.push(off);
      } catch {
        /* optional events */
      }
    };
    on("bridge.approve", "Approving USDC…");
    on("bridge.burn", "Burning on source chain…");
    on("bridge.mint", "Minting on Arc…");

    const result = await k.bridge({
      from: { adapter, chain: params.source },
      to: { adapter, chain: ARC },
      amount: params.amount
    });
    return { hash: pickHash(result), raw: result };
  } finally {
    for (const u of unsubs) {
      try {
        u();
      } catch {
        /* ignore */
      }
    }
  }
}

/**
 * Unified Balance: deposit on source chain, spend to an Arc recipient (e.g. user or vault).
 * Requires Gateway support on the chains; falls back to bridge if UB fails.
 */
export async function appKitUnifiedBalanceToArc(params: {
  source: AppKitSourceChain;
  amount: string;
  recipientAddress: string;
  onProgress?: (msg: string) => void;
}): Promise<{ mode: "unified-balance" | "bridge-fallback"; hash: `0x${string}` | null; raw: unknown }> {
  const adapter = await browserAdapter();
  const k = kit();
  params.onProgress?.(`Unified Balance deposit on ${params.source}…`);

  try {
    const deposit = await k.unifiedBalance.deposit({
      from: { adapter, chain: params.source },
      amount: params.amount,
      token: "USDC"
    });
    params.onProgress?.("Spending Unified Balance on Arc…");
    const spend = await k.unifiedBalance.spend({
      amount: params.amount,
      token: "USDC",
      from: {
        adapter,
        allocations: [{ amount: params.amount, chain: params.source }]
      },
      to: {
        adapter,
        chain: ARC,
        recipientAddress: params.recipientAddress
      }
    });
    return {
      mode: "unified-balance",
      hash: pickHash(spend) ?? pickHash(deposit),
      raw: { deposit, spend }
    };
  } catch (ubError) {
    params.onProgress?.(
      `Unified Balance unavailable (${ubError instanceof Error ? ubError.message : "error"}) — falling back to App Kit bridge…`
    );
    const bridged = await appKitBridgeToArc({
      source: params.source,
      amount: params.amount,
      onProgress: params.onProgress
    });
    return { mode: "bridge-fallback", hash: bridged.hash, raw: bridged.raw };
  }
}

export function sourceKeyToAppKitChain(source: "baseSepolia" | "ethereumSepolia"): AppKitSourceChain {
  return source === "ethereumSepolia" ? "Ethereum_Sepolia" : "Base_Sepolia";
}
