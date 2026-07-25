/**
 * Browser-side Circle App Kit helpers (Send / Bridge / Unified Balance).
 * DeFi-track: App Kits for payment + liquidity workflows.
 */
"use client";

import { AppKit } from "@circle-fin/app-kit";
import { createViemAdapterFromProvider } from "@circle-fin/adapter-viem-v2";

export type AppKitSourceChain = "Base_Sepolia" | "Ethereum_Sepolia";

const ARC = "Arc_Testnet" as const;
const PENDING_UB_SPEND_KEY = "probx.pendingUbSpend";

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

function requireRecipientAddress(address: string): string {
  const trimmed = (address || "").trim();
  if (!/^0x[a-fA-F0-9]{40}$/.test(trimmed)) {
    throw new Error(
      "recipientAddress is required for App Kit bridge/spend — pass the Arc destination (e.g. Circle email wallet), not only the browser adapter."
    );
  }
  return trimmed;
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
 *
 * Always pass `recipientAddress` (session / Circle email wallet on Arc). Omitting it
 * mints to the browser wallet address derived from the adapter — wrong when MetaMask
 * burns on source but the user expects funds on the email session wallet.
 */
export async function appKitBridgeToArc(params: {
  source: AppKitSourceChain;
  amount: string;
  /** Arc mint destination — must match the address shown in the Fund UI. */
  recipientAddress: string;
  onProgress?: (msg: string) => void;
}): Promise<{ hash: `0x${string}` | null; raw: unknown }> {
  const recipientAddress = requireRecipientAddress(params.recipientAddress);
  const adapter = await browserAdapter();
  params.onProgress?.(`App Kit bridge ${params.source} → Arc_Testnet → ${recipientAddress.slice(0, 10)}…`);

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
      to: { adapter, chain: ARC, recipientAddress },
      amount: params.amount,
      token: "USDC"
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

/** Persisted after a successful UB deposit when spend fails — recoverable without re-bridging. */
export type PendingUbSpend = {
  source: AppKitSourceChain;
  amount: string;
  recipientAddress: string;
  depositHash: `0x${string}` | null;
  createdAt: number;
  purpose?: "lp" | "fund";
};

export type UnifiedBalanceResult = {
  mode: "unified-balance" | "bridge-fallback";
  phase: "complete" | "deposit_only" | "spend_pending";
  hash: `0x${string}` | null;
  raw: unknown;
  depositCompleted?: boolean;
};

export class UbSpendPendingError extends Error {
  readonly pending: PendingUbSpend;
  readonly causeMessage: string;

  constructor(pending: PendingUbSpend, causeMessage: string) {
    super(
      `Unified Balance deposit succeeded, but spend to ${pending.recipientAddress.slice(0, 10)}… failed (${causeMessage}). ` +
        `Funds are in the Gateway/UB balance — use “Complete transfer from Unified Balance” (retry spend only). ` +
        `Deposit tx: ${pending.depositHash ?? "see wallet activity"}.`
    );
    this.name = "UbSpendPendingError";
    this.pending = pending;
    this.causeMessage = causeMessage;
  }
}

export function loadPendingUbSpend(): PendingUbSpend | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(PENDING_UB_SPEND_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as PendingUbSpend;
    if (!parsed?.amount || !parsed?.recipientAddress || !parsed?.source) return null;
    // Drop stale recoveries after 7 days
    if (parsed.createdAt && Date.now() - parsed.createdAt > 7 * 24 * 60 * 60 * 1000) {
      clearPendingUbSpend();
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function savePendingUbSpend(pending: PendingUbSpend): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(PENDING_UB_SPEND_KEY, JSON.stringify(pending));
  } catch {
    /* private mode / quota */
  }
}

export function clearPendingUbSpend(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(PENDING_UB_SPEND_KEY);
  } catch {
    /* ignore */
  }
}

/** Spend-only Unified Balance (retry after a successful deposit). Never deposits or bridges. */
export async function appKitSpendUnifiedBalance(params: {
  source: AppKitSourceChain;
  amount: string;
  recipientAddress: string;
  onProgress?: (msg: string) => void;
}): Promise<UnifiedBalanceResult> {
  const recipientAddress = requireRecipientAddress(params.recipientAddress);
  const adapter = await browserAdapter();
  const k = kit();
  params.onProgress?.("Completing transfer — spending Unified Balance on Arc…");

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
      recipientAddress
    }
  });

  clearPendingUbSpend();
  return {
    mode: "unified-balance",
    phase: "complete",
    hash: pickHash(spend),
    raw: { spend },
    depositCompleted: true
  };
}

/**
 * Unified Balance: deposit on source chain, spend to an Arc recipient (e.g. user or vault).
 *
 * Deposit and spend are separate try blocks:
 * - deposit fails → safe to fall back to a single App Kit bridge (no double-move)
 * - deposit ok, spend fails → persist pending spend + throw UbSpendPendingError (no bridge)
 */
export async function appKitUnifiedBalanceToArc(params: {
  source: AppKitSourceChain;
  amount: string;
  recipientAddress: string;
  purpose?: "lp" | "fund";
  onProgress?: (msg: string) => void;
}): Promise<UnifiedBalanceResult> {
  const recipientAddress = requireRecipientAddress(params.recipientAddress);
  const adapter = await browserAdapter();
  const k = kit();
  params.onProgress?.(`Unified Balance deposit on ${params.source}…`);

  let deposit: unknown;
  try {
    deposit = await k.unifiedBalance.deposit({
      from: { adapter, chain: params.source },
      amount: params.amount,
      token: "USDC"
    });
  } catch (depositError) {
    params.onProgress?.(
      `Unified Balance deposit unavailable (${depositError instanceof Error ? depositError.message : "error"}) — falling back to App Kit bridge…`
    );
    const bridged = await appKitBridgeToArc({
      source: params.source,
      amount: params.amount,
      recipientAddress,
      onProgress: params.onProgress
    });
    return {
      mode: "bridge-fallback",
      phase: "complete",
      hash: bridged.hash,
      raw: { depositError, bridge: bridged.raw }
    };
  }

  params.onProgress?.("Spending Unified Balance on Arc…");
  try {
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
        recipientAddress
      }
    });
    clearPendingUbSpend();
    return {
      mode: "unified-balance",
      phase: "complete",
      hash: pickHash(spend) ?? pickHash(deposit),
      raw: { deposit, spend },
      depositCompleted: true
    };
  } catch (spendError) {
    // Deposit already moved funds into Gateway balance — never auto-bridge the same amount again.
    const why = spendError instanceof Error ? spendError.message : String(spendError);
    const pending: PendingUbSpend = {
      source: params.source,
      amount: params.amount,
      recipientAddress,
      depositHash: pickHash(deposit),
      createdAt: Date.now(),
      purpose: params.purpose
    };
    savePendingUbSpend(pending);
    throw new UbSpendPendingError(pending, why);
  }
}

export function sourceKeyToAppKitChain(source: "baseSepolia" | "ethereumSepolia"): AppKitSourceChain {
  return source === "ethereumSepolia" ? "Ethereum_Sepolia" : "Base_Sepolia";
}
