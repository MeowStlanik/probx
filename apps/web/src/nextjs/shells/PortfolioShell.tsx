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
 * Wires PortfolioView → fetchUserTickets + settleTicket (same as PortfolioClient).
 */
export function PortfolioShell() {
  const { address, ready, getWalletClient, publicClient, ensureArcChain } = useWallet();
  const [state, setState] = useState<LoadState>("loading");
  const [tickets, setTickets] = useState<Ticket[]>([]);

  const load = useCallback(async () => {
    if (!ready) return;
    if (!address) {
      setTickets([]);
      setState("live");
      return;
    }
    setState("loading");
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

  const openCount = tickets.filter((t) => t.status === "OPEN").length;
  const totalStaked = tickets
    .filter((t) => t.status === "OPEN")
    .reduce((s, t) => s + t.riskAmount, 0);
  const claimable = tickets
    .filter((t) => t.claimable)
    .reduce((s, t) => s + (t.claimAmount ?? (t.result === "WIN" ? t.payout : t.result === "REFUND" ? t.riskAmount : 0)), 0);
  const realized = tickets
    .filter((t) => t.status === "SETTLED")
    .reduce((s, t) => {
      if (t.result === "WIN") return s + (t.payout - t.riskAmount);
      if (t.result === "LOSS") return s - t.riskAmount;
      return s;
    }, 0);

  const onClaim = useCallback(
    async (id: string) => {
      if (!address) {
        window.alert("Connect wallet first.");
        return;
      }
      try {
        await ensureArcChain();
      } catch (error) {
        window.alert(readableWalletError(error));
        return;
      }
      const walletClient = getWalletClient();
      if (!walletClient) {
        window.alert("Wallet provider unavailable.");
        return;
      }
      let ticketId: bigint;
      try {
        ticketId = BigInt(id.replace(/^PXLT-/, ""));
      } catch {
        window.alert(`Cannot parse ticket id ${id}`);
        return;
      }
      try {
        const hash = await walletClient.writeContract({
          address: getAddress(arcDeployment.microBoostEngine),
          abi: engineAbi,
          functionName: "settleTicket",
          args: [ticketId]
        });
        await publicClient.waitForTransactionReceipt({ hash });
        await load();
      } catch (error) {
        window.alert(readableWalletError(error));
      }
    },
    [address, ensureArcChain, getWalletClient, load, publicClient]
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
      onClaim={(id) => {
        void onClaim(id);
      }}
      onRetry={() => void load()}
    />
  );
}
