"use client";

import { CheckCircle2, LockKeyhole, ShoppingCart } from "lucide-react";
import { useMemo, useState } from "react";
import { formatPercent, formatUsdc } from "@/lib/format";
import { quoteTicket } from "@/lib/quote";
import type { LpStats, Market, Outcome } from "@/lib/types";
import { BoostSelector } from "./BoostSelector";
import { PayoutPreview } from "./PayoutPreview";

interface MicroTradeTicketProps {
  market: Market;
  lpStats: LpStats;
}

export function MicroTradeTicket({ market, lpStats }: MicroTradeTicketProps) {
  const [outcome, setOutcome] = useState<Outcome>("YES");
  const [riskAmount, setRiskAmount] = useState(100);
  const [boost, setBoost] = useState(2);
  const [ticketId, setTicketId] = useState<string | null>(null);

  const quote = useMemo(
    () => quoteTicket(market, outcome, riskAmount, boost, lpStats.availableLiquidity),
    [boost, lpStats.availableLiquidity, market, outcome, riskAmount]
  );

  function confirmTicket() {
    setTicketId(`PXLT-${Math.floor(1000 + Math.random() * 9000)}`);
  }

  return (
    <section className="tradeSurface" aria-label="Buy Micro Boost ticket">
      <div className="surfaceHeader">
        <div>
          <span className="eyebrow">Micro Boost Ticket</span>
          <h2>Buy locked YES/NO exposure</h2>
        </div>
        <span className={market.status === "OPEN" ? "statusPill open" : "statusPill"}>{market.status}</span>
      </div>

      <div className="outcomeSwitch" role="group" aria-label="Select outcome">
        <button
          aria-pressed={outcome === "YES"}
          className={outcome === "YES" ? "yes selected" : "yes"}
          onClick={() => setOutcome("YES")}
          type="button"
        >
          <span className="outcomeLabel">YES</span>
          <span className="outcomePrice">{formatPercent(market.yesPrice)}</span>
        </button>
        <button
          aria-pressed={outcome === "NO"}
          className={outcome === "NO" ? "no selected" : "no"}
          onClick={() => setOutcome("NO")}
          type="button"
        >
          <span className="outcomeLabel">NO</span>
          <span className="outcomePrice">{formatPercent(market.noPrice)}</span>
        </button>
      </div>

      <label className="fieldLabel" htmlFor="riskAmount">
        Amount to risk
      </label>
      <div className="amountInput">
        <input
          id="riskAmount"
          inputMode="decimal"
          max={100}
          min={1}
          onChange={(event) => setRiskAmount(Number(event.target.value))}
          step={1}
          type="number"
          value={riskAmount}
        />
        <span>USDC</span>
      </div>

      <div className="fieldRow">
        <span className="fieldLabel">Boost</span>
        <span className="hint">Max safe {quote.maxAvailableBoost.toFixed(2)}x</span>
      </div>
      <BoostSelector maxBoost={quote.maxAvailableBoost} onChange={setBoost} value={boost} />

      <PayoutPreview quote={quote} riskAmount={riskAmount} />

      <div className="feeRow">
        <span>Fee</span>
        <strong>{formatUsdc(quote.fee, 4)}</strong>
      </div>
      <div className="feeRow">
        <span>Total debit</span>
        <strong>{formatUsdc(quote.totalDebit, 4)}</strong>
      </div>

      <button
        className="confirmButton"
        disabled={!quote.accepted || market.status !== "OPEN"}
        onClick={confirmTicket}
        type="button"
        data-tour="buy-button"
        data-tour-phase="buy"
      >
        <ShoppingCart size={18} aria-hidden />
        {quote.accepted ? `Buy ${outcome} ticket` : quote.reason}
      </button>

      <p className="settlementNote">
        <LockKeyhole size={15} aria-hidden />
        Ticket is non-transferable and settles after oracle resolution.
      </p>

      {ticketId ? (
        <div className="successBanner" role="status">
          <CheckCircle2 size={18} aria-hidden />
          {ticketId} created. Reserve locked: {formatUsdc(quote.requiredReserve)}.
        </div>
      ) : null}
    </section>
  );
}
