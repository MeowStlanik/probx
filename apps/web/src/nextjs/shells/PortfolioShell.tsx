"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { getAddress } from "viem";
import { fetchUserTickets } from "@/lib/api";
import { arcDeployment, engineAbi } from "@/lib/onchain";
import { loadPositions, type LocalPosition } from "@/lib/positions";
import type { Ticket } from "@/lib/types";
import { readableWalletError, useWallet } from "@/lib/wallet";
import { moneyUsdc, ticketToPosition } from "../mapMarket";
import type { LoadState, Position } from "../types";
import { PortfolioView } from "../views/PortfolioView";

/**
 * Wires PortfolioView → fetchUserTickets + settleTicket (wins/refunds only).
 * Falls back to localStorage positions when Arc RPC / API blips so the page
 * never looks like a total loss of funds.
 */
export function PortfolioShell() {
  const { address, ready, getWalletClient, publicClient, ensureArcChain, trackTx } = useWallet();
  const [state, setState] = useState<LoadState>("loading");
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [warning, setWarning] = useState<string | null>(null);
  const [claimingId, setClaimingId] = useState<string | null>(null);
  const [claimMessage, setClaimMessage] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!ready) return;
    if (!address) {
      setTickets([]);
      setWarning(null);
      setState("live");
      return;
    }
    setState((s) => (s === "live" ? s : "loading"));
    try {
      const next = await fetchUserTickets(address);
      // Merge browser-saved tickets that the log scan has not caught yet
      // (e.g. just after buy, or when ARC_FROM_BLOCK skips the buy block).
      const merged = mergeWithLocal(next, loadPositions());
      setTickets(merged);
      setWarning(null);
      setState("live");
    } catch (error) {
      const local = localTicketsFromPositions(loadPositions());
      if (local.length > 0) {
        setTickets(local);
        setWarning(
          "Live Arc read failed — showing tickets saved in this browser. Funds are safe; Retry when RPC recovers."
        );
        setState("live");
        return;
      }
      console.error("[portfolio] load failed", error);
      setState("error");
    }
  }, [address, ready]);

  useEffect(() => {
    void load();
    if (!address) return;
    const id = window.setInterval(() => void load(), 12_000);
    return () => window.clearInterval(id);
  }, [address, load]);

  const positions: Position[] = useMemo(() => tickets.map(ticketToPosition), [tickets]);

  const openCount = tickets.filter((t) => t.status === "OPEN" && !t.result).length;
  const totalStaked = tickets
    .filter((t) => t.status === "OPEN" && !t.result)
    .reduce((s, t) => s + t.riskAmount, 0);
  const claimable = tickets
    .filter((t) => t.claimable && (t.result === "WIN" || t.result === "REFUND"))
    .reduce(
      (s, t) => s + (t.claimAmount ?? (t.result === "WIN" ? t.payout : t.result === "REFUND" ? t.riskAmount : 0)),
      0
    );
  const realized = tickets
    .filter((t) => t.status === "SETTLED" || t.result === "LOSS" || t.result === "WIN" || t.result === "REFUND")
    .reduce((s, t) => {
      if (t.result === "WIN" && t.status === "SETTLED") return s + (t.payout - t.riskAmount);
      if (t.result === "LOSS") return s - t.riskAmount;
      return s;
    }, 0);

  const onClaim = useCallback(
    async (id: string) => {
      setClaimMessage(null);
      const ticket = tickets.find((t) => t.id === id);
      if (ticket?.result === "LOSS") {
        setClaimMessage("This ticket lost — nothing to claim.");
        return;
      }
      if (!ticket?.claimable || (ticket.result !== "WIN" && ticket.result !== "REFUND")) {
        setClaimMessage("Nothing to claim on this ticket.");
        return;
      }
      if (!address) {
        setClaimMessage("Connect wallet first.");
        return;
      }
      try {
        await ensureArcChain();
      } catch (error) {
        setClaimMessage(readableWalletError(error));
        return;
      }
      const walletClient = getWalletClient();
      if (!walletClient) {
        setClaimMessage("Wallet provider unavailable.");
        return;
      }
      let ticketId: bigint;
      try {
        ticketId = BigInt(id.replace(/^PXLT-/, ""));
      } catch {
        setClaimMessage(`Cannot parse ticket id ${id}`);
        return;
      }
      setClaimingId(id);
      try {
        const hash = await walletClient.writeContract({
          address: getAddress(arcDeployment.microBoostEngine),
          abi: engineAbi,
          functionName: "settleTicket",
          args: [ticketId]
        });
        trackTx({ hash, kind: "claim", label: `Claim ticket ${id}` });
        await publicClient.waitForTransactionReceipt({ hash });
        setClaimMessage(`Claimed — tx ${hash.slice(0, 10)}…`);
        await load();
      } catch (error) {
        setClaimMessage(readableWalletError(error));
      } finally {
        setClaimingId(null);
      }
    },
    [address, ensureArcChain, getWalletClient, load, publicClient, tickets, trackTx]
  );

  return (
    <PortfolioView
      state={state}
      openCount={openCount}
      totalStaked={moneyUsdc(totalStaked, 2)}
      claimable={moneyUsdc(claimable, 2)}
      pnl={`${realized >= 0 ? "+" : "−"}${moneyUsdc(Math.abs(realized), 2)}`}
      pnlPositive={realized >= 0}
      positions={positions}
      claimingId={claimingId}
      claimMessage={claimMessage}
      warning={warning}
      onClaim={(id) => {
        void onClaim(id);
      }}
      onRetry={() => void load()}
    />
  );
}

function localTicketsFromPositions(local: LocalPosition[]): Ticket[] {
  return local.map((p) => ({
    id: p.ticketId.startsWith("PXLT-") ? p.ticketId : `PXLT-${p.ticketId}`,
    marketId: p.marketAddress || p.marketId,
    marketQuestion: p.marketQuestion ?? p.marketId,
    marketStatus: "OPEN" as const,
    outcome: p.outcome,
    riskAmount: p.riskAmount,
    boost: p.boost,
    payout: p.payout,
    requiredReserve: Math.max(0, p.payout - p.riskAmount),
    status: "OPEN" as const,
    claimable: false,
    createdAt: p.createdAt,
    openReferencePrice: p.referencePrice,
    openReferenceFeed: p.referenceFeed,
    openReferenceLabel: p.referenceLabel
  }));
}

function mergeWithLocal(onchain: Ticket[], local: LocalPosition[]): Ticket[] {
  const byId = new Map(onchain.map((t) => [t.id, t]));
  for (const p of local) {
    const id = p.ticketId.startsWith("PXLT-") ? p.ticketId : `PXLT-${p.ticketId}`;
    if (byId.has(id)) continue;
    // Only show local tickets that look like real engine ids.
    if (!/^PXLT-\d+$/.test(id) && !/^\d+$/.test(p.ticketId)) continue;
    const synthetic = localTicketsFromPositions([p])[0];
    if (synthetic) byId.set(id, { ...synthetic, id });
  }
  return [...byId.values()].sort((a, b) => {
    const na = Number(a.id.replace(/^PXLT-/, "")) || 0;
    const nb = Number(b.id.replace(/^PXLT-/, "")) || 0;
    return nb - na;
  });
}
