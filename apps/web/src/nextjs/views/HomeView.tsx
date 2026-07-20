import Link from "next/link";
import { theme } from "../theme";
import type { MarketSummary } from "../types";
import { MarketCard } from "../components/MarketCard";

interface Props {
  heroMarket: MarketSummary;
  marketsPreview: MarketSummary[];
  stats: { volume: string; tickets: string; resolved: string; tvl: string };
  onSelectMarket: (id: string) => void;
}

export function HomeView({
  heroMarket,
  marketsPreview,
  stats,
  onSelectMarket
}: Props) {

  return (
    <main>
      <section style={{ maxWidth: theme.layout.maxWidth, margin: "0 auto", padding: "56px 24px 48px" }}>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 44, alignItems: "flex-start" }}>
          <div style={{ flex: "1 1 560px", minWidth: 320, maxWidth: 640 }}>
            <span
              style={{
                display: "inline-block",
                fontSize: 12.5,
                fontWeight: 600,
                letterSpacing: ".02em",
                color: theme.color.blue,
                background: theme.color.blueSoft,
                padding: "5px 11px",
                borderRadius: 20,
                marginBottom: 20
              }}
            >
              USDC-native · Arc Testnet
            </span>
            <h1
              style={{
                fontSize: 46,
                lineHeight: 1.08,
                fontWeight: 700,
                letterSpacing: "-0.025em",
                color: theme.color.ink,
                margin: 0
              }}
            >
              Short prediction markets, settled entirely in USDC on Arc
            </h1>
            <p
              style={{
                fontSize: 16.5,
                lineHeight: 1.55,
                color: theme.color.muted,
                margin: "18px 0 0",
                maxWidth: "52ch"
              }}
            >
              60-second YES/NO tickets. Wallets created from email, gas paid in USDC, liquidity bridged over CCTP. Every
              settlement is verifiable on Arcscan.
            </p>

            {/* Feature highlights */}
            <div style={{ display: "flex", flexWrap: "wrap", gap: 10, marginTop: 24 }}>
              <span
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 8,
                  border: `1px solid ${theme.color.border}`,
                  borderRadius: 10,
                  padding: "9px 13px",
                  fontSize: 13,
                  color: theme.color.ink,
                  background: "#fff",
                  boxShadow: theme.shadow.card
                }}
              >
                <span style={{ width: 8, height: 8, borderRadius: "50%", background: theme.color.yes }} />
                No gas tokens needed
              </span>
              <span
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 8,
                  border: `1px solid ${theme.color.border}`,
                  borderRadius: 10,
                  padding: "9px 13px",
                  fontSize: 13,
                  color: theme.color.ink,
                  background: "#fff",
                  boxShadow: theme.shadow.card
                }}
              >
                <span style={{ width: 8, height: 8, borderRadius: "50%", background: theme.color.purple }} />
                Instant USDC settlement
              </span>
              <Link
                href="/portfolio"
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 8,
                  border: `1px solid ${theme.color.border}`,
                  borderRadius: 10,
                  padding: "9px 13px",
                  fontSize: 13,
                  color: theme.color.ink,
                  background: "#fff",
                  boxShadow: theme.shadow.card,
                  textDecoration: "none"
                }}
              >
                <span style={{ width: 8, height: 8, borderRadius: "50%", background: theme.color.blue }} />
                Email sign-up, instant wallet
              </Link>
            </div>
          </div>

          {/* Hero market card */}
          <div style={{ flex: "1 1 380px", minWidth: 280, maxWidth: 460 }}>
            <MarketCard market={heroMarket} variant="hero" onClick={() => onSelectMarket(heroMarket.id)} />
          </div>
        </div>
      </section>

      {/* Stats strip */}
      <section
        style={{
          background: theme.color.tint,
          borderTop: `1px solid ${theme.color.border}`,
          borderBottom: `1px solid ${theme.color.border}`,
          padding: "36px 0"
        }}
      >
        <div
          style={{
            maxWidth: theme.layout.maxWidth,
            margin: "0 auto",
            padding: "0 24px",
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit,minmax(160px,1fr))",
            gap: 24
          }}
        >
          {(
            [
              ["Total volume", stats.volume],
              ["Tickets sold", stats.tickets],
              ["Markets resolved", stats.resolved],
              ["LP TVL", stats.tvl]
            ] as const
          ).map(([label, value]) => (
            <div key={label}>
              <div style={{ fontSize: 11.5, color: theme.color.muted, fontWeight: 500 }}>{label}</div>
              <div
                style={{
                  fontFamily: theme.font.mono,
                  fontSize: 26,
                  fontWeight: 600,
                  color: theme.color.ink,
                  marginTop: 4
                }}
              >
                {value}
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* Live markets on white — not a second tint block */}
      <section style={{ background: "#fff", padding: "56px 0 72px" }}>
        <div style={{ maxWidth: theme.layout.maxWidth, margin: "0 auto", padding: "0 24px" }}>
          <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 18 }}>
            <h2 style={{ fontSize: 20, fontWeight: 600, color: theme.color.ink, margin: 0 }}>Live markets</h2>
            <Link href="/markets" style={{ fontSize: 13, fontWeight: 600, color: theme.color.blue }}>
              View all markets →
            </Link>
          </div>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 300px), 380px))",
              gap: 18,
              justifyContent: "center"
            }}
          >
            {marketsPreview.map((m) => (
              <MarketCard key={m.id} market={m} onClick={() => onSelectMarket(m.id)} />
            ))}
          </div>
        </div>
      </section>
    </main>
  );
}
