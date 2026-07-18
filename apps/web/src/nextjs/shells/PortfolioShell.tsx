"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { getAddress } from "viem";
import { fetchUserTickets } from "@/lib/api";
import { arcDeployment, engineAbi } from "@/lib/onchain";
import type { Ticket } from "@/lib/types";
import { readableWalletError, useWallet } from "@/lib/wallet";
import { moneyUsdc, ticketToPosition } from "../mapMarket";
import type { LoadState, Position } from "../types";
import { PortfolioView } from "../views/PortfolioView";

/**
 * Wires PortfolioView → fetchUserTickets + settleTicket (wins/refunds only).
 */
export function PortfolioShell() {
  const { address, ready, getWalletClient, publicClient, ensureArcChain } = useWallet();
  const [state, setState] = useState<LoadState>("loading");
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [claimingId, setClaimingId] = useState<string | null>(null);
  const [claimMessage, setClaimMessage] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!ready) return;
    if (!address) {
      setTickets([]);
      setState("live");
      return;
    }
    setState((s) => (s === "live" ? s : "loading"));
    try {
      const next = await fetchUserTickets(address);
      setTickets(next);
      setState("live");
    } catch {
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
        await publicClient.waitForTransactionReceipt({ hash });
        setClaimMessage(`Claimed — tx ${hash.slice(0, 10)}…`);
        await load();
      } catch (error) {
        setClaimMessage(readableWalletError(error));
      } finally {
        setClaimingId(null);
      }
    },
    [address, ensureArcChain, getWalletClient, load, publicClient, tickets]
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
      onClaim={(id) => {
        void onClaim(id);
      }}
      onRetry={() => void load()}
    />
  );
}
