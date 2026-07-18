import Link from "next/link";
import { LiveHomeMarkets } from "@/components/LiveHomeMarkets";
import { MarketCard } from "@/components/MarketCard";
import { UsdcFlow } from "@/components/UsdcFlow";
import { fetchLpStats, fetchMarkets } from "@/lib/api.server";
import { formatUsdc } from "@/lib/format";
import { arcDeployment, hasArcDeployment } from "@/lib/onchain";
import type { Market } from "@/lib/types";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export default async function HomePage() {
  const [allMarkets, stats] = await Promise.all([fetchMarkets(), fetchLpStats()]);
  const featuredMarket = pickFeaturedMarket(allMarkets);
  const resolvedCount = allMarkets.filter((m) => m.status === "RESOLVED").length;
  const ticketTotal = allMarkets.reduce((sum, m) => sum + (m.ticketCount ?? 0), 0);
  const volumeTotal = allMarkets.reduce((sum, m) => sum + (m.volume ?? 0), 0);
  const explorer = arcDeployment.explorerUrl || "https://testnet.arcscan.app";

  const fmtStat = (n: number) =>
    n > 0
      ? formatUsdc(n, 0).replace(/\s*USDC/, "").trim()
      : "—";

  return (
    <main className="homeMain">
      {/* Hero */}
      <section className="homeHero">
        <div className="homeHeroGrid">
          <div className="homeHeroCopy">
            <span className="eyebrow">USDC-native · Arc Testnet</span>
            <h1>Short prediction markets, settled entirely in USDC on Arc</h1>
            <p className="homeHeroLead">
              60-second YES/NO tickets. Wallets created from email, gas paid in USDC, liquidity
              bridged over CCTP. Every settlement is verifiable on Arcscan.
            </p>
            <div className="proofChips">
              {hasArcDeployment ? (
                <a
                  className="proofChip"
                  href={`${explorer}/address/${arcDeployment.liquidityPool}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  <span className="proofDot yes" aria-hidden />
                  Gas paid in USDC · chain{" "}
                  <span className="mono accent">{arcDeployment.chainId}</span>
                </a>
              ) : (
                <span className="proofChip">
                  <span className="proofDot yes" aria-hidden />
                  Demo mode · live Arc when configured
                </span>
              )}
              <span className="proofChip">
                <span className="proofDot purple" aria-hidden />
                CCTP Base→Arc in <span className="mono">~4 min</span>
              </span>
              <Link className="proofChip asButton" href="/markets">
                <span className="proofDot blue" aria-hidden />
                Email → wallet in <span className="mono">30 sec</span>
              </Link>
            </div>
          </div>

          <div className="homeHeroCard">
            {featuredMarket ? (
              <MarketCard market={featuredMarket} featured />
            ) : (
              <div className="marketCard marketCardFeatured marketsEmptyState">
                <strong>No open markets</strong>
                <p>Next BTC / London window opens as the cycle rolls (~1–2 min).</p>
                <Link className="iconButton secondary" href="/markets">
                  View markets
                </Link>
              </div>
            )}
          </div>
        </div>
      </section>

      {/* Stats */}
      <section className="arcStatsBar" aria-label="Platform stats">
        <div className="arcStatsBarInner">
          <div>
            <div className="arcStatLabel">Total volume</div>
            <div className="arcStatValue">
              {fmtStat(volumeTotal)} <span>USDC</span>
            </div>
          </div>
          <div>
            <div className="arcStatLabel">Tickets sold</div>
            <div className="arcStatValue">{ticketTotal > 0 ? ticketTotal : "—"}</div>
          </div>
          <div>
            <div className="arcStatLabel">Markets resolved</div>
            <div className="arcStatValue">{resolvedCount > 0 ? resolvedCount : "—"}</div>
          </div>
          <div>
            <div className="arcStatLabel">LP TVL</div>
            <div className="arcStatValue">
              {fmtStat(stats.tvl)} <span>USDC</span>
            </div>
          </div>
        </div>
      </section>

      <UsdcFlow />

      {/* Live markets — client polled */}
      <section className="homeLiveBand">
        <div className="homeLiveInner">
          <LiveHomeMarkets initial={allMarkets} band />
        </div>
      </section>

      {/* Infra */}
      <section className="arcInfraStrip" aria-label="Infrastructure">
        <div>
          <span className="label">CIRCLE WALLETS</span>
          <p>EOA per user, created from email — no seed phrase to manage.</p>
          <a
            href={`${explorer}/address/${arcDeployment.deployer}`}
            target="_blank"
            rel="noreferrer"
          >
            View wallet ↗
          </a>
        </div>
        <div>
          <span className="label purple">CCTP V2</span>
          <p>Native USDC bridged from Base Sepolia — burn, attest, mint.</p>
          <a href={explorer} target="_blank" rel="noreferrer">
            View on Arcscan ↗
          </a>
        </div>
        <div>
          <span className="label">USDC GAS</span>
          <p>Every transaction — trade, claim, bridge — pays gas in USDC.</p>
          <a
            href={`${explorer}/address/${arcDeployment.usdc}`}
            target="_blank"
            rel="noreferrer"
          >
            View token ↗
          </a>
        </div>
      </section>
    </main>
  );
}

function pickFeaturedMarket(markets: Market[]): Market | undefined {
  if (!markets.length) return undefined;
  const open = markets.filter((market) => market.status === "OPEN");
  const pool = open.length ? open : markets.filter((m) => m.status === "LOCKED");
  const list = pool.length ? pool : markets;
  return (
    list.find((market) => market.demoRole === "btc_price") ??
    list.find((market) => market.demoRole === "london_weather") ??
    list[0]
  );
}
