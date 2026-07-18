import Link from "next/link";
import { CountdownTimer } from "./CountdownTimer";
import { LifecycleBar, marketLifecycleProgress } from "./LifecycleBar";
import { formatCompact, formatDisplayOdds } from "@/lib/format";
import type { Market } from "@/lib/types";

interface MarketCardProps {
  market: Market;
  /** Larger featured card on home hero */
  featured?: boolean;
}

export function MarketCard({ market, featured = false }: MarketCardProps) {
  const yesVol = market.yesVolume ?? 0;
  const noVol = market.noVolume ?? 0;
  const volSum = yesVol + noVol;
  const yesVolPct = volSum > 0 ? Math.round((yesVol / volSum) * 100) : 50;
  const progress = marketLifecycleProgress(market);

  const category =
    market.demoRole === "btc_price"
      ? "Crypto · Coinbase"
      : market.demoRole === "london_weather"
        ? "Weather · London"
        : "Market";

  const statusOpen = market.status === "OPEN";

  return (
    <Link
      href={`/markets/${market.id}`}
      className={featured ? "marketCardLink featured" : "marketCardLink"}
    >
      <article className={featured ? "marketCard marketCardFeatured" : "marketCard"}>
        <div className="marketCardTop">
          <div className="marketCardTopLeft">
            {statusOpen ? (
              <CountdownTimer target={market.lockTime} label="" finishedLabel="Locking…" />
            ) : market.status === "LOCKED" ? (
              <CountdownTimer target={market.observationEnd} label="" finishedLabel="Settling…" />
            ) : market.status === "RESOLVED" ? (
              <span className="countdown">Resolved</span>
            ) : (
              <span className="countdown">{market.status}</span>
            )}
            {featured ? (
              <span className={statusOpen ? "statusPill open" : "statusPill"}>{market.status}</span>
            ) : null}
          </div>
          <span className="marketCardCat">{category}</span>
        </div>

        <h3>{market.question}</h3>

        <div className={featured ? "oddsRow oddsRowFeatured" : "oddsRow"}>
          <div className="oddsBox yes">
            <div className="oddsBoxLabel">YES</div>
            <div className="oddsBoxValue">{formatDisplayOdds(market.yesPrice, market.noPrice, "YES")}</div>
          </div>
          <div className="oddsBox no">
            <div className="oddsBoxLabel">NO</div>
            <div className="oddsBoxValue">{formatDisplayOdds(market.yesPrice, market.noPrice, "NO")}</div>
          </div>
        </div>

        <LifecycleBar progressPct={progress} size={featured ? "md" : "sm"} showLabels={featured} />

        <div className="volSplit" aria-hidden>
          <div className="volSplitYes" style={{ width: `${yesVolPct}%` }} />
          <div className="volSplitNo" />
        </div>

        <div className="cardStats">
          <span>
            {formatCompact(market.volume)} USDC · {market.ticketCount ?? 0} tickets
          </span>
          {!featured ? (
            <span className={statusOpen ? "statusPill open" : "statusPill"}>{market.status}</span>
          ) : null}
        </div>
      </article>
    </Link>
  );
}
