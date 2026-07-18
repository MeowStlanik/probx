"use client";

import { BadgeCheck, CircleDollarSign, Gift, Hourglass, RotateCcw, XCircle } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { SettlementCountdown } from "@/components/SettlementCountdown";
import { formatUsdc } from "@/lib/format";
import { latestPositionForMarket } from "@/lib/positions";
import type { Ticket } from "@/lib/types";

interface TicketCardProps {
  ticket: Ticket;
  action?: ReactNode;
}

export function TicketCard({ ticket, action }: TicketCardProps) {
  const Icon = iconForTicket(ticket);
  const visibleStatus = ticket.claimable ? "CLAIMABLE" : ticket.status;
  const resultClass = resultClassName(ticket.result);
  const claimAmount = ticket.claimAmount ?? (ticket.result === "WIN" ? ticket.payout : ticket.result === "REFUND" ? ticket.riskAmount : ticket.result === "LOSS" ? 0 : undefined);
  const [localTimers, setLocalTimers] = useState<{ lockTime?: string; observationEnd?: string }>({});

  useEffect(() => {
    const local = latestPositionForMarket(ticket.marketId);
    if (local) {
      setLocalTimers({ lockTime: local.lockTime, observationEnd: local.observationEnd });
    }
  }, [ticket.marketId, ticket.id]);

  return (
    <article className={`ticketCard ${ticket.claimable ? "ticketCardClaimable" : ""} ${resultClass}`}>
      <div className="ticketIcon">
        <Icon size={20} aria-hidden />
      </div>
      <div>
        <div className="ticketHeader">
          <strong>{ticket.id}</strong>
          <span className={ticket.claimable ? "statusPill open" : "statusPill"}>{visibleStatus}</span>
          {ticket.result ? (
            <span className={`resultPill ${resultClass}`}>{ticket.result}</span>
          ) : null}
        </div>
        <h3>{ticket.marketQuestion}</h3>
        <div className="ticketMeta">
          <span>Bought {ticket.outcome}</span>
          <span>{ticket.boost}x Boost</span>
          <span>Stake {formatUsdc(ticket.riskAmount)} USDC</span>
          {ticket.marketStatus ? <span>Market {ticket.marketStatus}</span> : null}
          {ticket.winningOutcome ? <span>Winner {ticket.winningOutcome}</span> : null}
          <span>
            <CircleDollarSign size={15} aria-hidden />
            Max payout {formatUsdc(ticket.payout)} USDC
          </span>
        </div>
        {ticket.openReferencePrice !== undefined && Number.isFinite(ticket.openReferencePrice) ? (
          <p className="ticketClaimHint">
            Entry <strong>{formatOpenReference(ticket)}</strong>
            {ticket.openThreshold !== undefined && Number.isFinite(ticket.openThreshold)
              ? <> · threshold <strong>{formatThreshold(ticket)}</strong></>
              : null}
          </p>
        ) : null}
        {ticket.claimable ? (
          <p className="ticketClaimHint">
            {ticket.result === "WIN" && (
              <>You won — claim <strong>{formatUsdc(claimAmount ?? ticket.payout)} USDC</strong> to your wallet.</>
            )}
            {ticket.result === "REFUND" && (
              <>Market cancelled — claim <strong>{formatUsdc(claimAmount ?? ticket.riskAmount)} USDC</strong> risk refund.</>
            )}
            {ticket.result === "LOSS" && (
              <>You lost — close the ticket to release LP reserve (payout 0 USDC).</>
            )}
            {!ticket.result && (
              <>Market finished — claim available.</>
            )}
          </p>
        ) : null}
        {!ticket.claimable && ticket.status === "OPEN" ? (
          <>
            <p className="ticketClaimHint mutedHint">
              Position open. Wait for lock + observation, then claim payout here.
            </p>
            {localTimers.lockTime || localTimers.observationEnd ? (
              <SettlementCountdown
                compact
                lockTime={localTimers.lockTime}
                observationEnd={localTimers.observationEnd}
              />
            ) : null}
          </>
        ) : null}
        {ticket.status !== "OPEN" && ticket.result ? (
          <p className="ticketClaimHint mutedHint">
            {ticket.result === "WIN" && <>Settled win · received {formatUsdc(ticket.payout)} USDC.</>}
            {ticket.result === "LOSS" && <>Settled loss · no payout.</>}
            {ticket.result === "REFUND" && <>Refunded · returned {formatUsdc(ticket.riskAmount)} USDC risk.</>}
          </p>
        ) : null}
        {action ? <div className="ticketActions">{action}</div> : null}
      </div>
    </article>
  );
}

function iconForTicket(ticket: Ticket) {
  if (ticket.claimable && ticket.result === "WIN") return Gift;
  if (ticket.claimable && ticket.result === "REFUND") return RotateCcw;
  if (ticket.claimable && ticket.result === "LOSS") return XCircle;
  if (ticket.status === "OPEN") return Hourglass;
  if (ticket.result === "REFUND") return RotateCcw;
  if (ticket.result === "LOSS") return XCircle;
  return BadgeCheck;
}

function resultClassName(result: Ticket["result"] | undefined): string {
  if (result === "WIN") return "resultWin";
  if (result === "LOSS") return "resultLoss";
  if (result === "REFUND") return "resultRefund";
  return "";
}

function formatOpenReference(ticket: Ticket): string {
  const value = ticket.openReferencePrice as number;
  if (ticket.openReferenceFeed === "btc") {
    return `BTC/USD $${value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  }
  if (ticket.openReferenceFeed === "weather") {
    return `London ${value.toFixed(2)}°C`;
  }
  return String(value);
}

function formatThreshold(ticket: Ticket): string {
  const value = ticket.openThreshold as number;
  if (ticket.openReferenceFeed === "btc") {
    return `$${value.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
  }
  if (ticket.openReferenceFeed === "weather") {
    return `${value.toFixed(2)}°C`;
  }
  return String(value);
}
