import { MarketCard } from "@/components/MarketCard";
import { fetchMarkets } from "@/lib/api.server";
import { formatCompact } from "@/lib/format";
import type { Market } from "@/lib/types";
import Link from "next/link";

export const dynamic = "force-dynamic";

export default async function MarketsPage() {
  const markets = await fetchMarkets();
  const open = markets.filter((m) => m.status === "OPEN" || m.status === "LOCKED");
  const resolved = markets
    .filter((m) => m.status === "RESOLVED")
    .slice(0, 3);
  return (
    <main className="pageShell pageShellTight">
      <div className="sectionHeader sectionHeaderCompact">
        <div>
          <h1>Markets</h1>
          <p className="pageLead">
            Live and recently resolved short-window USDC markets on Arc.
          </p>
        </div>
      </div>

      {resolved.length > 0 ? (
        <div className="resolvedStrip">
          <div className="resolvedStripLabel">
            <span className="resolvedDot" aria-hidden />
            <span>Just resolved</span>
          </div>
          {resolved.map((market) => (
            <ResolvedRow key={market.id} market={market}  />
          ))}
        </div>
      ) : null}

      <h2 className="openNowHeading">Open now</h2>
      {open.length ? (
        <div className="cardGrid">
          {open.map((market) => (
            <MarketCard key={market.id} market={market} />
          ))}
        </div>
      ) : (
        <div className="emptyStatePanel">
          No open markets. Next BTC / London window opens as the cycle rolls (~1–2 min).
        </div>
      )}
    </main>
  );
}

function ResolvedRow({ market }: { market: Market }) {
  const won =
    market.winningOutcome === "YES" || market.winningOutcome === "NO"
      ? `${market.winningOutcome} WON`
      : "RESOLVED";

  return (
    <Link href={`/markets/${market.id}`} className="resolvedRow">
      <span className="statusPill open">{won}</span>
      <div className="resolvedRowBody">
        <h3>{market.question}</h3>
        <div className="resolvedRowMeta">
          {market.ticketCount ?? 0} tickets · {formatCompact(market.volume)} USDC vol
        </div>
      </div>
      {market.id.startsWith("0x") ? (
        <span className="resolvedRowTx mono">
          market {market.id.slice(0, 6)}…{market.id.slice(-4)}
        </span>
      ) : null}
    </Link>
  );
}
