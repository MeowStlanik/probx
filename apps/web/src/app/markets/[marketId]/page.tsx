import Link from "next/link";
import { notFound } from "next/navigation";
import { CountdownTimer } from "@/components/CountdownTimer";
import { LifecycleBar, marketLifecycleProgress } from "@/components/LifecycleBar";
import { MarketLiveChart } from "@/components/MarketLiveChart";
import { MicroTradeTicket } from "@/components/MicroTradeTicket";
import { OnchainTradeTicket } from "@/components/OnchainTradeTicket";
import { fetchLpStats, fetchMarket } from "@/lib/api.server";
import { formatDisplayOdds } from "@/lib/format";
import { arcDeployment, hasArcDeployment } from "@/lib/onchain";

interface MarketDetailPageProps {
  params: Promise<{ marketId: string }>;
}

export const dynamic = "force-dynamic";

export default async function MarketDetailPage({ params }: MarketDetailPageProps) {
  const { marketId } = await params;
  const [market, stats] = await Promise.all([fetchMarket(marketId), fetchLpStats()]);
  if (!market) notFound();
  const referenceFeed = referenceFeedForMarket(market);
  const explorer = arcDeployment.explorerUrl || "https://testnet.arcscan.app";
  const progress = marketLifecycleProgress(market);
  const addr = market.contractAddress || (market.id.startsWith("0x") ? market.id : "");

  return (
    <main className="pageShell marketPage">
      <Link href="/markets" className="backLink">
        ← All markets
      </Link>

      <div className="marketPageHead">
        <div className="marketPageHeadTop">
          {market.status === "OPEN" ? (
            <CountdownTimer target={market.lockTime} label="" finishedLabel="Locking…" />
          ) : market.status === "LOCKED" || market.status === "OBSERVATION" ? (
            <CountdownTimer target={market.observationEnd} label="" finishedLabel="Settling…" />
          ) : (
            <span className="countdown">{market.status}</span>
          )}
          <span className={market.status === "OPEN" ? "statusPill open" : "statusPill"}>
            {market.status}
          </span>
        </div>
        <h1 className="marketTitle">{market.question}</h1>
        <p className="marketPageMeta">
          Resolves from {shortSource(market.resolutionSource)}
          {addr ? (
            <>
              {" · market "}
              <a
                href={`${explorer}/address/${addr}`}
                target="_blank"
                rel="noreferrer"
                className="footerMonoLink"
              >
                {addr.slice(0, 6)}…{addr.slice(-4)} ↗
              </a>
            </>
          ) : null}
        </p>
      </div>

      <div className="lifecyclePanel">
        <div className="lifecyclePanelHead">
          <span>Market lifecycle</span>
          <span className="mono muted">
            now · {market.status}
          </span>
        </div>
        <LifecycleBar progressPct={progress} size="lg" showLabels />
      </div>

      <div className="marketPageGrid">
        <div className="marketPageMain">
          <div className="surfaceCard">
            <div className="chartLegend">
              <span className="chartLegendTitle">Price</span>
              <span className="chartLegendYes">
                <i aria-hidden />
                YES {formatDisplayOdds(market.yesPrice, market.noPrice, "YES")}
              </span>
              <span className="chartLegendNo">
                <i aria-hidden />
                NO {formatDisplayOdds(market.yesPrice, market.noPrice, "NO")}
              </span>
            </div>
            {referenceFeed ? (
              <MarketLiveChart market={market} feed={referenceFeed} />
            ) : (
              <div className="emptyStatePanel" style={{ marginTop: 14 }}>
                No live chart for this market type.
              </div>
            )}
          </div>
        </div>

        <div className="marketPageSide">
          {hasArcDeployment ? (
            <OnchainTradeTicket market={market} />
          ) : (
            <MicroTradeTicket market={market} lpStats={stats} />
          )}
        </div>
      </div>
    </main>
  );
}

function referenceFeedForMarket(market: {
  category: string;
  demoRole?: string;
  question: string;
}): "btc" | "weather" | undefined {
  const question = market.question.toLowerCase();
  if (
    market.demoRole === "btc_price" ||
    market.category === "crypto-candle" ||
    question.includes("btc/usd") ||
    question.includes("bitcoin")
  )
    return "btc";
  if (
    market.demoRole === "london_weather" ||
    market.category === "weather" ||
    question.includes("london temperature") ||
    question.includes("weather")
  )
    return "weather";
  return undefined;
}

function shortSource(source: string): string {
  if (/coinbase/i.test(source)) return "Coinbase BTC/USD";
  if (/meteo|weather/i.test(source)) return "Open-Meteo";
  return source.length > 36 ? `${source.slice(0, 36)}…` : source;
}
