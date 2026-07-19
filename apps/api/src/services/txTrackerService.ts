/**
 * Transaction tracking with durable status.
 *
 * Every write we surface to a user (buy / claim / deposit / transfer) is
 * recorded here the moment we get a hash, then reconciled against the chain so
 * the UI can show pending -> confirmed / failed instead of hanging on a hash.
 *
 * Records are persisted in the durable KV (or file fallback) so status survives
 * cold starts and can be polled from any instance. Reconciliation reads the
 * receipt over RPC; when Circle owns the wallet we also accept a Circle txId to
 * cross-check state.
 */
import { createPublicClient, http } from "viem";
import { NamespaceStore } from "./persistentStore.js";

export type TxKind = "buy" | "claim" | "deposit" | "transfer" | "approve" | "other";
export type TxStatus = "pending" | "confirmed" | "failed";

export type TxRecord = {
  id: string;
  hash: `0x${string}`;
  kind: TxKind;
  status: TxStatus;
  /** lowercased owner email or address, used to scope listing */
  owner: string;
  from?: `0x${string}`;
  to?: `0x${string}`;
  /** human label, e.g. "Buy YES · mkt_btc_1m" */
  label?: string;
  circleTxId?: string;
  amountUsdc?: string;
  createdAt: string;
  updatedAt: string;
  blockNumber?: string;
  error?: string;
};

const store = new NamespaceStore<TxRecord>("tx-records");

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

function publicClient() {
  return createPublicClient({ chain: arcChain, transport: http(arcRpcUrl) });
}

function normalizeOwner(owner: string): string {
  return owner.trim().toLowerCase();
}

export async function recordTx(input: {
  hash: `0x${string}`;
  kind: TxKind;
  owner: string;
  from?: `0x${string}`;
  to?: `0x${string}`;
  label?: string;
  circleTxId?: string;
  amountUsdc?: string;
}): Promise<TxRecord> {
  const now = new Date().toISOString();
  const record: TxRecord = {
    id: input.hash,
    hash: input.hash,
    kind: input.kind,
    status: "pending",
    owner: normalizeOwner(input.owner),
    from: input.from,
    to: input.to,
    label: input.label,
    circleTxId: input.circleTxId,
    amountUsdc: input.amountUsdc,
    createdAt: now,
    updatedAt: now
  };
  await store.set(record.id, record);
  return record;
}

/** Read the receipt and move pending -> confirmed / failed. Idempotent. */
export async function reconcileTx(hash: `0x${string}`): Promise<TxRecord | null> {
  const record = await store.get(hash);
  if (!record) return null;
  if (record.status !== "pending") return record;

  try {
    const receipt = await publicClient().getTransactionReceipt({ hash });
    const confirmed = receipt.status === "success";
    const updated: TxRecord = {
      ...record,
      status: confirmed ? "confirmed" : "failed",
      blockNumber: receipt.blockNumber?.toString(),
      error: confirmed ? undefined : "Transaction reverted on chain.",
      updatedAt: new Date().toISOString()
    };
    await store.set(updated.id, updated);
    return updated;
  } catch {
    // Receipt not mined yet — leave pending. Mark failed only after a grace window.
    const ageMs = Date.now() - Date.parse(record.createdAt);
    if (ageMs > 10 * 60_000) {
      const updated: TxRecord = {
        ...record,
        status: "failed",
        error: "No receipt after 10 minutes; treated as dropped.",
        updatedAt: new Date().toISOString()
      };
      await store.set(updated.id, updated);
      return updated;
    }
    return record;
  }
}

export async function getTx(hash: `0x${string}`): Promise<TxRecord | null> {
  const record = await store.get(hash);
  if (record && record.status === "pending") {
    return (await reconcileTx(hash)) ?? record;
  }
  return record;
}

export async function listTxForOwner(owner: string, limit = 25): Promise<TxRecord[]> {
  const key = normalizeOwner(owner);
  const all = await store.all();
  const mine = Object.values(all)
    .filter((r) => r.owner === key)
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));

  // Reconcile the pending ones so a poll returns fresh status.
  await Promise.all(
    mine.filter((r) => r.status === "pending").map((r) => reconcileTx(r.hash).catch(() => null))
  );

  const refreshed = Object.values(await store.all())
    .filter((r) => r.owner === key)
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
    .slice(0, limit);
  return refreshed;
}

/** Reconcile all still-pending records (used by the cron heartbeat). */
export async function reconcilePending(maxToCheck = 40): Promise<{ checked: number; settled: number }> {
  const all = await store.all();
  const pending = Object.values(all)
    .filter((r) => r.status === "pending")
    .slice(0, maxToCheck);
  let settled = 0;
  for (const r of pending) {
    const updated = await reconcileTx(r.hash).catch(() => null);
    if (updated && updated.status !== "pending") settled += 1;
  }
  return { checked: pending.length, settled };
}
