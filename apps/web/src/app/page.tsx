import Link from "next/link";
import { LiveHomeMarkets } from "@/components/LiveHomeMarkets";
import { LiveReferencePanel } from "@/components/LiveReferencePanel";
import { CountdownTimer } from "@/components/CountdownTimer";
import { fetchLpStats, fetchMarkets } from "@/lib/api.server";
import { formatDisplayOdds, formatUsdc } from "@/lib/format";
import { pickLiveMarketHref } from "@/lib/marketLinks";
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

  return (
    <main>
      {/* Hero — matches Arc redesign: copy left, live market card right */}
      <section className="heroAurora homeHero">
        <div className="heroCopy">
          <div className="heroBadges">
            <span>USDC-native · Arc Testnet</span>
          </div>
          <h1>Short prediction markets, settled entirely in USDC on Arc</h1>
          <p>
            60-second YES/NO tickets. Wallets created from email, gas paid in USDC, liquidity bridged
            over CCTP. Every settlement is verifiable on Arcscan.
          </p>
          <div className="miniProofs">
            {hasArcDeployment ? (
              <a
                href={`${explorer}/address/${arcDeployment.liquidityPool}`}
                target="_blank"
                rel="noreferrer"
              >
                <span className="dotLive" aria-hidden />
                Gas paid in USDC · chain {arcDeployment.chainId}
              </a>
            ) : (
              <div>
                <span className="dotLive" aria-hidden />
                Demo mode · live Arc when configured
              </div>
            )}
            <div>
              <span
                aria-hidden
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: "50%",
                  background: "var(--purple)",
                  display: "inline-block"
                }}
              />
              CCTP Base→Arc bridge
            </div>
            <div>
              <span
                aria-hidden
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: "50%",
                  background: "var(--blue)",
                  display: "inline-block"
                }}
              />
              Email → wallet in 30 sec
            </div>
          </div>
        </div>

        {featuredMarket ? (
          <Link
            href={`/markets/${featuredMarket.id}`}
            className="heroDashboard homeDashboard"
            style={{ textDecoration: "none", color: "inherit", display: "block" }}
            aria-label={`Trade market: ${featuredMarket.question}`}
          >
            <div className="dashboardTopbar">
              <div>
                {featuredMarket.status === "OPEN" ? (
                  <CountdownTimer target={featuredMarket.lockTime} label="" finishedLabel="Locking…" />
                ) : featuredMarket.status === "LOCKED" ? (
                  <CountdownTimer
                    target={featuredMarket.observationEnd}
                    label=""
                    finishedLabel="Settling…"
                  />
                ) : (
                  <span className="countdown">{featuredMarket.status}</span>
                )}
                <span
                  className={featuredMarket.status === "OPEN" ? "statusPill open" : "statusPill"}
                >
                  {featuredMarket.status}
                </span>
              </div>
              <span style={{ fontSize: 12, color: "var(--muted)" }}>
                {marketCategory(featuredMarket)}
              </span>
            </div>

            <h2
              style={{
                fontSize: 18,
                fontWeight: 600,
                lineHeight: 1.25,
                color: "var(--ink)",
                margin: "4px 0 0"
              }}
            >
              {featuredMarket.question}
            </h2>

            <div className="oddsRow">
              <span className="yesText">
                <span>YES</span>
                {formatDisplayOdds(featuredMarket.yesPrice, featuredMarket.noPrice, "YES")}
              </span>
              <span className="noText">
                <span>NO</span>
                {formatDisplayOdds(featuredMarket.yesPrice, featuredMarket.noPrice, "NO")}
              </span>
            </div>

            <div
              style={{
                marginTop: 14,
                fontSize: 12,
                color: "var(--muted)",
                fontFamily: "var(--mono)"
              }}
            >
              {featuredMarket.ticketCount ?? 0} tickets ·{" "}
              {formatUsdc(featuredMarket.volume ?? 0, 0)} vol
              {stats.tvl > 0
                ? ` · LP ${formatUsdc(stats.tvl, 0)}`
                : ""}
            </div>
          </Link>
        ) : (
          <div className="heroDashboard homeDashboard">
            <div className="dashboardHeroCard">
              <div>
                <span>No open markets</span>
                <h2>Browse markets or check back soon</h2>
                <p className="dashboardHeroMeta">
                  BTC and London weather markets auto-resolve from live feeds.
                </p>
              </div>
            </div>
            <div className="homeQuickLinks">
              <Link href="/markets">All markets →</Link>
            </div>
          </div>
        )}
      </section>

      {/* Stats strip */}
      <section className="arcStatsBar" aria-label="Platform stats">
        <div className="arcStatsBarInner">
          <div>
            <div className="arcStatLabel">Total volume</div>
            <div className="arcStatValue">
              {volumeTotal > 0 ? formatUsdc(volumeTotal, 0).replace(/\s*USDC/, "") : "—"}{" "}
              <span>USDC</span>
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
              {stats.tvl > 0 ? formatUsdc(stats.tvl, 0).replace(/\s*USDC/, "") : "—"}{" "}
              <span>USDC</span>
            </div>
          </div>
        </div>
      </section>

      {/* Live feeds + markets */}
      <div className="pageShell homeBody homeBodyTight">
        <LiveReferencePanel
          btcMarketHref={pickLiveMarketHref(allMarkets, "btc")}
          weatherMarketHref={pickLiveMarketHref(allMarkets, "weather")}
        />
        <LiveHomeMarkets initial={allMarkets} />
      </div>

      {/* Infrastructure */}
      <section className="arcInfraStrip" aria-label="Infrastructure">
        <div>
          <span className="label">CIRCLE WALLETS</span>
          <p>EOA per user, created from email — no seed phrase to manage.</p>
        </div>
        <div>
          <span className="label purple">CCTP V2</span>
          <p>Native USDC bridged from Base Sepolia — burn, attest, mint.</p>
        </div>
        <div>
          <span className="label">USDC GAS</span>
          <p>Every transaction — trade, claim, bridge — pays gas in USDC.</p>
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

function marketCategory(market: Market): string {
  if (market.demoRole === "btc_price") return "Crypto · Coinbase";
  if (market.demoRole === "london_weather") return "Weather · London";
  return "Market";
}
