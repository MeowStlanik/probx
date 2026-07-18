import { LiveMarketTable } from "@/components/LiveMarketTable";
import { LiveReferencePanel } from "@/components/LiveReferencePanel";
import { fetchMarkets } from "@/lib/api.server";
import { pickLiveMarketHref } from "@/lib/marketLinks";

export const dynamic = "force-dynamic";

export default async function MarketsPage() {
  const markets = await fetchMarkets();

  return (
    <main className="pageShell pageShellTight">
      <div className="sectionHeader sectionHeaderCompact">
        <div>
          <span className="eyebrow">Live</span>
          <h1>Markets</h1>
          <p style={{ color: "var(--muted)", fontSize: "13.5px", margin: "6px 0 0" }}>
            Live and recently resolved short-window USDC markets on Arc.
          </p>
        </div>
      </div>
      <LiveReferencePanel
        compact
        btcMarketHref={pickLiveMarketHref(markets, "btc")}
        weatherMarketHref={pickLiveMarketHref(markets, "weather")}
      />
      <LiveMarketTable initial={markets} />
    </main>
  );
}
