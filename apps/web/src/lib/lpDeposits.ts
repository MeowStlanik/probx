import { formatUnits, type PublicClient } from "viem";
import { arcDeployment, poolAbi } from "./onchain";

export type LpLedgerRow = {
  id: string;
  time: string;
  kind: "Deposit" | "Withdraw";
  amount: string;
  txHref?: string;
};

const money = (value: number) =>
  `$${Number(value || 0).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  })}`;

function relativeTime(tsSec: number, nowMs = Date.now()): string {
  const mins = Math.max(0, Math.round((nowMs / 1000 - tsSec) / 60));
  if (mins < 1) return "just now";
  if (mins < 60) return `~${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 48) return `~${hrs}h`;
  return `~${Math.floor(hrs / 24)}d`;
}

const LOCAL_KEY = "probx.lp.ledger";

type LocalEntry = {
  id: string;
  kind: "Deposit" | "Withdraw";
  amountUsdc: number;
  at: number;
  tx?: string;
};

function readLocal(): LocalEntry[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(LOCAL_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as LocalEntry[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeLocal(entries: LocalEntry[]): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(LOCAL_KEY, JSON.stringify(entries.slice(0, 40)));
  } catch {
    /* ignore */
  }
}

/** Call after a successful deposit/withdraw from the LP shell. */
export function recordLocalLpAction(input: {
  kind: "Deposit" | "Withdraw";
  amountUsdc: number;
  tx?: string;
}): void {
  const next: LocalEntry = {
    id: `${input.kind}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    kind: input.kind,
    amountUsdc: input.amountUsdc,
    at: Date.now(),
    tx: input.tx
  };
  writeLocal([next, ...readLocal()].slice(0, 40));
}

/**
 * Recent vault deposits/withdrawals (chain logs + local cache).
 * Shows last `limit` rows — sized like the deposit card, not fake $0 reserves.
 */
export async function fetchRecentLpLedger(
  publicClient: PublicClient,
  opts?: { address?: `0x${string}` | null; limit?: number }
): Promise<LpLedgerRow[]> {
  const limit = opts?.limit ?? 5;
  const pool = arcDeployment.liquidityPool as `0x${string}`;
  const explorer = arcDeployment.explorerUrl || "https://testnet.arcscan.app";
  const now = Date.now();
  const rows: LpLedgerRow[] = [];

  try {
    const latest = await publicClient.getBlockNumber();
    // ~2s blocks → 7 days window, capped for RPC friendliness
    const lookback = 300_000n;
    const fromBlock = latest > lookback ? latest - lookback : 0n;

    const [deposits, withdraws] = await Promise.all([
      publicClient.getLogs({
        address: pool,
        event: {
          type: "event",
          name: "Deposited",
          inputs: [
            { name: "lp", type: "address", indexed: true },
            { name: "assets", type: "uint256", indexed: false },
            { name: "shares", type: "uint256", indexed: false }
          ]
        },
        fromBlock,
        toBlock: latest
      }),
      publicClient.getLogs({
        address: pool,
        event: {
          type: "event",
          name: "Withdrawn",
          inputs: [
            { name: "lp", type: "address", indexed: true },
            { name: "assets", type: "uint256", indexed: false },
            { name: "shares", type: "uint256", indexed: false }
          ]
        },
        fromBlock,
        toBlock: latest
      })
    ]);

    type Raw = {
      kind: "Deposit" | "Withdraw";
      blockNumber: bigint;
      logIndex: number;
      assets: bigint;
      txHash?: `0x${string}`;
      lp?: string;
    };

    const raw: Raw[] = [];
    for (const log of deposits) {
      const assets = (log.args as { assets?: bigint })?.assets ?? 0n;
      const lp = (log.args as { lp?: string })?.lp;
      if (opts?.address && lp && lp.toLowerCase() !== opts.address.toLowerCase()) continue;
      raw.push({
        kind: "Deposit",
        blockNumber: log.blockNumber ?? 0n,
        logIndex: log.logIndex ?? 0,
        assets,
        txHash: log.transactionHash,
        lp
      });
    }
    for (const log of withdraws) {
      const assets = (log.args as { assets?: bigint })?.assets ?? 0n;
      const lp = (log.args as { lp?: string })?.lp;
      if (opts?.address && lp && lp.toLowerCase() !== opts.address.toLowerCase()) continue;
      raw.push({
        kind: "Withdraw",
        blockNumber: log.blockNumber ?? 0n,
        logIndex: log.logIndex ?? 0,
        assets,
        txHash: log.transactionHash,
        lp
      });
    }

    raw.sort((a, b) => {
      if (a.blockNumber === b.blockNumber) return b.logIndex - a.logIndex;
      return a.blockNumber > b.blockNumber ? -1 : 1;
    });

    // Resolve timestamps for the newest few only
    const top = raw.slice(0, limit * 2);
    const blockTimes = new Map<string, number>();
    await Promise.all(
      [...new Set(top.map((r) => r.blockNumber.toString()))].slice(0, 12).map(async (bn) => {
        try {
          const block = await publicClient.getBlock({ blockNumber: BigInt(bn) });
          blockTimes.set(bn, Number(block.timestamp));
        } catch {
          /* ignore */
        }
      })
    );

    for (const r of top) {
      const ts = blockTimes.get(r.blockNumber.toString()) ?? Math.floor(now / 1000);
      const amount = Number(formatUnits(r.assets, 6));
      if (amount <= 0) continue;
      rows.push({
        id: `${r.kind}-${r.txHash ?? r.blockNumber}-${r.logIndex}`,
        time: relativeTime(ts, now),
        kind: r.kind,
        amount: money(amount),
        txHref: r.txHash ? `${explorer}/tx/${r.txHash}` : undefined
      });
      if (rows.length >= limit) break;
    }
  } catch {
    /* fall through to local */
  }

  if (rows.length < limit) {
    const local = readLocal()
      .filter((e) => e.amountUsdc > 0)
      .slice(0, limit);
    for (const e of local) {
      if (rows.some((r) => r.id === e.id)) continue;
      rows.push({
        id: e.id,
        time: relativeTime(Math.floor(e.at / 1000), now),
        kind: e.kind,
        amount: money(e.amountUsdc),
        txHref: e.tx ? `${explorer}/tx/${e.tx}` : undefined
      });
      if (rows.length >= limit) break;
    }
  }

  return rows.slice(0, limit);
}
