import { notFound } from "next/navigation";
import { Activity, RadioTower } from "lucide-react";
import { CountdownTimer } from "@/components/CountdownTimer";
import { MarketLifecycleStage } from "@/components/MarketLifecycleStage";
import { MarketLiveChart } from "@/components/MarketLiveChart";
import { MicroTradeTicket } from "@/components/MicroTradeTicket";
import { OnchainTradeTicket } from "@/components/OnchainTradeTicket";
import { fetchLpStats, fetchMarket } from "@/lib/api.server";
import { formatCompact, formatDisplayOdds } from "@/lib/format";
import { hasArcDeployment } from "@/lib/onchain";

interface MarketDetailPageProps {
  params: Promise<{ marketId: string }>;
}

export const dynamic = "force-dynamic";

export default async function MarketDetailPage({ params }: MarketDetailPageProps) {
  const { marketId } = await params;
  const [market, stats] = await Promise.all([fetchMarket(marketId), fetchLpStats()]);
  if (!market) notFound();
  const referenceFeed = referenceFeedForMarket(market);

  return (
    <main className="pageShell detailGrid detailGridWide">
      <section className="marketDetail marketDetailCompact">
        <div className="sectionHeader sectionHeaderCompact">
          <div>
            <span className="eyebrow">{labelForMarket(market)}</span>
            <h1 className="marketTitle">{market.question}</h1>
          </div>
          <span className={market.status === "OPEN" ? "statusPill open" : "statusPill"}>{market.status}</span>
        </div>

        <MarketLifecycleStage market={market} />

        <div className="oddsPanel compactOddsPanel">
          <div>
            <span>YES</span>
            <strong className="yesText">{formatDisplayOdds(market.yesPrice, market.noPrice, "YES")}</strong>
          </div>
          <div>
            <span>NO</span>
            <strong className="noText">{formatDisplayOdds(market.yesPrice, market.noPrice, "NO")}</strong>
          </div>
          <div>
            <span>Lock</span>
            <strong>
              <CountdownTimer target={market.lockTime} label="" finishedLabel="Locked" />
            </strong>
          </div>
          <div>
            <span>Settle</span>
            <strong>
              <CountdownTimer target={market.observationEnd} label="" finishedLabel="Ready" />
            </strong>
          </div>
          <div>
            <span>Vol</span>
            <strong>{formatCompact(market.volume)} · {market.ticketCount ?? 0}t</strong>
          </div>
          <div>
            <span>Flow</span>
            <strong>
              Y{formatCompact(market.yesVolume ?? 0)}/N{formatCompact(market.noVolume ?? 0)}
            </strong>
          </div>
        </div>

        <div className="detailStats compactDetailStats">
          <div>
            <Activity size={14} aria-hidden />
            <span>Source</span>
            <strong>{shortSource(market.resolutionSource)}</strong>
          </div>
          <div>
            <RadioTower size={14} aria-hidden />
            <span>Feed</span>
            <strong>{referenceFeed === "btc" ? "BTC" : referenceFeed === "weather" ? "London" : "—"}</strong>
          </div>
        </div>

        {referenceFeed ? <MarketLiveChart market={market} feed={referenceFeed} /> : null}
      </section>

      {hasArcDeployment ? <OnchainTradeTicket market={market} /> : <MicroTradeTicket market={market} lpStats={stats} />}
    </main>
  );
}

function referenceFeedForMarket(market: { category: string; demoRole?: string; question: string }): "btc" | "weather" | undefined {
  const question = market.question.toLowerCase();
  if (market.demoRole === "btc_price" || market.category === "crypto-candle" || question.includes("btc/usd") || question.includes("bitcoin")) return "btc";
  if (market.demoRole === "london_weather" || market.category === "weather" || question.includes("london temperature") || question.includes("weather")) return "weather";
  return undefined;
}

function labelForMarket(market: { demoRole?: string; category: string }): string {
  if (market.demoRole === "btc_price" || market.category === "crypto-candle") return "BTC market";
  if (market.demoRole === "london_weather" || market.category === "weather") return "London weather";
  return market.category.replace("-", " ");
}

function shortSource(source: string): string {
  if (/coinbase/i.test(source)) return "Coinbase BTC";
  if (/meteo|weather/i.test(source)) return "Open-Meteo";
  return source.length > 28 ? `${source.slice(0, 28)}…` : source;
}
