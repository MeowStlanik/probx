"use client";

import { RefreshCcw, Wallet } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { getAddress } from "viem";
import { TicketCard } from "@/components/TicketCard";
import { fetchUserTickets } from "@/lib/api";
import { formatUsdc } from "@/lib/format";
import { arcDeployment, engineAbi } from "@/lib/onchain";
import type { Ticket } from "@/lib/types";
import { readableWalletError, shortHex, useWallet } from "@/lib/wallet";

export function PortfolioClient() {
  const {
    address,
    connecting,
    restoring,
    ready,
    connect,
    getWalletClient,
    publicClient
  } = useWallet();

  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [status, setStatus] = useState("Connect your Arc Testnet wallet to load tickets.");
  const [loading, setLoading] = useState(false);
  const [settlingTicket, setSettlingTicket] = useState<string | null>(null);
  const [txHash, setTxHash] = useState<string | null>(null);

  const claimableTickets = useMemo(
    () => tickets.filter((ticket) => ticket.claimable),
    [tickets]
  );
  const waitingTickets = useMemo(
    () => tickets.filter((ticket) => ticket.status === "OPEN" && !ticket.claimable),
    [tickets]
  );
  const historyTickets = useMemo(
    () => tickets.filter((ticket) => ticket.status !== "OPEN"),
    [tickets]
  );
  const claimablePayoutTotal = useMemo(
    () => claimableTickets.reduce((sum, ticket) => sum + (ticket.claimAmount ?? 0), 0),
    [claimableTickets]
  );

  const refresh = useCallback(async (walletAddress = address) => {
    if (!walletAddress) {
      setTickets([]);
      setStatus("Connect wallet in the header (or below) — session is shared across all pages.");
      return;
    }
    setLoading(true);
    setStatus("Loading tickets from Arc indexer...");
    try {
      const nextTickets = await fetchUserTickets(walletAddress);
      setTickets(nextTickets);
      const claimable = nextTickets.filter((ticket) => ticket.claimable).length;
      if (!nextTickets.length) {
        setStatus("No tickets yet. Buy a YES/NO ticket on Markets first.");
      } else if (claimable > 0) {
        setStatus(`${nextTickets.length} ticket(s) loaded · ${claimable} ready to claim.`);
      } else {
        setStatus(`${nextTickets.length} ticket(s) loaded · waiting for market resolution.`);
      }
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Portfolio indexing failed.");
    } finally {
      setLoading(false);
    }
  }, [address]);

  // Auto-load when shared wallet connects / restores.
  useEffect(() => {
    if (!ready) return;
    if (address) {
      void refresh(address);
    } else {
      setTickets([]);
      setStatus("Connect wallet in the header (or below) — session is shared across all pages.");
    }
  }, [address, ready, refresh]);

  useEffect(() => {
    if (!address) return;
    const interval = window.setInterval(() => void refresh(address), 12_000);
    return () => window.clearInterval(interval);
  }, [address, refresh]);

  async function handleConnect() {
    setLoading(true);
    try {
      const next = await connect();
      if (next) await refresh(next);
      else setStatus("Wallet not connected.");
    } catch (error) {
      setStatus(readableWalletError(error));
    } finally {
      setLoading(false);
    }
  }

  async function settle(ticket: Ticket) {
    if (!address) {
      setStatus("Connect wallet before claiming a ticket.");
      return;
    }
    const walletClient = getWalletClient();
    if (!walletClient) {
      setStatus("Wallet provider unavailable. Reconnect wallet and try again.");
      return;
    }
    const ticketId = ticketIdNumber(ticket.id);
    if (ticketId <= 0n) {
      setStatus(`Cannot parse ticket id ${ticket.id}.`);
      return;
    }
    setSettlingTicket(ticket.id);
    setStatus(`Claiming ${ticket.id} onchain...`);
    try {
      const hash = await walletClient.writeContract({
        address: getAddress(arcDeployment.microBoostEngine),
        abi: engineAbi,
        functionName: "settleTicket",
        args: [ticketId]
      });
      setTxHash(hash);
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      if (receipt.status === "success") {
        const amountText = ticket.claimAmount !== undefined
          ? ` ${formatUsdc(ticket.claimAmount)} USDC`
          : "";
        setStatus(
          ticket.result === "LOSS"
            ? `${ticket.id} closed (loss). LP reserve released.`
            : `${ticket.id} claimed successfully.${amountText ? ` Received${amountText}.` : ""}`
        );
      } else {
        setStatus(`${ticket.id} claim transaction failed.`);
      }
      await refresh(address);
    } catch (error) {
      setStatus(readableWalletError(error));
    } finally {
      setSettlingTicket(null);
    }
  }

  return (
    <>
      <section className="portfolioToolbar">
        <div>
          <span className="eyebrow">Arc wallet</span>
          <strong>
            {restoring
              ? "Restoring session…"
              : address
                ? shortHex(address)
                : "Not connected"}
          </strong>
          <p>{loading || connecting ? "Refreshing..." : status}</p>
          {txHash ? (
            <a className="txLink" href={`${arcDeployment.explorerUrl}/tx/${txHash}`} target="_blank">
              View claim tx
            </a>
          ) : null}
        </div>
        <div className="portfolioActions">
          {!address ? (
            <button className="iconButton" disabled={loading || connecting || restoring} onClick={() => void handleConnect()} type="button">
              <Wallet size={18} aria-hidden />
              {connecting ? "Connecting…" : "Connect wallet"}
            </button>
          ) : null}
          <button className="iconButton secondaryButton" disabled={!address || loading} onClick={() => void refresh()} type="button">
            <RefreshCcw size={18} aria-hidden />
            Refresh
          </button>
        </div>
      </section>

      {address ? (
        <section className="portfolioSummary">
          <article>
            <span>Ready to claim</span>
            <strong>{claimableTickets.length}</strong>
            <small>{formatUsdc(claimablePayoutTotal)} USDC total</small>
          </article>
          <article>
            <span>Waiting</span>
            <strong>{waitingTickets.length}</strong>
            <small>locked until resolve</small>
          </article>
          <article>
            <span>History</span>
            <strong>{historyTickets.length}</strong>
            <small>already settled</small>
          </article>
        </section>
      ) : null}

      <section className="ticketSection">
        <div className="ticketSectionHeader">
          <h2>Ready to claim</h2>
          {claimableTickets.length ? (
            <span className="statusPill open">{claimableTickets.length} claimable</span>
          ) : null}
        </div>
        <p className="sectionHint">
          These markets are resolved or cancelled. Press the button to settle onchain and receive funds (or close a loss).
        </p>
        <div className="ticketList">
          {claimableTickets.length ? claimableTickets.map((ticket) => (
            <TicketCard
              action={(
                <button
                  className={`iconButton settleButton ${ticket.result === "LOSS" ? "lossClaimButton" : ""}`}
                  disabled={Boolean(settlingTicket)}
                  onClick={() => void settle(ticket)}
                  type="button"
                >
                  {settlingTicket === ticket.id
                    ? "Claiming..."
                    : ticket.claimLabel ?? defaultClaimLabel(ticket)}
                </button>
              )}
              key={ticket.id}
              ticket={ticket}
            />
          )) : (
            <p className="emptyState">
              {address
                ? "Nothing to claim yet. When a market resolves, winning tickets appear here with a Claim button."
                : "Connect a wallet to see claimable tickets."}
            </p>
          )}
        </div>
      </section>

      <section className="ticketSection">
        <div className="ticketSectionHeader">
          <h2>Waiting for resolution</h2>
          {waitingTickets.length ? (
            <span className="statusPill">{waitingTickets.length} open</span>
          ) : null}
        </div>
        <p className="sectionHint">
          Tickets are locked. BTC and London weather auto-resolve after the observation window; other markets need a manual resolve in Admin.
        </p>
        <div className="ticketList">
          {waitingTickets.length ? waitingTickets.map((ticket) => (
            <TicketCard
              action={<span className="settlementNote">Waiting for market resolution…</span>}
              key={ticket.id}
              ticket={ticket}
            />
          )) : (
            <p className="emptyState">No open tickets waiting on resolution.</p>
          )}
        </div>
      </section>

      <section className="ticketSection">
        <div className="ticketSectionHeader">
          <h2>History</h2>
        </div>
        <p className="sectionHint">Already settled or refunded tickets for this wallet.</p>
        <div className="ticketList">
          {historyTickets.length ? historyTickets.map((ticket) => (
            <TicketCard key={ticket.id} ticket={ticket} />
          )) : (
            <p className="emptyState">No settled tickets yet.</p>
          )}
        </div>
      </section>
    </>
  );
}

function defaultClaimLabel(ticket: Ticket): string {
  if (ticket.marketStatus === "CANCELLED" || ticket.result === "REFUND") return "Claim refund";
  if (ticket.result === "LOSS") return "Close ticket (lost)";
  if (ticket.result === "WIN") return `Claim ${formatUsdc(ticket.payout)} USDC`;
  return "Claim payout";
}

function ticketIdNumber(id: string): bigint {
  try {
    return BigInt(id.replace(/^PXLT-/, ""));
  } catch {
    return 0n;
  }
}
