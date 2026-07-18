import { theme } from "../theme";
import type { LoadState, MarketSummary } from "../types";
import { MarketCard } from "../components/MarketCard";
import { EmptyState, SkeletonCard } from "../components/EmptyState";

interface Props {
  state: LoadState;
  markets: MarketSummary[];
  resolvedBanner?: {
    question: string;
    resolvedAgo: string;
    stats: string;
    outcome: "YES" | "NO";
    txHref: string;
  } | null;
  onSelectMarket: (id: string) => void;
  onRetry: () => void;
}

// /markets — BTC + weather only, centered two-card grid with lifecycle labels.
export function MarketsListView({ state, markets, resolvedBanner, onSelectMarket, onRetry }: Props) {
  return (
    <main style={{ maxWidth: theme.layout.maxWidth, margin: "0 auto", padding: "40px 24px 72px", flex: 1 }}>
      <h1 style={{ fontSize: 26, fontWeight: 600, color: theme.color.ink, marginBottom: 6 }}>Markets</h1>
      <p style={{ fontSize: 13.5, color: theme.color.muted, marginBottom: 28 }}>
        Live BTC and London weather windows on Arc — one of each.
      </p>

      {state === "error" && (
        <EmptyState
          tone="error"
          title="Couldn't load markets"
          description="The Arc RPC request timed out. Check your connection and try again."
          action={
            <button
              onClick={onRetry}
              style={{
                background: theme.color.ink,
                color: "#fff",
                border: "none",
                borderRadius: 9,
                padding: "9px 16px",
                fontSize: 12.5,
                fontWeight: 600,
                cursor: "pointer"
              }}
            >
              Retry
            </button>
          }
        />
      )}

      {state === "empty" && (
        <EmptyState
          title="No markets open right now"
          description="A new BTC/weather round opens after the previous one fully resolves."
        />
      )}

      {state === "loading" && (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 340px), 400px))",
            gap: 18,
            justifyContent: "center"
          }}
        >
          {Array.from({ length: 2 }).map((_, i) => (
            <SkeletonCard key={i} />
          ))}
        </div>
      )}

      {state === "live" && (
        <>
          {resolvedBanner && (
            <>
              <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 14 }}>
                <span style={{ width: 7, height: 7, borderRadius: "50%", background: theme.color.muted }} />
                <span
                  style={{
                    fontSize: 12.5,
                    fontWeight: 600,
                    color: theme.color.muted,
                    letterSpacing: ".02em",
                    textTransform: "uppercase"
                  }}
                >
                  Just resolved
                </span>
              </div>
              <div
                style={{
                  background: "#fff",
                  border: `1px solid ${theme.color.border}`,
                  borderRadius: 14,
                  boxShadow: theme.shadow.card,
                  padding: "18px 20px",
                  display: "flex",
                  alignItems: "center",
                  gap: 18,
                  marginBottom: 32,
                  flexWrap: "wrap"
                }}
              >
                <span
                  style={{
                    fontSize: 11,
                    fontWeight: 600,
                    color: theme.color.yes,
                    background: theme.color.yesSoft,
                    borderRadius: 6,
                    padding: "5px 10px"
                  }}
                >
                  {resolvedBanner.outcome} WON
                </span>
                <div style={{ flex: 1, minWidth: 220 }}>
                  <h3 style={{ fontSize: 15, fontWeight: 600, color: theme.color.ink }}>{resolvedBanner.question}</h3>
                  <div style={{ fontSize: 12, color: theme.color.muted, marginTop: 3 }}>
                    Resolved {resolvedBanner.resolvedAgo} · {resolvedBanner.stats}
                  </div>
                </div>
                <a
                  href={resolvedBanner.txHref}
                  target="_blank"
                  rel="noreferrer"
                  style={{ fontFamily: theme.font.mono, fontSize: 11.5, color: theme.color.purple, flexShrink: 0 }}
                >
                  settlement ↗
                </a>
              </div>
            </>
          )}
          <h2 style={{ fontSize: 14, fontWeight: 600, color: theme.color.ink, marginBottom: 14, textAlign: "center" }}>
            Open now
          </h2>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 300px), 380px))",
              gap: 18,
              justifyContent: "center",
              maxWidth: 860,
              margin: "0 auto"
            }}
          >
            {markets.map((m) => (
              <MarketCard key={m.id} market={m} onClick={() => onSelectMarket(m.id)} />
            ))}
          </div>
        </>
      )}
    </main>
  );
}
