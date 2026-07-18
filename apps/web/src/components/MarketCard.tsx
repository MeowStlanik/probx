import Link from "next/link";
import { CountdownTimer } from "./CountdownTimer";
import { formatCompact, formatDisplayOdds } from "@/lib/format";
import type { Market } from "@/lib/types";

interface MarketCardProps {
  market: Market;
}

export function MarketCard({ market }: MarketCardProps) {
  const yesVol = market.yesVolume ?? 0;
  const noVol = market.noVolume ?? 0;
  const volSum = yesVol + noVol;
  const yesVolPct = volSum > 0 ? Math.round((yesVol / volSum) * 100) : 50;

  const category =
    market.demoRole === "btc_price"
      ? "Crypto · Coinbase"
      : market.demoRole === "london_weather"
        ? "Weather · London"
        : "Market";

  return (
    <Link
      href={`/markets/${market.id}`}
      style={{ textDecoration: "none", color: "inherit", display: "block", height: "100%" }}
    >
      <article className="marketCard marketCardCompact">
        <div className="marketCardTop">
          {market.status === "OPEN" ? (
            <CountdownTimer target={market.lockTime} label="" finishedLabel="Locking…" />
          ) : market.status === "LOCKED" ? (
            <CountdownTimer target={market.observationEnd} label="" finishedLabel="Settling…" />
          ) : market.status === "RESOLVED" ? (
            <span className="countdown">Resolved</span>
          ) : (
            <span className="countdown">{market.status}</span>
          )}
          <span style={{ fontSize: 12, color: "var(--muted)" }}>{category}</span>
        </div>

        <h3>{market.question}</h3>

        <div className="oddsRow">
          <span className="yesText">
            <span>YES</span>
            {formatDisplayOdds(market.yesPrice, market.noPrice, "YES")}
          </span>
          <span className="noText">
            <span>NO</span>
            {formatDisplayOdds(market.yesPrice, market.noPrice, "NO")}
          </span>
        </div>

        <div
          style={{
            marginTop: 16,
            height: 5,
            borderRadius: 3,
            overflow: "hidden",
            display: "flex",
            background: "#F0F3F7"
          }}
          aria-hidden
        >
          <div style={{ height: "100%", background: "var(--yes)", width: `${yesVolPct}%` }} />
          <div style={{ height: "100%", background: "var(--no)", flex: 1 }} />
        </div>

        <div className="cardStats">
          <span>
            {formatCompact(market.volume)} USDC · {market.ticketCount ?? 0} tickets
          </span>
          <span className={market.status === "OPEN" ? "statusPill open" : "statusPill"}>
            {market.status}
          </span>
        </div>
      </article>
    </Link>
  );
}
